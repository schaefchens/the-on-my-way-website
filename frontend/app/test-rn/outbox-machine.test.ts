import { describe, expect, it } from '@jest/globals';
import type { AppEntry } from '@omw/contracts/app';
import type { UploadStatus } from '../modules/omw-native';
import {
  deriveStatus,
  MAX_PREPARE_ATTEMPTS,
  newDraft,
  type OutboxManifest,
  OutboxTransitionError,
  originalLine,
  pillSummary,
  type StatusContext,
  transition,
  wireIdOf,
} from '../src/core/outbox-machine';
import { HOTSPOT, ID, LATER, MOBILE, NOW, OFFLINE_NET, PHOTO_FILES, ROAMING, SETTINGS, status, WIFI } from './fixtures';

const photoDraft = (): OutboxManifest =>
  newDraft({
    entryId: ID,
    kind: 'photo',
    origin: 'camera',
    now: NOW,
    source: { name: 'source.jpg', mimetype: 'image/jpeg', bytes: 4_000_000, width: 4000, height: 3000 },
  });

const ENTRY = { entryId: ID } as unknown as AppEntry;
const FRESH = '01JD4Z9A0B1C2D3E4F5G6H7J8K';

function run(m: OutboxManifest, ...events: Parameters<typeof transition>[1][]): OutboxManifest {
  return events.reduce((acc, e) => transition(acc, e, LATER).next, m);
}

const shared = () => run(photoDraft(), { type: 'share', at: NOW, tz: 'Asia/Ho_Chi_Minh' });
const prepared = () => run(shared(), { type: 'prepared', files: PHOTO_FILES, entry: ENTRY });
const enqueued = () => run(prepared(), { type: 'enqueued' });

const ctx = (patch: Partial<StatusContext> = {}): StatusContext => ({
  settings: SETTINGS,
  network: WIFI,
  paired: true,
  archiveOnly: true,
  now: LATER,
  ...patch,
});

describe('outbox transitions', () => {
  it('walks the happy path and asks for the right effects', () => {
    const d = photoDraft();
    expect(d.phase).toBe('draft');

    const s = transition(
      d,
      { type: 'share', at: NOW, tz: 'Asia/Ho_Chi_Minh', choice: { visibility: 'pending' } },
      LATER,
    );
    expect(s.next.phase).toBe('preparing');
    expect(s.next.sharedAt).toBe(NOW);
    expect(s.next.choice.visibility).toBe('pending');
    expect(s.effects).toEqual([{ type: 'prepare' }]);
    expect(s.next.rev).toBe(d.rev + 1);

    const p = transition(s.next, { type: 'prepared', files: PHOTO_FILES, entry: ENTRY }, LATER);
    expect(p.next.phase).toBe('prepared');
    expect(p.effects).toEqual([{ type: 'enqueue' }]);

    const q = transition(p.next, { type: 'enqueued' }, LATER);
    expect(q.next.phase).toBe('enqueued');

    const up = transition(q.next, { type: 'upload', status: status({ state: 'uploaded', sentBytes: 960_000 }) }, LATER);
    expect(up.next.phase).toBe('uploaded');

    const home = transition(
      up.next,
      {
        type: 'server',
        server: { state: 'archived', heldBack: false, publish: null, backendLastSeenAt: NOW, checkedAt: LATER },
      },
      LATER,
    );
    expect(home.next.phase).toBe('archived');
  });

  it('refuses events that do not fit the phase', () => {
    expect(() => transition(photoDraft(), { type: 'enqueued' }, LATER)).toThrow(OutboxTransitionError);
    expect(() => transition(enqueued(), { type: 'edit', patch: { caption: 'late' } }, LATER)).toThrow(
      OutboxTransitionError,
    );
    expect(() => transition(enqueued(), { type: 'share', at: NOW, tz: 'UTC' }, LATER)).toThrow(OutboxTransitionError);
  });

  it('cannot share a media draft without its source, nor a text draft without text', () => {
    const noSource = newDraft({ entryId: ID, kind: 'photo', origin: 'gallery', now: NOW });
    expect(() => transition(noSource, { type: 'share', at: NOW, tz: 'UTC' }, LATER)).toThrow(OutboxTransitionError);
    const noText = newDraft({ entryId: ID, kind: 'text', origin: 'text', now: NOW });
    expect(() => transition(noText, { type: 'share', at: NOW, tz: 'UTC' }, LATER)).toThrow(OutboxTransitionError);
  });

  it('edits only drafts and merges the publish choice', () => {
    const d = run(photoDraft(), { type: 'edit', patch: { caption: 'Lanterns', choice: { mode: 'manual' } } });
    const e = run(d, { type: 'edit', patch: { choice: { visibility: 'hidden' } } });
    expect(e.caption).toBe('Lanterns');
    expect(e.choice).toEqual({ mode: 'manual', visibility: 'hidden' });
  });

  it('keeps preparing on transient errors and gives up after the attempt limit', () => {
    let m = shared();
    const error = { code: 'io', message: 'disk busy', permanent: false };
    for (let i = 1; i < MAX_PREPARE_ATTEMPTS; i++) {
      m = run(m, { type: 'prepare_failed', error });
      expect(m.phase).toBe('preparing');
      expect(m.attempts).toBe(i);
    }
    m = run(m, { type: 'prepare_failed', error });
    expect(m.phase).toBe('failed');
  });

  it('turns a permanent prepare error into "Needs you" at once, and retry prepares again', () => {
    const failed = run(shared(), {
      type: 'prepare_failed',
      error: { code: 'unreadable', message: 'broken file', permanent: true },
    });
    expect(failed.phase).toBe('failed');
    const r = transition(failed, { type: 'retry', freshId: FRESH }, LATER);
    expect(r.next.phase).toBe('preparing');
    expect(r.effects).toEqual([{ type: 'prepare' }]);
    // Nothing reached the uploader under this id: it stays.
    expect(wireIdOf(r.next)).toBe(ID);
  });

  it.each(['validation_failed', 'forbidden', 'entry_conflict', 'gone', 'sha256_mismatch'])(
    'retries a failed upload (%s) under a new wire id and withdraws the old one',
    (code) => {
      const failed = run(enqueued(), {
        type: 'upload',
        status: status({ state: 'failed', error: { code, message: 'x', permanent: true } }),
      });
      expect(failed.phase).toBe('failed');
      const r = transition(failed, { type: 'retry', freshId: FRESH }, LATER);
      expect(r.next.phase).toBe('prepared');
      expect(r.next.entryId).toBe(ID); // the folder stays
      expect(wireIdOf(r.next)).toBe(FRESH);
      expect(r.next.entry?.entryId).toBe(FRESH);
      expect(r.next.withdrawals).toEqual([ID]);
      expect(r.next.upload).toBeNull();
      expect(r.effects).toEqual([{ type: 'withdraw', ids: [ID] }, { type: 'enqueue' }]);
      // Once the uploader has the withdrawal, the manifest forgets it.
      const handed = run(r.next, { type: 'withdrawals_handed', ids: [ID] });
      expect(handed.withdrawals).toBeUndefined();
      // Statuses come for the new id now; the old id's are not this entry's any more.
      expect(() => transition(handed, { type: 'upload', status: status() }, LATER)).toThrow(OutboxTransitionError);
      const home = run(
        handed,
        { type: 'enqueued' },
        { type: 'upload', status: status({ entryId: FRESH, state: 'uploaded' }) },
      );
      expect(home.phase).toBe('uploaded');
    },
  );

  it('prepares again under a new wire id when the prepared file is gone from the phone', () => {
    const failed = run(enqueued(), {
      type: 'upload',
      status: status({ state: 'failed', error: { code: 'file_missing', message: 'x', permanent: true } }),
    });
    const r = transition(failed, { type: 'retry', freshId: FRESH }, LATER);
    expect(r.next.phase).toBe('preparing');
    expect(r.next.entry).toBeUndefined();
    expect(r.next.files).toEqual([]);
    expect(wireIdOf(r.next)).toBe(FRESH);
    expect(r.effects).toEqual([{ type: 'withdraw', ids: [ID] }, { type: 'prepare' }]);
  });

  it('a server rejection stays “Needs you” when the uploader replays the job’s “uploaded”', () => {
    const uploaded = run(enqueued(), { type: 'upload', status: status({ state: 'uploaded' }) });
    const base = { heldBack: false, publish: null, backendLastSeenAt: null, checkedAt: LATER };
    const rejected = run(uploaded, { type: 'server', server: { ...base, state: 'rejected' } });
    expect(rejected.phase).toBe('failed');
    // Every return to the app replays the native statuses (Uploader.status()).
    expect(() => transition(rejected, { type: 'upload', status: status({ state: 'uploaded' }) }, LATER)).toThrow(
      OutboxTransitionError,
    );
    expect(deriveStatus(rejected, ctx())).toEqual({ status: 'needs_you' });
  });

  it('a server rejection is tried again under a new wire id too', () => {
    const uploaded = run(enqueued(), { type: 'upload', status: status({ state: 'uploaded' }) });
    const base = { heldBack: false, publish: null, backendLastSeenAt: null, checkedAt: LATER };
    const rejected = run(uploaded, { type: 'server', server: { ...base, state: 'rejected' } });
    const r = transition(rejected, { type: 'retry', freshId: FRESH }, LATER);
    expect(r.next.phase).toBe('prepared');
    expect(r.next.server).toBeNull();
    expect(r.effects).toEqual([{ type: 'withdraw', ids: [ID] }, { type: 'enqueue' }]);
  });

  it('an unpaired or refused token only waits: the uploader goes on by itself after pairing', () => {
    // What omw-native reports for a job while no token is in the vault (or the token was refused).
    const notPaired = status({
      state: 'failed',
      blockedBy: 'unauthorized',
      error: { code: 'not_paired', message: 'The phone is not paired.', permanent: true },
    });
    const waiting = run(enqueued(), { type: 'upload', status: notPaired });
    expect(waiting.phase).toBe('enqueued');
    expect(deriveStatus(waiting, ctx({ paired: false }))).toMatchObject({
      status: 'waiting_network',
      reason: 'not_paired',
    });
    // Paired, but the API refused the token: she needs to connect again (not "Try again").
    expect(deriveStatus(waiting, ctx({ paired: true }))).toEqual({ status: 'needs_you', reason: 'unauthorized' });
    // After pairing the uploader reports progress again.
    expect(run(waiting, { type: 'upload', status: status({ state: 'uploading', sentBytes: 5 }) }).phase).toBe(
      'enqueued',
    );
  });

  it('brings back an entry an older build marked as failed once the uploader resumes it', () => {
    const notPaired = status({
      state: 'failed',
      blockedBy: 'unauthorized',
      error: { code: 'not_paired', message: 'x', permanent: true },
    });
    const failed = { ...enqueued(), phase: 'failed' as const, upload: notPaired };
    expect(run(failed, { type: 'upload', status: status({ state: 'queued' }) }).phase).toBe('enqueued');
    expect(run(failed, { type: 'upload', status: status({ state: 'uploaded' }) }).phase).toBe('uploaded');
    // A real permanent failure stays failed.
    const terminal = status({ state: 'failed', error: { code: 'validation_failed', message: 'x', permanent: true } });
    expect(() => transition({ ...failed, upload: terminal }, { type: 'upload', status: terminal }, LATER)).toThrow(
      OutboxTransitionError,
    );
  });

  it('undo returns to a draft under a new wire id and withdraws the old one durably', () => {
    for (const m of [
      prepared(),
      enqueued(),
      run(enqueued(), { type: 'upload', status: status({ state: 'uploading' }) }),
    ]) {
      const u = transition(m, { type: 'undo', freshId: FRESH }, LATER);
      expect(u.next.phase).toBe('draft');
      expect(u.next.files).toEqual([]);
      expect(u.next.sharedAt).toBeUndefined();
      expect(u.next.entry).toBeUndefined();
      expect(u.next.entryId).toBe(ID);
      expect(wireIdOf(u.next)).toBe(FRESH);
      // The uploader decides whether the API may have it (then it owes a DELETE) and stops the job.
      expect(u.next.withdrawals).toEqual([ID]);
      expect(u.effects).toEqual([{ type: 'withdraw', ids: [ID] }]);
      // The draft keeps what she made.
      expect(u.next.source?.name).toBe('source.jpg');
    }
  });

  it('undo while preparing needs no withdrawal (nothing went to the uploader), still a new wire id', () => {
    const u = transition(shared(), { type: 'undo', freshId: FRESH }, LATER);
    expect(u.next.phase).toBe('draft');
    expect(wireIdOf(u.next)).toBe(FRESH);
    expect(u.next.withdrawals).toBeUndefined();
    expect(u.effects).toEqual([]);
  });

  it('refuses a prepare result for an id Undo replaced (her edit must not lose to the old export)', () => {
    const again = run(shared(), { type: 'undo', freshId: FRESH }, { type: 'share', at: LATER, tz: 'UTC' });
    expect(() => transition(again, { type: 'prepared', files: PHOTO_FILES, entry: ENTRY }, LATER)).toThrow(
      OutboxTransitionError,
    );
    expect(() =>
      transition(
        again,
        { type: 'prepare_failed', error: { code: 'io', message: 'x', permanent: true }, wireId: ID },
        LATER,
      ),
    ).toThrow(OutboxTransitionError);
    const fresh = { ...ENTRY, entryId: FRESH } as AppEntry;
    expect(run(again, { type: 'prepared', files: PHOTO_FILES, entry: fresh }).phase).toBe('prepared');
  });

  it('undo after the upload (even once archived) also brings back the draft and withdraws it', () => {
    const uploaded = run(enqueued(), { type: 'upload', status: status({ state: 'uploaded' }) });
    const base = { heldBack: false, publish: null, backendLastSeenAt: null, checkedAt: LATER };
    const archived = run(uploaded, { type: 'server', server: { ...base, state: 'archived' } });
    for (const m of [uploaded, archived]) {
      const u = transition(m, { type: 'undo', freshId: FRESH }, LATER);
      expect(u.next.phase).toBe('draft');
      expect(u.next.server).toBeNull();
      expect(wireIdOf(u.next)).toBe(FRESH);
      expect(u.next.withdrawals).toEqual([ID]);
      expect(u.effects).toEqual([{ type: 'withdraw', ids: [ID] }]);
    }
    expect(() => transition(photoDraft(), { type: 'undo', freshId: FRESH }, LATER)).toThrow(OutboxTransitionError);
  });

  it('a server rejection needs her; a server withdrawal ends the entry', () => {
    const uploaded = run(enqueued(), { type: 'upload', status: status({ state: 'uploaded' }) });
    const base = { heldBack: false, publish: null, backendLastSeenAt: null, checkedAt: LATER };
    expect(run(uploaded, { type: 'server', server: { ...base, state: 'rejected' } }).phase).toBe('failed');
    expect(run(uploaded, { type: 'server', server: { ...base, state: 'withdrawn' } }).phase).toBe('withdrawn');
    expect(run(uploaded, { type: 'server', server: { ...base, state: 'fetching' } }).phase).toBe('uploaded');
  });

  it('discards drafts, finished entries and ones that need her; withdrawals are handed over first', () => {
    expect(transition(photoDraft(), { type: 'discard' }, LATER).effects).toEqual([{ type: 'delete_folder' }]);
    expect(() => transition(enqueued(), { type: 'discard' }, LATER)).toThrow(OutboxTransitionError);
    // A moment that needs her may be on the API: it is withdrawn, then its folder goes.
    const failed = run(enqueued(), {
      type: 'upload',
      status: status({ state: 'failed', error: { code: 'forbidden', message: 'x', permanent: true } }),
    });
    expect(transition(failed, { type: 'discard' }, LATER).effects).toEqual([
      { type: 'withdraw', ids: [ID] },
      { type: 'delete_folder' },
    ]);
    // A draft after Undo whose withdrawal the uploader does not have yet.
    const undone = run(enqueued(), { type: 'undo', freshId: FRESH });
    expect(transition(undone, { type: 'discard' }, LATER).effects).toEqual([
      { type: 'withdraw', ids: [ID] },
      { type: 'delete_folder' },
    ]);
  });

  it('ignores status events of other entries', () => {
    expect(() =>
      transition(enqueued(), { type: 'upload', status: status({ entryId: '01JD4Z8W3K5V7X9Y1Z3B5C7D9G' }) }, LATER),
    ).toThrow(OutboxTransitionError);
  });
});

describe('status vocabulary', () => {
  it('shows nothing for drafts and withdrawn entries', () => {
    expect(deriveStatus(photoDraft(), ctx())).toBeNull();
  });

  it('says "Preparing…" while baking, with the export hint when the native step is missing', () => {
    expect(deriveStatus(shared(), ctx())).toEqual({ status: 'preparing' });
    const pending = run(shared(), {
      type: 'prepare_failed',
      error: { code: 'ERR_NOT_IMPLEMENTED', message: 'later', permanent: false },
    });
    expect(deriveStatus(pending, ctx())).toEqual({ status: 'preparing', reason: 'export_pending' });
  });

  it('maps the uploader blocks onto the vocabulary (API.md)', () => {
    const at = (blockedBy: UploadStatus['blockedBy']) =>
      deriveStatus(run(enqueued(), { type: 'upload', status: status({ state: 'waiting', blockedBy }) }), ctx())?.status;
    expect(at('manual')).toBe('ready');
    expect(at('no_network')).toBe('waiting_network');
    expect(at('not_validated')).toBe('waiting_network');
    expect(at('backoff')).toBe('waiting_network');
    expect(at('server_busy')).toBe('waiting_network');
    expect(at('inbox_full')).toBe('waiting_network');
    expect(at('wifi_only')).toBe('waiting_wifi');
    expect(at('roaming')).toBe('waiting_roaming');
    expect(at('unauthorized')).toBe('needs_you');
  });

  it('reports upload progress in whole percent', () => {
    const m = run(enqueued(), {
      type: 'upload',
      status: status({ state: 'uploading', sentBytes: 403_200, totalBytes: 960_000 }),
    });
    expect(deriveStatus(m, ctx())).toEqual({ status: 'uploading', percent: 42 });
  });

  it('predicts the state from the rules until the uploader reports', () => {
    expect(deriveStatus(prepared(), ctx())?.status).toBe('uploading');
    expect(deriveStatus(prepared(), ctx({ network: OFFLINE_NET }))?.status).toBe('waiting_network');
    expect(deriveStatus(prepared(), ctx({ network: MOBILE }))?.status).toBe('waiting_wifi');
    expect(deriveStatus(prepared(), ctx({ settings: { ...SETTINGS, mode: 'manual' } }))?.status).toBe('ready');
    // The per-entry override from the publish sheet beats the setting.
    const manual = run(photoDraft(), { type: 'edit', patch: { choice: { mode: 'manual' } } });
    const m = run(
      manual,
      { type: 'share', at: NOW, tz: 'UTC' },
      { type: 'prepared', files: PHOTO_FILES, entry: ENTRY },
    );
    expect(deriveStatus(m, ctx())?.status).toBe('ready');
  });

  it('names a metered Wi-Fi (or hotspot) instead of just "mobile data"', () => {
    expect(deriveStatus(prepared(), ctx({ network: HOTSPOT }))).toMatchObject({
      status: 'waiting_wifi',
      reason: 'metered_wifi',
    });
  });

  it('waits on roaming when mobile data is allowed but roaming is not', () => {
    const settings = { ...SETTINGS, wifiOnly: false };
    expect(deriveStatus(prepared(), ctx({ settings, network: ROAMING }))?.status).toBe('waiting_roaming');
    expect(
      deriveStatus(prepared(), ctx({ settings: { ...settings, roamingAllowedSims: ['45204'] }, network: ROAMING }))
        ?.status,
    ).toBe('uploading');
  });

  it('waits for a connection while the phone is not paired', () => {
    expect(deriveStatus(enqueued(), ctx({ paired: false }))).toMatchObject({
      status: 'waiting_network',
      reason: 'not_paired',
    });
  });

  it('says "Archived ✓" in archive-only mode, whatever she chose', () => {
    const archived = run(
      run(photoDraft(), { type: 'edit', patch: { choice: { visibility: 'hidden' } } }),
      { type: 'share', at: NOW, tz: 'UTC' },
      { type: 'prepared', files: PHOTO_FILES, entry: ENTRY },
      { type: 'enqueued' },
      { type: 'upload', status: status({ state: 'uploaded' }) },
      {
        type: 'server',
        server: { state: 'archived', heldBack: false, publish: null, backendLastSeenAt: NOW, checkedAt: LATER },
      },
    );
    expect(deriveStatus(archived, ctx())?.status).toBe('archived');
    expect(deriveStatus(archived, ctx({ archiveOnly: false }))?.status).toBe('hidden');
  });

  it('says "Live ✓" once the site has it (after the archive-only phase)', () => {
    const live = run(
      enqueued(),
      { type: 'upload', status: status({ state: 'uploaded' }) },
      {
        type: 'server',
        server: {
          state: 'archived',
          heldBack: false,
          publish: { visibility: 'public', state: 'live', publishAt: null },
          backendLastSeenAt: NOW,
          checkedAt: LATER,
        },
      },
    );
    expect(deriveStatus(live, ctx({ archiveOnly: false }))?.status).toBe('live');
  });

  it('mentions a sleeping home computer after half an hour', () => {
    const uploaded = run(
      enqueued(),
      { type: 'upload', status: status({ state: 'uploaded' }) },
      {
        type: 'server',
        server: {
          state: 'uploaded',
          heldBack: false,
          publish: null,
          backendLastSeenAt: '2026-11-20T08:00:00.000Z',
          checkedAt: LATER,
        },
      },
    );
    expect(deriveStatus(uploaded, ctx())).toEqual({ status: 'uploaded', reason: 'home_offline' });
  });
});

describe('the archive original (Q2 c)', () => {
  const withOriginal = (original: UploadStatus['original'], state: UploadStatus['state'] = 'uploaded') =>
    run(enqueued(), { type: 'upload', status: status({ state, original }) });
  const o = (patch: Partial<NonNullable<UploadStatus['original']>>) => ({
    state: 'queued' as const,
    blockedBy: null,
    sentBytes: 0,
    totalBytes: 4_000_000,
    error: null,
    ...patch,
  });

  it('has its own line once the artifact is uploaded, until the original is home', () => {
    expect(originalLine(withOriginal(o({ state: 'queued' }), 'uploading'))).toBeNull();
    expect(originalLine(withOriginal(o({ state: 'waiting', blockedBy: 'wifi_only' })))).toEqual({
      state: 'waiting_wifi',
      percent: 0,
      bytesLeft: 4_000_000,
    });
    expect(originalLine(withOriginal(o({ state: 'uploading', sentBytes: 1_000_000 })))).toMatchObject({
      state: 'uploading',
      percent: 25,
    });
    expect(originalLine(withOriginal(o({ state: 'uploaded', sentBytes: 4_000_000 })))).toBeNull();
    expect(originalLine(withOriginal(null))).toBeNull();
  });
});

describe('sync pill', () => {
  it('summarises the queue in one calm word', () => {
    expect(pillSummary([])).toEqual({ kind: 'all_safe' });
    expect(pillSummary([{ status: 'archived' }, null])).toEqual({ kind: 'all_safe' });
    expect(pillSummary([{ status: 'ready' }, { status: 'ready' }])).toEqual({ kind: 'ready', count: 2 });
    expect(pillSummary([{ status: 'waiting_wifi' }, { status: 'waiting_roaming' }])).toEqual({
      kind: 'waiting_wifi',
      count: 2,
    });
    expect(pillSummary([{ status: 'uploading', percent: 4 }, { status: 'ready' }])).toEqual({
      kind: 'on_the_way',
      count: 2,
    });
    expect(pillSummary([{ status: 'needs_you' }, { status: 'ready' }])).toEqual({ kind: 'needs_you', count: 1 });
  });
});
