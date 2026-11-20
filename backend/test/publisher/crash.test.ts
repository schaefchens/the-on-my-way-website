/**
 * Crash safety (plan phase 1: "kill -9 during a deploy leaves the site consistent and the next
 * deploy completes it"). For every mutating remote operation k of an incremental deploy, the
 * deploy is killed at k (the operation either not applied, or applied with the reply lost); then:
 *
 *   - the target must be consistent: every file referenced by a page, the timeline, a day file or
 *     the manifest exists; and when the new manifest is live, every new file is live too;
 *   - a restarted publisher (same store = process restart; or a fresh store = lost local state)
 *     completes the deploy: the target mirrors OUT_DIR (+ old assets in their grace period), no
 *     temp files or journal remain, and media of hidden items is gone.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { createPublisher, type DeployResult } from '../../src/publisher/index.js';
import { Store } from '../../src/store/index.js';
import { fakeClock, makeTempDir } from '../helpers.js';
import { FakeServer } from './fakeRemote.js';
import { sftpTarget, silentLog, staticTargets, testConfig } from './helpers.js';
import { assetPaths, manifestProblems, mediaPaths, referenceProblems, type SiteSpec, writeSite } from './site.js';

const V1: SiteSpec = {
  version: 1,
  build: 'b1',
  days: { '2026-11-16': ['x'], '2026-11-17': ['a', 'b'], '2026-11-18': ['c'] },
};
const V2: SiteSpec = {
  version: 2,
  build: 'b2',
  days: { '2026-11-16': ['x'], '2026-11-17': ['a', 'd'], '2026-11-19': ['e', 'f'] },
};
const HIDDEN_MEDIA = [...mediaPaths('b'), ...mediaPaths('c')];
const OLD_ASSETS = Object.values(assetPaths('b1'));

describe('crash safety', () => {
  let tmp: ReturnType<typeof makeTempDir>;
  let config: Config;
  let out1: string;
  let out2: string;
  let files2: Map<string, string>;

  beforeAll(() => {
    tmp = makeTempDir('publisher-crash-');
    config = testConfig(tmp.dir);
    out1 = join(tmp.dir, 'out1');
    out2 = join(tmp.dir, 'out2');
    writeSite(out1, V1);
    files2 = writeSite(out2, V2);
  });
  afterAll(() => tmp.cleanup());

  function publisherFor(server: FakeServer, store: Store) {
    return createPublisher({
      config,
      log: silentLog,
      store,
      targets: staticTargets([sftpTarget('t', { remoteRoot: '/www', concurrency: 3 })]),
      connect: async () => server.connect(),
      hashCacheFile: null,
      maxAttempts: 1, // a kill is not retried within the same process
      httpCheck: false,
    });
  }

  async function deployOnce(server: FakeServer, store: Store, outDir: string): Promise<DeployResult> {
    const [r] = await publisherFor(server, store).deploy({ outDir });
    return r as DeployResult;
  }

  /** V1 fully deployed; returns the server and store, clock advanced. */
  async function baseline(atomic: boolean) {
    const clock = fakeClock('2026-11-19T10:00:00.000Z');
    const server = new FakeServer({ atomicReplace: atomic });
    const store = Store.memory({ now: clock });
    const r = await deployOnce(server, store, out1);
    expect(r.ok).toBe(true);
    clock.advance(60_000);
    return { server, store, clock };
  }

  function assertConsistent(server: FakeServer, atomic: boolean, label: string) {
    const live = server.siteFiles('/www');
    if (atomic) {
      expect(referenceProblems(live), label).toEqual([]);
    } else {
      // delete+rename fallback: a file may be briefly missing, but then its complete temp copy exists.
      const withTmp = new Map(live);
      for (const [p, b] of server.siteFiles('/www', { includeBookkeeping: true })) {
        const m = /^(.*?)\.omw-tmp\.(.+)$/.exec(p);
        if (m) {
          const real = `${m[1]}${m[2]}`;
          if (!withTmp.has(real)) withTmp.set(real, b);
        }
      }
      expect(referenceProblems(withTmp), label).toEqual([]);
    }
    expect(manifestProblems(live, files2), label).toEqual([]);
  }

  function assertComplete(server: FakeServer, label: string) {
    const live = server.siteFiles('/www');
    const want = [...files2.keys(), ...OLD_ASSETS].sort();
    expect([...live.keys()].sort(), label).toEqual(want);
    for (const [p, c] of files2) expect(live.get(p)?.toString(), `${label}: ${p}`).toBe(c);
    for (const m of HIDDEN_MEDIA) expect(server.files.has(`/www/${m}`), `${label}: ${m}`).toBe(false);
    const leftovers = [...server.siteFiles('/www', { includeBookkeeping: true }).keys()].filter(
      (p) => p.includes('.omw-tmp.') || p === '.omw-deploy.pending.json',
    );
    expect(leftovers, label).toEqual([]);
    expect(server.files.has('/www/.omw-deploy.json.gz'), label).toBe(true);
    expect(server.files.has('/www/.omw-deploy.json'), label).toBe(false);
  }

  for (const atomic of [true, false]) {
    it(`kill at every step (${atomic ? 'posix-rename' : 'delete+rename fallback'}) keeps the site consistent; restart completes`, async () => {
      // Count the mutations of a clean V1 -> V2 deploy.
      const ref = await baseline(atomic);
      const before = ref.server.mutations;
      expect((await deployOnce(ref.server, ref.store, out2)).ok).toBe(true);
      assertComplete(ref.server, 'reference run');
      const total = ref.server.mutations - before;
      expect(total).toBeGreaterThan(40);

      let checked = 0;
      for (const applied of [false, true]) {
        for (let k = 1; k <= total; k++) {
          for (const restart of ['same-store', 'lost-store'] as const) {
            const label = `k=${k}/${total} applied=${applied} ${restart}`;
            const { server, store, clock } = await baseline(atomic);
            server.crashAt(k, applied);
            const crashed = await deployOnce(server, store, out2);
            expect(crashed.ok, label).toBe(false);
            assertConsistent(server, atomic, label);

            server.clearCrash();
            clock.advance(1000);
            const nextStore = restart === 'same-store' ? store : Store.memory({ now: clock });
            const r = await deployOnce(server, nextStore, out2);
            expect(r.ok, `${label}: ${r.error ?? ''}`).toBe(true);
            assertComplete(server, label);
            // And a further deploy has nothing left to do.
            const again = await deployOnce(server, nextStore, out2);
            expect(again, label).toMatchObject({ ok: true, uploaded: 0, deleted: 0, connections: 0 });
            if (nextStore !== store) nextStore.close();
            store.close();
            checked++;
          }
        }
      }
      expect(checked).toBe(total * 4);
    }, 120_000);
  }

  it('the site changes between the crash and the restart: in-flight files are reconciled, hidden media removed', async () => {
    // V3 hides d and e (their media may have been in flight) and goes back to build b1, so pages
    // revert to their V1 bytes while the crashed deploy may already have replaced them.
    const V3: SiteSpec = {
      version: 3,
      build: 'b1',
      days: { '2026-11-16': ['x'], '2026-11-17': ['a'], '2026-11-19': ['f'] },
    };
    const out3 = join(tmp.dir, 'out3');
    const files3 = writeSite(out3, V3);
    const mustBeGone = [...HIDDEN_MEDIA, ...mediaPaths('d'), ...mediaPaths('e')];
    const ref = await baseline(true);
    const before = ref.server.mutations;
    await deployOnce(ref.server, ref.store, out2);
    const total = ref.server.mutations - before;
    for (const applied of [false, true]) {
      for (let k = 1; k <= total; k++) {
        for (const restart of ['same-store', 'lost-store'] as const) {
          const label = `k=${k}/${total} applied=${applied} ${restart}`;
          const { server, store, clock } = await baseline(true);
          server.crashAt(k, applied);
          expect((await deployOnce(server, store, out2)).ok, label).toBe(false);
          server.clearCrash();
          clock.advance(1000);
          const next = restart === 'same-store' ? store : Store.memory({ now: clock });
          const r = await deployOnce(server, next, out3);
          expect(r.ok, `${label}: ${r.error ?? ''}`).toBe(true);
          const live = server.siteFiles('/www');
          for (const [p, c] of files3) expect(live.get(p)?.toString(), `${label}: ${p}`).toBe(c);
          const extra = [...live.keys()].filter((p) => !files3.has(p));
          // Only b2 assets that were confirmed live may stay (grace period); nothing else.
          expect(
            extra.filter((p) => !Object.values(assetPaths('b2')).includes(p)),
            label,
          ).toEqual([]);
          for (const m of mustBeGone) expect(server.files.has(`/www/${m}`), `${label}: ${m}`).toBe(false);
          expect(referenceProblems(live), label).toEqual([]);
          const leftovers = [...server.siteFiles('/www', { includeBookkeeping: true }).keys()].filter(
            (p) => p.includes('.omw-tmp.') || p === '.omw-deploy.pending.json',
          );
          expect(leftovers, label).toEqual([]);
          if (next !== store) next.close();
          store.close();
        }
      }
    }
  }, 120_000);

  it('a crash during the very first deploy (no record yet) is completed by the next one', async () => {
    const clock = fakeClock('2026-11-19T10:00:00.000Z');
    const probe = new FakeServer();
    const probeStore = Store.memory({ now: clock });
    expect((await deployOnce(probe, probeStore, out2)).ok).toBe(true);
    const total = probe.mutations;
    for (let k = 1; k <= total; k += 3) {
      for (const lost of [false, true]) {
        const server = new FakeServer();
        const store = Store.memory({ now: clock });
        server.crashAt(k, true);
        expect((await deployOnce(server, store, out2)).ok).toBe(false);
        expect(referenceProblems(server.siteFiles('/www')), `k=${k}`).toEqual([]);
        server.clearCrash();
        clock.advance(1000);
        const next = lost ? Store.memory({ now: clock }) : store;
        expect((await deployOnce(server, next, out2)).ok, `k=${k}`).toBe(true);
        const live = server.siteFiles('/www');
        expect([...live.keys()].sort(), `k=${k}`).toEqual([...files2.keys()].sort());
        expect(
          [...server.siteFiles('/www', { includeBookkeeping: true }).keys()].filter((p) => p.includes('.omw-tmp.')),
        ).toEqual([]);
        store.close();
        if (next !== store) next.close();
      }
    }
  }, 60_000);
});
