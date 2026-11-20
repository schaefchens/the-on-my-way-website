/**
 * Ingest edge cases with hand-written inbox entries and a fake WaSource: download lifecycle
 * (transient failure -> redownload with backoff, give-up -> media_lost, late download -> rescue,
 * permanent failure), revoke before insert, time-zone resolution, invalid meta/revoke files,
 * pipeline retries and integrity errors, helper events.
 */
import { copyFileSync, mkdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waSourceKey } from '@omw/contracts/ids';
import type { InboxMeta } from '@omw/contracts/wa';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIngest, type Ingest } from '../../src/capture/index.js';
import { sha256File } from '../../src/pipeline/index.js';
import { fakeClock } from '../helpers.js';
import { FakeSource, FIXTURE_INBOX, fixtureByKey, fixturesPresent, makeEnv, type TestEnv } from './env.js';

// Media encoding is CPU-bound: generous per-test timeouts for parallel runs.
vi.setConfig({ testTimeout: 60_000 });

const PHOTO = fixtureByKey('berlin-photo');
const PHOTO_FILE = join(FIXTURE_INBOX, PHOTO.msgId, 'original.jpg');

function baseMeta(msgId: string, overrides: Partial<InboxMeta> = {}): InboxMeta {
  return {
    schema: 1,
    msgId,
    source: 'fixture',
    receivedAt: '2026-11-19T10:00:00Z',
    sender: { pn: '4915100000001' },
    timestamp: '2026-11-19T09:59:00Z',
    kind: 'text',
    text: { body: `text ${msgId}`, bgArgb: null, textArgb: null, font: null },
    download: { state: 'not_applicable', attempts: 0 },
    ...overrides,
  };
}

function photoMeta(msgId: string, download: InboxMeta['download']): InboxMeta {
  const { text: _text, ...rest } = baseMeta(msgId);
  return {
    ...rest,
    kind: 'photo',
    caption: 'photo',
    media: { mimetype: 'image/jpeg', fileSha256B64: 'AAAA', fileLength: 30591, width: 1600, height: 1200 },
    download,
  };
}

let bump = 0;
/** Writes meta.json (and optionally the original) like the helper; bumps mtime so rewrites are seen. */
function writeInbox(env: TestEnv, meta: InboxMeta, original?: string): void {
  const dir = join(env.paths.inbox, meta.msgId);
  mkdirSync(dir, { recursive: true });
  if (original) copyFileSync(original, join(dir, meta.download.file ?? 'original.jpg'));
  const file = join(dir, 'meta.json');
  writeFileSync(file, JSON.stringify(meta));
  const t = new Date(Date.now() + ++bump * 1000);
  utimesSync(file, t, t);
}

function writeRaw(env: TestEnv, dirName: string, content: string): void {
  mkdirSync(join(env.paths.inbox, dirName), { recursive: true });
  const file = join(env.paths.inbox, dirName, 'meta.json');
  writeFileSync(file, content);
  const t = new Date(Date.now() + ++bump * 1000);
  utimesSync(file, t, t);
}

describe.skipIf(!fixturesPresent)('ingest edge cases', () => {
  let env: TestEnv;
  let ingest: Ingest;
  const clock = fakeClock('2026-11-19T10:00:00.000Z');
  const source = new FakeSource();

  const setup = (
    options: Parameters<typeof createIngest>[0] extends infer T ? Partial<T> : never = {},
    envVars: Record<string, string> = {},
  ) => {
    clock.set('2026-11-19T10:00:00.000Z');
    source.sent.length = 0;
    source.tz.clear();
    source.process = 'running';
    env = makeEnv({ now: clock, prefix: 'ingest-edge-', env: envVars });
    ingest = createIngest({ config: env.config, log: env.log, paths: env.paths, store: env.store, source, ...options });
  };
  afterEach(async () => {
    await ingest?.stop();
    env?.cleanup();
  });

  it('sends redownload for transient failures with backoff, then gives up after MEDIA_GIVE_UP_HOURS', async () => {
    setup();
    const msgId = 'TRANSIENT1';
    const sourceKey = waSourceKey(msgId);
    writeInbox(env, photoMeta(msgId, { state: 'failed', reason: 'network', permanent: false, attempts: 1 }));
    expect(await ingest.drain()).toMatchObject({ ingested: 1, processed: 0 });
    // Inserted directly as a transient failure: no redownload before its retry is due.
    expect(env.store.captures.get(sourceKey)).toMatchObject({
      state: 'awaiting_media',
      downloadState: 'failed',
      attempts: 1,
      nextAttemptAt: '2026-11-19T10:10:00.000Z',
    });
    await ingest.drain();
    expect(source.sent).toEqual([]);

    clock.advance(11 * 60_000);
    await ingest.drain();
    expect(source.sent).toEqual([{ type: 'redownload', msgId }]);
    const after = env.store.captures.get(sourceKey);
    expect(after?.attempts).toBe(2);
    expect(Date.parse(after?.nextAttemptAt ?? '')).toBe(clock().getTime() + 20 * 60_000);
    await ingest.drain();
    expect(source.sent).toHaveLength(1); // not due again yet

    clock.advance(21 * 60_000);
    await ingest.drain();
    expect(source.sent).toHaveLength(2);

    clock.set('2026-11-21T10:00:01.000Z'); // 48 h after receivedAt
    await ingest.drain();
    expect(env.store.captures.get(sourceKey)).toMatchObject({ state: 'media_lost' });
    expect(env.store.captures.get(sourceKey)?.lastError).toMatch(
      /not downloaded within 48 h \(download failed: network\)/,
    );
    const mirror = env.store.outbox.pending('capture', sourceKey)?.payload;
    expect(mirror).toMatchObject({ mediaState: 'lost' });
    expect(env.store.events.recent({ type: 'capture.media_lost' })).toHaveLength(1);
  });

  it('sends redownload only while the helper runs, without spending attempts while it is down', async () => {
    setup();
    const msgId = 'HELPERDOWN1';
    const sourceKey = waSourceKey(msgId);
    writeInbox(env, photoMeta(msgId, { state: 'failed', reason: 'network', permanent: false, attempts: 1 }));
    await ingest.drain();
    clock.advance(11 * 60_000);
    source.process = 'backoff'; // helper crashed and waits for its restart: commands would be dropped
    await ingest.drain();
    expect(source.sent).toEqual([]);
    expect(env.store.captures.get(sourceKey)).toMatchObject({ attempts: 1, nextAttemptAt: '2026-11-19T10:10:00.000Z' });
    source.process = 'running';
    await ingest.drain();
    expect(source.sent).toEqual([{ type: 'redownload', msgId }]);
    expect(env.store.captures.get(sourceKey)?.attempts).toBe(2);
  });

  it('never gives up while the helper is down; a due redownload always comes before giving up', async () => {
    setup();
    const msgId = 'DOWNTIME1';
    const sourceKey = waSourceKey(msgId);
    writeInbox(env, photoMeta(msgId, { state: 'failed', reason: 'network', permanent: false, attempts: 1 }));
    await ingest.drain();
    await ingest.stop();

    // The backend was off for three days. On boot the ingest starts before the helper runs.
    clock.set('2026-11-22T10:00:00.000Z');
    source.process = 'stopped';
    ingest = createIngest({
      config: env.config,
      log: env.log,
      paths: env.paths,
      store: env.store,
      source,
      scanIntervalMs: 3_600_000,
      pumpIntervalMs: 3_600_000,
    });
    await ingest.start();
    expect(env.store.captures.get(sourceKey)).toMatchObject({ state: 'awaiting_media', attempts: 1 });
    expect(source.sent).toEqual([]);

    // Helper up: the overdue redownload goes out at once; giving up waits for the grace period.
    source.process = 'running';
    await ingest.drain();
    expect(source.sent).toEqual([{ type: 'redownload', msgId }]);
    expect(env.store.captures.get(sourceKey)?.state).toBe('awaiting_media');
    clock.advance(16 * 60_000);
    await ingest.drain();
    expect(env.store.captures.get(sourceKey)?.state).toBe('media_lost');
    expect(source.sent).toHaveLength(1); // the next redownload was not due yet

    // Control-UI retry of the lost capture: one more redownload before it is given up again …
    expect(ingest.retry?.(sourceKey)).toBe(true);
    await ingest.drain();
    expect(source.sent).toEqual([
      { type: 'redownload', msgId },
      { type: 'redownload', msgId },
    ]);
    expect(env.store.captures.get(sourceKey)?.state).toBe('media_lost');
    // … and a download that succeeds after that rescues it.
    const { sha256 } = await sha256File(PHOTO_FILE);
    writeInbox(
      env,
      photoMeta(msgId, { state: 'ok', file: 'original.jpg', sha256Hex: sha256, attempts: 3 }),
      PHOTO_FILE,
    );
    expect(await ingest.drain()).toMatchObject({ processed: 1, failed: 0 });
    expect(env.store.captures.get(sourceKey)?.state).toBe('ready');
  });

  it('gives up on a stuck pending download and rescues it when the media arrives later', async () => {
    setup();
    const msgId = 'PENDING1';
    const sourceKey = waSourceKey(msgId);
    writeInbox(env, photoMeta(msgId, { state: 'pending', attempts: 0 }));
    await ingest.drain();
    expect(env.store.captures.get(sourceKey)?.state).toBe('awaiting_media');
    clock.set('2026-11-21T12:00:00.000Z');
    await ingest.drain();
    expect(env.store.captures.get(sourceKey)?.state).toBe('media_lost');
    expect(source.sent).toEqual([]); // never redownload a pending download (wa.ts rule 2)

    const { sha256 } = await sha256File(PHOTO_FILE);
    writeInbox(
      env,
      photoMeta(msgId, { state: 'ok', file: 'original.jpg', sha256Hex: sha256, attempts: 1 }),
      PHOTO_FILE,
    );
    expect(await ingest.drain()).toMatchObject({ processed: 1, failed: 0 });
    expect(env.store.captures.get(sourceKey)).toMatchObject({ state: 'ready', downloadState: 'ok' });
    expect(ingest.stats().media_rescued).toBe(1);
    expect(env.store.outbox.pending('capture', sourceKey)?.payload).toMatchObject({ mediaState: 'ok' });
  });

  it('follows the helper: pending -> ok becomes ready; permanent failures are never rescued', async () => {
    setup();
    const { sha256 } = await sha256File(PHOTO_FILE);
    writeInbox(env, photoMeta('LATEOK1', { state: 'pending', attempts: 0 }));
    writeInbox(env, photoMeta('GONE1', { state: 'failed', reason: 'expired', permanent: true, attempts: 2 }));
    await ingest.drain();
    expect(env.store.captures.get(waSourceKey('GONE1'))?.state).toBe('media_lost');

    writeInbox(
      env,
      photoMeta('LATEOK1', { state: 'ok', file: 'original.jpg', sha256Hex: sha256, attempts: 1 }),
      PHOTO_FILE,
    );
    writeInbox(
      env,
      photoMeta('GONE1', { state: 'ok', file: 'original.jpg', sha256Hex: sha256, attempts: 3 }),
      PHOTO_FILE,
    );
    await ingest.drain();
    expect(env.store.captures.get(waSourceKey('LATEOK1'))).toMatchObject({ state: 'ready' });
    expect(env.store.captures.get(waSourceKey('GONE1'))).toMatchObject({ state: 'media_lost' });
  });

  it('keeps a capture skipped after its original arrived lost across restarts (no rescue)', async () => {
    setup({ retry: { maxAttempts: 1 } });
    const msgId = 'SKIPPED1';
    const sourceKey = waSourceKey(msgId);
    const bad = join(env.dir, 'broken.jpg');
    writeFileSync(bad, 'not a jpeg at all');
    const { sha256 } = await sha256File(bad);
    writeInbox(env, photoMeta(msgId, { state: 'ok', file: 'original.jpg', sha256Hex: sha256, attempts: 1 }), bad);
    expect(await ingest.drain()).toMatchObject({ failed: 1 });
    expect(env.store.captures.get(sourceKey)?.state).toBe('failed');
    // Control UI "skip" (app.ts skipCapture): the broken original is given up for good.
    expect(env.store.captures.markMediaLost(sourceKey, 'skipped in the control UI')).toBe(true);
    await ingest.stop();

    // A restart re-reads every meta.json ("ok"): that must not resurrect the capture.
    ingest = createIngest({ config: env.config, log: env.log, paths: env.paths, store: env.store, source });
    expect(await ingest.drain()).toEqual({ ingested: 0, processed: 0, failed: 0 });
    expect(env.store.captures.get(sourceKey)).toMatchObject({ state: 'media_lost', downloadState: 'ok' });
    expect(ingest.stats().media_rescued).toBe(0);
  });

  it('parks a revoke that arrives before its status', async () => {
    setup();
    const msgId = 'REVOKEFIRST';
    writeFileSync(
      join(env.paths.revokes, `${msgId}.json`),
      JSON.stringify({ schema: 1, msgId, at: '2026-11-19T10:05:00Z' }),
    );
    await ingest.drain();
    expect(env.store.captures.pendingRevokes()).toEqual([{ msgId, at: '2026-11-19T10:05:00.000Z' }]);
    writeInbox(env, baseMeta(msgId));
    await ingest.drain();
    const row = env.store.captures.get(waSourceKey(msgId));
    expect(row).toMatchObject({ state: 'ready', revokedAt: '2026-11-19T10:05:00.000Z' });
    expect(env.store.outbox.pending('revoke', waSourceKey(msgId))?.payload).toEqual({
      contractVersion: 1,
      at: '2026-11-19T10:05:00.000Z',
    });
    expect(ingest.stats()).toMatchObject({ revokes_parked: 1, revokes_applied: 1 });
  });

  it('resolves the zone: tzFor > source hint > mirrored timezone.current > DEFAULT_TIMEZONE', async () => {
    setup({ tzFor: (meta) => (meta.msgId === 'TZOVERRIDE' ? 'America/New_York' : null) });
    writeInbox(env, baseMeta('TZDEFAULT', { timestamp: '2026-11-19T23:30:00Z' }));
    await ingest.drain();
    expect(env.store.captures.get(waSourceKey('TZDEFAULT'))).toMatchObject({
      tz: 'Europe/Berlin',
      localDate: '2026-11-20',
    });
    env.store.owner.setSetting('timezone.current', 'Asia/Tokyo');
    source.tz.set('TZHINT', 'Pacific/Kiritimati');
    writeInbox(env, baseMeta('TZMIRROR'));
    writeInbox(env, baseMeta('TZHINT'));
    writeInbox(env, baseMeta('TZOVERRIDE'));
    await ingest.drain();
    expect(env.store.captures.get(waSourceKey('TZMIRROR'))?.tz).toBe('Asia/Tokyo');
    expect(env.store.captures.get(waSourceKey('TZHINT'))?.tz).toBe('Pacific/Kiritimati');
    expect(env.store.captures.get(waSourceKey('TZOVERRIDE'))?.tz).toBe('America/New_York');
  });

  it('sends the optional read receipt once per live status after archiving (SEND_READ_RECEIPT, observer)', async () => {
    setup({}, { WA_MODE: 'observer', TRAVELER_PHONE: '4915100000001', SEND_READ_RECEIPT: 'true' });
    const live = <T extends InboxMeta>(meta: T): T => ({
      ...meta,
      source: 'live',
      sender: { pn: '4915100000001', jid: '4915100000001@s.whatsapp.net' },
      rawProtoB64: 'AAAA',
    });
    const { sha256 } = await sha256File(PHOTO_FILE);
    writeInbox(env, live(baseMeta('LIVETEXT1')));
    writeInbox(
      env,
      live(photoMeta('LIVEPHOTO1', { state: 'ok', file: 'original.jpg', sha256Hex: sha256, attempts: 1 })),
      PHOTO_FILE,
    );
    writeInbox(env, live(photoMeta('LIVELOST1', { state: 'failed', reason: 'expired', permanent: true, attempts: 1 })));
    writeInbox(env, baseMeta('FIXTURETEXT1')); // replayed fixture: never
    expect(await ingest.drain()).toMatchObject({ ingested: 4, processed: 3, failed: 0 });
    const receipts = () =>
      source.sent
        .filter((c) => c.type === 'mark_read')
        .map((c) => (c as { msgId: string }).msgId)
        .sort();
    expect(receipts()).toEqual(['LIVEPHOTO1', 'LIVETEXT1']);
    expect(ingest.stats().read_receipts).toBe(2);
    // Never again: not on later drains, not on reprocess.
    await ingest.drain();
    expect(await ingest.reprocess()).toBe(3);
    expect(receipts()).toEqual(['LIVEPHOTO1', 'LIVETEXT1']);
  });

  it('sends no read receipts unless SEND_READ_RECEIPT is set', async () => {
    setup({}, { WA_MODE: 'observer', TRAVELER_PHONE: '4915100000001' });
    writeInbox(env, {
      ...baseMeta('LIVETEXT2'),
      source: 'live',
      sender: { pn: '4915100000001', jid: '4915100000001@s.whatsapp.net' },
      rawProtoB64: 'AAAA',
    });
    expect(await ingest.drain()).toMatchObject({ ingested: 1, processed: 1 });
    expect(source.sent).toEqual([]);
  });

  it('re-ingests an archived status under the zone and date it was filed under after a store reset', async () => {
    setup();
    env.store.owner.setSetting('timezone.current', 'Asia/Tokyo');
    writeInbox(env, baseMeta('FILED1', { timestamp: '2026-11-19T20:30:00Z' }));
    await ingest.drain();
    expect(env.store.captures.get(waSourceKey('FILED1'))).toMatchObject({ tz: 'Asia/Tokyo', localDate: '2026-11-20' });
    await ingest.stop();

    // store.db lost, inbox and archive kept; the owner mirror (timezone.current) is not back yet.
    env.store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${env.paths.storeDb}${suffix}`, { force: true });
    const store = env.reopenStore();
    ingest = createIngest({ config: env.config, log: env.log, paths: env.paths, store, source });
    expect(await ingest.drain()).toMatchObject({ ingested: 1, processed: 1 });
    expect(store.captures.get(waSourceKey('FILED1'))).toMatchObject({
      tz: 'Asia/Tokyo',
      localDate: '2026-11-20',
      state: 'ready',
    });
  });

  it('notices a meta.json replaced by rename even when size and mtime are unchanged', async () => {
    setup();
    const msgId = 'SAMESIZE1';
    const sourceKey = waSourceKey(msgId);
    writeInbox(env, photoMeta(msgId, { state: 'failed', reason: 'network', permanent: false, attempts: 1 }));
    await ingest.drain();
    const file = join(env.paths.inbox, msgId, 'meta.json');
    const before = statSync(file);
    // Same length ("network" -> "timeout"), same mtime, new inode (the helper writes temp + rename).
    const tmp = `${file}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify(photoMeta(msgId, { state: 'failed', reason: 'timeout', permanent: false, attempts: 1 })),
    );
    utimesSync(tmp, before.atime, before.mtime);
    renameSync(tmp, file);
    expect(statSync(file).size).toBe(before.size);
    await ingest.drain();
    expect(env.store.captures.get(sourceKey)?.downloadReason).toBe('timeout');
  });

  it('skips invalid meta.json and revoke files (logged once per version) and recovers when fixed', async () => {
    setup();
    writeRaw(env, 'BADJSON1', '{ not json');
    writeRaw(env, 'BADSCHEMA1', JSON.stringify({ ...baseMeta('BADSCHEMA1'), kind: 'photo' })); // photo without media
    writeRaw(env, 'MISMATCH1', JSON.stringify(baseMeta('OTHERID')));
    writeRaw(env, '.staging-x', JSON.stringify(baseMeta('IGNORED1'))); // not a MsgId: never read
    mkdirSync(join(env.paths.inbox, 'NOMETA1')); // directory without meta.json yet
    writeFileSync(
      join(env.paths.revokes, 'BADREVOKE1.json'),
      JSON.stringify({ schema: 1, msgId: 'SOMEONEELSE', at: 'x' }),
    );
    writeInbox(env, baseMeta('GOOD1'));

    expect(await ingest.drain()).toMatchObject({ ingested: 1, failed: 0 });
    expect(ingest.stats()).toMatchObject({ invalid_meta: 3, invalid_revoke: 1 });
    const events = env.store.events.recent({ type: 'capture.invalid_meta' });
    expect(events.map((e) => (e.data as { msgId: string; problem: string }).problem).sort()).toEqual([
      'invalid_json',
      'invalid_schema',
      'msgid_mismatch',
    ]);
    const warnings = env.records.filter((r) => r.msg === 'invalid inbox meta.json skipped');
    expect(warnings).toHaveLength(3);

    await ingest.drain();
    expect(ingest.stats().invalid_meta).toBe(3);
    expect(env.records.filter((r) => r.msg === 'invalid inbox meta.json skipped')).toHaveLength(3);

    writeRaw(env, 'BADJSON1', JSON.stringify(baseMeta('BADJSON1')));
    expect(await ingest.drain()).toMatchObject({ ingested: 1 });
    expect(env.store.captures.get(waSourceKey('BADJSON1'))?.state).toBe('ready');
  });

  it('retries pipeline failures with backoff and gives up after maxAttempts', async () => {
    setup({ retry: { baseMs: 60_000, maxAttempts: 2 } });
    const msgId = 'CORRUPT1';
    const bad = join(env.dir, 'corrupt.jpg');
    writeFileSync(bad, 'definitely not a jpeg');
    const { sha256 } = await sha256File(bad);
    writeInbox(env, photoMeta(msgId, { state: 'ok', file: 'original.jpg', sha256Hex: sha256, attempts: 1 }), bad);
    expect(await ingest.drain()).toMatchObject({ ingested: 1, processed: 0, failed: 1 });
    const row = env.store.captures.get(waSourceKey(msgId));
    expect(row).toMatchObject({ state: 'archived', attempts: 1 });
    expect(Date.parse(row?.nextAttemptAt ?? '')).toBe(clock().getTime() + 60_000);
    expect(await ingest.drain()).toMatchObject({ failed: 0 }); // not due yet
    clock.advance(61_000);
    expect(await ingest.drain()).toMatchObject({ failed: 1 });
    expect(env.store.captures.get(waSourceKey(msgId))).toMatchObject({ state: 'failed', attempts: 2 });
    expect(env.store.events.recent({ type: 'capture.failed' })).toHaveLength(1);

    // Control UI retry: resumes from the archived step (and fails again here).
    expect(ingest.retry?.(waSourceKey(msgId))).toBe(true);
    await ingest.drain();
    expect(env.store.captures.get(waSourceKey(msgId))?.attempts).toBe(1);
  });

  it('fails an original whose sha256 does not match immediately (no retries)', async () => {
    setup();
    writeInbox(
      env,
      photoMeta('SHAMISMATCH', { state: 'ok', file: 'original.jpg', sha256Hex: 'a'.repeat(64), attempts: 1 }),
      PHOTO_FILE,
    );
    expect(await ingest.drain()).toMatchObject({ failed: 1 });
    expect(env.store.captures.get(waSourceKey('SHAMISMATCH'))).toMatchObject({ state: 'failed' });
    expect(env.store.captures.get(waSourceKey('SHAMISMATCH'))?.lastError).toMatch(/sha256 mismatch/);
  });

  it('reacts to helper events after start() and stops cleanly', async () => {
    setup({ scanIntervalMs: 3_600_000, pumpIntervalMs: 3_600_000 });
    await ingest.start();
    const changed = new Promise<string[]>((resolve) => ingest.onChange((c) => resolve(c.sourceKeys)));
    writeInbox(env, baseMeta('EVENT1'));
    source.emit({ type: 'status', msgId: 'EVENT1', source: 'live' });
    expect(await changed).toEqual([waSourceKey('EVENT1')]);
    expect(env.store.captures.get(waSourceKey('EVENT1'))?.state).toBe('ready');

    writeFileSync(
      join(env.paths.revokes, 'EVENT1.json'),
      JSON.stringify({ schema: 1, msgId: 'EVENT1', at: '2026-11-19T10:09:00Z' }),
    );
    const revoked = new Promise<string[]>((resolve) => ingest.onChange((c) => resolve(c.sourceKeys)));
    source.emit({ type: 'revoke', msgId: 'EVENT1', at: '2026-11-19T10:09:00Z' });
    expect(await revoked).toEqual([waSourceKey('EVENT1')]);
    expect(env.store.captures.get(waSourceKey('EVENT1'))?.revokedAt).toBe('2026-11-19T10:09:00.000Z');
    await ingest.stop();
    expect(await ingest.drain()).toMatchObject({ processed: 0 });
  });
});
