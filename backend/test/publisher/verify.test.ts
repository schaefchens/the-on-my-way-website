/**
 * Regression tests added by the independent verification of the publisher (B4a):
 * scenarios the builder's suites did not cover.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { createPublisher, type DeployResult, decodeRecord, encodeRecord } from '../../src/publisher/index.js';
import type { DeployRecord as DeployRecordJson } from '../../src/publisher/record.js';
import { Store } from '../../src/store/index.js';
import { fakeClock, makeTempDir } from '../helpers.js';
import { FakeServer } from './fakeRemote.js';
import { sftpTarget, silentLog, staticTargets, testConfig } from './helpers.js';
import { mediaPaths, referenceProblems, type SiteSpec, writeSite } from './site.js';

const V1: SiteSpec = { version: 1, build: 'b1', days: { '2026-11-17': ['a'] } };
const V2: SiteSpec = { version: 2, build: 'b1', days: { '2026-11-17': ['a'], '2026-11-18': ['e'] } };
/** e is hidden again. */
const V3: SiteSpec = { version: 3, build: 'b1', days: { '2026-11-17': ['a'] } };

describe('publisher: verification regressions', () => {
  let tmp: ReturnType<typeof makeTempDir>;
  let config: Config;
  const clock = fakeClock();
  /** Real time moves on during a deploy: every reading of this clock advances it by 1 ms. */
  const ticking = Object.assign(
    () => {
      clock.advance(1);
      return clock();
    },
    { advance: clock.advance },
  );

  beforeEach(() => {
    clock.set('2026-11-19T10:00:00.000Z');
    tmp = makeTempDir('publisher-verify-');
    config = testConfig(tmp.dir);
  });
  afterEach(() => tmp.cleanup());

  function publisherFor(server: FakeServer, store: Store) {
    return createPublisher({
      config,
      log: silentLog,
      store,
      targets: staticTargets([sftpTarget('t', { remoteRoot: '/www', concurrency: 1 })]),
      connect: async () => server.connect(),
      hashCacheFile: null,
      maxAttempts: 1,
      httpCheck: false,
    });
  }

  async function deployOnce(server: FakeServer, store: Store, outDir: string): Promise<DeployResult> {
    const [r] = await publisherFor(server, store).deploy({ outDir });
    return r as DeployResult;
  }

  it('two interrupted deploys, then the local state is lost: media confirmed by the first is still cleaned up', async () => {
    const out1 = join(tmp.dir, 'out1');
    const out2 = join(tmp.dir, 'out2');
    const out3 = join(tmp.dir, 'out3');
    writeSite(out1, V1);
    writeSite(out2, V2);
    const files3 = writeSite(out3, V3);
    const hidden = mediaPaths('e');

    // Reference run: the index of the first data/ rename = every immutable file is confirmed.
    const ref = new FakeServer();
    const refStore = Store.memory({ now: ticking });
    expect((await deployOnce(ref, refStore, out1)).ok).toBe(true);
    const before = ref.mutations;
    expect((await deployOnce(ref, refStore, out2)).ok).toBe(true);
    const firstData = ref.log.slice(before).findIndex((l) => l.startsWith('rename /www/data/'));
    expect(firstData).toBeGreaterThan(0);
    refStore.close();

    const server = new FakeServer();
    const store = Store.memory({ now: ticking });
    expect((await deployOnce(server, store, out1)).ok).toBe(true);
    clock.advance(1000);

    // 1st interruption: after e's media are live and confirmed, before the deploy record is written.
    server.crashAt(firstData + 1, false);
    expect((await deployOnce(server, store, out2)).ok).toBe(false);
    for (const m of hidden) expect(server.files.has(`/www/${m}`)).toBe(true);
    server.clearCrash();
    clock.advance(1000);

    // 2nd interruption, same store: right after its journal is written (2 mutations).
    server.crashAt(3, false);
    expect((await deployOnce(server, store, out2)).ok).toBe(false);
    server.clearCrash();
    clock.advance(1000);
    store.close();

    // The backend lost its store; meanwhile e was hidden.
    const fresh = Store.memory({ now: ticking });
    const r = await deployOnce(server, fresh, out3);
    expect(r.ok, r.error).toBe(true);
    for (const m of hidden) expect(server.files.has(`/www/${m}`), m).toBe(false);
    const live = server.siteFiles('/www');
    for (const [p, c] of files3) expect(live.get(p)?.toString(), p).toBe(c);
    expect(referenceProblems(live)).toEqual([]);
    fresh.close();
  });

  it('sweep: any two interruptions in a row, lost store, item hidden meanwhile -> converges, hidden media gone', async () => {
    const out1 = join(tmp.dir, 'out1');
    const out2 = join(tmp.dir, 'out2');
    const out3 = join(tmp.dir, 'out3');
    writeSite(out1, V1);
    writeSite(out2, V2);
    const files3 = writeSite(out3, V3);
    const hidden = mediaPaths('e');

    const ref = new FakeServer();
    const refStore = Store.memory({ now: ticking });
    expect((await deployOnce(ref, refStore, out1)).ok).toBe(true);
    const before = ref.mutations;
    expect((await deployOnce(ref, refStore, out2)).ok).toBe(true);
    const total = ref.mutations - before;
    refStore.close();

    let runs = 0;
    for (let k1 = 1; k1 <= total; k1++) {
      for (const k2 of [1, 2, 3, 4, 5, 8, 13]) {
        for (const applied of [false, true]) {
          const label = `k1=${k1}/${total} k2=${k2} applied=${applied}`;
          const server = new FakeServer();
          const store = Store.memory({ now: ticking });
          expect((await deployOnce(server, store, out1)).ok, label).toBe(true);
          clock.advance(1000);
          server.crashAt(k1, applied);
          expect((await deployOnce(server, store, out2)).ok, label).toBe(false);
          server.clearCrash();
          clock.advance(1000);
          server.crashAt(k2, applied);
          const second = await deployOnce(server, store, out2);
          server.clearCrash();
          clock.advance(1000);
          store.close();
          if (second.ok) continue; // the second deploy finished before mutation k2

          const fresh = Store.memory({ now: ticking });
          const r = await deployOnce(server, fresh, out3);
          expect(r.ok, `${label}: ${r.error ?? ''}`).toBe(true);
          const live = server.siteFiles('/www');
          expect([...live.keys()].sort(), label).toEqual([...files3.keys()].sort());
          for (const [p, c] of files3) expect(live.get(p)?.toString(), `${label}: ${p}`).toBe(c);
          for (const m of hidden) expect(server.files.has(`/www/${m}`), `${label}: ${m}`).toBe(false);
          const leftovers = [...server.siteFiles('/www', { includeBookkeeping: true }).keys()].filter(
            (p) => p.includes('.omw-tmp.') || p === '.omw-deploy.pending.json',
          );
          expect(leftovers, label).toEqual([]);
          fresh.close();
          runs++;
        }
      }
    }
    expect(runs).toBeGreaterThan(total * 4);
  }, 120_000);

  it('recovered state never trusts the record clock: a crash after a recovered deploy is still reconciled', async () => {
    const out1 = join(tmp.dir, 'out1');
    const out2 = join(tmp.dir, 'out2');
    const files1 = writeSite(out1, V1);
    writeSite(out2, V2);
    const future = (server: FakeServer) => {
      const raw = server.files.get('/www/.omw-deploy.json.gz');
      if (!raw) throw new Error('no record');
      const rec = decodeRecord(raw) as DeployRecordJson;
      rec.deployedAt = '9999-12-31T00:00:00.000Z'; // another machine's clock, or hand-edited
      server.files.set('/www/.omw-deploy.json.gz', encodeRecord(rec));
    };

    // Reference: position of the timeline rename in a recovered V1 -> V2 deploy.
    const ref = new FakeServer();
    const refA = Store.memory({ now: ticking });
    expect((await deployOnce(ref, refA, out1)).ok).toBe(true);
    future(ref);
    const refB = Store.memory({ now: ticking });
    const before = ref.mutations;
    expect((await deployOnce(ref, refB, out2)).ok).toBe(true);
    const idx = ref.log.slice(before).indexOf('rename /www/data/timeline.json');
    expect(idx).toBeGreaterThan(0);
    refA.close();
    refB.close();

    const server = new FakeServer();
    const storeA = Store.memory({ now: ticking });
    expect((await deployOnce(server, storeA, out1)).ok).toBe(true);
    storeA.close();
    future(server);
    const storeB = Store.memory({ now: ticking });
    // The rename is applied, the reply is lost: the new timeline is live, the store never heard of it.
    server.crashAt(idx + 1, true);
    expect((await deployOnce(server, storeB, out2)).ok).toBe(false);
    server.clearCrash();
    clock.advance(1000);
    // The site goes back to V1: the timeline must be re-uploaded although the store's hash matches.
    const r = await deployOnce(server, storeB, out1);
    expect(r.ok, r.error).toBe(true);
    const live = server.siteFiles('/www');
    for (const [p, c] of files1) expect(live.get(p)?.toString(), p).toBe(c);
    storeB.close();
  });

  it('temp files of a crashed generator/pipeline run in OUT_DIR are never published', async () => {
    const out = join(tmp.dir, 'out');
    writeSite(out, V1);
    mkdirSync(join(out, 'data', 'days'), { recursive: true });
    writeFileSync(join(out, 'data', 'days', '2026-11-18.json.tmp-1-7'), '{"stale":true}');
    mkdirSync(join(out, 'media', 'ab'), { recursive: true });
    writeFileSync(join(out, 'media', 'ab', '0123456789abcdef_w320.avif.tmp-1-0a1b2c3d'), 'partial');
    const server = new FakeServer();
    const store = Store.memory({ now: clock });
    const r = await deployOnce(server, store, out);
    expect(r.ok, r.error).toBe(true);
    const names = [...server.siteFiles('/www').keys()];
    expect(names.filter((p) => p.includes('.tmp-'))).toEqual([]);
    store.close();
  });

  it('writer temp names: generator, pipeline and fsutil patterns only', async () => {
    const { isWriterTemp } = await import('../../src/publisher/scan.js');
    for (const n of ['2026-11-18.json.tmp-12-3', 'x_w320.avif.tmp-7-0a1b2c3d-ffee0011', 'targets.json.tmp-99']) {
      expect(isWriterTemp(n), n).toBe(true);
    }
    for (const n of ['2026-11-18.json', 'app-1a2b3c4d.js', 'index.html', 'x.tmp-1.js', 'notes.tmp', 'a.tmp-x']) {
      expect(isWriterTemp(n), n).toBe(false);
    }
  });
});

describe('publisher: local targets never write into the backend state directories', () => {
  it('refuses a local target dir that contains MEDIA_DIR (deletes would hit the media store)', async () => {
    const { mkdirSync: mk, writeFileSync: wr, existsSync } = await import('node:fs');
    const t = makeTempDir('publisher-verify-local-');
    try {
      const config = testConfig(t.dir, { MEDIA_DIR: join(t.dir, 'm', 'media') });
      const out = join(t.dir, 'out');
      writeSite(out, V1);
      const variant = 'media/ab/0123456789abcdef_w320.avif';
      mk(join(t.dir, 'm', 'media', 'ab'), { recursive: true });
      wr(join(t.dir, 'm', variant), 'processed variant of a hidden capture');
      const store = Store.memory();
      const publisher = createPublisher({
        config,
        log: silentLog,
        store,
        hashCacheFile: null,
        httpCheck: false,
        env: {},
      });
      expect(() => publisher.saveTarget({ id: 'preview', kind: 'local', dir: join(t.dir, 'm') })).toThrow(
        /MEDIA_DIR|state/,
      );
      expect(publisher.listTargets()).toEqual([]);
      expect(existsSync(join(t.dir, 'm', variant))).toBe(true);
      store.close();
    } finally {
      t.cleanup();
    }
  });
});

describe('publisher: target bootstrap from an invalid environment', () => {
  it('warns once per process, not on every list() (the control UI polls the targets)', async () => {
    const pino = (await import('pino')).default;
    const { TargetStore } = await import('../../src/publisher/targets.js');
    const t = makeTempDir('publisher-verify-boot-');
    try {
      const lines: string[] = [];
      const log = pino({ level: 'warn' }, { write: (s: string) => void lines.push(s) });
      const ts = new TargetStore({
        file: join(t.dir, 'config', 'targets.json'),
        configDir: join(t.dir, 'config'),
        baseDir: t.dir,
        outDir: join(t.dir, 'out'),
        env: { SFTP_HOST: 'h.example', SFTP_USER: 'u' },
        log,
        now: () => new Date(),
      });
      for (let i = 0; i < 5; i++) expect(ts.list()).toEqual([]);
      expect(lines.filter((l) => l.includes('ignoring SFTP_* environment'))).toHaveLength(1);
    } finally {
      t.cleanup();
    }
  });
});
