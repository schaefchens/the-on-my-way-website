import { Heartbeat } from '@omw/contracts/api';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { Store } from '../../src/store/index.js';
import {
  createSync,
  maskPhoneNumber,
  type OwnerChange,
  readPublishState,
  type Sync,
  type SyncOptions,
  writeGenerateSnapshot,
} from '../../src/sync/index.js';
import { makeTempDir } from '../helpers.js';
import { deleteItem, type FakeApi, postItem, resetSeq, settingItem, startFakeApi, TOKEN } from './fake-api.js';
import { insertPhotoCapture, insertTextCapture, silentLog, testConfig } from './helpers.js';

// Backend test ports 19200-19219 (sync tests use 19200).
const PORT = 19200;
const FAST: SyncOptions = {
  backoffBaseMs: 1_000,
  backoffMaxMs: 60_000,
  permanentMs: 3_600_000,
  orderingMs: 30_000,
  requestTimeoutMs: 2_000,
  authPauseMs: 60_000,
};

let api: FakeApi;
let tmp: { dir: string; cleanup: () => void };
let config: Config;
let store: Store;
let sync: Sync;
let changes: OwnerChange[];

beforeAll(async () => {
  api = await startFakeApi(PORT);
});
afterAll(async () => {
  await api.close();
});

beforeEach(() => {
  tmp = makeTempDir('sync-');
  config = testConfig(tmp.dir, { API_BASE_URL: api.url, API_TOKEN: TOKEN });
  store = Store.memory();
  api.feed = [];
  api.feedId = 'feed_aaaaaaaa';
  api.captures.clear();
  api.previews = [];
  api.revokes = [];
  api.heartbeats = [];
  api.published = [];
  api.log = [];
  api.failures.clear();
  api.invalidBodies = [];
  resetSeq();
  changes = [];
  sync = createSync({ config, log: silentLog(), store, options: FAST, random: () => 0.5 });
  sync.onOwnerChange((c) => changes.push(c));
});

afterEach(async () => {
  await sync.stop();
  store.close();
  tmp.cleanup();
});

describe('change feed pull', () => {
  it('pages through the feed and reports the union of changed dates once', async () => {
    for (let i = 1; i <= 450; i++)
      api.feed.push(
        postItem(`p_post${String(i).padStart(4, '0')}`, `2026-11-${String((i % 20) + 1).padStart(2, '0')}`),
      );
    const applied = await sync.pullNow();
    expect(applied).toBe(450);
    expect(api.log.filter((l) => l.startsWith('GET /api/v1/backend/changes'))).toEqual([
      'GET /api/v1/backend/changes?after=0&limit=200',
      'GET /api/v1/backend/changes?after=200&limit=200',
      'GET /api/v1/backend/changes?after=400&limit=200',
    ]);
    expect(store.syncState.feedCursor()).toBe(450);
    expect(store.syncState.feedId()).toBe('feed_aaaaaaaa');
    expect(store.owner.listPosts()).toHaveLength(450);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.localDates).toHaveLength(20);
    expect(changes[0]?.full).toBe(false);
    expect(store.syncState.lastPullAt()).not.toBeNull();

    // Nothing new: one request, no change event.
    expect(await sync.pullNow()).toBe(0);
    expect(changes).toHaveLength(1);
  });

  it('marks settings changes as full and applies deletes', async () => {
    api.feed.push(postItem('p_one1', '2026-11-18'), settingItem('site.title', 'Unterwegs'));
    await sync.pullNow();
    expect(store.owner.settings()['site.title']).toBe('Unterwegs');
    expect(changes.at(-1)).toMatchObject({ full: true, localDates: ['2026-11-18'] });
    api.feed.push(deleteItem('post', 'p_one1'));
    await sync.pullNow();
    expect(store.owner.getPost('p_one1')).toBeUndefined();
    expect(changes.at(-1)).toMatchObject({ full: false, localDates: ['2026-11-18'] });
  });

  it('quarantines invalid items and ignores unknown ones without blocking the feed', async () => {
    api.feed.push(
      postItem('p_good1', '2026-11-18'),
      { seq: 2, entity: 'post', key: 'p_bad1', op: 'upsert', data: { nonsense: true } },
      { seq: 3, entity: 'hearts', key: 'x', op: 'upsert', data: {} },
      settingItem('site.title', '', 4), // invalid value (min 1)
      postItem('p_good2', '2026-11-19', 5),
    );
    resetSeq(5);
    const applied = await sync.pullNow();
    expect(applied).toBe(2);
    expect(store.syncState.feedCursor()).toBe(5);
    expect(store.owner.quarantineCount()).toBe(2);
    expect(
      store.owner
        .quarantined()
        .map((q) => q.key)
        .sort(),
    ).toEqual(['p_bad1', 'site.title']);
    expect(sync.status().quarantined).toBe(2);
    const hb = await sync.buildHeartbeat();
    expect(hb.sync).toMatchObject({ feedId: 'feed_aaaaaaaa', feedSeq: 5, quarantined: 2 });
  });

  it('rebuilds the mirror on 409 feed_reset and re-pushes every capture', async () => {
    api.feed.push(postItem('p_keep', '2026-11-18'), postItem('p_gone', '2026-11-18'));
    await sync.pullNow();
    expect(store.owner.listPosts()).toHaveLength(2);
    await insertTextCapture(store, 'T1', '2026-11-18T08:00:00.000Z');

    // The API was restored from an older backup: its feed is shorter than our cursor.
    resetSeq();
    api.feed = [postItem('p_keep', '2026-11-18')];
    store.syncState.setFeedCursor(50);
    await sync.pullNow();
    expect(api.log.some((l) => l === 'GET /api/v1/backend/changes?after=50&limit=200')).toBe(true);
    expect(store.syncState.feedCursor()).toBe(1);
    expect(store.syncState.rebuildPending()).toBe(false);
    expect(store.owner.listPosts().map((p) => p.publicId)).toEqual(['p_keep']);
    expect(changes.at(-1)?.full).toBe(true);
    expect(store.outbox.pending('capture', 'wa:T1')).toBeDefined();
  });

  it('rebuilds when the feed id changes', async () => {
    api.feed.push(postItem('p_aaaa', '2026-11-18'));
    await sync.pullNow();
    api.feedId = 'feed_bbbbbbbb';
    resetSeq();
    api.feed = [postItem('p_bbbb', '2026-11-19')];
    await sync.pullNow();
    expect(store.syncState.feedId()).toBe('feed_bbbbbbbb');
    expect(store.owner.listPosts().map((p) => p.publicId)).toEqual(['p_bbbb']);
    expect(changes.at(-1)?.full).toBe(true);
  });

  it('keeps the cursor when the API is down and pauses on 401', async () => {
    api.feed.push(postItem('p_aaaa', '2026-11-18'));
    api.fail('GET changes', { status: 503 });
    await expect(sync.pullNow()).rejects.toThrow(/503/);
    expect(store.syncState.feedCursor()).toBe(0);
    expect(sync.status().lastPullError).toMatch(/503/);
    await sync.pullNow();
    expect(store.syncState.feedCursor()).toBe(1);
    expect(sync.status().lastPullError).toBeNull();

    api.fail('GET changes', { status: 401, code: 'unauthorized' });
    await expect(sync.pullNow()).rejects.toThrow(/401/);
    expect(sync.status().authPausedUntil).not.toBeNull();
    await expect(sync.pullNow()).rejects.toThrow(/paused/);
    expect(store.events.recent({ type: 'sync.auth_failed' })).toHaveLength(1);
  });

  it('coalesces concurrent pulls', async () => {
    api.feed.push(postItem('p_aaaa', '2026-11-18'));
    const [a, b, c] = await Promise.all([sync.pullNow(), sync.pullNow(), sync.pullNow()]);
    expect(a + b + c).toBe(1);
    expect(api.log.filter((l) => l.startsWith('GET')).length).toBeLessThanOrEqual(2);
  });
});

describe('outbox push', () => {
  it('sends capture mirror, preview and revoke, retrying the preview until the capture is mirrored', async () => {
    const photo = await insertPhotoCapture(store, config.dirs.media, 'ABC123', '2026-11-18T09:00:00.000Z');
    // Queue the preview BEFORE the capture to force a 404 capture_not_mirrored first.
    store.outbox.enqueue('preview', `${photo.sourceKey}#preview`, {
      sourceKey: photo.sourceKey,
      role: 'preview',
      relPath: photo.variants?.[0]?.relPath,
      contentType: 'image/webp',
    });
    store.captures.setRevoked(photo.sourceKey, '2026-11-18T12:00:00.000Z');
    sync.capturesChanged([photo.sourceKey]);

    let r = await sync.flushNow();
    expect(r).toMatchObject({ sent: 2, failed: 1 });
    expect(api.captures.get('wa:ABC123')).toMatchObject({
      sourceKey: 'wa:ABC123',
      kind: 'photo',
      mediaState: 'ok',
      revokedAt: '2026-11-18T12:00:00.000Z',
      media: { w: 640, h: 480, color: '#aabbcc' },
    });
    expect(api.revokes).toEqual([{ sourceKey: 'wa:ABC123', at: '2026-11-18T12:00:00.000Z' }]);
    const waiting = store.outbox.pending('preview', 'wa:ABC123#preview');
    expect(waiting?.attempts).toBe(1);
    expect(waiting?.lastError).toMatch(/capture_not_mirrored/);
    // ordering delay: 30 s * jitter(1.0)
    expect(Date.parse(waiting?.nextAttemptAt ?? '') - Date.now()).toBeGreaterThan(25_000);

    store.db
      .prepare('UPDATE sync_outbox SET next_attempt_at = ? WHERE done_at IS NULL')
      .run('2000-01-01T00:00:00.000Z');
    r = await sync.flushNow();
    expect(r.sent).toBe(1);
    expect(api.previews).toEqual([
      { sourceKey: 'wa:ABC123', role: 'preview', filename: 'preview.webp', type: 'image/webp', size: 2048 },
    ]);
    expect(store.outbox.stats().pending).toBe(0);
  });

  it('always sends the current capture row, whatever payload was queued', async () => {
    const row = await insertTextCapture(store, 'T2', '2026-11-18T08:00:00.000Z');
    store.outbox.enqueue('capture', row.sourceKey, { stale: true });
    await sync.flushNow();
    expect(api.captures.get('wa:T2')).toMatchObject({ kind: 'text', text: { body: 'hello T2', font: 'SYSTEM' } });
  });

  it('backs off transient errors with jitter and honours Retry-After', async () => {
    let offset = 0; // the sync's clock (push pause); the outbox uses the store's clock
    const s = createSync({
      config,
      log: silentLog(),
      store,
      options: FAST,
      random: () => 0.5,
      now: () => new Date(Date.now() + offset),
    });
    const row = await insertTextCapture(store, 'T3', '2026-11-18T08:00:00.000Z');
    s.capturesChanged([row.sourceKey]);
    api.fail('PUT capture', { status: 503 });
    let r = await s.flushNow();
    expect(r.failed).toBe(1);
    let item = store.outbox.pending('capture', 'wa:T3');
    // attempt 1: base 1 s * 2^0 * jitter 1.0
    expect(Date.parse(item?.nextAttemptAt ?? '') - Date.now()).toBeGreaterThan(500);
    expect(Date.parse(item?.nextAttemptAt ?? '') - Date.now()).toBeLessThanOrEqual(1_000);

    offset += 2_000; // past the push pause of the 503
    store.db.prepare('UPDATE sync_outbox SET next_attempt_at = ?').run('2000-01-01T00:00:00.000Z');
    api.fail('PUT capture', { status: 429, retryAfter: '120' });
    r = await s.flushNow();
    item = store.outbox.pending('capture', 'wa:T3');
    expect(item?.attempts).toBe(2);
    expect(Date.parse(item?.nextAttemptAt ?? '') - Date.now()).toBeGreaterThan(110_000);

    // 429: every push waits for Retry-After, even items that are due.
    store.db.prepare('UPDATE sync_outbox SET next_attempt_at = ?').run('2000-01-01T00:00:00.000Z');
    expect(await s.flushNow()).toEqual({ sent: 0, failed: 0, dropped: 0 });
    offset += 121_000;
    r = await s.flushNow();
    expect(r.sent).toBe(1);
    expect(api.captures.has('wa:T3')).toBe(true);
    await s.stop();
  });

  it('catches up at once when the API answers again after an outage, not after the backoff', async () => {
    const row = await insertTextCapture(store, 'T8', '2026-11-18T08:00:00.000Z');
    const stuck = await insertTextCapture(store, 'T9', '2026-11-18T08:01:00.000Z');
    // T9 failed permanently (422) BEFORE the outage: an outage end must not touch its slow retry.
    sync.capturesChanged([stuck.sourceKey]);
    api.fail('PUT capture', { status: 422, code: 'validation_failed' });
    await sync.flushNow();
    const slow = store.outbox.pending('capture', 'wa:T9')?.nextAttemptAt;
    await new Promise((r) => setTimeout(r, 5)); // updated_at of later failures is strictly newer

    // Outage: the API (or the proxy in front of it) answers 503 for the push and the heartbeat.
    sync.capturesChanged([row.sourceKey]);
    api.fail('PUT capture', { status: 503 });
    expect((await sync.flushNow()).failed).toBe(1);
    api.fail('POST heartbeat', { status: 503 });
    expect(await sync.heartbeatNow()).toBe(false);
    // Many failed attempts later the item would wait up to backoffMaxMs.
    store.db
      .prepare("UPDATE sync_outbox SET next_attempt_at = ? WHERE key = 'wa:T8'")
      .run(new Date(Date.now() + 10 * 60_000).toISOString());
    expect(await sync.flushNow()).toEqual({ sent: 0, failed: 0, dropped: 0 });

    // The next heartbeat gets through: everything that failed during the outage is due now.
    expect(await sync.heartbeatNow()).toBe(true);
    expect(Date.parse(store.outbox.pending('capture', 'wa:T8')?.nextAttemptAt ?? '')).toBeLessThanOrEqual(Date.now());
    expect(store.outbox.pending('capture', 'wa:T9')?.nextAttemptAt).toBe(slow);
    const r = await sync.flushNow();
    expect(r.sent).toBe(1);
    expect(api.captures.has('wa:T8')).toBe(true);
    expect(api.captures.has('wa:T9')).toBe(false);
  });

  it('stops the batch on 429/503 instead of sending the rest into the rate limit', async () => {
    for (const id of ['R1', 'R2', 'R3']) await insertTextCapture(store, id, '2026-11-18T08:00:00.000Z');
    sync.capturesChanged(['wa:R1', 'wa:R2', 'wa:R3']);
    api.fail('PUT capture', { status: 429, retryAfter: '30' });
    const r = await sync.flushNow();
    expect(r).toEqual({ sent: 0, failed: 1, dropped: 0 });
    expect(api.log.filter((l) => l.startsWith('PUT'))).toHaveLength(1);
    expect(store.outbox.stats().pending).toBe(3);
  });

  it('retries permanent 4xx slowly and never drops the capture', async () => {
    const row = await insertTextCapture(store, 'T4', '2026-11-18T08:00:00.000Z');
    sync.capturesChanged([row.sourceKey]);
    api.fail('PUT capture', { status: 422, code: 'validation_failed' });
    await sync.flushNow();
    const item = store.outbox.pending('capture', 'wa:T4');
    expect(item).toBeDefined();
    expect(Date.parse(item?.nextAttemptAt ?? '') - Date.now()).toBeGreaterThan(3_000_000);
    expect(sync.status().queue).toMatchObject({ pending: 1, failed: 1 });
  });

  it('drops previews whose file is gone and stops the batch when the API is unreachable', async () => {
    store.outbox.enqueue('preview', 'wa:GONE#preview', {
      sourceKey: 'wa:GONE',
      role: 'preview',
      relPath: 'media/ab/abababababababab_w640.webp',
      contentType: 'image/webp',
    });
    const r = await sync.flushNow();
    expect(r.dropped).toBe(1);
    expect(store.events.recent({ type: 'sync.outbox_dropped' })).toHaveLength(1);
  });

  it('pauses all pushes on 401', async () => {
    await insertTextCapture(store, 'T5', '2026-11-18T08:00:00.000Z');
    await insertTextCapture(store, 'T6', '2026-11-18T08:01:00.000Z');
    sync.capturesChanged(['wa:T5', 'wa:T6']);
    api.fail('PUT capture', { status: 401 });
    const r = await sync.flushNow();
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(sync.status().authPausedUntil).not.toBeNull();
    expect(await sync.flushNow()).toMatchObject({ sent: 0, failed: 0 });
  });

  it('queues the full mirror once per API base URL on start', async () => {
    await insertTextCapture(store, 'T7', '2026-11-18T08:00:00.000Z');
    await sync.start();
    expect(store.outbox.pending('capture', 'wa:T7')).toBeDefined();
    await sync.stop();
    const again = createSync({ config, log: silentLog(), store, options: FAST });
    store.db.prepare('DELETE FROM sync_outbox').run();
    await again.start();
    expect(store.outbox.pending('capture', 'wa:T7')).toBeUndefined();
    await again.stop();
  });
});

describe('heartbeat and publish reports', () => {
  it('builds a contract-valid heartbeat', async () => {
    await insertTextCapture(store, 'H1', '2026-11-18T08:00:00.000Z');
    await insertPhotoCapture(store, config.dirs.media, 'H2', '2026-11-18T09:00:00.000Z', { ready: false });
    const s = createSync({
      config,
      log: silentLog(),
      store,
      options: FAST,
      wa: () => ({
        state: 'open',
        jid: '4915100000009@s.whatsapp.net',
        travelerPn: '4915100000001',
        travelerLid: '123',
        stats: { captured: 3, undecryptable: 0 },
      }),
      stats: () => ({ processed: 5 }),
      diskFree: async () => 123_456_789,
    });
    const hb = await s.buildHeartbeat();
    expect(Heartbeat.safeParse(hb).success).toBe(true);
    // L1-03: no observer JID, the traveler number masked to country code + last two digits
    expect(hb.wa).toEqual({
      state: 'open',
      lastStatusAt: '2026-11-18T09:00:00.000Z',
      traveler: { pn: '+49…01', lidKnown: true },
    });
    expect(hb.captures).toEqual({ awaitingMedia: 0, failed: 0, mediaLost: 0 });
    expect(hb.stats).toEqual({ captured: 3, undecryptable: 0, 'ingest.processed': 5 });
    expect(hb.disk.freeBytes).toBe(123_456_789);
    expect(await s.heartbeatNow()).toBe(true);
    expect(api.heartbeats).toHaveLength(1);
    // What the API receives (and stores) carries neither the JID nor the full number.
    const posted = JSON.stringify(api.heartbeats[0]);
    expect(posted).not.toContain('4915100000009');
    expect(posted).not.toContain('4915100000001');
    expect(Heartbeat.safeParse(api.heartbeats[0]).success).toBe(true);
    expect((api.heartbeats[0] as Heartbeat).wa.jid).toBeUndefined();
    await s.stop();
  });

  it('masks the traveler number (country code + last two digits) or sends null', async () => {
    expect(maskPhoneNumber('4915187654321')).toBe('+49…21');
    expect(maskPhoneNumber('+1 415 555 0134')).toBe('+1…34');
    expect(maskPhoneNumber('84912345678')).toBe('+84…78');
    expect(maskPhoneNumber('358401234567')).toBe('+358…67');
    expect(maskPhoneNumber('12')).toBe('…');
    expect(maskPhoneNumber(null)).toBeNull();
    expect(maskPhoneNumber('')).toBeNull();
    const fixtureMode = createSync({
      config,
      log: silentLog(),
      store,
      options: FAST,
      wa: () => ({ state: 'open', travelerPn: null, travelerLid: null, stats: {} }),
      diskFree: async () => 1,
    });
    const hb = await fixtureMode.buildHeartbeat();
    expect(hb.wa.traveler).toEqual({ pn: null, lidKnown: false });
    await fixtureMode.stop();
  });

  it('reports deploys with the generate snapshot (not the current cursor)', async () => {
    writeGenerateSnapshot(store, {
      version: 7,
      at: '2026-11-18T10:00:00.000Z',
      feedSeq: 12,
      capturesThrough: '2026-11-18T09:59:00.000Z',
      full: false,
      durationMs: 5,
      changed: 3,
      removed: 0,
    });
    store.syncState.setFeedCursor(20);
    sync.reportPublished([
      { targetId: 'local', ok: true, version: 7, uploaded: 3, deleted: 1 },
      { targetId: 'sftp-main', ok: false, version: 7, uploaded: 0, deleted: 0, error: 'connection refused' },
    ]);
    await sync.flushNow();
    expect(api.published).toHaveLength(2);
    expect(api.published[0]).toMatchObject({
      target: 'local',
      ok: true,
      version: 7,
      feedSeq: 12,
      capturesThrough: '2026-11-18T09:59:00.000Z',
    });
    expect(api.published[1]).toMatchObject({ target: 'sftp-main', ok: false, error: 'connection refused' });
    const state = readPublishState(store);
    expect(state.lastError).toMatch(/sftp-main: connection refused/);
    expect(state.targets?.local?.ok).toBe(true);
  });
});

describe('publish state over all enabled targets (W2-3)', () => {
  it("one target's success does not hide another failing target; removing or disabling it clears it", async () => {
    let enabled = ['a', 'b'];
    const s = createSync({
      config,
      log: silentLog(),
      store,
      options: FAST,
      enabledTargets: () => enabled,
      diskFree: async () => 1,
    });
    s.reportPublished([{ targetId: 'a', ok: true, version: 4, uploaded: 1, deleted: 0 }]);
    s.reportPublished([{ targetId: 'b', ok: true, version: 4, uploaded: 1, deleted: 0 }]);
    expect(readPublishState(store)).toMatchObject({ lastVersion: 4 });
    // B fails, then A succeeds with a newer version: B's error must survive
    s.reportPublished([{ targetId: 'b', ok: false, version: 5, uploaded: 0, deleted: 0, error: 'auth failed' }]);
    s.reportPublished([{ targetId: 'a', ok: true, version: 5, uploaded: 2, deleted: 0 }]);
    let state = readPublishState(store);
    expect(state.lastError).toBe('b: auth failed');
    expect(state.lastVersion).toBe(4); // not live everywhere yet
    expect((await s.buildHeartbeat()).publish).toMatchObject({ lastVersion: 4, lastError: 'b: auth failed' });
    // disabling (or removing) B clears its error, also without a new deploy (heartbeat)
    enabled = ['a'];
    const hb = await s.buildHeartbeat();
    expect(hb.publish.lastError).toBeUndefined();
    expect(hb.publish.lastVersion).toBe(5);
    s.reportPublished([{ targetId: 'a', ok: true, version: 6, uploaded: 1, deleted: 0 }]);
    state = readPublishState(store);
    expect(state.lastError).toBeUndefined();
    expect(state.lastVersion).toBe(6);
    expect(Object.keys(state.targets ?? {})).toEqual(['a']);
    await s.stop();
  });
});

describe('without an API', () => {
  it('is disabled: nothing is queued, pulls are no-ops, publish state is still recorded', async () => {
    const offline = createSync({ config: testConfig(tmp.dir), log: silentLog(), store });
    expect(offline.enabled).toBe(false);
    await offline.start();
    await insertTextCapture(store, 'N1', '2026-11-18T08:00:00.000Z');
    offline.capturesChanged(['wa:N1']);
    expect(offline.resyncAllCaptures()).toBe(0);
    expect(store.outbox.stats().pending).toBe(0);
    expect(await offline.pullNow()).toBe(0);
    expect(await offline.heartbeatNow()).toBe(false);
    offline.reportPublished([{ targetId: 'local', ok: true, version: 3, uploaded: 1, deleted: 0 }]);
    expect(store.outbox.stats().pending).toBe(0);
    expect(readPublishState(store)).toMatchObject({ lastVersion: 3 });
    expect(offline.status()).toMatchObject({ enabled: false, baseUrl: null });
    await offline.stop();
  });
});
