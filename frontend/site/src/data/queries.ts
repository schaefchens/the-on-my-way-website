/**
 * TanStack Query layer over the static data files (plan C, "Data (site)").
 *
 * Keys carry the content hash, so cached entries are immutable (staleTime: Infinity):
 *   ['omw', 'manifest']                 polled every 5 min, never cached by the browser
 *   ['omw', 'timeline', v]
 *   ['omw', 'day', date, v]
 *   ['omw', 'trip', slug, v]
 * The current timeline hash is held by a VersionStore: it starts at the Boot JSON's timelineV
 * (or the first manifest), is checked once against the manifest (resolveTimelineV) and later
 * only moves when the visitor accepts "new moments".
 *
 * Startup (L3-01, main.tsx): the manifest and the boot's timeline.json?v=<timelineV> are
 * requested at once, in parallel with the message catalog (startInitialFetches); a day inlined
 * in the Boot JSON serves its day/story route without waiting for either (ensureDay).
 */
import type { DayDetail, DaySummary, TimelineIndex, TripDetail } from '@omw/contracts/site';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { accessState } from '../access/access';
import { MANIFEST_POLL_MS } from '../config';
import { AccessEndedError, fetchDay, fetchManifest, fetchTimeline, fetchTrip } from './fetch';

export const queryKeys = {
  all: ['omw'] as const,
  manifest: () => ['omw', 'manifest'] as const,
  timeline: (v: string) => ['omw', 'timeline', v] as const,
  day: (date: string, v: string) => ['omw', 'day', date, v] as const,
  trip: (slug: string, v: string) => ['omw', 'trip', slug, v] as const,
};

const IMMUTABLE = { staleTime: Number.POSITIVE_INFINITY, gcTime: 30 * 60_000 } as const;

/**
 * The manifest poll: every 5 minutes, until the gate refuses a request (AccessEndedError, here or
 * anywhere else: the access state then leaves "ok", spec-wave5 §6.3).
 */
export function manifestPollInterval(error: unknown): number | false {
  return error instanceof AccessEndedError || accessState.get() !== 'ok' ? false : MANIFEST_POLL_MS;
}

export function manifestQueryOptions(basePath: string) {
  return queryOptions({
    queryKey: queryKeys.manifest(),
    queryFn: ({ signal }) => fetchManifest(basePath, { signal }),
    staleTime: 60_000,
    refetchInterval: (query) => manifestPollInterval(query.state.error),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

export function timelineQueryOptions(basePath: string, v: string) {
  return queryOptions({
    queryKey: queryKeys.timeline(v),
    queryFn: ({ signal }) => fetchTimeline(basePath, v, { signal }),
    ...IMMUTABLE,
  });
}

export function dayQueryOptions(basePath: string, date: string, v: string) {
  return queryOptions({
    queryKey: queryKeys.day(date, v),
    queryFn: ({ signal }) => fetchDay(basePath, date, v, { signal }),
    ...IMMUTABLE,
  });
}

export function tripQueryOptions(basePath: string, slug: string, v: string) {
  return queryOptions({
    queryKey: queryKeys.trip(slug, v),
    queryFn: ({ signal }) => fetchTrip(basePath, slug, v, { signal }),
    ...IMMUTABLE,
  });
}

// ---------------------------------------------------------------------------------------------
// Current timeline version

export interface VersionStore {
  get(): string | null;
  set(v: string): void;
  subscribe(listener: () => void): () => void;
}

export function createVersionStore(initial: string | null): VersionStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set(v) {
      if (v === current) return;
      current = v;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** What the page's Boot JSON says about its data (a subset of SiteBoot). */
export interface BootData {
  /** Timeline hash of the release the page belongs to. */
  timelineV: string | null;
  /** The day of a day/story page, inlined. */
  day: DayDetail | null;
}

export interface DataContext {
  basePath: string;
  queryClient: QueryClient;
  timelineVersion: VersionStore;
  boot?: BootData;
}

/** One check of the boot's timeline hash against the manifest per VersionStore (page load). */
const validations = new WeakMap<VersionStore, Promise<void>>();
/** Stores whose check has completed. */
const validated = new WeakSet<VersionStore>();

async function validateTimelineV(ctx: DataContext): Promise<void> {
  const bootV = ctx.timelineVersion.get();
  if (!bootV) {
    // Nothing to start from (no Boot JSON): the manifest decides (retried like any request).
    const manifest = await ctx.queryClient.ensureQueryData(manifestQueryOptions(ctx.basePath));
    if (!ctx.timelineVersion.get()) ctx.timelineVersion.set(manifest.timeline.v);
    return;
  }
  // The boot's timeline is already on its way (startInitialFetches). A manifest that cannot be
  // loaded right now must not hold the page: no retries here (the hooks retry it later), the
  // boot's hash stands.
  const manifest = await ctx.queryClient
    .fetchQuery({ ...manifestQueryOptions(ctx.basePath), retry: false })
    .catch(() => null);
  // Only the boot's hash is replaced (the visitor may have accepted newer moments meanwhile).
  if (manifest && ctx.timelineVersion.get() === bootV) ctx.timelineVersion.set(manifest.timeline.v);
}

/**
 * The accepted timeline hash. The first call settles it: the Boot JSON's hash is used when the
 * manifest names the same timeline (or cannot be loaded); when the site has moved on since the
 * page was generated, the manifest's hash is used instead. Without a boot hash the manifest
 * decides.
 */
export async function resolveTimelineV(ctx: DataContext): Promise<string> {
  let validation = validations.get(ctx.timelineVersion);
  if (!validation) {
    const started = validateTimelineV(ctx).then(() => {
      validated.add(ctx.timelineVersion);
    });
    validation = started;
    validations.set(ctx.timelineVersion, started);
    // Without a boot hash a failed manifest fails the route; the next call (retry) tries again.
    started.catch(() => {
      if (validations.get(ctx.timelineVersion) === started) validations.delete(ctx.timelineVersion);
    });
  }
  await validation;
  const v = ctx.timelineVersion.get();
  if (!v) throw new Error('No timeline version');
  return v;
}

export interface EnsureTimelineOptions {
  /**
   * The page's own timeline (the Boot JSON's hash) right away, without waiting for the manifest
   * check: enough to find the files of a day or trip page of that release (their HTML carries
   * that release), so their data does not queue behind the manifest round trip. The check still
   * runs; later calls see its result.
   */
  pageRelease?: boolean;
}

export async function ensureTimeline(ctx: DataContext, opts: EnsureTimelineOptions = {}): Promise<TimelineIndex> {
  const current = ctx.timelineVersion.get();
  if (opts.pageRelease && current && !validated.has(ctx.timelineVersion)) {
    resolveTimelineV(ctx).catch(() => undefined);
    return ctx.queryClient.ensureQueryData(timelineQueryOptions(ctx.basePath, current));
  }
  const v = await resolveTimelineV(ctx);
  return ctx.queryClient.ensureQueryData(timelineQueryOptions(ctx.basePath, v));
}

export interface InitialFetchOptions {
  /**
   * Priority of the speculative timeline request: "low" when the first screen does not need it
   * (a deep-linked day: the player starts from the inlined day, the timeline loads behind it).
   */
  timelinePriority?: RequestPriority;
}

/**
 * Starts the first requests at once (L3-01): the manifest (no-store) and, when the Boot JSON
 * names it, exactly `<basePath>data/timeline.json?v=<timelineV>` (the URL generated pages
 * preload). The manifest only validates that hash (resolveTimelineV). Never throws.
 */
export function startInitialFetches(ctx: DataContext, opts: InitialFetchOptions = {}): void {
  const v = ctx.timelineVersion.get();
  if (v) {
    const base = timelineQueryOptions(ctx.basePath, v);
    void ctx.queryClient.prefetchQuery({
      ...base,
      queryFn: ({ signal }) =>
        fetchTimeline(
          ctx.basePath,
          v,
          opts.timelinePriority ? { signal, priority: opts.timelinePriority } : { signal },
        ),
    });
  }
  resolveTimelineV(ctx).catch(() => undefined);
}

/** The day inlined in the Boot JSON, while the page's own timeline is the accepted one. */
export function bootDayFor(ctx: DataContext, date: string): DayDetail | null {
  const boot = ctx.boot;
  const day = boot?.day;
  if (!day || day.date !== date) return null;
  // After "new moments" (or a newer manifest at startup) the day may have changed: the timeline
  // decides again.
  if (boot.timelineV !== null && ctx.timelineVersion.get() !== boot.timelineV) return null;
  return ctx.queryClient.getQueryData<DayDetail>(queryKeys.day(day.date, day.v)) ?? day;
}

export function findDay(timeline: TimelineIndex, date: string): DaySummary | undefined {
  return timeline.days.find((d) => d.date === date);
}

/**
 * Day data, or null when the timeline has no such (public) day. The day of a day/story page
 * comes from its Boot JSON without waiting for the manifest or the timeline (bootDayFor).
 */
export async function ensureDay(ctx: DataContext, date: string): Promise<DayDetail | null> {
  const inlined = bootDayFor(ctx, date);
  if (inlined) return inlined;
  const summary = findDay(await ensureTimeline(ctx, { pageRelease: true }), date);
  if (!summary) return null;
  return ctx.queryClient.ensureQueryData(dayQueryOptions(ctx.basePath, date, summary.v));
}

/** Trip data, or null when the timeline has no such trip. */
export async function ensureTrip(ctx: DataContext, slug: string): Promise<TripDetail | null> {
  const summary = (await ensureTimeline(ctx, { pageRelease: true })).trips.find((t) => t.slug === slug);
  if (!summary) return null;
  return ctx.queryClient.ensureQueryData(tripQueryOptions(ctx.basePath, slug, summary.v));
}

/** Neighbouring public days in the timeline (days are ascending). */
export function adjacentDays(timeline: TimelineIndex, date: string): { prev?: DaySummary; next?: DaySummary } {
  const i = timeline.days.findIndex((d) => d.date === date);
  if (i < 0) return {};
  const prev = timeline.days[i - 1];
  const next = timeline.days[i + 1];
  return { ...(prev ? { prev } : {}), ...(next ? { next } : {}) };
}

/** Prefetch on intent (hover/focus/touchstart) or ahead of the player. Never throws. */
export function prefetchDay(ctx: DataContext, timeline: TimelineIndex, date: string): Promise<void> {
  const summary = findDay(timeline, date);
  if (!summary) return Promise.resolve();
  return ctx.queryClient.prefetchQuery(dayQueryOptions(ctx.basePath, date, summary.v));
}

/** Prefetch day N±1 while the player shows day N (plan C). */
export async function prefetchAdjacentDays(ctx: DataContext, timeline: TimelineIndex, date: string): Promise<void> {
  const { prev, next } = adjacentDays(timeline, date);
  await Promise.all([prev, next].filter((d) => d !== undefined).map((d) => prefetchDay(ctx, timeline, d.date)));
}

/**
 * Prefetch the newest `count` days: the top of the timeline (days level) shows their filmstrips,
 * so their files can be on the way before React has rendered the rows.
 */
export function prefetchNewestDays(ctx: DataContext, timeline: TimelineIndex, count: number): void {
  for (const day of timeline.days.slice(-count)) void prefetchDay(ctx, timeline, day.date);
}

/** Seeds the cache with data inlined in the Boot JSON, so the first screen needs no day request. */
export function seedFromBoot(ctx: DataContext, boot: { day: DayDetail | null }): void {
  if (boot.day) ctx.queryClient.setQueryData(queryKeys.day(boot.day.date, boot.day.v), boot.day);
}
