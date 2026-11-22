/**
 * "Share, spot a typo, Undo within 8 s, fix it, Share again" (review R2), through the state machine
 * and the entry builder as the outbox runs them: the second share must reach the API under a new
 * id (the API keeps an id's first content for good, also once withdrawn), the first id must be
 * withdrawn durably, and the uploader's statuses of the old id must not touch the moment any more.
 * The API's side of the same flow: api/tests/Http/AppRecoveryTest.php; the uploader's:
 * UploadRecoveryTest.undoThenShareAgainWithdrawsTheOldIdAndUploadsTheNewOne.
 */
import { describe, expect, it } from '@jest/globals';
import { AppEntry } from '@omw/contracts/app';
import { buildAppEntry } from '../src/core/entry';
import { makeInstallId } from '../src/core/install-id';
import {
  newDraft,
  type OutboxEffect,
  type OutboxEvent,
  type OutboxManifest,
  transition,
  wireIdOf,
} from '../src/core/outbox-machine';
import { monotonicUlid } from '../src/core/ulid';
import { ID, LATER, NOW, status } from './fixtures';

const CLIENT = { app: '0.5.0-test', os: '16' };
const TEXT = { body: 'Arived in Hội An!', bgArgb: 0xff7e57c2, textArgb: 0xffffffff, font: 'SYSTEM' as const };

let seed = 1;
const nextUlid = monotonicUlid((n) => Uint8Array.from({ length: n }, () => (seed = (seed * 31 + 7) % 256)));

/** Applies events the way OutboxProvider.apply() does and collects the effects. */
function drive(m: OutboxManifest, events: OutboxEvent[], at = LATER): { m: OutboxManifest; effects: OutboxEffect[] } {
  const effects: OutboxEffect[] = [];
  let cur = m;
  for (const e of events) {
    const r = transition(cur, e, at);
    cur = r.next;
    effects.push(...r.effects);
  }
  return { m: cur, effects };
}

/** What the 'prepare' effect produces for a text status (core/entry, as prepare.ts calls it). */
function prepared(m: OutboxManifest): OutboxEvent {
  const built = buildAppEntry(m, { files: [] }, CLIENT);
  if (!built.ok) throw new Error(JSON.stringify(built.problems));
  return { type: 'prepared', files: [], entry: built.entry };
}

describe('Undo, edit and Share again', () => {
  it('sends the edited moment under a new id and withdraws the first one', () => {
    const draft = newDraft({ entryId: ID, kind: 'text', origin: 'text', now: NOW, text: TEXT });
    // Share: prepared, handed to the uploader and already uploaded (a text status takes < 1 s).
    let m = drive(draft, [{ type: 'share', at: NOW, tz: 'Asia/Ho_Chi_Minh' }]).m;
    const first = prepared(m) as Extract<OutboxEvent, { type: 'prepared' }>;
    m = drive(m, [first, { type: 'enqueued' }, { type: 'upload', status: status({ state: 'uploaded' }) }]).m;
    expect(m.phase).toBe('uploaded');
    expect(AppEntry.parse(first.entry).entryId).toBe(ID);

    // Undo within 8 s: back to the draft under a new wire id; the first id is withdrawn.
    const fresh = nextUlid(Date.parse(LATER));
    const undo = drive(m, [{ type: 'undo', freshId: fresh }]);
    expect(undo.m.phase).toBe('draft');
    expect(undo.effects).toEqual([{ type: 'withdraw', ids: [ID] }]);

    // She fixes the typo and shares again, 20 s later.
    const again = '2026-11-20T10:00:25.000Z';
    let second = drive(undo.m, [
      { type: 'edit', patch: { text: { ...TEXT, body: 'Arrived in Hội An!' } } },
      { type: 'share', at: again, tz: 'Asia/Ho_Chi_Minh' },
    ]).m;
    const secondPrepared = prepared(second) as Extract<OutboxEvent, { type: 'prepared' }>;
    second = drive(second, [secondPrepared]).m;
    const secondEntry = secondPrepared.entry;
    expect(secondEntry.entryId).toBe(fresh);
    expect(secondEntry.entryId).not.toBe(first.entry.entryId);
    expect(secondEntry.occurredAt).toBe(again);
    expect(secondEntry.text?.body).toBe('Arrived in Hội An!');
    // The folder (and every screen's key) stays the same.
    expect(second.entryId).toBe(ID);
    expect(wireIdOf(second)).toBe(fresh);

    // Until the uploader confirmed it has the withdrawal, the manifest keeps it (durable).
    expect(second.withdrawals).toEqual([ID]);
    second = drive(second, [{ type: 'withdrawals_handed', ids: [ID] }]).m;
    expect(second.withdrawals).toBeUndefined();

    // The old id's statuses (its job was cancelled) never move the new moment.
    expect(() => transition(second, { type: 'upload', status: status({ state: 'cancelled' }) }, LATER)).toThrow();
    const home = drive(second, [
      { type: 'enqueued' },
      { type: 'upload', status: status({ entryId: fresh, state: 'uploaded' }) },
    ]).m;
    expect(home.phase).toBe('uploaded');
  });

  it('a second Undo of the shared-again moment withdraws both ids', () => {
    const draft = newDraft({ entryId: ID, kind: 'text', origin: 'text', now: NOW, text: TEXT });
    const f1 = nextUlid(Date.parse(LATER));
    const f2 = nextUlid(Date.parse(LATER));
    let m = drive(draft, [{ type: 'share', at: NOW, tz: 'UTC' }]).m;
    m = drive(m, [prepared(m), { type: 'enqueued' }, { type: 'undo', freshId: f1 }]).m;
    m = drive(m, [{ type: 'share', at: LATER, tz: 'UTC' }]).m;
    const r = drive(m, [prepared(m), { type: 'enqueued' }, { type: 'undo', freshId: f2 }]);
    expect(r.effects.at(-1)).toEqual({ type: 'withdraw', ids: [ID, f1] });
    expect(wireIdOf(r.m)).toBe(f2);
  });
});

describe('install id', () => {
  it('is 22 base64url characters from 16 random bytes', () => {
    const id = makeInstallId((n) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256));
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(makeInstallId((n) => new Uint8Array(n))).toBe('A'.repeat(22));
    expect(makeInstallId((n) => new Uint8Array(n).fill(255))).toBe(`${'_'.repeat(21)}w`);
    expect(() => makeInstallId(() => new Uint8Array(4))).toThrow(RangeError);
  });
});
