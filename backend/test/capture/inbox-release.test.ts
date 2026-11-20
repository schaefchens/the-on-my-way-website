/**
 * L2-06: once a status is archived (or its download failed permanently) the inbox keeps only
 * meta.json as the tombstone; restarts never re-ingest, re-archive or give up such a status.
 * L1-09: archive originals/records and the store are owner-only (0600 files, 0700 directories).
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { waSourceKey } from '@omw/contracts/ids';
import type { InboxMeta } from '@omw/contracts/wa';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIngest, type Ingest } from '../../src/capture/index.js';
import { sha256File } from '../../src/pipeline/index.js';
import { fakeClock } from '../helpers.js';
import { FakeSource, FIXTURE_INBOX, fixtureByKey, fixturesPresent, makeEnv, type TestEnv } from './env.js';

vi.setConfig({ testTimeout: 60_000 });

const PHOTO = fixtureByKey('berlin-photo');
const PHOTO_FILE = join(FIXTURE_INBOX, PHOTO.msgId, 'original.jpg');

function photoMeta(msgId: string, download: InboxMeta['download']): InboxMeta {
  return {
    schema: 1,
    msgId,
    source: 'fixture',
    receivedAt: '2026-11-19T10:00:00Z',
    sender: { pn: '4915100000001' },
    timestamp: '2026-11-19T09:59:00Z',
    kind: 'photo',
    caption: 'photo',
    media: { mimetype: 'image/jpeg', fileSha256B64: 'AAAA', fileLength: 30591, width: 1600, height: 1200 },
    download,
  };
}

let bump = 0;
function writeInbox(env: TestEnv, meta: InboxMeta, files: Record<string, string> = {}): string {
  const dir = join(env.paths.inbox, meta.msgId);
  mkdirSync(dir, { recursive: true });
  for (const [name, from] of Object.entries(files)) copyFileSync(from, join(dir, name));
  const file = join(dir, 'meta.json');
  writeFileSync(file, JSON.stringify(meta));
  const t = new Date(Date.now() + ++bump * 1000);
  utimesSync(file, t, t);
  return dir;
}

const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);

/** Every file below `dir` -> "<size>:<mtimeMs>" (detects rewrites). */
function fingerprint(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        out[p.slice(dir.length + 1)] = `${st.size}:${st.mtimeMs}`;
      }
    }
  };
  walk(dir);
  return out;
}

describe.skipIf(!fixturesPresent)('inbox release (L2-06) and private modes (L1-09)', () => {
  let env: TestEnv;
  let ingest: Ingest;
  const clock = fakeClock('2026-11-19T10:00:00.000Z');
  const source = new FakeSource();
  const newIngest = () =>
    createIngest({ config: env.config, log: env.log, paths: env.paths, store: env.store, source });

  afterEach(async () => {
    await ingest?.stop();
    env?.cleanup();
  });

  it('archived: the inbox keeps only meta.json; a restart changes nothing; archive files are private', async () => {
    clock.set('2026-11-19T10:00:00.000Z');
    env = makeEnv({ now: clock, prefix: 'inbox-release-' });
    const msgId = 'RELEASE1';
    const sourceKey = waSourceKey(msgId);
    const { sha256, bytes } = await sha256File(PHOTO_FILE);
    const dir = writeInbox(
      env,
      photoMeta(msgId, { state: 'ok', file: 'original.jpg', sha256Hex: sha256, attempts: 1 }),
      {
        'original.jpg': PHOTO_FILE,
      },
    );
    ingest = newIngest();
    expect(await ingest.drain()).toMatchObject({ ingested: 1, processed: 1, failed: 0 });
    const row = env.store.captures.get(sourceKey);
    expect(row).toMatchObject({ state: 'ready', originalSha256: sha256 });
    expect(readdirSync(dir)).toEqual(['meta.json']);
    expect(ingest.stats().inbox_freed_bytes).toBe(bytes);

    // L1-09: the archive is owner-only, the store too
    const record = join(env.config.dirs.archive, row?.archivePath ?? '');
    const original = join(dirname(record), `${msgId}.jpg`);
    expect(mode(record)).toBe('600');
    expect(mode(original)).toBe('600');
    for (
      let d = dirname(record);
      d.startsWith(env.config.dirs.archive) && d !== env.config.dirs.archive;
      d = dirname(d)
    ) {
      expect(mode(d), d).toBe('700');
    }
    expect(mode(env.paths.storeDb)).toBe('600');
    expect(mode(`${env.paths.storeDb}-wal`)).toBe('600');
    // public media variants stay world-readable
    const variant = join(env.config.dirs.media, (row?.variants?.[0]?.relPath ?? '').replace(/^media\//, ''));
    expect(mode(variant)).toBe('644');

    // Restart: meta.json is re-read, the original is gone: nothing happens.
    await ingest.stop();
    const archiveBefore = fingerprint(env.config.dirs.archive);
    const events = env.store.events.recent({ limit: 1000 }).length;
    ingest = newIngest();
    await ingest.start();
    expect(await ingest.drain()).toEqual({ ingested: 0, processed: 0, failed: 0 });
    expect(env.store.captures.get(sourceKey)).toEqual(row);
    expect(fingerprint(env.config.dirs.archive)).toEqual(archiveBefore);
    expect(env.store.events.recent({ limit: 1000 }).length).toBe(events);
    expect(source.sent).toEqual([]);
    expect(readdirSync(dir)).toEqual(['meta.json']);
  });

  it('cleans a terminal media_lost entry but never a pending download', async () => {
    clock.set('2026-11-19T10:00:00.000Z');
    env = makeEnv({ now: clock, prefix: 'inbox-release-' });
    const gone = writeInbox(
      env,
      photoMeta('LOST1', { state: 'failed', reason: 'expired', permanent: true, attempts: 2 }),
      {
        '.dl-123456': PHOTO_FILE,
      },
    );
    const pending = writeInbox(env, photoMeta('PEND1', { state: 'pending', attempts: 0 }), { '.dl-777': PHOTO_FILE });
    ingest = newIngest();
    await ingest.drain();
    expect(env.store.captures.get(waSourceKey('LOST1'))?.state).toBe('media_lost');
    expect(readdirSync(gone)).toEqual(['meta.json']);
    expect(env.store.captures.get(waSourceKey('PEND1'))?.state).toBe('awaiting_media');
    expect(readdirSync(pending).sort()).toEqual(['.dl-777', 'meta.json']);
    // a later start (sweep) leaves the pending entry alone as well
    await ingest.stop();
    ingest = newIngest();
    await ingest.start();
    expect(readdirSync(pending).sort()).toEqual(['.dl-777', 'meta.json']);
  });

  it('the startup sweep frees originals that older versions left behind (idempotent)', async () => {
    clock.set('2026-11-19T10:00:00.000Z');
    env = makeEnv({ now: clock, prefix: 'inbox-release-' });
    const { sha256, bytes } = await sha256File(PHOTO_FILE);
    const meta = photoMeta('OLD1', { state: 'ok', file: 'original.jpg', sha256Hex: sha256, attempts: 1 });
    const dir = writeInbox(env, meta, { 'original.jpg': PHOTO_FILE });
    ingest = newIngest();
    await ingest.drain();
    await ingest.stop();
    // as left by a version without the release: original (and a stray temp file) still there
    copyFileSync(PHOTO_FILE, join(dir, 'original.jpg'));
    writeFileSync(join(dir, '.tmp-abc'), 'x');
    ingest = newIngest();
    await ingest.start();
    expect(readdirSync(dir)).toEqual(['meta.json']);
    expect(ingest.stats().inbox_freed_bytes).toBe(bytes + 1);
    expect(env.store.events.recent({ type: 'ingest.inbox_swept' })[0]?.data).toEqual({ entries: 1, bytes: bytes + 1 });
    expect(env.records.some((r) => String(r.msg).startsWith(`inbox sweep freed ${bytes + 1} bytes`))).toBe(true);
    await ingest.stop();
    // a second start finds nothing to do
    ingest = newIngest();
    await ingest.start();
    expect(ingest.stats().inbox_freed_bytes).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')).msgId).toBe('OLD1');
  });
});
