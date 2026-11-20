import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FORCE_PUBLISH_KEY, LockHeldError, ProcessLock } from '../../src/app.js';
import { controlBaseUrl, formatStatus, ownerImport, parseArgs, parseLocalesFlag, runCli } from '../../src/cli.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import { REPO_ROOT, statePaths } from '../../src/paths.js';
import { createPublisher } from '../../src/publisher/index.js';
import { Store } from '../../src/store/index.js';
import { makeTempDir } from '../helpers.js';
import { writeSite } from '../publisher/site.js';
import { sampleStatus } from '../ui/fake-backend.js';

let tmp: { dir: string; cleanup: () => void };
let env: Record<string, string>;
let out: string[];
let err: string[];
const io = { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) };

beforeEach(() => {
  tmp = makeTempDir('cli-');
  env = {
    NODE_ENV: 'test',
    DATA_DIR: join(tmp.dir, 'state'),
    ARCHIVE_DIR: join(tmp.dir, 'archive'),
    OUT_DIR: join(tmp.dir, 'out'),
    CONFIG_DIR: join(tmp.dir, 'config'),
    MEDIA_DIR: join(tmp.dir, 'media'),
    CONTROL_PORT: '19202',
    CONTROL_TOKEN: 'cli-test-token-1234',
  };
  out = [];
  err = [];
});
afterEach(() => tmp.cleanup());

const offline: typeof fetch = async () => {
  throw new TypeError('fetch failed');
};

describe('parseArgs', () => {
  it('parses commands, flags and --target', () => {
    expect(parseArgs([])).toMatchObject({ command: 'start', args: [] });
    expect(parseArgs(['publish', '--target', 'sftp-main'])).toMatchObject({ command: 'publish' });
    expect(parseArgs(['publish', '--target', 'sftp-main']).flags.get('target')).toBe('sftp-main');
    expect(parseArgs(['publish', '--target=local']).flags.get('target')).toBe('local');
    expect(parseArgs(['generate', '--full']).flags.has('full')).toBe(true);
    expect(parseArgs(['reprocess', 'wa:ABC'])).toMatchObject({ command: 'reprocess', args: ['wa:ABC'] });
    expect(parseArgs(['status', '-h']).command).toBe('help');
  });

  it('builds the control URL for wildcard hosts', () => {
    const token = { CONTROL_TOKEN: 'a-control-token-for-tests' };
    expect(controlBaseUrl(loadConfig({ ...token, CONTROL_HOST: '0.0.0.0', CONTROL_PORT: '8787' }))).toBe(
      'http://127.0.0.1:8787',
    );
    expect(controlBaseUrl(loadConfig({ CONTROL_HOST: '::1' }))).toBe('http://[::1]:8787');
  });
});

describe('runCli', () => {
  it('prints help and rejects unknown commands', async () => {
    expect(await runCli(['help'], { env, io, fetch: offline })).toBe(0);
    expect(out.join('\n')).toContain('pair-code PHONE');
    expect(await runCli(['frobnicate'], { env, io, fetch: offline })).toBe(2);
    expect(err.join('\n')).toContain('Unknown command');
    expect(await runCli(['status'], { env: { ...env, WA_MODE: 'observer' }, io, fetch: offline })).toBe(2);
    expect(err.join('\n')).toContain('TRAVELER_PHONE');
  });

  it('reports status from the store when the backend is not running', async () => {
    expect(await runCli(['status'], { env, io, fetch: offline })).toBe(0);
    expect(out[0]).toContain('NOT running');
    expect(out[0]).toContain('Captures   0 total');
    out = [];
    expect(await runCli(['status', '--json'], { env, io, fetch: offline })).toBe(0);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ running: false, app: 'omw-backend', captures: { total: 0 } });
  });

  it('delegates to a running backend with the Bearer token', async () => {
    const seen: { url: string; auth: string | null; body: string | null }[] = [];
    const daemon: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, auth: headers.get('authorization'), body: (init?.body as string) ?? null });
      if (url.endsWith('/healthz')) return Response.json({ ok: true, app: 'omw-backend' });
      if (url.endsWith('/api/rebuild')) return Response.json({ ok: true, result: { version: 9, changed: 2 } });
      if (url.endsWith('/api/pair-code')) return Response.json({ ok: true, code: 'K3Y5-C0DE' });
      if (url.endsWith('/api/publish')) return Response.json({ ok: false, results: [{ targetId: 'x', ok: false }] });
      return new Response('{}', { status: 404 });
    };
    expect(await runCli(['generate', '--full'], { env, io, fetch: daemon })).toBe(0);
    expect(JSON.parse(out[0] ?? '')).toEqual({ version: 9, changed: 2 });
    const call = seen.find((s) => s.url.endsWith('/api/rebuild'));
    expect(call).toEqual({
      url: 'http://127.0.0.1:19202/api/rebuild',
      auth: 'Bearer cli-test-token-1234',
      body: '{"full":true}',
    });

    expect(await runCli(['pair-code', '+49 151 0000 0009'], { env, io, fetch: daemon })).toBe(0);
    expect(out.at(-1)).toBe('K3Y5-C0DE');
    expect(await runCli(['publish', '--target', 'x'], { env, io, fetch: daemon })).toBe(1);
  });

  it('needs a running backend for pair-code and validates arguments', async () => {
    expect(await runCli(['pair-code'], { env, io, fetch: offline })).toBe(2);
    expect(await runCli(['pair-code', '4915100000009'], { env, io, fetch: offline })).toBe(1);
    expect(err.join('\n')).toContain('not running');
    expect(await runCli(['publish', '--target'], { env, io, fetch: offline })).toBe(2);
  });

  it('owner-import applies the fixtures owner feed (+ site.locales) to the owner mirror', async () => {
    const file = join(REPO_ROOT, 'fixtures', 'generated', 'owner.json');
    expect(await runCli(['owner-import', file, '--locales=de,en,ar'], { env, io, fetch: offline })).toBe(0);
    const result = JSON.parse(out[0] ?? '') as { applied: number; locales: string[]; localDates: string[] };
    expect(result.applied).toBeGreaterThan(10);
    expect(result.locales).toEqual(['de', 'en', 'ar']);
    expect(result.localDates.length).toBeGreaterThan(0);
    const store = Store.open(statePaths(env.DATA_DIR as string).storeDb);
    try {
      expect(store.owner.settings()['site.locales']).toEqual(['de', 'en', 'ar']);
      expect(store.owner.listTrips().map((t) => t.slug)).toContain('vietnam-2026');
    } finally {
      store.close();
    }
    // Idempotent: a second import of the same feed applies nothing new.
    out = [];
    expect(await runCli(['owner-import', file], { env, io, fetch: offline })).toBe(0);
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ applied: 0, rebuilt: false });
  });

  it('owner-import validates its arguments and refuses when an API owns the content', async () => {
    const file = join(REPO_ROOT, 'fixtures', 'generated', 'owner.json');
    expect(await runCli(['owner-import'], { env, io, fetch: offline })).toBe(2);
    expect(await runCli(['owner-import', file, '--locales=de,xx'], { env, io, fetch: offline })).toBe(2);
    expect(err.join('\n')).toContain('unknown locale');
    const withApi = { ...env, API_BASE_URL: 'https://api.example.org', API_TOKEN: 'api-token-for-tests-123' };
    expect(await runCli(['owner-import', file], { env: withApi, io, fetch: offline })).toBe(2);
    expect(err.join('\n')).toContain('--force');
    expect(parseLocalesFlag(undefined)).toBeNull();
    expect(() => parseLocalesFlag(true)).toThrow(/needs a value/);
    expect(() => parseLocalesFlag('de,de')).toThrow(/duplicate/);
  });

  it('owner-import replaces a mirror from another feed (rebuild)', () => {
    const store = Store.open(statePaths(env.DATA_DIR as string).storeDb);
    try {
      const day = (seq: number, date: string) => ({
        seq,
        entity: 'day',
        key: date,
        op: 'upsert',
        data: { localDate: date, title: { de: `Tag ${date}` }, origLocale: 'de', updatedAt: '2026-11-01T00:00:00Z' },
      });
      const a = {
        feedId: 'feedaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
        items: [day(1, '2026-11-01')],
        nextSeq: 1,
        hasMore: false,
      };
      expect(ownerImport(store, a, null)).toMatchObject({ applied: 1, rebuilt: false });
      const b = {
        feedId: 'feedbbbbbbbbbbbbbbbbbbbbbbbbbbb2',
        items: [day(1, '2026-11-02')],
        nextSeq: 1,
        hasMore: false,
      };
      expect(ownerImport(store, { changes: b }, null)).toMatchObject({ applied: 1, rebuilt: true, cursor: 1 });
      expect(store.owner.getDay('2026-11-01')).toBeUndefined();
      expect(store.owner.getDay('2026-11-02')).toBeDefined();
    } finally {
      store.close();
    }
  });
});

describe('formatStatus', () => {
  it('summarises the backend in a few lines', () => {
    const text = formatStatus(sampleStatus(), true);
    expect(text).toMatch(/^On My Way backend 0\.1\.0-test — running/);
    expect(text).toContain('WhatsApp   open');
    expect(text).toContain('LID known (learned)');
    expect(text).toContain('API sync   https://api.example.org · feed seq 5');
  });
});

describe('ProcessLock', () => {
  it('is exclusive, detects stale locks and releases', () => {
    const path = join(tmp.dir, 'state', 'backend.lock');
    const lock = ProcessLock.acquire(path, 'start');
    expect(ProcessLock.read(path)?.pid).toBe(process.pid);
    lock.release();
    expect(ProcessLock.read(path)).toBeNull();

    // A live other process on this host holds it.
    writeFileSync(path, JSON.stringify({ pid: process.ppid, host: hostname(), command: 'start', startedAt: 'x' }));
    expect(() => ProcessLock.acquire(path, 'generate')).toThrow(LockHeldError);
    expect(ProcessLock.holder(path)?.pid).toBe(process.ppid);

    // Dead pid, our own pid (container restart), or another host whose heartbeat is old: stale.
    const old = Date.now() / 1000 - 3600;
    for (const info of [
      { pid: 2 ** 22 + 12345, host: hostname() },
      { pid: process.pid, host: hostname() },
      { pid: process.ppid, host: 'old-container', stale: true },
    ]) {
      writeFileSync(path, JSON.stringify({ ...info, command: 'start', startedAt: 'x' }));
      if (info.stale) utimesSync(path, old, old);
      const l = ProcessLock.acquire(path, 'generate');
      expect(ProcessLock.read(path)?.command).toBe('generate');
      l.release();
    }
  });

  it('holds across hosts while the heartbeat is fresh (D-15)', () => {
    const path = join(tmp.dir, 'state', 'backend.lock');
    let t = Date.parse('2026-11-20T10:00:00.000Z');
    const now = () => t;
    // The daemon in container "daemon-host" takes the lock (heartbeat = now).
    const daemon = ProcessLock.acquire(path, 'start', { hostname: () => 'daemon-host', now });
    expect(ProcessLock.read(path)).toMatchObject({ host: 'daemon-host', command: 'start' });
    const cli = { hostname: () => 'run-container', now };

    // A one-shot `docker compose run` container sees a fresh foreign lock: held, never taken over.
    t += 25_000;
    expect(ProcessLock.holder(path, cli)).toMatchObject({ host: 'daemon-host', foreign: true });
    let err: unknown;
    try {
      ProcessLock.acquire(path, 'generate', cli);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LockHeldError);
    expect((err as LockHeldError).foreign).toBe(true);
    expect((err as LockHeldError).message).toContain('host daemon-host');

    // The daemon's refresh keeps it fresh well past the 30 s threshold.
    daemon.refresh();
    t += 25_000; // 50 s after acquiring, 25 s after the refresh
    expect(ProcessLock.holder(path, cli)).not.toBeNull();
    expect(() => ProcessLock.acquire(path, 'generate', cli)).toThrow(LockHeldError);

    // Without refreshes (daemon gone) the lock is stale after 30 s and is taken over.
    t += 10_000;
    expect(ProcessLock.holder(path, cli)).toBeNull();
    const taken = ProcessLock.acquire(path, 'generate', cli);
    expect(ProcessLock.read(path)).toMatchObject({ host: 'run-container', command: 'generate' });
    // The old daemon's release must not delete the new holder's lock.
    daemon.release();
    expect(ProcessLock.read(path)?.host).toBe('run-container');
    taken.release();
    expect(ProcessLock.read(path)).toBeNull();
  });

  it('refreshes the heartbeat on a timer until released', async () => {
    const path = join(tmp.dir, 'state', 'backend.lock');
    const lock = ProcessLock.acquire(path, 'start', { heartbeatMs: 20 });
    const old = Date.now() / 1000 - 3600;
    utimesSync(path, old, old);
    lock.startHeartbeat();
    await new Promise((r) => setTimeout(r, 80));
    expect(Date.now() - (ProcessLock.heartbeat(path) ?? 0)).toBeLessThan(5_000);
    lock.release();
    expect(ProcessLock.read(path)).toBeNull();
  });
});

describe('one-shot writers next to a daemon in another container (D-15)', () => {
  it('refuse with a hint to use docker compose exec; read-only status keeps working', async () => {
    const path = join(tmp.dir, 'state', 'backend.lock');
    mkdirSync(join(tmp.dir, 'state'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ pid: 7, host: 'omw-backend-daemon', command: 'start', startedAt: '2026-11-20T06:00:00.000Z' }),
    );
    for (const command of ['generate', 'publish', 'reprocess']) {
      err = [];
      expect(await runCli([command], { env, io, fetch: offline }), command).toBe(1);
      expect(err.join('\n'), command).toContain('The backend daemon is running (host omw-backend-daemon');
      expect(err.join('\n'), command).toContain(`docker compose exec backend backend ${command}`);
    }
    // the daemon's lock is untouched
    expect(JSON.parse(readFileSync(path, 'utf8')).host).toBe('omw-backend-daemon');
    out = [];
    expect(await runCli(['status'], { env, io, fetch: offline })).toBe(0);
    expect(out.join('\n')).toContain('NOT running');
  });
});

describe('backend publish --force (L2-02 c)', () => {
  it('a deploy that would delete every day is refused; --force deploys it', async () => {
    const www = join(tmp.dir, 'www');
    const store = Store.open(statePaths(env.DATA_DIR as string).storeDb);
    try {
      createPublisher({ config: loadConfig(env), log: createLogger({ level: 'silent' }), store }).saveTarget({
        id: 'www',
        kind: 'local',
        dir: www,
        enabled: true,
      });
    } finally {
      store.close();
    }
    writeSite(env.OUT_DIR as string, { version: 1, build: 'b1', days: { '2026-11-17': ['a'], '2026-11-18': ['b'] } });
    expect(await runCli(['publish'], { env, io, fetch: offline })).toBe(0);
    expect(existsSync(join(www, 'data', 'days', '2026-11-17.json'))).toBe(true);

    writeSite(env.OUT_DIR as string, { version: 2, build: 'b1', days: {} });
    out = [];
    err = [];
    expect(await runCli(['publish'], { env, io, fetch: offline })).toBe(1);
    expect(out.join('\n')).toMatch(/refused: would delete \d+ of \d+ remote files; use backend publish --force/);
    expect(existsSync(join(www, 'data', 'days', '2026-11-17.json'))).toBe(true);

    out = [];
    expect(await runCli(['publish', '--force'], { env, io, fetch: offline })).toBe(0);
    expect(existsSync(join(www, 'data', 'days', '2026-11-17.json'))).toBe(false);
  });

  it('next to a running daemon --force is handed over through the store', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const daemon: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/healthz')) return new Response(JSON.stringify({ ok: true, app: 'omw-backend' }));
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ ok: true, results: [{ targetId: 'www', ok: true }] }));
    };
    expect(await runCli(['publish', '--force'], { env, io, fetch: daemon })).toBe(0);
    expect(calls).toEqual([{ url: 'http://127.0.0.1:19202/api/publish', body: { force: true } }]);
    const store = Store.open(statePaths(env.DATA_DIR as string).storeDb);
    try {
      expect(store.syncState.get(FORCE_PUBLISH_KEY)).toMatch(/^\d{4}-/);
    } finally {
      store.close();
    }
  });
});
