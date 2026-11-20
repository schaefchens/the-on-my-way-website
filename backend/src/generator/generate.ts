/**
 * One generator run (plan A4 "Incremental builds").
 *
 * 1. Read the site build, settings and the previous state; decide full vs incremental.
 *    Full when requested, on the first run, after an interrupted run, or when the generator
 *    version, the site build (Vite manifest hash), the site.* settings or the public URL
 *    changed (publish.*, ingest.* and timezone.current act through the model diff below).
 * 2. Build the complete site model (cheap: one pass over the store). Comparing each day's and
 *    trip's change key (hash of its DaySummary/TripSummary: the file's `v` plus the cover and
 *    other summary-only facts its pages show) with the previous state finds every changed day —
 *    also those changed by time alone (publish.mode "delayed") — so `dates` is only an extra
 *    "re-render these".
 * 3. Dependency map: a changed day D re-renders days/D.json, D's day page and story pages per
 *    locale, the pages of D's previous and next day (their player twin previews D), and the trip
 *    (JSON + pages) D belongs/belonged to; a changed trip re-renders its files and the day pages
 *    of its days (they show the trip title). timeline.json, the home and trip pages (their first
 *    screen is the timeline twin with the newest days), 404.html, the language picker,
 *    robots/sitemap/.htaccess and manifest.json are rendered on every run. Files of days/trips/stories that disappeared are removed, and so
 *    is media no longer referenced (OUT_DIR/media mirrors exactly the referenced variants).
 * 4. Release: if any content changed (data, page content, media set, build, removals) the
 *    version is bumped (store.meta.nextSiteVersion, monotonic) and generatedAt = now; otherwise
 *    nothing is written. Pages carry the release in which their content last changed (see
 *    pages.ts), so an incremental run and a full run produce byte-identical output.
 * 5. Write order: media, assets, day/trip JSON, timeline.json, HTML, root files, manifest.json
 *    last; removals after that. Every write is atomic (temp + rename) and skipped when the
 *    bytes on disk are already identical; `changed`/`removed` list what actually happened.
 */

import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { CONTRACT_VERSION } from '@omw/contracts';
import type { Settings } from '@omw/contracts/api';
import {
  Boot,
  DayDetail,
  dayDataPath,
  MANIFEST_PATH,
  Manifest,
  type RouteRef,
  type SiteInfo,
  TIMELINE_PATH,
  TimelineIndex,
  TripDetail,
  tripDataPath,
} from '@omw/contracts/site';
import { isValidLocalDate } from '@omw/contracts/time';
import { z } from 'zod';
import type { Config } from '../config.js';
import { linkOrCopy } from '../fsutil.js';
import type { Logger } from '../log.js';
import { mediaFilePath, REPO_ROOT } from '../paths.js';
import { mkdirWithMode } from '../pipeline/files.js';
import type { Store } from '../store/index.js';
import { htaccess, robotsTxt, sitemapXml } from './extras.js';
import { contentHash, shortSha } from './hash.js';
import { scanMediaRoot } from './media.js';
import { buildSiteModel, loadModelInputs, type SiteModel } from './model.js';
import {
  assertSafeOutDir,
  copyAtomic,
  isGeneratorPath,
  readIfExists,
  removeOutput,
  scanOutputs,
  syncDirs,
  writeAtomic,
} from './output.js';
import {
  type ReleaseStamp,
  type RenderedPage,
  renderDay,
  renderHome,
  renderNotFound,
  renderPicker,
  renderStory,
  renderTrip,
  type SiteContext,
} from './pages.js';
import { readSiteBuild, scanAssets } from './site-build.js';
import { type GeneratorState, isDirty, loadState, markDirty, saveState } from './state.js';

/** Bump when templates, CSS or strings change: the next run is full and re-stamps every page. */
export const GENERATOR_VERSION = 4;

export interface GenerateOptions {
  /** Re-render and re-check everything (also removes stray files from OUT_DIR). */
  full?: boolean;
  /** Local dates whose pages must be re-rendered even if their data did not change. */
  dates?: string[];
  /** Free text for logs ("feed", "capture", "startup", …). */
  reason?: string;
  /**
   * Refuse (FeedCatchingUpError, nothing written) when the owner mirror holds only a prefix of the
   * change feed (sync_state feed_catching_up_since, read in the same transaction as the model).
   */
  holdWhileFeedCatchingUp?: boolean;
}

/** The owner mirror is half-applied (L2-03): the caller retries once the feed is caught up. */
export class FeedCatchingUpError extends Error {
  override name = 'FeedCatchingUpError';
}

export interface GenerateResult {
  /** Manifest.version after this run (unchanged when nothing changed). */
  version: number;
  /** OUT_DIR-relative paths written, linked or copied (sorted). */
  changed: string[];
  /** OUT_DIR-relative paths removed (sorted). */
  removed: string[];
  full: boolean;
  durationMs: number;
  /** Why the run was full (null for incremental runs). */
  fullReason: string | null;
  /** Local dates whose files were (re)rendered. */
  dates: string[];
  timelineV: string;
  /** Next instant at which a pending capture becomes public (publish.mode "delayed"): run again then. */
  nextRunAt: string | null;
  warnings: string[];
  stats: { days: number; trips: number; entries: number; media: number; pagesRendered: number; written: number };
}

export interface GenerationContext {
  config: Config;
  log: Logger;
  store: Store;
  now: () => Date;
  siteDistDir: string;
  outDir: string;
  mediaDir: string;
  /** Validate every JSON file and Boot block against @omw/contracts/site (dev/test). */
  validate: boolean;
  /** Write /.htaccess (Apache hosts). */
  htaccess: boolean;
  /** Warnings of the previous run (logged at warn level only when they change). */
  lastWarnings?: string;
}

export class GeneratorValidationError extends Error {
  override name = 'GeneratorValidationError';
}

const json = (value: unknown) => `${JSON.stringify(value)}\n`;

/**
 * Settings that shape every page directly (site.*): a change forces a full run. publish.*,
 * ingest.* and timezone.current only matter through the model (visibility, placement), which is
 * diffed per day anyway, so changing them (e.g. the traveler's one-tap "timezone from this
 * device") must not re-check the whole site. alerts.* do not influence the output at all.
 */
function outputSettings(settings: Settings): Record<string, unknown> {
  return Object.fromEntries(Object.entries(settings).filter(([k]) => k.startsWith('site.')));
}

function publicBaseOf(config: Config): string | null {
  const url = config.site.publicUrl;
  if (!url) return null;
  const u = new URL(url);
  const path = u.pathname.endsWith('/') ? u.pathname : `${u.pathname}/`;
  return `${u.origin}${path}`;
}

interface PlannedFile {
  path: string;
  bytes: string;
  /** Short sha of the content used for change detection (pages: without stamp). */
  contentKey: string;
  page?: RenderedPage;
}

function union<T>(...sets: Iterable<T>[]): Set<T> {
  const out = new Set<T>();
  for (const s of sets) for (const v of s) out.add(v);
  return out;
}

function dayPrefixes(locales: Iterable<string>, date: string): string[] {
  return [...locales].map((l) => `${l}/day/${date}/`);
}

export async function runGeneration(ctx: GenerationContext, opts: GenerateOptions = {}): Promise<GenerateResult> {
  const started = performance.now();
  const { store, log, config, outDir } = ctx;
  const now = ctx.now();
  const nowIso = now.toISOString();
  for (const d of opts.dates ?? []) if (!isValidLocalDate(d)) throw new RangeError(`Invalid date: ${d}`);
  assertSafeOutDir(outDir, {
    DATA_DIR: config.dirs.data,
    ARCHIVE_DIR: config.dirs.archive,
    CONFIG_DIR: config.dirs.config,
    MEDIA_DIR: ctx.mediaDir,
    'the site build': ctx.siteDistDir,
    'the repository': REPO_ROOT,
  });

  // One read transaction reads state, settings and every model input: it pins one WAL snapshot
  // for all statements, so no store write (not even from another process, e.g. the CLI next to
  // the running backend) can land between the reads. MEDIA_DIR is scanned AFTER the snapshot:
  // the pipeline writes a capture's media before it marks the capture ready, so every ready
  // capture in the snapshot finds its files (scanning first could miss a capture that became
  // ready in between and leave it out as "missing media").
  const build = await readSiteBuild(ctx.siteDistDir);
  let mediaAvailable: ReadonlySet<string> = new Set();
  const { state, dirty, inputs, versionFloor } = store.db
    .transaction(() => {
      const since = opts.holdWhileFeedCatchingUp ? store.syncState.catchingUpSince() : null;
      if (since) throw new FeedCatchingUpError(`the owner change feed is catching up (since ${since})`);
      return {
        state: loadState(store),
        dirty: isDirty(store),
        inputs: loadModelInputs(store, now, (p) => mediaAvailable.has(p)),
        versionFloor: store.meta.siteVersion(),
      };
    })
    .deferred();
  mediaAvailable = await scanMediaRoot(ctx.mediaDir);
  const settings = inputs.settings;
  const site: SiteInfo = {
    title: settings['site.title'],
    locales: settings['site.locales'],
    defaultLocale: settings['site.default_locale'],
    basePath: config.site.basePath,
    indexable: settings['site.indexable'],
  };
  const publicBase = publicBaseOf(config);
  const settingsHash = contentHash({ s: outputSettings(settings), site, publicBase, htaccess: ctx.htaccess });

  const fullReason = opts.full
    ? 'requested'
    : !state
      ? 'no previous state'
      : dirty
        ? 'previous run was interrupted'
        : state.generatorVersion !== GENERATOR_VERSION
          ? 'generator version changed'
          : state.buildHash !== build.hash
            ? 'new site build'
            : state.settingsHash !== settingsHash
              ? 'settings changed'
              : null;
  const full = fullReason !== null;
  markDirty(store);

  // ------------------------------------------------------------------------- model
  const model: SiteModel = buildSiteModel(inputs);
  const days = new Map(model.days.map((d) => [d.date, d]));
  const trips = new Map(model.trips.map((t) => [t.slug, t]));
  const summaryByDate = new Map(model.summaries.map((s) => [s.date, s]));
  // Change keys: everything a day's/trip's own files render. DaySummary includes the day file's
  // `v` plus the cover, which is not part of the day file (Day.coverSourceKey) but is shown as
  // the hero and og:image of the day and story pages and as the thumbnail on the trip page.
  // TripSummary includes the trip file's `v` plus the countries shown on the trip page.
  const dayKeys = new Map(model.summaries.map((s) => [s.date, contentHash(s)]));
  const tripKeys = new Map(model.tripSummaries.map((s) => [s.slug, contentHash(s)]));
  const timelineGeneratedAt = state && state.timelineV === model.timelineV ? state.timelineGeneratedAt : nowIso;

  // ------------------------------------------------------------------------- dependency map
  let renderDays: Set<string>;
  let renderTrips: Set<string>;
  if (full) {
    renderDays = new Set(days.keys());
    renderTrips = new Set(trips.keys());
  } else {
    const prev = state as GeneratorState;
    const changedDays = new Set<string>(opts.dates ?? []);
    for (const d of union(Object.keys(prev.days), days.keys())) {
      if (prev.days[d]?.v !== dayKeys.get(d)) changedDays.add(d);
    }
    const changedTrips = new Set<string>();
    for (const s of union(Object.keys(prev.trips), trips.keys())) {
      if (prev.trips[s]?.v !== tripKeys.get(s)) changedTrips.add(s);
    }
    renderTrips = new Set(changedTrips);
    for (const d of changedDays) {
      const before = prev.days[d]?.trip;
      const after = days.get(d)?.trip;
      if (before) renderTrips.add(before);
      if (after) renderTrips.add(after);
    }
    renderDays = new Set(changedDays);
    for (const s of changedTrips) {
      for (const d of prev.trips[s]?.days ?? []) renderDays.add(d);
      for (const d of trips.get(s)?.days ?? []) renderDays.add(d);
    }
    // A day page's first screen (the player twin, L3-02) previews the previous and next day
    // (cover, title, place): a changed day re-renders its neighbours' pages too.
    for (const d of changedDays) {
      const day = days.get(d);
      if (day?.prev) renderDays.add(day.prev);
      if (day?.next) renderDays.add(day.next);
    }
  }
  const sortedRenderDays = [...renderDays].sort();
  const sortedRenderTrips = [...renderTrips].sort();

  // ------------------------------------------------------------------------- render
  const planned = new Map<string, PlannedFile>();
  const plan = (path: string, bytes: string, page?: RenderedPage) => {
    planned.set(path, {
      path,
      bytes,
      contentKey: page ? page.contentHash : shortSha(bytes),
      ...(page ? { page } : {}),
    });
  };
  for (const date of sortedRenderDays) {
    const day = days.get(date);
    if (day) plan(dayDataPath(date), json(day));
  }
  for (const slug of sortedRenderTrips) {
    const trip = trips.get(slug);
    if (trip) plan(tripDataPath(slug), json(trip));
  }
  const timeline: TimelineIndex = {
    contractVersion: CONTRACT_VERSION,
    generatedAt: timelineGeneratedAt,
    trips: model.tripSummaries,
    days: model.summaries,
  };
  plan(TIMELINE_PATH, json(timeline));

  const pageCtx: SiteContext = {
    site,
    publicBase,
    build,
    days,
    summaries: model.summaries,
    summaryByDate,
    trips,
    tripSummaries: model.tripSummaries,
  };
  const pages: RenderedPage[] = [];
  for (const locale of site.locales) {
    pages.push(renderHome(pageCtx, locale));
    for (const date of sortedRenderDays) {
      const day = days.get(date);
      if (!day) continue;
      pages.push(renderDay(pageCtx, locale, day));
      for (const entry of day.entries) if (entry.kind === 'story') pages.push(renderStory(pageCtx, locale, day, entry));
    }
    // Every trip page, every run: its first screen shows the newest days (pages.ts renderTrip).
    for (const trip of model.trips) pages.push(renderTrip(pageCtx, locale, trip));
  }
  pages.push(renderNotFound(pageCtx), renderPicker(pageCtx));
  for (const page of pages) plan(page.path, '', page);

  plan('robots.txt', robotsTxt(site, publicBase));
  const routes: RouteRef[] = [{ name: 'home' }];
  for (const day of model.days) {
    routes.push({ name: 'day', date: day.date });
    for (const e of day.entries) if (e.kind === 'story') routes.push({ name: 'story', date: day.date, id: e.id });
  }
  for (const t of model.trips) routes.push({ name: 'trip', slug: t.slug });
  const sitemap = sitemapXml(site, publicBase, routes);
  if (sitemap) plan('sitemap.xml', sitemap);
  if (ctx.htaccess) plan('.htaccess', htaccess(site));
  if (site.indexable && !publicBase) log.warn('site.indexable is on but SITE_PUBLIC_URL is unset: no sitemap.xml');

  // ------------------------------------------------------------------------- removals in scope
  const toRemove = new Set<string>();
  if (full) {
    for (const path of Object.keys(state?.files ?? {})) if (!planned.has(path)) toRemove.add(path);
    const buildFiles = new Set(build.files);
    const foreign: string[] = [];
    for (const path of await scanOutputs(outDir)) {
      if (planned.has(path) || buildFiles.has(path) || path === MANIFEST_PATH) continue;
      if (isGeneratorPath(path)) toRemove.add(path);
      else foreign.push(path);
    }
    if (foreign.length > 0) {
      log.warn(
        { count: foreign.length, sample: foreign.slice(0, 5) },
        'OUT_DIR contains files the generator does not manage: left alone (they are published as they are)',
      );
    }
  } else {
    const prev = state as GeneratorState;
    const locales = union(prev.locales, site.locales);
    const prefixes: string[] = [];
    for (const d of renderDays) prefixes.push(dayDataPath(d), ...dayPrefixes(locales, d));
    for (const s of renderTrips) prefixes.push(tripDataPath(s), ...[...locales].map((l) => `${l}/trip/${s}/`));
    prefixes.push('sitemap.xml', '.htaccess');
    for (const path of Object.keys(prev.files)) {
      if (planned.has(path) || path === MANIFEST_PATH) continue;
      if (prefixes.some((p) => path === p || (p.endsWith('/') && path.startsWith(p)))) toRemove.add(path);
    }
  }
  toRemove.delete(MANIFEST_PATH);

  // ------------------------------------------------------------------------- media + assets plan
  const mediaDesired = new Set(model.media);
  const mediaPresent = await scanMediaRoot(join(outDir, 'media'));
  const mediaToLink: string[] = model.media.filter((rel) => !mediaPresent.has(rel));
  if (full) {
    // Full runs also re-link present files that are not (a same-sized copy of) the variant.
    const present = model.media.filter((rel) => mediaPresent.has(rel));
    const stale = await mapLimit(present, FS_CONCURRENCY, async (rel) => {
      const [s, t] = await Promise.all([
        fsp.stat(mediaFilePath(ctx.mediaDir, rel)),
        fsp.stat(join(outDir, rel)).catch(() => null),
      ]);
      return !t || !((s.ino === t.ino && s.dev === t.dev) || s.size === t.size);
    });
    present.forEach((rel, i) => {
      if (stale[i]) mediaToLink.push(rel);
    });
  }
  const mediaToRemove = [...mediaPresent].filter((rel) => !mediaDesired.has(rel)).sort();
  const mediaHash = contentHash(model.media);

  const assetsToCopy: string[] = [];
  const assetsToRemove: string[] = [];
  if (full) {
    const present = await scanAssets(outDir);
    for (const rel of build.files) {
      const current = await readIfExists(outDir, rel);
      if (!current?.equals(await fsp.readFile(join(build.dir, rel)))) assetsToCopy.push(rel);
    }
    const wanted = new Set(build.files);
    for (const rel of [...present].sort()) if (!wanted.has(rel)) assetsToRemove.push(rel);
  }

  // ------------------------------------------------------------------------- release
  const contentChanged = (f: PlannedFile): boolean =>
    f.page ? state?.pages[f.path]?.h !== f.contentKey : state?.files[f.path] !== f.contentKey;
  const trackedRemovals = [...toRemove].filter((p) => state?.files[p] !== undefined);
  const anyChange =
    !state ||
    // The version floor was raised above the last release (a target serves a newer one, L2-02 d).
    versionFloor > state.version ||
    [...planned.values()].some(contentChanged) ||
    trackedRemovals.length > 0 ||
    state.mediaHash !== mediaHash ||
    state.buildHash !== build.hash ||
    state.timelineV !== model.timelineV;
  const version = anyChange ? store.meta.nextSiteVersion() : (state as GeneratorState).version;
  const generatedAt = anyChange ? nowIso : (state as GeneratorState).generatedAt;
  const current: ReleaseStamp = { manifestVersion: version, timelineV: model.timelineV };

  const pageStates: GeneratorState['pages'] = {};
  for (const f of planned.values()) {
    if (!f.page) continue;
    const prevPage = state?.pages[f.path];
    const stamp: ReleaseStamp =
      f.page.alwaysCurrent || contentChanged(f) || !prevPage
        ? current
        : { manifestVersion: prevPage.mv, timelineV: prevPage.tv };
    f.bytes = f.page.render(stamp);
    pageStates[f.path] = { h: f.contentKey, mv: stamp.manifestVersion, tv: stamp.timelineV };
  }
  const manifest: Manifest = {
    contractVersion: CONTRACT_VERSION,
    version,
    generatedAt,
    site,
    timeline: { v: model.timelineV },
  };
  const manifestBytes = json(manifest);

  if (ctx.validate) validateOutputs(planned, manifest, timeline);

  // ------------------------------------------------------------------------- write
  const changed: string[] = [];
  const removed: string[] = [];
  // Durability (W2-1): every file is fsynced before its rename; the directories of new entries
  // are fsynced once, before manifest.json (which switches the site to this release) is written.
  const pendingDirs = new Set<string>();
  // Media directories world-readable whatever the umask (linkOrCopy creates missing ones plainly).
  for (const dir of new Set(mediaToLink.map((rel) => dirname(join(outDir, rel))))) await mkdirWithMode(dir, 0o755);
  await mapLimit(mediaToLink, FS_CONCURRENCY, (rel) => linkOrCopy(mediaFilePath(ctx.mediaDir, rel), join(outDir, rel)));
  for (const rel of mediaToLink) pendingDirs.add(dirname(join(outDir, rel)));
  changed.push(...mediaToLink);
  for (const rel of assetsToCopy) {
    await copyAtomic(join(build.dir, rel), outDir, rel, { pendingDirs, durable: false });
    changed.push(rel);
  }
  const order = (p: string) =>
    p.startsWith('data/days/') || p.startsWith('data/trips/')
      ? 0
      : p === TIMELINE_PATH
        ? 1
        : p.endsWith('.html')
          ? 2
          : 3;
  const writes = [...planned.values()].sort((a, b) => order(a.path) - order(b.path) || (a.path < b.path ? -1 : 1));
  // Phase by phase (data files, timeline, pages, root files); within a phase in parallel, so the
  // fsyncs overlap instead of adding up.
  for (const phase of [0, 1, 2, 3]) {
    const batch = writes.filter((f) => order(f.path) === phase);
    const written = await mapLimit(batch, FS_CONCURRENCY, async (f) => {
      const existing = await readIfExists(outDir, f.path);
      if (existing?.equals(Buffer.from(f.bytes, 'utf8'))) return false;
      await writeAtomic(outDir, f.path, f.bytes, { pendingDirs });
      return true;
    });
    batch.forEach((f, i) => {
      if (written[i]) changed.push(f.path);
    });
  }
  await syncDirs(pendingDirs);
  const existingManifest = await readIfExists(outDir, MANIFEST_PATH);
  if (!existingManifest?.equals(Buffer.from(manifestBytes, 'utf8'))) {
    await writeAtomic(outDir, MANIFEST_PATH, manifestBytes);
    changed.push(MANIFEST_PATH);
  }
  for (const rel of [...toRemove].sort()) if (await removeOutput(outDir, rel)) removed.push(rel);
  for (const rel of mediaToRemove) if (await removeOutput(outDir, rel)) removed.push(rel);
  for (const rel of assetsToRemove) if (await removeOutput(outDir, rel)) removed.push(rel);

  // ------------------------------------------------------------------------- state
  const files: GeneratorState['files'] = full ? {} : { ...(state as GeneratorState).files };
  const pagesState: GeneratorState['pages'] = full ? {} : { ...(state as GeneratorState).pages };
  for (const path of toRemove) {
    delete files[path];
    delete pagesState[path];
  }
  for (const f of planned.values()) files[f.path] = shortSha(f.bytes);
  files[MANIFEST_PATH] = shortSha(manifestBytes);
  Object.assign(pagesState, pageStates);
  const next: GeneratorState = {
    schema: 1,
    generatorVersion: GENERATOR_VERSION,
    buildHash: build.hash,
    settingsHash,
    version,
    generatedAt,
    timelineV: model.timelineV,
    timelineGeneratedAt,
    mediaHash,
    locales: [...site.locales],
    days: Object.fromEntries(
      model.days.map((d) => [
        d.date,
        {
          v: dayKeys.get(d.date) ?? d.v,
          trip: d.trip ?? null,
          stories: d.entries.filter((e) => e.kind === 'story').map((e) => e.id),
        },
      ]),
    ),
    trips: Object.fromEntries(model.trips.map((t) => [t.slug, { v: tripKeys.get(t.slug) ?? t.v, days: [...t.days] }])),
    files: sortRecord(files),
    pages: sortRecord(pagesState),
  };
  saveState(store, next);

  const result: GenerateResult = {
    version,
    changed: changed.sort(),
    removed: removed.sort(),
    full,
    durationMs: Math.round(performance.now() - started),
    fullReason,
    dates: sortedRenderDays,
    timelineV: model.timelineV,
    nextRunAt: model.nextPublishAt,
    warnings: model.warnings,
    stats: {
      days: model.days.length,
      trips: model.trips.length,
      entries: model.stats.entries,
      media: model.media.length,
      pagesRendered: pages.length,
      written: changed.length,
    },
  };
  const warningsKey = model.warnings.join('\n');
  if (warningsKey !== ctx.lastWarnings) for (const w of model.warnings) log.warn(w);
  ctx.lastWarnings = warningsKey;
  log.info(
    {
      reason: opts.reason,
      full,
      fullReason,
      version,
      changed: result.changed.length,
      removed: result.removed.length,
      days: result.stats.days,
      durationMs: result.durationMs,
      nextRunAt: result.nextRunAt,
      warnings: model.warnings.length,
    },
    anyChange ? 'site generated' : 'site unchanged',
  );
  return result;
}

/** Parallel file operations (media links/stats): enough to hide syscall latency, few fds. */
const FS_CONCURRENCY = 16;

/** Maps `items` with at most `limit` calls in flight; results in input order; rejects on the first error. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function bootOf(bytes: string): unknown {
  const m = /<script id="omw-boot" type="application\/json">([\s\S]*?)<\/script>/.exec(bytes);
  return m?.[1] ? JSON.parse(m[1]) : null;
}

/** Validates every planned JSON file and Boot block against the site contracts. */
function validateOutputs(planned: ReadonlyMap<string, PlannedFile>, manifest: Manifest, timeline: TimelineIndex): void {
  const problems: string[] = [];
  const check = (path: string, schema: z.ZodType, value: unknown) => {
    const r = schema.safeParse(value);
    if (!r.success) problems.push(`${path}: ${z.prettifyError(r.error)}`);
  };
  check(MANIFEST_PATH, Manifest, manifest);
  check(TIMELINE_PATH, TimelineIndex, timeline);
  for (const f of planned.values()) {
    if (f.path.startsWith('data/days/')) check(f.path, DayDetail, JSON.parse(f.bytes));
    else if (f.path.startsWith('data/trips/')) check(f.path, TripDetail, JSON.parse(f.bytes));
    else if (f.page?.boot) check(`${f.path} (boot)`, Boot, bootOf(f.bytes));
  }
  if (problems.length > 0) {
    throw new GeneratorValidationError(`Generated files violate @omw/contracts/site:\n- ${problems.join('\n- ')}`);
  }
}
