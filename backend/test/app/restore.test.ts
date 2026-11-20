/**
 * L2-02: a lost or empty state never wipes the live site.
 *
 * Phase 1 publishes photos and texts (real ingest + pipeline, real generator with a fake site
 * build, real publisher to a local folder target). Phase 2 starts a backend with the same archive
 * and target but an EMPTY DATA_DIR, OUT_DIR and MEDIA_DIR (lost state volume, new machine, the
 * restore drill): it must restore the captures from the archive by itself, never deploy a deletion
 * past the mass-delete threshold (deploys stay paused until the restore is drained), end with the
 * same day pages and media on the target, and continue the site version above the published one.
 *
 * Also: the hourly maintenance bounds the event log and the change-feed quarantine (L2-08).
 */
import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { InboxMeta, WaCommand, WaEvent } from '@omw/contracts/wa';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type App,
  type AppFactories,
  createApp,
  EVENTS_KEEP,
  PAUSE_RESTORE_CONFIRM,
  QUARANTINE_KEEP_MS,
  RESTORE_CONFIRM_KEY,
} from '../../src/app.js';
import { createIngest, type WaSource, type WaSourceState } from '../../src/capture/index.js';
import type { Config } from '../../src/config.js';
import { createGenerator } from '../../src/generator/index.js';
import { statePaths } from '../../src/paths.js';
import { sha256File } from '../../src/pipeline/index.js';
import { createPublisher, type DeployResult } from '../../src/publisher/index.js';
import { Store } from '../../src/store/index.js';
import { writeFakeSiteBuild } from '../generator/harness.js';
import { makeTempDir } from '../helpers.js';
import { localTarget, staticTargets } from '../publisher/helpers.js';
import { silentLog, testConfig } from '../sync/helpers.js';

vi.setConfig({ testTimeout: 120_000 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  tzHint() {
    return 'Asia/Ho_Chi_Minh';
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) rec(p);
      else out.push(relative(dir, p));
    }
  };
  rec(dir);
  return out.sort();
}

let tmp: { dir: string; cleanup: () => void } | null = null;
const apps: { app: App; store: Store }[] = [];
afterEach(async () => {
  for (const { app, store } of apps.splice(0)) {
    await app.stop('test end');
    store.close();
  }
  tmp?.cleanup();
  tmp = null;
});

/** A backend with the real ingest/generator/publisher; `phase` picks its own state/out/media dirs. */
function backend(root: string, phase: string): { app: App; store: Store; config: Config } {
  const config = testConfig(root, {
    DATA_DIR: join(root, phase, 'state'),
    OUT_DIR: join(root, phase, 'out'),
    MEDIA_DIR: join(root, phase, 'media'),
    ARCHIVE_DIR: join(root, 'archive'),
    CONFIG_DIR: join(root, 'config'),
  });
  const store = Store.open(statePaths(config.dirs.data).storeDb);
  const siteDist = join(root, 'site-dist');
  const factories: AppFactories = {
    createWaSource: () => new StillSource(),
    createIngest: (d) => createIngest({ ...d, scanIntervalMs: 60_000, pumpIntervalMs: 50, encode: { avifEffort: 0 } }),
    createGenerator: (d) => createGenerator({ ...d, siteDistDir: siteDist, validate: true }),
    createPublisher: (d) =>
      createPublisher({
        ...d,
        targets: staticTargets([localTarget('www', join(root, 'www'))]),
        hashCacheFile: null,
        httpCheck: false,
      }),
  };
  const app = createApp({
    config,
    log: silentLog(),
    store,
    factories,
    options: { controlUi: false, quietMs: 30, maxWaitMs: 200, publishRetryBaseMs: 60_000 },
  });
  apps.push({ app, store });
  return { app, store, config };
}

/** Everything is generated, published (or held for the operator: `paused`) and idle. */
async function settled(app: App, timeoutMs = 90_000, paused: string | null = null): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await app.status();
    const by = s.captures.byState;
    const busy = (by.received ?? 0) + (by.archived ?? 0) + (by.processed ?? 0);
    if (paused) {
      if (
        s.captures.total > 0 &&
        busy === 0 &&
        s.publish.pausedReason === paused &&
        !s.build.running &&
        !s.build.pending
      )
        return;
    } else if (
      s.captures.total > 0 &&
      busy === 0 &&
      !s.publish.pausedReason &&
      !s.publish.running &&
      !s.publish.queued &&
      !s.build.running &&
      !s.build.pending &&
      s.build.last !== null &&
      s.publish.state.lastVersion === s.build.last.version
    ) {
      return;
    }
    if (Date.now() > deadline)
      throw new Error(`not settled: ${JSON.stringify({ by, build: s.build, publish: s.publish })}`);
    await sleep(50);
  }
}

async function writePhoto(inbox: string, msgId: string, timestamp: string, color: string): Promise<void> {
  const dir = join(inbox, msgId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'original.jpg');
  await sharp({ create: { width: 400, height: 300, channels: 3, background: color } })
    .jpeg()
    .toFile(file);
  const { sha256, bytes } = await sha256File(file);
  const meta: InboxMeta = {
    schema: 1,
    msgId,
    source: 'fixture',
    receivedAt: timestamp,
    sender: { pn: '4915100000001' },
    timestamp,
    kind: 'photo',
    caption: `photo ${msgId}`,
    media: { mimetype: 'image/jpeg', fileSha256B64: Buffer.from(sha256, 'hex').toString('base64'), fileLength: bytes },
    download: { state: 'ok', file: 'original.jpg', sha256Hex: sha256, attempts: 1 },
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  const t = new Date(Date.now() - 1000);
  utimesSync(join(dir, 'meta.json'), t, t);
}

function writeText(inbox: string, msgId: string, timestamp: string): void {
  const dir = join(inbox, msgId);
  mkdirSync(dir, { recursive: true });
  const meta: InboxMeta = {
    schema: 1,
    msgId,
    source: 'fixture',
    receivedAt: timestamp,
    sender: { pn: '4915100000001' },
    timestamp,
    kind: 'text',
    text: { body: `text ${msgId}`, bgArgb: null, textArgb: null, font: null },
    download: { state: 'not_applicable', attempts: 0 },
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
}

describe('L2-02: restore from the archive with an empty state', () => {
  it('restores by itself, never mass-deletes, keeps day pages and media, continues the version', async () => {
    tmp = makeTempDir('app-restore-');
    const root = tmp.dir;
    writeFakeSiteBuild(join(root, 'site-dist'));

    // --- phase 1: the live site
    const one = backend(root, 'p1');
    const inbox = statePaths(one.config.dirs.data).inbox;
    await writePhoto(inbox, 'RST0PHOTO01', '2026-11-14T02:00:00.000Z', '#cc3355');
    await writePhoto(inbox, 'RST0PHOTO02', '2026-11-14T05:00:00.000Z', '#3355cc');
    await writePhoto(inbox, 'RST0PHOTO03', '2026-11-15T03:00:00.000Z', '#33cc55');
    await writePhoto(inbox, 'RST0PHOTO04', '2026-11-16T03:00:00.000Z', '#cccc33');
    writeText(inbox, 'RST0TEXT01', '2026-11-15T09:00:00.000Z');
    writeText(inbox, 'RST0TEXT02', '2026-11-16T09:00:00.000Z');
    await one.app.start();
    await settled(one.app);
    const www = join(root, 'www');
    const before = walk(www);
    const dayPages = (files: string[]) => files.filter((p) => /\/day\/[^/]+\/index\.html$/.test(p));
    const media = (files: string[]) => files.filter((p) => p.startsWith('media/'));
    const daysBefore = dayPages(before);
    const mediaBefore = media(before);
    expect(daysBefore.length).toBeGreaterThanOrEqual(6); // 3 days x 2 locales
    expect(mediaBefore.length).toBeGreaterThan(8);
    const versionBefore = JSON.parse(readFileSync(join(www, 'data', 'manifest.json'), 'utf8')).version as number;
    await one.app.stop('phase 1 done');

    // --- phase 2: same archive and target, empty DATA_DIR / OUT_DIR / MEDIA_DIR
    const two = backend(root, 'p2');
    expect(two.store.captures.count()).toBe(0);
    await two.app.start();
    expect((await two.app.status()).publish.pausedReason).toMatch(/^restoring 6 captures from the archive/);
    await two.app.restoreDone();
    // Without an API the owner's content went with the store: nothing is published until the
    // operator publishes by hand (after `backend owner-import`, if the site had owner content).
    await settled(two.app, 90_000, PAUSE_RESTORE_CONFIRM);
    expect(walk(www)).toEqual(before);
    expect(two.store.events.recent({ type: 'publish.deploy' })).toEqual([]);
    expect(await two.app.publishNow()).toMatchObject([{ ok: true }]);
    expect(two.store.syncState.get(RESTORE_CONFIRM_KEY)).toBeUndefined();
    await settled(two.app);

    const deploys = two.store.events.recent({ type: 'publish.deploy', limit: 100 }).map((e) => e.data as DeployResult);
    expect(deploys.length).toBeGreaterThan(0);
    for (const d of deploys) {
      expect(d.errorCode, JSON.stringify(d)).not.toBe('refused');
      expect(d.deleted, JSON.stringify(d)).toBe(0); // nothing that was live went missing at any point
    }
    const after = walk(www);
    expect(dayPages(after)).toEqual(daysBefore);
    expect(media(after)).toEqual(mediaBefore);
    const versionAfter = JSON.parse(readFileSync(join(www, 'data', 'manifest.json'), 'utf8')).version as number;
    expect(versionAfter).toBeGreaterThan(versionBefore);
    expect(two.store.events.recent({ type: 'backend.restore_finished' })).toHaveLength(1);
    // the private archive stayed private (L1-09)
    expect((statSync(join(root, 'archive')).mode & 0o777).toString(8)).toBe('700');
  });
});

describe('maintenance (L2-08)', () => {
  it('keeps the newest events and drops quarantined feed items older than 90 days', async () => {
    tmp = makeTempDir('app-maint-');
    const now = new Date('2026-11-20T12:00:00.000Z');
    const store = Store.memory({ now: () => now });
    const config = testConfig(tmp.dir);
    const app = createApp({
      config,
      log: silentLog(),
      store,
      now: () => now,
      factories: {
        createWaSource: () => new StillSource(),
        createIngest: (d) => createIngest(d),
        createGenerator: (d) => createGenerator({ ...d, siteDistDir: join(tmp?.dir ?? '', 'none') }),
        createPublisher: (d) => createPublisher({ ...d, targets: staticTargets([]), hashCacheFile: null }),
      },
      options: { controlUi: false },
    });
    apps.push({ app, store });
    app.init();
    store.transaction(() => {
      for (let i = 0; i < EVENTS_KEEP + 250; i++) store.events.append('test.event', { i });
    });
    const insert = store.db.prepare(
      `INSERT INTO feed_quarantine (feed_id, seq, entity, key, raw_json, error, received_at) VALUES ('f', ?, 'post', 'k', '{}', 'bad', ?)`,
    );
    const old = new Date(now.getTime() - QUARANTINE_KEEP_MS - 60_000).toISOString();
    const recent = new Date(now.getTime() - 24 * 3600_000).toISOString();
    insert.run(1, old);
    insert.run(2, old);
    insert.run(3, recent);
    expect(app.maintenance()).toEqual({ events: 250, quarantined: 2 });
    const count = (sql: string) => (store.db.prepare(sql).get() as { n: number }).n;
    expect(count('SELECT COUNT(*) AS n FROM events')).toBe(EVENTS_KEEP);
    expect(count('SELECT MIN(id) AS n FROM events')).toBe(251); // the newest ones are kept
    expect(store.owner.quarantineCount()).toBe(1);
    expect(app.maintenance()).toEqual({ events: 0, quarantined: 0 }); // bounded, idempotent
  });
});
