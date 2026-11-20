/**
 * Publish mode switches in the settings screen (src/lib/mode-since.ts) checked against the
 * contract policy: what the confirmation counts is exactly what the switch publishes, and a
 * switch that is not confirmed publishes nothing and hides nothing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OnRevoke, PublishMode, Settings } from '@omw/contracts/api';
import { effectiveCaptureVisibility, nextModeSince } from '@omw/contracts/policy';
import { describe, expect, it } from 'vitest';
import { modeSinceAfter, switchReleases, type WaitingCapture, waitingToPublish } from '../src/lib/mode-since';
import { settings as baseSettings } from './helpers';

const now = Date.parse('2026-11-20T12:00:00.000Z');
const MIN = 60_000;
const since = now - 5 * 60 * MIN;
const MODES: readonly PublishMode[] = ['instant', 'delayed', 'review'];

type Override = 'public' | 'hidden' | 'pending' | null;

interface Item extends WaitingCapture {
  revokedAt: string | null;
}

/**
 * Captures around every boundary: the delay (1 h), mode_since (5 h ago), long before it; with
 * every owner override and revoked or not.
 */
function items(): Item[] {
  const ages = [
    1 * MIN,
    30 * MIN,
    60 * MIN - 1,
    60 * MIN,
    60 * MIN + 1,
    90 * MIN,
    now - since - 1,
    now - since,
    now - since + 1,
    26 * 60 * MIN,
  ];
  const out: Item[] = [];
  for (const age of ages) {
    for (const override of [null, 'public', 'hidden', 'pending'] as Override[]) {
      for (const revoked of [false, true]) {
        const sourceKey = `wa:${age}-${override ?? 'none'}-${revoked ? 'rev' : 'live'}`;
        const occurredAt = new Date(now - age).toISOString();
        out.push({
          sourceKey,
          occurredAt,
          revokedAt: revoked ? new Date(now - age + MIN).toISOString() : null,
          annotation: override ? { visibility: override } : null,
          effectiveVisibility: 'public', // replaced per settings below
        });
      }
    }
  }
  return out;
}

function settingsFor(mode: PublishMode, delayMinutes: number, onRevoke: OnRevoke): Settings {
  return {
    ...baseSettings,
    'publish.mode': mode,
    'publish.delay_minutes': delayMinutes,
    'publish.mode_since': new Date(since).toISOString(),
    'ingest.on_revoke': onRevoke,
  };
}

/** Effective visibility of every item under `s` (contract policy). */
function visibilities(list: readonly Item[], s: Settings): Map<string, string> {
  return new Map(list.map((c) => [c.sourceKey, effectiveCaptureVisibility(c, c.annotation, s, now)]));
}

/** The settings after switching to `next`, with mode_since moved like the API does. */
function switched(prev: Settings, next: PublishMode): Settings {
  return { ...prev, 'publish.mode': next, 'publish.mode_since': modeSinceAfter(prev, { 'publish.mode': next }, now) };
}

describe('publish mode switch: the confirmation counts exactly what the switch publishes', () => {
  for (const from of MODES) {
    for (const to of MODES) {
      if (from === to) continue;
      for (const delay of [0, 60, 24 * 60]) {
        for (const onRevoke of ['hide', 'keep'] as const) {
          it(`${from} -> ${to}, delay ${delay} min, on_revoke ${onRevoke}`, () => {
            const prev = settingsFor(from, delay, onRevoke);
            const next = switched(prev, to);
            const list = items();
            const before = visibilities(list, prev);
            const after = visibilities(list, next);
            const current = list.map((c) => ({
              ...c,
              effectiveVisibility: before.get(c.sourceKey) as Item['effectiveVisibility'],
            }));

            const released = list
              .filter((c) => before.get(c.sourceKey) === 'pending' && after.get(c.sourceKey) === 'public')
              .map((c) => c.sourceKey)
              .sort();
            const counted = waitingToPublish(current, prev, to, now)
              .map((c) => c.sourceKey)
              .sort();
            expect(counted).toEqual(released);
            // Nothing else changes: no status is hidden or held back by a mode switch.
            const otherChanges = list.filter(
              (c) => !released.includes(c.sourceKey) && before.get(c.sourceKey) !== after.get(c.sourceKey),
            );
            expect(
              otherChanges.map((c) => `${c.sourceKey}: ${before.get(c.sourceKey)} -> ${after.get(c.sourceKey)}`),
            ).toEqual([]);
            // Only switches that release ask at all.
            if (!switchReleases(prev, to)) expect(counted).toEqual([]);
          });
        }
      }
    }
  }

  it('review -> delayed releases the backlog older than the delay, and only that', () => {
    const prev = settingsFor('review', 60, 'hide');
    const list = items();
    const before = visibilities(list, prev);
    const current = list.map((c) => ({
      ...c,
      effectiveVisibility: before.get(c.sourceKey) as Item['effectiveVisibility'],
    }));
    const counted = waitingToPublish(current, prev, 'delayed', now);
    expect(counted.length).toBeGreaterThan(0);
    for (const c of counted) {
      expect(c.annotation).toBeNull();
      expect(c.revokedAt).toBeNull(); // revoked ones stay hidden (on_revoke = hide)
      expect(Date.parse(c.occurredAt)).toBeGreaterThanOrEqual(since); // older ones were public already
      expect(now - Date.parse(c.occurredAt)).toBeGreaterThanOrEqual(60 * MIN); // older than the delay
    }
    // Exactly one delay old counts (public at now >= occurredAt + delay); a millisecond younger waits.
    const keys = counted.map((c) => c.sourceKey);
    expect(keys).toContain(`wa:${60 * MIN}-none-live`);
    expect(keys).not.toContain(`wa:${60 * MIN - 1}-none-live`);
    // mode_since stays where it was: the review backlog follows the delay.
    expect(modeSinceAfter(prev, { 'publish.mode': 'delayed' }, now)).toBe(prev['publish.mode_since']);
  });

  it('a list without an older waiting status asks nothing (the switch saves right away)', () => {
    const prev = settingsFor('review', 60, 'hide');
    const fresh = items().filter((c) => now - Date.parse(c.occurredAt) < 60 * MIN);
    const before = visibilities(fresh, prev);
    const current = fresh.map((c) => ({
      ...c,
      effectiveVisibility: before.get(c.sourceKey) as Item['effectiveVisibility'],
    }));
    expect(current.some((c) => c.effectiveVisibility === 'pending')).toBe(true);
    expect(waitingToPublish(current, prev, 'delayed', now)).toEqual([]);
  });

  it('counts a status once, even when several cached lists hold it', () => {
    const prev = settingsFor('review', 60, 'hide');
    const old = {
      sourceKey: 'wa:OLD',
      occurredAt: new Date(now - 2 * 60 * MIN).toISOString(),
      effectiveVisibility: 'pending' as const,
      annotation: null,
    };
    expect(waitingToPublish([old, { ...old }, { ...old }], prev, 'delayed', now)).toHaveLength(1);
  });
});

describe('which switches ask first', () => {
  it.each([
    ['review', 'delayed', true],
    ['review', 'instant', true],
    ['delayed', 'instant', true],
    ['delayed', 'review', false],
    ['instant', 'delayed', false],
    ['instant', 'review', false],
    ['review', 'review', false],
    ['delayed', 'delayed', false],
    ['instant', 'instant', false],
  ] as const)('%s -> %s: %s', (from, to, asks) => {
    expect(switchReleases({ 'publish.mode': from }, to)).toBe(asks);
  });
});

describe('publish.mode_since: the admin restates the API rule', () => {
  interface Vector {
    before: Settings;
    after: Pick<Settings, 'publish.mode' | 'publish.delay_minutes'>;
    now: string;
    modeSince: string;
  }
  const { cases } = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../../fixtures/vectors/mode-switch.json'), 'utf8'),
  ) as { cases: Vector[] };

  it('matches every shared vector (fixtures/vectors/mode-switch.json, also run by PHP and contracts)', () => {
    expect(cases.length).toBeGreaterThan(100);
    for (const c of cases) {
      const name = `${c.before['publish.mode']}(${c.before['publish.delay_minutes']}, ${c.before['publish.mode_since']}) -> ${c.after['publish.mode']}(${c.after['publish.delay_minutes']})`;
      expect(modeSinceAfter(c.before, c.after, Date.parse(c.now)), name).toBe(c.modeSince);
    }
  });

  it('agrees with the contract function when a patch leaves a key out', () => {
    for (const from of MODES) {
      for (const to of MODES) {
        for (const delay of [0, 60, 1440]) {
          const prev = {
            'publish.mode': from,
            'publish.delay_minutes': 60,
            'publish.mode_since': new Date(since).toISOString(),
          };
          const patch = { 'publish.mode': to, 'publish.delay_minutes': delay };
          const expected = nextModeSince(prev, patch, now);
          expect(modeSinceAfter(prev, patch, now), `${from} -> ${to} (${delay})`).toBe(expected);
          if (delay === 60) expect(modeSinceAfter(prev, { 'publish.mode': to }, now)).toBe(expected);
        }
      }
    }
  });
});
