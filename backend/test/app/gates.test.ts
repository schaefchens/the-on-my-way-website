/**
 * The App with the REAL sync engine (fake PHP API), the real generator (fake site build) and the
 * real publisher (local folder target):
 *
 * - L2-03: a change split over two feed pages (publish.mode on page 1, publish.mode_since on page
 *   2) never reaches a generate half-applied, also when page 2 fails once; exactly one generate
 *   follows page 2.
 * - L2-02 (b): a fresh store with an API that does not answer publishes nothing; once the API
 *   answers, the owner-hidden capture is not in OUT_DIR and not on the target.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WaCommand, WaEvent } from '@omw/contracts/wa';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type App, type AppFactories, createApp, PAUSE_FIRST_SYNC } from '../../src/app.js';
import type { DrainResult, Ingest, IngestChange, WaSource, WaSourceState } from '../../src/capture/index.js';
import type { Config } from '../../src/config.js';
import { createGenerator } from '../../src/generator/index.js';
import { createPublisher } from '../../src/publisher/index.js';
import { Store } from '../../src/store/index.js';
import { writeFakeSiteBuild } from '../generator/harness.js';
import { makeTempDir } from '../helpers.js';
import { localTarget, staticTargets } from '../publisher/helpers.js';
import { annotationItem, type FakeApi, resetSeq, settingItem, startFakeApi, TOKEN } from '../sync/fake-api.js';
import { insertTextCapture, silentLog, testConfig } from '../sync/helpers.js';

// Backend test ports 19200-19219: this file uses 19218.
const PORT = 19218;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(10);
  }
}

class StillSource implements WaSource {
  async start() {}
  async stop() {}
  send(_cmd: WaCommand) {}
  state(): WaSourceState {
    return {
      mode: 'fixture',
      wa: 'open',
      reason: null,
      detail: null,
      until: null,
      jid: null,
      process: 'running',
      pid: null,
      helperVersion: null,
      restarts: 0,
      nextRestartAt: null,
      lastExit: null,
      qr: null,
      pairCode: null,
      traveler: { pn: null, lid: null },
      lastStatusAt: null,
      lastEventAt: null,
      stats: {},
      invalidLines: 0,
    };
  }
  onEvent(_cb: (e: WaEvent) => void) {
    return () => {};
  }
}

class EmitIngest implements Ingest {
  listeners = new Set<(c: IngestChange) => void>();
  async start() {}
  async stop() {}
  async drain(): Promise<DrainResult> {
    return { ingested: 0, processed: 0, failed: 0 };
  }
  async reprocess() {
    return 0;
  }
  onChange(cb: (c: IngestChange) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(c: IngestChange) {
    for (const l of this.listeners) l(c);
  }
  stats() {
    return {};
  }
}

let api: FakeApi;
let tmp: { dir: string; cleanup: () => void };
let config: Config;
let store: Store;
let app: App | null = null;

beforeAll(async () => {
  api = await startFakeApi(PORT);
});
afterAll(async () => {
  await api.close();
});
beforeEach(() => {
  tmp = makeTempDir('app-gates-');
  config = testConfig(tmp.dir, { API_BASE_URL: api.url, API_TOKEN: TOKEN });
  store = Store.memory();
  api.feed = [];
  api.feedId = 'feed_gatesgates';
  api.failures.clear();
  api.delays.clear();
  api.log = [];
  resetSeq();
});
afterEach(async () => {
  await app?.stop('test end');
  app = null;
  store.close();
  tmp.cleanup();
});

interface Observed {
  mode: string;
  since: string | undefined;
  catchingUp: string | null;
  reason: string | undefined;
}

function build(opts: { withTarget?: boolean } = {}) {
  const siteDist = join(tmp.dir, 'site-dist');
  writeFakeSiteBuild(siteDist);
  const ingest = new EmitIngest();
  const observed: Observed[] = [];
  const www = join(tmp.dir, 'www');
  const factories: AppFactories = {
    createWaSource: () => new StillSource(),
    createIngest: () => ingest,
    createGenerator: (d) => {
      const real = createGenerator({ ...d, siteDistDir: siteDist, validate: true });
      return {
        outDir: real.outDir,
        async generate(o) {
          const r = await real.generate(o);
          // What the generate read (the mirror cannot change during the run: one transaction).
          const s = store.owner.settings();
          observed.push({
            mode: s['publish.mode'],
            since: s['publish.mode_since'],
            catchingUp: store.syncState.catchingUpSince(),
            reason: o?.reason,
          });
          return r;
        },
      };
    },
    createPublisher: (d) =>
      createPublisher({
        ...d,
        targets: staticTargets(opts.withTarget ? [localTarget('www', www)] : []),
        hashCacheFile: null,
        httpCheck: false,
      }),
  };
  app = createApp({
    config,
    log: silentLog(),
    store,
    factories,
    options: {
      controlUi: false,
      startupGenerate: false,
      quietMs: 20,
      maxWaitMs: 100,
      holdRetryMs: 25,
      sync: { pageLimit: 1, pullIntervalMs: 3_600_000, heartbeatIntervalMs: 3_600_000, requestTimeoutMs: 2_000 },
    },
  });
  return { app, ingest, observed, www };
}

describe('L2-03: a change split over two feed pages is never generated half-applied', () => {
  for (const variant of ['page 2 slow', 'page 2 fails once'] as const) {
    it(variant, async () => {
      await insertTextCapture(store, 'OLD1', '2026-11-18T08:00:00.000Z');
      // the mirror starts in sync (instant mode, nothing pending)
      store.owner.applyChanges({ feedId: api.feedId, items: [], nextSeq: 0, hasMore: false });
      store.syncState.setOwnerSynced(new Date());
      api.feed.push(
        settingItem('publish.mode', 'review'), // page 1
        settingItem('publish.mode_since', '2026-11-19T12:00:00.000Z'), // page 2
      );
      if (variant === 'page 2 slow') api.delays.set('GET changes', [0, 400]);
      else api.fail('GET changes', { status: 503, whenAfter: 1 });
      const { app: a, ingest, observed } = build();
      await a.start();

      const first = a.sync.pullNow().catch(() => -1);
      await waitFor(() => store.syncState.feedCursor() === 1); // page 1 applied
      expect(store.syncState.catchingUpSince()).not.toBeNull();
      // A new capture (or any other trigger) asks for a generate while page 2 is outstanding.
      ingest.emit({ sourceKeys: ['wa:OLD1'], localDates: ['2026-11-18'] });
      await sleep(250);
      expect(observed).toEqual([]);
      expect((await a.status()).build.heldReason).toBe('owner change feed is catching up');
      await first;
      if (variant === 'page 2 fails once') {
        expect(store.syncState.feedCursor()).toBe(1);
        await sleep(100);
        expect(observed).toEqual([]);
        await a.sync.pullNow();
      }
      await waitFor(() => observed.length === 1);
      await sleep(250);
      expect(observed).toEqual([
        { mode: 'review', since: '2026-11-19T12:00:00.000Z', catchingUp: null, reason: expect.any(String) },
      ]);
      expect(observed[0]?.reason?.split(',')).toEqual(expect.arrayContaining(['captures', 'settings']));
      expect(a.sync.catchingUp()).toBe(false);
    });
  }

  it('the generator refuses a half-applied mirror inside its read transaction', async () => {
    const { app: a } = build();
    a.init();
    store.owner.applyChanges({
      feedId: api.feedId,
      items: [settingItem('publish.mode', 'review')],
      nextSeq: 1,
      hasMore: true,
    });
    await expect(a.generator.generate({ holdWhileFeedCatchingUp: true })).rejects.toThrow(/catching up/);
    expect(existsSync(join(config.dirs.out, 'data', 'manifest.json'))).toBe(false);
  });
});

describe('L2-02 (b): first owner-content sync gate', () => {
  it('a fresh store with an unreachable API deploys nothing; after the sync the hidden capture stays out', async () => {
    const visible = await insertTextCapture(store, 'SHOWN1', '2026-11-18T08:00:00.000Z');
    const hidden = await insertTextCapture(store, 'HIDDEN1', '2026-11-18T09:00:00.000Z');
    api.feed.push(annotationItem(hidden.sourceKey, { visibility: 'hidden' }));
    for (let i = 0; i < 20; i++) api.fail('GET changes', { status: 503 });
    const { app: a, ingest, www } = build({ withTarget: true });
    await a.start();
    await a.sync.pullNow().catch(() => -1);
    ingest.emit({ sourceKeys: [visible.sourceKey, hidden.sourceKey], localDates: ['2026-11-18'] });
    await waitFor(() => existsSync(join(config.dirs.out, 'data', 'manifest.json')));
    await sleep(200);
    // generated, but never deployed
    expect(existsSync(www) ? readdirSync(www) : []).toEqual([]);
    expect(store.events.recent({ type: 'publish.deploy' })).toEqual([]);
    const st = await a.status();
    expect(st.publish.pausedReason).toBe(PAUSE_FIRST_SYNC);
    expect(await a.publishNow()).toMatchObject([{ ok: false, errorCode: 'paused' }]);

    // The API answers: the owner's hide arrives before anything is published.
    api.failures.clear();
    await a.sync.pullNow();
    expect(store.syncState.ownerSyncedAt()).not.toBeNull();
    await waitFor(() => existsSync(join(www, 'data', 'manifest.json')));
    await waitFor(() => !a.publishRunner.busy);
    const day = (root: string) => readFileSync(join(root, 'data', 'days', '2026-11-18.json'), 'utf8');
    expect(day(config.dirs.out)).toContain(visible.publicId);
    expect(day(config.dirs.out)).not.toContain(hidden.publicId);
    expect(day(www)).not.toContain(hidden.publicId);
    expect((await a.status()).publish.pausedReason).toBeNull();
    // A backend that synced once keeps publishing while the API is down.
    for (let i = 0; i < 20; i++) api.fail('GET changes', { status: 503 });
    await a.sync.pullNow().catch(() => -1);
    expect(a.publishGate()).toBeNull();
  });
});
