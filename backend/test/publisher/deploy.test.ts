import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, relative } from 'node:path';
import { publicIdForSourceKey, waSourceKey } from '@omw/contracts/ids';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import {
  type Connector,
  createPublisher,
  type DeployResult,
  decodeRecord,
  encodeRecord,
  PublishError,
  RemoteError,
  type StoredTarget,
} from '../../src/publisher/index.js';
import { Store } from '../../src/store/index.js';
import { fakeClock, makeTempDir } from '../helpers.js';
import { FakeServer } from './fakeRemote.js';
import { localTarget, sftpTarget, silentLog, staticTargets, testConfig } from './helpers.js';
import { assetPaths, mediaPaths, referenceProblems, type SiteSpec, writeSite } from './site.js';

/** The gzip deploy record on the fake server (L2-05). */
function readRecord(
  server: FakeServer,
  root: string,
): Record<string, unknown> & {
  files: Record<string, unknown>;
  obsoleteSince: Record<string, string>;
} {
  const raw = server.files.get(`${root}/.omw-deploy.json.gz`);
  if (!raw) throw new Error(`no deploy record below ${root}`);
  return decodeRecord(raw) as ReturnType<typeof readRecord>;
}

const V1: SiteSpec = { version: 1, build: 'b1', days: { '2026-11-17': ['a', 'b'], '2026-11-18': ['c'] } };
const V2: SiteSpec = { version: 2, build: 'b2', days: { '2026-11-17': ['a'], '2026-11-19': ['e'] } };

describe('publisher deploy (fake SFTP)', () => {
  let tmp: ReturnType<typeof makeTempDir>;
  let config: Config;
  const clock = fakeClock();
  let out1: string;
  let out2: string;
  let files1: Map<string, string>;
  let files2: Map<string, string>;

  beforeEach(() => {
    clock.set('2026-11-19T10:00:00.000Z');
    tmp = makeTempDir('publisher-deploy-');
    config = testConfig(tmp.dir);
    out1 = join(tmp.dir, 'out1');
    out2 = join(tmp.dir, 'out2');
    files1 = writeSite(out1, V1);
    files2 = writeSite(out2, V2);
  });
  afterEach(() => tmp.cleanup());

  function setup(
    opts: {
      server?: FakeServer;
      store?: Store;
      target?: StoredTarget;
      connect?: Connector;
      maxAttempts?: number;
      fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    } = {},
  ) {
    const server = opts.server ?? new FakeServer();
    const store = opts.store ?? Store.memory({ now: clock });
    const target = opts.target ?? sftpTarget('fake', { remoteRoot: '/site' });
    const sleeps: number[] = [];
    const publisher = createPublisher({
      config,
      log: silentLog,
      store,
      targets: staticTargets([target]),
      connect: opts.connect ?? (async () => server.connect()),
      hashCacheFile: null,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      httpCheck: { attempts: 1 },
      ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    return { server, store, publisher, sleeps };
  }

  const one = async (p: Promise<DeployResult[]>) => {
    const r = await p;
    expect(r).toHaveLength(1);
    return r[0] as DeployResult;
  };

  function expectMirror(server: FakeServer, want: Map<string, string>, extra: string[] = []) {
    const got = server.siteFiles('/site');
    expect([...got.keys()].sort()).toEqual([...new Set([...want.keys(), ...extra])].sort());
    for (const [p, c] of want) expect(got.get(p)?.toString(), p).toBe(c);
    const all = server.siteFiles('/site', { includeBookkeeping: true });
    expect([...all.keys()].filter((p) => p.includes('.omw-tmp.') || p.endsWith('.omw-deploy.pending.json'))).toEqual(
      [],
    );
    expect(referenceProblems(got)).toEqual([]);
  }

  it('first deploy uploads everything in phase order and writes the deploy record', async () => {
    const { server, store, publisher } = setup();
    const r = await one(publisher.deploy({ outDir: out1, reason: 'test' }));
    expect(r).toMatchObject({
      targetId: 'fake',
      ok: true,
      version: 1,
      uploaded: files1.size,
      deleted: 0,
      httpCheck: 'skipped',
      connections: 1,
      recovered: true,
      reason: 'test',
    });
    expectMirror(server, files1);

    const record = readRecord(server, '/site');
    expect(record).toMatchObject({ format: 'omw-deploy/1', target: 'fake', version: 1 });
    expect(Object.keys(record.files).sort()).toEqual([...files1.keys()].sort());

    // Phase order of the renames that make files visible.
    const renames = server.log.filter((l) => l.startsWith('rename /site/')).map((l) => l.slice('rename /site/'.length));
    const idx = (pred: (p: string) => boolean) => renames.map((p, i) => (pred(p) ? i : -1)).filter((i) => i >= 0);
    const immutable = idx((p) => p.startsWith('media/') || p.startsWith('assets/'));
    const days = idx((p) => p.startsWith('data/days/'));
    const timeline = idx((p) => p === 'data/timeline.json');
    const pages = idx((p) => p.endsWith('.html') || p === 'robots.txt');
    const manifest = idx((p) => p === 'data/manifest.json');
    const recordIdx = idx((p) => p === '.omw-deploy.json.gz');
    const journal = idx((p) => p === '.omw-deploy.pending.json');
    expect(Math.max(...journal)).toBeLessThan(Math.min(...immutable));
    expect(Math.max(...immutable)).toBeLessThan(Math.min(...days));
    expect(Math.max(...days)).toBeLessThan(Math.min(...timeline));
    expect(Math.max(...timeline)).toBeLessThan(Math.min(...pages));
    expect(Math.max(...pages)).toBeLessThan(Math.min(...manifest));
    expect(Math.max(...manifest)).toBeLessThan(Math.min(...recordIdx));

    expect(store.deploys.get('fake').size).toBe(files1.size);
    expect(store.events.recent({ type: 'publish.deploy' })[0]?.data).toMatchObject({ ok: true, version: 1 });
    expect(publisher.getTarget('fake')?.status).toMatchObject({ deployedVersion: 1, lastDeploy: { ok: true } });
    expect(publisher.lastResults()).toHaveLength(1);
  });

  it('a deploy without changes does not connect', async () => {
    const { server, publisher } = setup();
    await one(publisher.deploy({ outDir: out1 }));
    clock.advance(60_000);
    const r = await one(publisher.deploy({ outDir: out1 }));
    expect(r).toMatchObject({ ok: true, uploaded: 0, deleted: 0, connections: 0, unchanged: files1.size });
    expect(server.connections).toBe(1);
  });

  it('incremental deploy: hidden media and removed days go immediately, old assets after the grace period', async () => {
    const { server, publisher } = setup();
    await one(publisher.deploy({ outDir: out1 }));
    clock.advance(60_000);
    const r = await one(publisher.deploy({ outDir: out2 }));
    const old = assetPaths('b1');
    expect(r).toMatchObject({ ok: true, version: 2, deferred: 2 });
    expectMirror(server, files2, [old.js, old.css]);
    for (const m of [...mediaPaths('b'), ...mediaPaths('c')]) expect(server.files.has(`/site/${m}`)).toBe(false);
    expect(server.files.has('/site/de/day/2026-11-18/index.html')).toBe(false);
    // Directories left empty are removed; shared ones stay.
    expect(server.dirs.has('/site/de/day/2026-11-18')).toBe(false);
    expect(server.dirs.has('/site/de/day')).toBe(true);
    const removedMediaDirs = [...mediaPaths('b'), ...mediaPaths('c')].map(
      (m) => `/site/${m.split('/').slice(0, 2).join('/')}`,
    );
    for (const d of removedMediaDirs) {
      const stillUsed = [...files2.keys()].some((p) => `/site/${p}`.startsWith(`${d}/`));
      expect(server.dirs.has(d)).toBe(stillUsed);
    }
    const record = readRecord(server, '/site');
    expect(Object.keys(record.obsoleteSince).sort()).toEqual([old.css, old.js].sort());
    expect(publisher.getTarget('fake')?.status.deferredDeletes).toBe(2);

    // Within the grace period nothing happens; after it the old assets go.
    clock.advance(6 * 24 * 3600_000);
    expect(await one(publisher.deploy({ outDir: out2 }))).toMatchObject({ connections: 0, deferred: 2 });
    clock.advance(2 * 24 * 3600_000);
    const later = await one(publisher.deploy({ outDir: out2 }));
    expect(later).toMatchObject({ ok: true, uploaded: 0, deleted: 2, deferred: 0, connections: 1 });
    expectMirror(server, files2);
  });

  it('recovers the deployed state from the remote record when the local store is lost', async () => {
    const server = new FakeServer();
    const a = setup({ server });
    await one(a.publisher.deploy({ outDir: out1 }));
    a.store.close();
    clock.advance(60_000);
    const b = setup({ server });
    const r = await one(b.publisher.deploy({ outDir: out2 }));
    const unchanged = [...files2].filter(([p, c]) => files1.get(p) === c).length;
    expect(r).toMatchObject({ ok: true, recovered: true, unchanged, uploaded: files2.size - unchanged, deferred: 2 });
    const old = assetPaths('b1');
    expectMirror(server, files2, [old.js, old.css]);
    expect(b.store.deploys.get('fake').size).toBe(files2.size + 2);
  });

  it('a tampered remote record or journal can never make the publisher delete outside its files', async () => {
    const sha = 'a'.repeat(64);
    for (const [name, body] of [
      [
        '.omw-deploy.json',
        {
          format: 'omw-deploy/1',
          target: 'fake',
          version: 1,
          deployedAt: '2026-11-18T00:00:00.000Z',
          files: { '../outside.txt': [sha, 3], 'index.php': [sha, 3] },
          obsoleteSince: {},
        },
      ],
      [
        '.omw-deploy.pending.json',
        {
          format: 'omw-deploy-pending/1',
          target: 'fake',
          startedAt: '2026-11-18T00:00:00.000Z',
          version: 1,
          uploads: ['../outside.txt'],
          deletes: ['../../etc/passwd', 'data/../../outside.txt'],
        },
      ],
    ] as const) {
      const server = new FakeServer();
      server.dirs.add('/site');
      server.files.set('/outside.txt', Buffer.from('foreign'));
      server.files.set('/site/index.php', Buffer.from('<?php // foreign'));
      server.files.set(`/site/${name}`, Buffer.from(JSON.stringify(body)));
      const { store, publisher } = setup({ server });
      const r = await one(publisher.deploy({ outDir: out1 }));
      expect(r, name).toMatchObject({ ok: true, recovered: true, uploaded: files1.size });
      expect(server.files.get('/outside.txt')?.toString(), name).toBe('foreign');
      if (name === '.omw-deploy.pending.json') {
        // Only the journal is invalid here: the foreign index.php is not ours and stays.
        expect(server.files.get('/site/index.php')?.toString(), name).toBe('<?php // foreign');
      }
      expect(
        [...server.files.keys()].filter((p) => !p.startsWith('/site/')),
        name,
      ).toEqual(['/outside.txt']);
      store.close();
    }
  });

  it('unknown target state: uploads everything, deletes known-obsolete media only, never foreign files', async () => {
    const { server, store, publisher } = setup();
    // A capture whose media is not public (not in OUT_DIR) but sits on the server from earlier.
    const sourceKey = waSourceKey('HIDDEN1');
    store.captures.insert({
      sourceKey,
      publicId: await publicIdForSourceKey(sourceKey),
      msgId: 'HIDDEN1',
      source: 'fixture',
      kind: 'photo',
      occurredAt: '2026-11-17T08:00:00Z',
      tz: 'Europe/Berlin',
      media: { mimetype: 'image/jpeg', fileSha256B64: 'AAAA', fileLength: 10 },
    });
    const hidden = 'media/9f/9f00000000000000_w320.avif';
    store.captures.markProcessed(sourceKey, {
      variants: [
        {
          role: 'image',
          variant: 'w320',
          format: 'avif',
          w: 320,
          h: 400,
          relPath: hidden,
          bytes: 3,
          sha256: '0'.repeat(64),
        },
      ],
      processedMeta: {},
    });
    server.dirs.add('/site');
    server.dirs.add('/site/media');
    server.dirs.add('/site/media/9f');
    server.files.set(`/site/${hidden}`, Buffer.from('old'));
    server.files.set('/site/foreign.txt', Buffer.from('not ours'));

    const r = await one(publisher.deploy({ outDir: out1 }));
    expect(r).toMatchObject({ ok: true, recovered: true, uploaded: files1.size, deleted: 1 });
    expect(server.files.has(`/site/${hidden}`)).toBe(false);
    expect(server.files.get('/site/foreign.txt')?.toString()).toBe('not ours');
    expectMirror(server, files1, ['foreign.txt']);
  });

  it('retries transient errors with a fresh connection', async () => {
    const { server, publisher, sleeps } = setup();
    server.failNext = { op: 'write', error: new RemoteError('connection', 'connection reset') };
    const r = await one(publisher.deploy({ outDir: out1 }));
    expect(r).toMatchObject({ ok: true, connections: 2, uploaded: files1.size });
    expect(sleeps).toEqual([2000]);
    expect(r.error).toBeUndefined();
    expectMirror(server, files1);
  });

  it('gives up after maxAttempts transient failures and reports the error', async () => {
    const connect: Connector = async () => {
      throw new RemoteError('connection', 'ECONNREFUSED');
    };
    const { publisher, sleeps } = setup({ connect, maxAttempts: 3 });
    const r = await one(publisher.deploy({ outDir: out1 }));
    expect(r).toMatchObject({ ok: false, errorCode: 'connection', connections: 3, httpCheck: 'skipped' });
    expect(sleeps).toEqual([2000, 8000]);
  });

  it('never retries an authentication failure and blocks the target until it is saved again', async () => {
    const server = new FakeServer();
    let calls = 0;
    let rejectLogin = true;
    const connect: Connector = async () => {
      calls++;
      if (rejectLogin) throw new PublishError('auth', 'SSH authentication failed (test)');
      return server.connect();
    };
    const store = Store.memory({ now: clock });
    const publisher = createPublisher({
      config,
      log: silentLog,
      store,
      env: {},
      connect,
      hashCacheFile: null,
      sleep: async () => {},
      httpCheck: false,
    });
    publisher.saveTarget({ id: 'web', kind: 'sftp', host: 'sftp.example', username: 'u', password: 'wrong' });

    const r1 = await one(publisher.deploy({ outDir: out1 }));
    expect(r1).toMatchObject({ ok: false, errorCode: 'auth', connections: 1 });
    expect(calls).toBe(1);
    expect(publisher.getTarget('web')?.status.authBlocked?.message).toMatch(/authentication failed/);

    const r2 = await one(publisher.deploy({ outDir: out1 }));
    expect(r2).toMatchObject({ ok: false, errorCode: 'auth_blocked', connections: 0 });
    expect(await publisher.testTarget('web')).toMatchObject({ ok: false, detail: expect.stringMatching(/blocked/) });
    expect(calls).toBe(1);

    rejectLogin = false;
    publisher.saveTarget({ id: 'web', kind: 'sftp', host: 'sftp.example', username: 'u', password: 'right' });
    expect(publisher.getTarget('web')?.status.authBlocked).toBeNull();
    const r3 = await one(publisher.deploy({ outDir: out1 }));
    expect(r3).toMatchObject({ ok: true, connections: 1 });
    store.close();
  });

  it('host key problems are not retried', async () => {
    let calls = 0;
    const connect: Connector = async () => {
      calls++;
      throw new PublishError('host_key', 'Host key mismatch (test)');
    };
    const { publisher } = setup({ connect });
    const r = await one(publisher.deploy({ outDir: out1 }));
    expect(r).toMatchObject({ ok: false, errorCode: 'host_key' });
    expect(calls).toBe(1);
  });

  it('refuses to deploy an OUT_DIR without a valid manifest', async () => {
    const { server, publisher } = setup();
    rmSync(join(out1, 'data', 'manifest.json'));
    const r = await one(publisher.deploy({ outDir: out1 }));
    expect(r).toMatchObject({ ok: false, errorCode: 'not_generated', connections: 0, version: null });
    expect(server.connections).toBe(0);
  });

  it('aborts before the manifest switches when OUT_DIR changes during the deploy', async () => {
    const server = new FakeServer();
    let mutate = false;
    const connect: Connector = async () => {
      if (mutate) {
        mutate = false;
        writeFileSync(
          join(out2, 'data', 'timeline.json'),
          `${readFileSync(join(out2, 'data', 'timeline.json'), 'utf8')} `,
        );
      }
      return server.connect();
    };
    const { publisher } = setup({ server, connect });
    await one(publisher.deploy({ outDir: out1 }));
    mutate = true;
    clock.advance(1000);
    const r = await one(publisher.deploy({ outDir: out2 }));
    expect(r).toMatchObject({ ok: false, errorCode: 'out_dir_changed' });
    const live = server.siteFiles('/site');
    expect(live.get('data/manifest.json')?.toString()).toBe(files1.get('data/manifest.json'));
    expect(referenceProblems(live)).toEqual([]);

    clock.advance(1000);
    const again = await one(publisher.deploy({ outDir: out2 }));
    expect(again.ok).toBe(true);
    expect(server.files.get('/site/data/timeline.json')?.toString()).toBe(`${files2.get('data/timeline.json')} `);
  });

  it('single flight: concurrent calls coalesce into one follow-up run', async () => {
    const server = new FakeServer();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const connect: Connector = async () => {
      await gate;
      return server.connect();
    };
    const { publisher } = setup({ server, connect });
    const p1 = publisher.deploy({ outDir: out1 });
    expect(publisher.busy()).toBe(true);
    const p2 = publisher.deploy({ outDir: out1 });
    const p3 = publisher.deploy({ outDir: out1, reason: 'third' });
    expect(p2).toBe(p3);
    release();
    const [r1] = await p1;
    const [r2] = await p2;
    expect(r1?.uploaded).toBe(files1.size);
    expect(r2).toMatchObject({ ok: true, uploaded: 0, connections: 0, reason: 'third' });
    expect(publisher.busy()).toBe(false);
    expect(server.connections).toBe(1);
  });

  it('a deploy lock held by another live process makes the deploy fail fast', async () => {
    const { server, store, publisher } = setup();
    store.meta.set(
      'publisher.lock.fake',
      JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other', refreshedAt: new Date().toISOString() }),
    );
    const r = await one(publisher.deploy({ outDir: out1 }));
    expect(r).toMatchObject({ ok: false, errorCode: 'busy', connections: 0 });
    expect(server.connections).toBe(0);
    // A stale lock is taken over.
    store.meta.set(
      'publisher.lock.fake',
      JSON.stringify({ pid: process.ppid, host: hostname(), token: 'other', refreshedAt: '2020-01-01T00:00:00.000Z' }),
    );
    expect((await one(publisher.deploy({ outDir: out1 }))).ok).toBe(true);
    expect(store.meta.get('publisher.lock.fake')).toBeUndefined();
  });

  it('a fresh lock left by a killed predecessor with the SAME pid and host (container restart) is taken over', async () => {
    const { store, publisher } = setup();
    // Docker: tini is pid 1 and node its first child, so the restarted process reuses the pid.
    store.meta.set(
      'publisher.lock.fake',
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        instance: 'previous-incarnation',
        token: `${process.pid}-old`,
        refreshedAt: new Date().toISOString(),
      }),
    );
    const r = await one(publisher.deploy({ outDir: out1 }));
    expect(r).toMatchObject({ ok: true, version: 1 });
    expect(store.meta.get('publisher.lock.fake')).toBeUndefined();
  });

  it('a lock held by another publisher in this same process still counts as busy', async () => {
    const { store, publisher } = setup();
    const { TargetStateRepo } = await import('../../src/publisher/state.js');
    const held = new TargetStateRepo(store).acquireLock('fake');
    expect(held).not.toBeNull();
    try {
      expect(await one(publisher.deploy({ outDir: out1 }))).toMatchObject({ ok: false, errorCode: 'busy' });
    } finally {
      held?.release();
    }
    expect((await one(publisher.deploy({ outDir: out1 }))).ok).toBe(true);
  });

  it('servers without posix-rename: delete + rename fallback converges', async () => {
    const { server, publisher } = setup({ server: new FakeServer({ atomicReplace: false }) });
    await one(publisher.deploy({ outDir: out1 }));
    clock.advance(1000);
    expect((await one(publisher.deploy({ outDir: out2 }))).ok).toBe(true);
    const old = assetPaths('b1');
    expectMirror(server, files2, [old.js, old.css]);
  });

  it('full deploy re-uploads every file', async () => {
    const { publisher } = setup();
    await one(publisher.deploy({ outDir: out1 }));
    const r = await one(publisher.deploy({ outDir: out1, full: true }));
    expect(r).toMatchObject({ ok: true, uploaded: files1.size, unchanged: 0 });
  });

  it('dry-run plan reads the remote record but never changes local state', async () => {
    const server = new FakeServer();
    const a = setup({ server });
    await one(a.publisher.deploy({ outDir: out1 }));
    const b = setup({ server });
    const [offline] = await b.publisher.plan({ outDir: out2, offline: true });
    expect(offline).toMatchObject({ remoteKnown: false, deletes: [] });
    expect(offline?.uploads).toHaveLength(files2.size);
    const connectionsBefore = server.connections;
    const [online] = await b.publisher.plan({ outDir: out2 });
    expect(server.connections).toBe(connectionsBefore + 1);
    expect(online?.remoteKnown).toBe(true);
    expect(online?.deletes).toContain('data/days/2026-11-18.json');
    expect(online?.deferred.map((d) => d.path).sort()).toEqual(Object.values(assetPaths('b1')).sort());
    expect(b.store.deploys.get('fake').size).toBe(0);
    expect(b.store.meta.get('publisher.target.fake')).toBeUndefined();
  });

  it('HTTP check compares the public manifest version', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    let body: unknown = { version: 1 };
    let status = 200;
    const fetch = async (url: string, init?: RequestInit) => {
      seen.push({ url, ...(init ? { init } : {}) });
      return new Response(JSON.stringify(body), { status });
    };
    const target = sftpTarget('fake', { remoteRoot: '/site', publicBaseUrl: 'https://example.test/travel/' });
    const { publisher } = setup({ target, fetch });
    expect(await one(publisher.deploy({ outDir: out1 }))).toMatchObject({ httpCheck: 'ok', httpDetail: 'version 1' });
    expect(seen[0]?.url).toBe(`https://example.test/travel/data/manifest.json?t=${clock().getTime()}`);
    expect(seen[0]?.init?.cache).toBe('no-store');

    body = { version: 1 };
    clock.advance(1000);
    expect(await one(publisher.deploy({ outDir: out2 }))).toMatchObject({
      ok: true,
      httpCheck: 'mismatch',
      httpDetail: 'expected version 2, got 1',
    });
    status = 404;
    expect(await one(publisher.deploy({ outDir: out2 }))).toMatchObject({ httpCheck: 'error', httpDetail: 'HTTP 404' });
  });

  describe('mass-delete guard (L2-02 c)', () => {
    const bigDays: Record<string, string[]> = {};
    for (let d = 1; d <= 8; d++) bigDays[`2026-11-0${d}`] = [`i${d}a`, `i${d}b`];

    it('refuses a deploy that deletes every day file; --force passes', async () => {
      const { server, publisher } = setup();
      expect((await one(publisher.deploy({ outDir: out1 }))).ok).toBe(true);
      const empty = join(tmp.dir, 'empty');
      writeSite(empty, { version: 2, build: 'b1', days: {} });
      const before = new Map(server.files);
      const r = await one(publisher.deploy({ outDir: empty }));
      expect(r).toMatchObject({ ok: false, errorCode: 'refused' });
      expect(r.error).toMatch(/^refused: would delete \d+ of 21 remote files; use backend publish --force$/);
      expect(r.deleted).toBe(0);
      expect(server.files).toEqual(before); // nothing touched on the target
      const forced = await one(publisher.deploy({ outDir: empty, force: true }));
      expect(forced).toMatchObject({ ok: true });
      expect([...server.siteFiles('/site').keys()].some((p) => p.startsWith('data/days/'))).toBe(false);
    });

    it('refuses a deploy that deletes at least half of a record with more than 20 files', async () => {
      const { server, publisher } = setup();
      const big = join(tmp.dir, 'big');
      const bigFiles = writeSite(big, { version: 1, build: 'b1', days: bigDays });
      expect((await one(publisher.deploy({ outDir: big }))).ok).toBe(true);
      // Keep 2 of 8 days: most media and pages would go, but a day file stays.
      const small = join(tmp.dir, 'small');
      writeSite(small, {
        version: 2,
        build: 'b1',
        days: { '2026-11-01': bigDays['2026-11-01'] ?? [], '2026-11-02': bigDays['2026-11-02'] ?? [] },
      });
      const [plan] = await publisher.plan({ outDir: small });
      expect(plan?.refusal).toContain(`refused: would delete`);
      const r = await one(publisher.deploy({ outDir: small }));
      expect(r).toMatchObject({ ok: false, errorCode: 'refused' });
      expect(r.error).toContain(`of ${bigFiles.size} remote files`);
      expect(server.siteFiles('/site').size).toBe(bigFiles.size);
      // Removing one day (a normal hide) is far below the threshold.
      const most = join(tmp.dir, 'most');
      const { '2026-11-08': _dropped, ...seven } = bigDays;
      writeSite(most, { version: 3, build: 'b1', days: seven });
      expect(await one(publisher.deploy({ outDir: most }))).toMatchObject({ ok: true, deleted: 7 });
      expect(await one(publisher.deploy({ outDir: small, force: true }))).toMatchObject({ ok: true });
    });

    it('also guards a target whose state is recovered from its record (lost store)', async () => {
      const server = new FakeServer();
      const a = setup({ server });
      expect((await one(a.publisher.deploy({ outDir: out1 }))).ok).toBe(true);
      const b = setup({ server });
      const empty = join(tmp.dir, 'empty2');
      writeSite(empty, { version: 7, build: 'b1', days: {} });
      expect(await one(b.publisher.deploy({ outDir: empty }))).toMatchObject({ ok: false, errorCode: 'refused' });
      expect(server.siteFiles('/site').size).toBe(files1.size);
    });
  });

  describe('site version continuity (L2-02 d)', () => {
    it('a lost store never deploys a lower version: refused, floor raised; versionFloor() reads the target', async () => {
      const server = new FakeServer();
      const a = setup({ server });
      const v5 = join(tmp.dir, 'v5');
      writeSite(v5, { ...V1, version: 5 });
      expect((await one(a.publisher.deploy({ outDir: v5 }))).ok).toBe(true);
      expect(await a.publisher.versionFloor()).toBe(5); // known locally: no connection needed
      const b = setup({ server });
      const connections = server.connections;
      expect(await b.publisher.versionFloor()).toBe(5); // read from the target
      expect(server.connections).toBe(connections + 1);
      // OUT_DIR generated by the fresh store with version 1 (same content): refused, floor raised
      const r = await one(b.publisher.deploy({ outDir: out1 }));
      expect(r).toMatchObject({ ok: false, errorCode: 'version_behind' });
      expect(b.store.meta.siteVersion()).toBe(5);
      expect(b.store.meta.nextSiteVersion()).toBe(6);
      expect(server.siteFiles('/site').get('data/manifest.json')?.toString()).toContain('"version":5');
      // the regenerated site (version 6) deploys
      const v6 = join(tmp.dir, 'v6');
      writeSite(v6, { ...V1, version: 6 });
      expect(await one(b.publisher.deploy({ outDir: v6 }))).toMatchObject({ ok: true, version: 6, recovered: true });
    });

    it('the same version with other content is behind: the floor exceeds the local release', async () => {
      const server = new FakeServer();
      const a = setup({ server });
      expect((await one(a.publisher.deploy({ outDir: out1 }))).ok).toBe(true);
      // A fresh store (target unreachable at startup) released its own version 1 with other bytes.
      const b = setup({ server });
      expect(b.store.meta.nextSiteVersion()).toBe(1);
      const otherDays = { '2026-11-17': ['a'], '2026-11-20': ['z'] };
      const other = join(tmp.dir, 'other-v1');
      writeSite(other, { version: 1, build: 'b9', days: otherDays });
      // The dry run says so too (it used to promise an upload the deploy then refused).
      const [plan] = await b.publisher.plan({ outDir: other });
      expect(plan?.refusal).toBe('the target serves site version 1, OUT_DIR has 1: regenerating above it');
      expect(b.store.meta.siteVersion()).toBe(1);
      const r = await one(b.publisher.deploy({ outDir: other }));
      expect(r).toMatchObject({ ok: false, errorCode: 'version_behind' });
      // Above the local release 1, so the generator re-releases (floor > state.version) ...
      expect(b.store.meta.siteVersion()).toBe(2);
      expect(server.siteFiles('/site').get('data/manifest.json')?.toString()).toBe(files1.get('data/manifest.json'));
      // ... and that release deploys.
      const next = b.store.meta.nextSiteVersion();
      const v = join(tmp.dir, 'other-next');
      writeSite(v, { version: next, build: 'b9', days: otherDays });
      expect(await one(b.publisher.deploy({ outDir: v }))).toMatchObject({ ok: true, version: next });
    });

    it('the same version with identical content is not "behind" (target re-added)', async () => {
      const server = new FakeServer();
      const a = setup({ server });
      expect((await one(a.publisher.deploy({ outDir: out1 }))).ok).toBe(true);
      const b = setup({ server });
      expect(await one(b.publisher.deploy({ outDir: out1 }))).toMatchObject({ ok: true, uploaded: 0 });
    });
  });

  describe('gzip deploy record (L2-05)', () => {
    it('round-trips, recovers from the gz and from a legacy .json record, removes the legacy file', async () => {
      const server = new FakeServer();
      const a = setup({ server });
      expect((await one(a.publisher.deploy({ outDir: out1 }))).ok).toBe(true);
      const gz = server.files.get('/site/.omw-deploy.json.gz') as Buffer;
      expect(gz.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
      const rec = decodeRecord(gz) as { files: Record<string, unknown> };
      expect(decodeRecord(encodeRecord(rec as never))).toEqual(rec);
      expect(gz.length).toBeLessThan(JSON.stringify(rec).length);

      // An older backend left only the uncompressed record: recovery reads it ...
      server.files.delete('/site/.omw-deploy.json.gz');
      server.files.set('/site/.omw-deploy.json', Buffer.from(JSON.stringify(rec)));
      const b = setup({ server });
      const r = await one(b.publisher.deploy({ outDir: out2 }));
      const unchanged = [...files2].filter(([p, c]) => files1.get(p) === c).length;
      expect(r).toMatchObject({ ok: true, recovered: true, unchanged });
      // ... and after the first .gz write it is gone
      expect(server.files.has('/site/.omw-deploy.json')).toBe(false);
      expect(server.files.has('/site/.omw-deploy.json.gz')).toBe(true);

      // A third store recovers from the gz record.
      const c = setup({ server });
      const again = await one(c.publisher.deploy({ outDir: out2 }));
      expect(again).toMatchObject({ ok: true, recovered: true, uploaded: 0, unchanged: files2.size });
    });

    it('does not re-upload an unchanged record', async () => {
      const { server, publisher } = setup();
      expect((await one(publisher.deploy({ outDir: out1 }))).ok).toBe(true);
      const writes = () => server.log.filter((l) => l === 'write /site/.omw-tmp..omw-deploy.json.gz').length;
      expect(writes()).toBe(1);
      clock.advance(60_000);
      // full: every file is uploaded again, but the record content is the same
      expect(await one(publisher.deploy({ outDir: out1, full: true }))).toMatchObject({ ok: true });
      expect(writes()).toBe(1);
      expect(await one(publisher.deploy({ outDir: out2 }))).toMatchObject({ ok: true });
      expect(writes()).toBe(2);
    });
  });

  it('local folder target: same algorithm on a directory', async () => {
    const dir = join(tmp.dir, 'www');
    const store = Store.memory({ now: clock });
    // L1-09: target modes are explicit (0644/0755), never the umask or the local file's mode.
    const umask = process.umask(0o077);
    try {
      const publisher = createPublisher({
        config,
        log: silentLog,
        store,
        targets: staticTargets([localTarget('www', dir)]),
        hashCacheFile: join(tmp.dir, 'state', 'publisher', 'hash-cache.json'),
        httpCheck: false,
      });
      expect((await one(publisher.deploy({ outDir: out1 }))).ok).toBe(true);
      clock.advance(1000);
      expect((await one(publisher.deploy({ outDir: out2 }))).ok).toBe(true);
      const tree = listTree(dir);
      const old = assetPaths('b1');
      expect(tree.filter((p) => !p.startsWith('.omw-')).sort()).toEqual([...files2.keys(), old.js, old.css].sort());
      expect(tree).toContain('.omw-deploy.json.gz');
      expect(tree).not.toContain('.omw-deploy.json');
      expect(tree.some((p) => p.includes('.omw-tmp.'))).toBe(false);
      for (const [p, c] of files2) expect(readFileSync(join(dir, p), 'utf8')).toBe(c);
      expect(statSync(join(dir, 'de', 'index.html')).mode & 0o777).toBe(0o644);
      for (const p of tree) expect((statSync(join(dir, p)).mode & 0o777).toString(8), p).toBe('644');
      for (const d of ['de', 'de/day', 'data', 'media', 'assets']) {
        expect((statSync(join(dir, d)).mode & 0o777).toString(8), d).toBe('755');
      }
      expect(existsSync(join(dir, 'de', 'day', '2026-11-18'))).toBe(false);
      expect(existsSync(join(tmp.dir, 'state', 'publisher', 'hash-cache.json'))).toBe(true);
    } finally {
      process.umask(umask);
      store.close();
    }
  });
});

function listTree(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(root, p));
    }
  };
  walk(root);
  return out;
}
