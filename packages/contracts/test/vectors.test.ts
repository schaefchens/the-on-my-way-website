/**
 * fixtures/vectors/*.json are the cross-runtime contract for the PHP duplicates of ids/time/policy.
 * They are written by `pnpm fixtures`; this test keeps them in sync with the TS implementation.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Visibility } from '../src/common.js';
import { publicIdForSourceKey } from '../src/ids.js';
import {
  type AnnotationPolicyInput,
  effectiveCaptureVisibility,
  effectiveLocalDate,
  effectiveTz,
  nextModeSince,
  type PlacementInput,
  type PolicySettings,
  type TripRange,
  tripForDate,
} from '../src/policy.js';
import { localDateFor, localTimeFor } from '../src/time.js';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/vectors');
const load = <T>(name: string): { cases: T[] } => JSON.parse(readFileSync(resolve(dir, name), 'utf8'));

describe('cross-runtime vectors', () => {
  it('ids.json', async () => {
    const { cases } = load<{ sourceKey: string; publicId: string }>('ids.json');
    expect(cases.length).toBeGreaterThan(10);
    for (const c of cases) expect(await publicIdForSourceKey(c.sourceKey)).toBe(c.publicId);
  });

  it('time.json', () => {
    const { cases } = load<{ isoUtc: string; tz: string; localDate: string; localTime: string }>('time.json');
    expect(cases.length).toBeGreaterThan(10);
    for (const c of cases) {
      expect(localDateFor(c.isoUtc, c.tz), `${c.isoUtc} ${c.tz}`).toBe(c.localDate);
      expect(localTimeFor(c.isoUtc, c.tz), `${c.isoUtc} ${c.tz}`).toBe(c.localTime);
    }
  });

  it('policy.json', () => {
    const { cases } = load<{
      settings: PolicySettings;
      capture: { occurredAt: string; revokedAt: string | null };
      annotation: AnnotationPolicyInput;
      now: string;
      expected: Visibility;
    }>('policy.json');
    expect(cases.length).toBe(288);
    expect(cases.some((c) => c.settings['publish.mode_since'] !== '1970-01-01T00:00:00.000Z')).toBe(true);
    for (const c of cases) {
      expect(effectiveCaptureVisibility(c.capture, c.annotation, c.settings, c.now)).toBe(c.expected);
    }
  });

  it('mode-switch.json: publish.mode_since and what a switch releases', () => {
    const { captures, cases } = JSON.parse(readFileSync(resolve(dir, 'mode-switch.json'), 'utf8')) as {
      captures: { label: string; occurredAt: string }[];
      cases: {
        before: PolicySettings;
        after: Pick<PolicySettings, 'publish.mode' | 'publish.delay_minutes'>;
        now: string;
        modeSince: string;
        visibilityBefore: Visibility[];
        visibilityAfter: Visibility[];
      }[];
    };
    expect(cases.length).toBe(162);
    let releasedByReviewToDelayed = 0;
    for (const c of cases) {
      const name = `${c.before['publish.mode']}(${c.before['publish.delay_minutes']}, ${c.before['publish.mode_since']}) -> ${c.after['publish.mode']}(${c.after['publish.delay_minutes']})`;
      expect(nextModeSince(c.before, c.after, c.now), name).toBe(c.modeSince);
      const after: PolicySettings = { ...c.before, ...c.after, 'publish.mode_since': c.modeSince };
      captures.forEach((capture, i) => {
        const label = `${name}: ${capture.label}`;
        const was = effectiveCaptureVisibility(capture, null, c.before, c.now);
        const is = effectiveCaptureVisibility(capture, null, after, c.now);
        expect(was, label).toBe(c.visibilityBefore[i]);
        expect(is, label).toBe(c.visibilityAfter[i]);
        // A capture at exactly the switch instant already falls under the new mode (mode_since
        // is inclusive): it counts as arriving with the switch, not before it.
        if (Date.parse(capture.occurredAt) >= Date.parse(c.now)) return;
        // The policy's promises: nothing public becomes pending; waiting statuses are released
        // only by -> instant, review -> delayed and a shorter delay, and only once they are at
        // least as old as the new delay.
        expect(was === 'public' && is === 'pending', label).toBe(false);
        if (was === 'pending' && is === 'public') {
          const from = c.before['publish.mode'];
          const to = c.after['publish.mode'];
          const age = Date.parse(c.now) - Date.parse(capture.occurredAt);
          const oldEnough = age >= c.after['publish.delay_minutes'] * 60_000;
          const shorter = from === 'delayed' && c.after['publish.delay_minutes'] < c.before['publish.delay_minutes'];
          expect(to === 'instant' || (to === 'delayed' && (from === 'review' || shorter) && oldEnough), label).toBe(
            true,
          );
          if (from === 'review' && to === 'delayed') releasedByReviewToDelayed++;
        }
        // review -> delayed releases EXACTLY the waiting statuses at least as old as the new delay.
        if (c.before['publish.mode'] === 'review' && c.after['publish.mode'] === 'delayed' && was === 'pending') {
          const age = Date.parse(c.now) - Date.parse(capture.occurredAt);
          expect(is, label).toBe(age >= c.after['publish.delay_minutes'] * 60_000 ? 'public' : 'pending');
        }
      });
    }
    expect(releasedByReviewToDelayed).toBeGreaterThan(0);
  });

  it('placement.json', () => {
    const { cases } = load<{
      item: PlacementInput;
      annotation: AnnotationPolicyInput | null;
      dayTz: string | null;
      localDate: string;
      tz: string;
    }>('placement.json');
    expect(cases.length).toBeGreaterThan(5);
    for (const c of cases) {
      expect(effectiveLocalDate(c.item, c.annotation, c.dayTz)).toBe(c.localDate);
      expect(effectiveTz(c.item, c.annotation, c.dayTz)).toBe(c.tz);
    }
  });

  it('trips.json', () => {
    const { trips, cases } = JSON.parse(readFileSync(resolve(dir, 'trips.json'), 'utf8')) as {
      trips: TripRange[];
      cases: { date: string; trip: string | null }[];
    };
    expect(cases.length).toBeGreaterThan(5);
    for (const c of cases) expect(tripForDate(c.date, trips), c.date).toBe(c.trip);
  });
});
