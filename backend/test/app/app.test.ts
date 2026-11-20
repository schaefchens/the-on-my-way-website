import type { WaCommand, WaEvent } from '@omw/contracts/wa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type App, type AppFactories, createApp, type GenerateResultLike } from '../../src/app.js';
import type { DrainResult, Ingest, IngestChange, WaSource, WaSourceState } from '../../src/capture/index.js';
import type { Config } from '../../src/config.js';
import type { DeployOptions, DeployResult, PublishTargetPublic } from '../../src/publisher/index.js';
import { Store } from '../../src/store/index.js';
import {
  type DeployReport,
  type OwnerChange,
  type PublishSnapshot,
  readGenerateSnapshot,
  type Sync,
  type SyncStatus,
  writePublishState,
} from '../../src/sync/index.js';
import { makeTempDir } from '../helpers.js';
import { insertPhotoCapture, insertTextCapture, silentLog, testConfig } from '../sync/helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(5);
  }
}

class FakeSource implements WaSource {
  timeline: string[];
  waState: WaSourceState['wa'] = 'open';
  sent: WaCommand[] = [];
  listeners = new Set<(e: WaEvent) => void>();
  constructor(timeline: string[]) {
    this.timeline = timeline;
  }
  async start() {
    this.timeline.push('source.start');
  }
  async stop() {
    this.timeline.push('source.stop');
  }
  send(cmd: WaCommand) {
    this.sent.push(cmd);
  }
  state(): WaSourceState {
    return {
      mode: 'fixture',
      wa: this.waState,
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
  onEvent(cb: (e: WaEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

class FakeIngest implements Ingest {
  timeline: string[];
  listeners = new Set<(c: IngestChange) => void>();
  syncOutbox: boolean | undefined;
  constructor(timeline: string[], syncOutbox: boolean | undefined) {
    this.timeline = timeline;
    this.syncOutbox = syncOutbox;
  }
  async start() {
    this.timeline.push('ingest.start');
  }
  async stop() {
    this.timeline.push('ingest.stop');
  }
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
    return { processed: 1 };
  }
}

class FakeGenerator {
  outDir = '/tmp/out';
  timeline: string[];
  calls: { full?: boolean; dates?: string[]; reason?: string }[] = [];
  version = 0;
  delayMs = 0;
  nextRunAt: string | null = null;
  changed = true;
  constructor(timeline: string[]) {
    this.timeline = timeline;
  }
  /** holdWhileFeedCatchingUp of each call (kept out of `calls`). */
  holds: (boolean | undefined)[] = [];
  async generate(
    opts: { full?: boolean; dates?: string[]; reason?: string; holdWhileFeedCatchingUp?: boolean } = {},
  ): Promise<GenerateResultLike> {
    const { holdWhileFeedCatchingUp, ...call } = opts;
    this.holds.push(holdWhileFeedCatchingUp);
    this.calls.push(call);
    this.timeline.push(`generate:start:${opts.reason}`);
    if (this.delayMs) await sleep(this.delayMs);
    if (this.changed) this.version++;
    this.timeline.push('generate:end');
    return {
      version: this.version,
      changed: this.changed ? ['data/manifest.json'] : [],
      removed: this.changed ? ['media/aa/old_w640.webp'] : [],
      full: Boolean(opts.full),
      durationMs: 1,
      nextRunAt: this.nextRunAt,
    };
  }
}

class FakePublisher {
  timeline: string[];
  targets: Partial<PublishTargetPublic>[] = [{ id: 'local', kind: 'local', enabled: true }];
  deploys: DeployOptions[] = [];
  delayMs = 0;
  generator: FakeGenerator;
  constructor(timeline: string[], generator: FakeGenerator) {
    this.timeline = timeline;
    this.generator = generator;
  }
  listTargets() {
    return this.targets as PublishTargetPublic[];
  }
  saveTarget(): PublishTargetPublic {
    throw new Error('not needed');
  }
  removeTarget() {}
  async testTarget() {
    return { ok: true, detail: 'ok' };
  }
  busy() {
    return false;
  }
  async deploy(opts: DeployOptions = {}): Promise<DeployResult[]> {
    this.deploys.push(opts);
    this.timeline.push(`deploy:start:${opts.reason}`);
    if (this.delayMs) await sleep(this.delayMs);
    this.timeline.push('deploy:end');
    return [
      {
        targetId: 'local',
        ok: true,
        version: this.generator.version,
        uploaded: 1,
        deleted: 0,
        bytes: 1,
        durationMs: 1,
        httpCheck: 'skipped',
      },
    ];
  }
}

class FakeSync implements Sync {
  readonly enabled = true;
  timeline: string[];
  listeners = new Set<(c: OwnerChange) => void>();
  reports: { results: readonly DeployReport[]; snapshot: PublishSnapshot | undefined }[] = [];
  changed: string[] = [];
  store: Store;
  constructor(timeline: string[], store: Store) {
    this.timeline = timeline;
    this.store = store;
  }
  async start() {
    this.timeline.push('sync.start');
  }
  async stop() {
    this.timeline.push('sync.stop');
  }
  async pullNow() {
    return 0;
  }
  async flushNow() {
    return { sent: 0, failed: 0, dropped: 0 };
  }
  async heartbeatNow() {
    return true;
  }
  onOwnerChange(cb: (c: OwnerChange) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(c: OwnerChange) {
    for (const l of this.listeners) l(c);
  }
  catching = false;
  synced = true;
  caughtUpListeners = new Set<() => void>();
  catchingUp() {
    return this.catching;
  }
  ownerSynced() {
    return this.synced;
  }
  onCaughtUp(cb: () => void) {
    this.caughtUpListeners.add(cb);
    return () => this.caughtUpListeners.delete(cb);
  }
  /** Simulates a pull that reached the end of the feed. */
  caughtUp() {
    this.catching = false;
    this.synced = true;
    for (const l of this.caughtUpListeners) l();
  }
  capturesChanged(keys: readonly string[]) {
    this.changed.push(...keys);
  }
  resyncAllCaptures() {
    return 0;
  }
  reportPublished(results: readonly DeployReport[], snapshot?: PublishSnapshot) {
    this.reports.push({ results, snapshot });
    const ok = results.find((r) => r.ok);
    if (ok?.version != null)
      writePublishState(this.store, { lastVersion: ok.version, lastAt: new Date().toISOString() });
  }
  async buildHeartbeat(): Promise<never> {
    throw new Error('not needed');
  }
  status(): SyncStatus {
    return {
      enabled: true,
      baseUrl: 'https://api.example.org',
      authPausedUntil: null,
      lastPullAt: null,
      lastPullError: null,
      lastPushAt: null,
      lastPushError: null,
      lastHeartbeatAt: null,
      lastHeartbeatError: null,
      feedId: null,
      feedSeq: 0,
      rebuilding: false,
      quarantined: 0,
      queue: { pending: 0, failed: 0, oldestAt: null },
    };
  }
}

interface Rig {
  app: App;
  store: Store;
  timeline: string[];
  source: FakeSource;
  ingest: FakeIngest;
  generator: FakeGenerator;
  publisher: FakePublisher;
  sync: FakeSync;
}

let tmp: { dir: string; cleanup: () => void };
let config: Config;
const rigs: Rig[] = [];

beforeEach(() => {
  tmp = makeTempDir('app-');
  config = testConfig(tmp.dir);
});

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.app.stop('test end');
    r.store.close();
  }
  tmp.cleanup();
});

function rig(options: { store?: Store; startupGenerate?: boolean; fetch?: typeof fetch } = {}): Rig {
  const timeline: string[] = [];
  const store = options.store ?? Store.memory();
  const generator = new FakeGenerator(timeline);
  const publisher = new FakePublisher(timeline, generator);
  const sync = new FakeSync(timeline, store);
  const parts: Partial<Rig> = { timeline, store, generator, publisher, sync };
  const factories: AppFactories = {
    createWaSource: () => {
      parts.source = new FakeSource(timeline);
      return parts.source;
    },
    createIngest: (deps) => {
      parts.ingest = new FakeIngest(timeline, deps.syncOutbox);
      return parts.ingest;
    },
    createGenerator: () => generator,
    createPublisher: () => publisher,
    createSync: () => sync,
  };
  const app = createApp({
    config,
    log: silentLog(),
    store,
    factories,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    options: {
      alertGraceMs: 0,
      alertCheckMs: 60_000,
      quietMs: 20,
      maxWaitMs: 200,
      controlUi: false,
      shutdownTimeoutMs: 2_000,
      publishRetryBaseMs: 50,
      ...(options.startupGenerate === false ? { startupGenerate: false } : {}),
    },
  });
  app.init(); // creates the modules (fills `parts`)
  const r = { ...(parts as Rig), app };
  rigs.push(r);
  return r;
}

describe('App orchestration', () => {
  it('starts consumers before producers, generates and publishes at startup', async () => {
    const r = rig();
    await r.app.start();
    expect(r.timeline.slice(0, 3)).toEqual(['ingest.start', 'source.start', 'sync.start']);
    expect(r.ingest.syncOutbox).toBe(false); // no API configured: the ingest must not fill the outbox
    await waitFor(() => r.publisher.deploys.length === 1);
    expect(r.generator.calls).toEqual([{ reason: 'startup' }]);
    expect(r.publisher.deploys[0]).toMatchObject({ reason: 'generate', knownObsolete: ['media/aa/old_w640.webp'] });
    await waitFor(() => r.sync.reports.length === 1);
    expect(r.sync.reports[0]?.snapshot).toMatchObject({ version: 1, feedSeq: 0 });
    expect(readGenerateSnapshot(r.store)).toMatchObject({ version: 1, changed: 1, removed: 1 });
  });

  it('debounces ingest and owner changes into one generate with the union of dates', async () => {
    const r = rig({ startupGenerate: false });
    await r.app.start();
    r.ingest.emit({ sourceKeys: ['wa:A'], localDates: ['2026-11-18'] });
    await sleep(5);
    r.sync.emit({ localDates: ['2026-11-17'], trips: [], full: false, applied: 1, reason: 'owner_changes' });
    r.ingest.emit({ sourceKeys: ['wa:B'], localDates: ['2026-11-18', '2026-11-19'] });
    await waitFor(() => r.generator.calls.length === 1);
    await sleep(60);
    expect(r.generator.calls).toEqual([
      { dates: ['2026-11-17', '2026-11-18', '2026-11-19'], reason: 'captures,owner_changes' },
    ]);
    await waitFor(() => r.publisher.deploys.length === 1);
  });

  it('passes full rebuilds through and records the feed cursor taken before generating', async () => {
    const r = rig({ startupGenerate: false });
    await r.app.start();
    r.store.syncState.setFeedCursor(41);
    r.generator.delayMs = 30;
    r.sync.emit({ localDates: [], trips: [], full: true, applied: 3, reason: 'settings' });
    await waitFor(() => r.timeline.includes('generate:start:settings'));
    r.store.syncState.setFeedCursor(99); // pulled while generating: not in this build
    await waitFor(() => r.sync.reports.length === 1);
    expect(r.generator.calls[0]).toEqual({ full: true, reason: 'settings' });
    expect(r.sync.reports[0]?.snapshot?.feedSeq).toBe(41);
  });

  it('never runs a generate and a deploy at the same time', async () => {
    const r = rig({ startupGenerate: false });
    await r.app.start();
    r.publisher.delayMs = 50;
    void r.app.publishNow();
    await sleep(5);
    r.ingest.emit({ sourceKeys: ['wa:A'], localDates: ['2026-11-18'] });
    await waitFor(() => r.timeline.filter((t) => t === 'deploy:end').length === 2);
    const relevant = r.timeline.filter((t) => t.startsWith('generate') || t.startsWith('deploy'));
    expect(relevant).toEqual([
      'deploy:start:manual',
      'deploy:end',
      'generate:start:captures',
      'generate:end',
      'deploy:start:generate',
      'deploy:end',
    ]);
  });

  it('coalesces deploys requested during a deploy and skips publishing when nothing changed', async () => {
    const r = rig({ startupGenerate: false });
    await r.app.start();
    r.publisher.delayMs = 40;
    const a = r.app.publishNow();
    const b = r.app.publishNow();
    const c = r.app.publishNow();
    await Promise.all([a, b, c]);
    expect(r.publisher.deploys).toHaveLength(2);
    // Live version == generated version and no file changed: no deploy after this generate.
    r.generator.changed = false;
    await r.app.rebuild(false);
    await sleep(30);
    expect(r.publisher.deploys).toHaveLength(2);
  });

  it('does not publish without targets', async () => {
    const r = rig();
    r.publisher.targets = [];
    await r.app.start();
    await waitFor(() => r.generator.calls.length === 1);
    await sleep(30);
    expect(r.publisher.deploys).toHaveLength(0);
    expect(await r.app.publishNow()).toEqual([]);
  });

  it('deploys one named target even when it is disabled (and no target is enabled)', async () => {
    const r = rig({ startupGenerate: false });
    r.publisher.targets = [{ id: 'local', kind: 'local', enabled: false }];
    await r.app.start();
    expect(await r.app.publishNow()).toEqual([]); // all enabled targets: none
    expect(await r.app.publishNow('nope')).toEqual([]); // unknown target
    const results = await r.app.publishNow('local');
    expect(results).toHaveLength(1);
    expect(r.publisher.deploys).toEqual([{ reason: 'manual', targetId: 'local' }]);
  });

  it('schedules a generate when the next delayed item becomes public', async () => {
    const r = rig({ startupGenerate: false });
    await r.app.start();
    r.generator.nextRunAt = new Date(Date.now() + 50).toISOString();
    r.ingest.emit({ sourceKeys: ['wa:A'], localDates: ['2026-11-18'] });
    await waitFor(() => r.generator.calls.length === 1);
    r.generator.nextRunAt = null;
    expect((await r.app.status()).build.nextPublishAt?.at).toBeDefined();
    await waitFor(() => r.generator.calls.length === 2, 3_000);
    expect(r.generator.calls[1]).toEqual({ reason: 'publish_at' });
  });

  it('persists pending generate work across a shutdown', async () => {
    const store = Store.memory();
    const first = rig({ store, startupGenerate: false });
    await first.app.start();
    first.ingest.emit({ sourceKeys: ['wa:A'], localDates: ['2026-11-20'] });
    await first.app.stop('test'); // before the debounce fired
    rigs.splice(rigs.indexOf(first), 1);
    expect(first.generator.calls).toHaveLength(0);
    const second = rig({ store, startupGenerate: false });
    await second.app.start();
    await waitFor(() => second.generator.calls.length === 1);
    expect(second.generator.calls[0]).toEqual({ dates: ['2026-11-20'], reason: 'resume' });
  });

  it('shuts down in order: source, ingest, running generate, sync', async () => {
    const r = rig({ startupGenerate: false });
    await r.app.start();
    r.generator.delayMs = 60;
    r.ingest.emit({ sourceKeys: ['wa:A'], localDates: ['2026-11-18'] });
    await waitFor(() => r.timeline.some((t) => t.startsWith('generate:start')));
    await r.app.stop('SIGTERM');
    rigs.splice(rigs.indexOf(r), 1);
    const tail = r.timeline.slice(r.timeline.indexOf('source.stop'));
    expect(tail[0]).toBe('source.stop');
    expect(tail.indexOf('ingest.stop')).toBeLessThan(tail.indexOf('generate:end'));
    expect(tail.indexOf('generate:end')).toBeLessThan(tail.indexOf('sync.stop'));
    expect(r.store.events.recent({ type: 'backend.stopped' })).toHaveLength(1);
    r.store.close();
  });

  it('reports the snapshot of the files the deploy saw, not of a generate queued behind it', async () => {
    const r = rig();
    r.publisher.delayMs = 50;
    await r.app.start();
    await waitFor(() => r.timeline.includes('deploy:start:generate'));
    r.ingest.emit({ sourceKeys: ['wa:B'], localDates: ['2026-11-19'] }); // generate v2 waits for the lock
    await waitFor(() => r.generator.calls.length === 2 && r.sync.reports.length >= 1);
    expect(r.sync.reports[0]?.snapshot?.version).toBe(1);
    expect(r.sync.reports[0]?.results[0]?.version).toBe(1);
  });

  it('survives damaged persisted generate work and drops invalid dates', async () => {
    const store = Store.memory();
    store.syncState.set('build_pending', '{not json');
    const a = rig({ store, startupGenerate: false });
    await a.app.start(); // must not throw
    await waitFor(() => a.generator.calls.length === 1);
    expect(a.generator.calls[0]).toEqual({ full: true, reason: 'resume' });
    await a.app.stop('test');
    rigs.splice(rigs.indexOf(a), 1);

    store.syncState.setJson('build_pending', { dates: ['2026-11-18', '2026-02-30', 'nope', 7], full: false });
    const b = rig({ store, startupGenerate: false });
    await b.app.start();
    await waitFor(() => b.generator.calls.length === 1);
    expect(b.generator.calls[0]).toEqual({ dates: ['2026-11-18'], reason: 'resume' });
    await waitFor(() => store.syncState.get('build_pending') === undefined);
  });

  it('starts no new deploy for a generate that finishes during shutdown', async () => {
    const r = rig({ startupGenerate: false });
    await r.app.start();
    r.generator.delayMs = 60;
    r.ingest.emit({ sourceKeys: ['wa:A'], localDates: ['2026-11-18'] });
    await waitFor(() => r.timeline.some((t) => t.startsWith('generate:start')));
    await r.app.stop('SIGTERM');
    rigs.splice(rigs.indexOf(r), 1);
    expect(r.timeline).toContain('generate:end');
    expect(r.publisher.deploys).toHaveLength(0); // the next start deploys it (version not live yet)
    r.store.close();
  });

  it('bounds the whole shutdown, not each step', async () => {
    const r = rig({ startupGenerate: false });
    await r.app.start();
    r.generator.delayMs = 3_000; // longer than what is left of the 2 s budget after the ingest step
    const ingestStop = r.ingest.stop.bind(r.ingest);
    r.ingest.stop = async () => {
      await sleep(1_200);
      await ingestStop();
    };
    r.ingest.emit({ sourceKeys: ['wa:A'], localDates: ['2026-11-18'] });
    await waitFor(() => r.timeline.some((t) => t.startsWith('generate:start')));
    const t0 = Date.now();
    await r.app.stop('SIGTERM');
    rigs.splice(rigs.indexOf(r), 1);
    expect(Date.now() - t0).toBeLessThan(2_600); // 2 s budget (+ the 1 s minimum per step)
    r.store.close();
  });
});

describe('control actions', () => {
  it('retries and skips captures', async () => {
    const r = rig({ startupGenerate: false });
    await r.app.start();
    await insertPhotoCapture(r.store, config.dirs.media, 'Q1', '2026-11-18T08:00:00.000Z', { ready: false });
    await insertTextCapture(r.store, 'Q2', '2026-11-18T09:00:00.000Z');
    r.store.captures.recordFailure('wa:Q1', 'sharp crashed', null);
    expect(r.store.captures.get('wa:Q1')?.state).toBe('failed');
    expect(r.app.retryCapture('wa:Q1')).toMatchObject({ ok: true });
    expect(r.store.captures.get('wa:Q1')?.state).toBe('received');
    expect(r.app.retryCapture('wa:Q2')).toMatchObject({ ok: false });
    expect(r.app.retryCapture('wa:NOPE')).toMatchObject({ ok: false });

    expect(r.app.skipCapture('wa:Q1')).toMatchObject({ ok: true });
    expect(r.store.captures.get('wa:Q1')?.state).toBe('media_lost');
    expect(r.app.skipCapture('wa:Q2')).toMatchObject({ ok: false }); // ready: nothing to skip
    expect(r.sync.changed).toEqual(['wa:Q1', 'wa:Q1']);
    expect(r.store.events.recent({ type: 'capture.skipped' })).toHaveLength(1);
  });

  it('rebuild() runs immediately and reports the result', async () => {
    const r = rig({ startupGenerate: false });
    await r.app.start();
    const res = await r.app.rebuild(true);
    expect(res).toMatchObject({ version: 1, changed: 1, removed: 1, full: true });
    expect(r.generator.calls).toEqual([{ full: true, reason: 'manual' }]);
    await waitFor(() => r.publisher.deploys.length === 1);
    expect(r.publisher.deploys[0]?.reason).toBe('manual');
    const status = await r.app.status();
    expect(status.build.last?.version).toBe(1);
    expect(status.publish.targets).toBe(1);
    expect(status.wa.state).toBe('open');
  });
});

describe('local alerts (NTFY_URL without an API)', () => {
  it('notifies once when WhatsApp is logged out or publishing keeps failing, and when resolved', async () => {
    config = testConfig(tmp.dir, { NTFY_URL: 'https://ntfy.example/omw-test' });
    const sent: { url: string; title: string | null; body: string }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      sent.push({ url: String(input), title: new Headers(init?.headers).get('title'), body: String(init?.body) });
      return new Response('ok');
    };
    const r = rig({ startupGenerate: false, fetch: fakeFetch });
    await r.app.start();
    await r.app.checkAlerts();
    expect(sent).toHaveLength(0);
    r.source.waState = 'logged_out';
    await r.app.checkAlerts();
    await r.app.checkAlerts();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ url: 'https://ntfy.example/omw-test', title: 'On My Way: WhatsApp logged_out' });
    expect(sent[0]?.body).toContain('link WhatsApp again');
    r.source.waState = 'open';
    await r.app.checkAlerts();
    expect(sent[1]).toMatchObject({ title: 'On My Way: Resolved: WhatsApp', body: 'WhatsApp is open again.' });

    r.publisher.deploy = async () => [
      {
        targetId: 'local',
        ok: false,
        version: null,
        uploaded: 0,
        deleted: 0,
        bytes: 0,
        durationMs: 1,
        httpCheck: 'skipped',
        error: 'disk full',
      },
    ];
    for (let i = 0; i < 3; i++) await r.app.publishNow();
    await r.app.checkAlerts();
    expect(sent[2]?.title).toBe('On My Way: publishing fails');
    expect(sent[2]?.body).toContain('disk full');
  });

  it('is off when an API is configured (the API alerts instead)', async () => {
    config = testConfig(tmp.dir, {
      NTFY_URL: 'https://ntfy.example/x',
      API_BASE_URL: 'https://api.example.org',
      API_TOKEN: 't',
    });
    const sent: string[] = [];
    const r = rig({
      startupGenerate: false,
      fetch: async (u) => {
        sent.push(String(u));
        return new Response('ok');
      },
    });
    await r.app.start();
    r.source.waState = 'logged_out';
    await r.app.checkAlerts();
    // (the API backup puller may use fetch; no ntfy message is sent)
    expect(sent.filter((u) => u.startsWith('https://ntfy.example'))).toHaveLength(0);
  });
});
