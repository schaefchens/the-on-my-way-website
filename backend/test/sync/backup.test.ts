/**
 * W2-4: daily pull of the API's SQLite backup (GET /api/v1/backend/backup/latest) into
 * DATA_DIR/api-backups: 200 (verified + saved 0600), 304, 404, hash mismatch, not SQLite,
 * rotation (API_BACKUP_KEEP), schedule and the sync's auth pause.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { Store } from '../../src/store/index.js';
import { BACKUP_STATE_KEY, type BackupState, createBackupPuller, sha256FromEtag } from '../../src/sync/backup.js';
import { fakeClock, makeTempDir } from '../helpers.js';
import { type FakeApi, startFakeApi, TOKEN } from './fake-api.js';
import { silentLog, testConfig } from './helpers.js';

// Backend test ports 19200-19219: this file uses 19217.
const PORT = 19217;

/** A tiny, valid-looking SQLite file (magic header + payload). */
const sqlite = (payload: string) => Buffer.concat([Buffer.from('SQLite format 3\0', 'latin1'), Buffer.from(payload)]);

let api: FakeApi;
let tmp: { dir: string; cleanup: () => void };
let config: Config;
let store: Store;
const clock = fakeClock('2026-11-20T03:00:00.000Z');
let paused: string | null = null;

beforeAll(async () => {
  api = await startFakeApi(PORT);
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  clock.set('2026-11-20T03:00:00.000Z');
  tmp = makeTempDir('backup-');
  config = testConfig(tmp.dir, { API_BASE_URL: api.url, API_TOKEN: TOKEN, API_BACKUP_KEEP: '3' });
  store = Store.memory({ now: clock });
  api.backup = null;
  api.log = [];
  api.failures.clear();
  paused = null;
});
afterEach(() => {
  store.close();
  tmp.cleanup();
});

const puller = () =>
  createBackupPuller({
    config,
    log: silentLog(),
    store,
    now: clock,
    sync: { status: () => ({ authPausedUntil: paused }) },
    options: { checkMs: 60_000 },
  });
const dir = () => join(config.dirs.data, 'api-backups');
const files = () => (existsSync(dir()) ? readdirSync(dir()).sort() : []);
const state = () => store.syncState.getJson<BackupState>(BACKUP_STATE_KEY) ?? {};

describe('API backup pull (W2-4)', () => {
  it('404 = no backup yet; 200 saves a verified 0600 file; 304 with If-None-Match does nothing', async () => {
    const p = puller();
    expect(await p.pullNow()).toEqual({ status: 'none' });
    expect(files()).toEqual([]);
    expect(state().checkedAt).toBe('2026-11-20T03:00:00.000Z');

    const bytes = sqlite('night one');
    api.backup = { bytes };
    const saved = await p.pullNow();
    expect(saved).toMatchObject({ status: 'saved', bytes: bytes.length });
    const name = (saved as { file: string }).file;
    expect(name).toMatch(/^2026-11-20-[0-9a-f]{8}\.sqlite$/);
    expect(files()).toEqual([name]);
    expect(readFileSync(join(dir(), name))).toEqual(bytes);
    expect((statSync(join(dir(), name)).mode & 0o777).toString(8)).toBe('600');
    expect((statSync(dir()).mode & 0o777).toString(8)).toBe('700');
    expect(store.events.recent({ type: 'backup.saved' })).toHaveLength(1);

    api.log = [];
    expect(await p.pullNow()).toEqual({ status: 'not_modified' });
    expect(api.log).toEqual(['GET /api/v1/backend/backup/latest']);
    expect(files()).toEqual([name]);
    await p.stop();
  });

  it('rejects a hash mismatch and a non-SQLite body (nothing kept, backoff, event)', async () => {
    const p = puller();
    api.backup = { bytes: sqlite('tampered'), etag: `"${'0'.repeat(64)}"` };
    const r = await p.pullNow();
    expect(r).toMatchObject({ status: 'failed' });
    expect((r as { error: string }).error).toMatch(/sha256 mismatch/);
    expect(files()).toEqual([]); // the temp file is gone too
    expect(state()).toMatchObject({ failures: 1, nextAttemptAt: '2026-11-20T03:15:00.000Z' });
    expect(store.events.recent({ type: 'backup.failed' })).toHaveLength(1);

    api.backup = { bytes: Buffer.from('<html>login</html>') };
    expect(await p.pullNow()).toMatchObject({ status: 'failed', error: 'the download is not an SQLite database' });
    expect(state()).toMatchObject({ failures: 2, nextAttemptAt: '2026-11-20T03:30:00.000Z' });
    expect(files()).toEqual([]);
    // a later good pull clears the failure state
    api.backup = { bytes: sqlite('good') };
    expect(await p.pullNow()).toMatchObject({ status: 'saved' });
    expect(state().failures).toBeUndefined();
    await p.stop();
  });

  it('keeps the newest API_BACKUP_KEEP files and removes stale temp files', async () => {
    const p = puller();
    const names: string[] = [];
    for (let day = 15; day <= 19; day++) {
      clock.set(`2026-11-${day}T03:00:00.000Z`);
      api.backup = { bytes: sqlite(`night ${day}`) };
      const r = await p.pullNow();
      names.push((r as { file: string }).file);
    }
    writeFileSync(join(dir(), '2026-11-14-deadbeef.sqlite.tmp'), 'partial');
    clock.set('2026-11-20T03:00:00.000Z');
    api.backup = { bytes: sqlite('night 20') };
    const last = (await p.pullNow()) as { file: string };
    expect(files()).toEqual([names[3], names[4], last.file].sort());
    await p.stop();
  });

  it('runs at start when the last check is older than a day, never while the sync is auth-paused', async () => {
    api.backup = { bytes: sqlite('x') };
    store.syncState.setJson(BACKUP_STATE_KEY, { checkedAt: '2026-11-19T10:00:00.000Z' });
    const fresh = puller();
    fresh.start(); // checked 17 h ago: not due
    await new Promise((r) => setTimeout(r, 50));
    expect(api.log).toEqual([]);
    await fresh.stop();

    store.syncState.setJson(BACKUP_STATE_KEY, { checkedAt: '2026-11-18T10:00:00.000Z' });
    paused = '2026-11-20T03:05:00.000Z';
    const p = puller();
    expect(await p.pullNow()).toMatchObject({ status: 'skipped' });
    expect(api.log).toEqual([]);
    paused = null;
    p.start(); // due (41 h): pulls right away
    for (let i = 0; i < 100 && files().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(files()).toHaveLength(1);
    await p.stop();
  });

  it('parses the PHP ETag format', () => {
    const sha = 'a'.repeat(64);
    expect(sha256FromEtag(`"${sha}"`)).toBe(sha);
    expect(sha256FromEtag(`W/"${sha.toUpperCase()}"`)).toBe(sha);
    expect(sha256FromEtag('"abc"')).toBeNull();
    expect(sha256FromEtag(null)).toBeNull();
  });
});
