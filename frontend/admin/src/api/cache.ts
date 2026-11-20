/**
 * Optimistic cache updates for owner writes.
 *
 * Every updater is IDEMPOTENT ("set the entity to X", never "+1"), because it may be re-applied:
 * after a rollback of an earlier write and after a refetch that landed while writes were still
 * queued (see writes.ts reapplyPending). Updaters only touch queries that already hold data,
 * except entity detail entries they create on purpose.
 *
 * CacheTx records the original data of every query it changes, so a failed write can restore
 * exactly what it touched.
 */
import type {
  AdminDayDetail,
  AdminDaySummary,
  AdminPost,
  AdminTrip,
  Annotation,
  CaptureListItem,
  CaptureListResponse,
  Day,
  DayListResponse,
  PostListResponse,
  Settings,
  SettingsPatch,
  TripListResponse,
} from '@omw/contracts/api';
import { effectiveCaptureVisibility, effectiveLocalDate, effectiveTz, tripForDate } from '@omw/contracts/policy';
import { localDateFor } from '@omw/contracts/time';
import { hashKey, type InfiniteData, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { modeSinceAfter } from '../lib/mode-since';
import { qk } from './keys';
import type {
  AnnotateVars,
  CacheSnapshot,
  CreatePostVars,
  DeletePostVars,
  DeleteTripVars,
  PatchDayVars,
  PatchSettingsVars,
  PutTripVars,
  UpdatePostVars,
} from './types';

export type CaptureLists = InfiniteData<CaptureListResponse, string | null>;

/** Records the first-seen data of every query it changes. */
export class CacheTx {
  readonly snapshot: CacheSnapshot = [];
  readonly #seen = new Set<string>();
  readonly #qc: QueryClient;
  readonly #record: boolean;

  constructor(qc: QueryClient, record = true) {
    this.#qc = qc;
    this.#record = record;
  }

  get client(): QueryClient {
    return this.#qc;
  }

  #remember(queryKey: QueryKey, data: unknown): void {
    if (!this.#record) return;
    const hash = hashKey(queryKey);
    if (this.#seen.has(hash)) return;
    this.#seen.add(hash);
    this.snapshot.push([[...queryKey], data === undefined ? undefined : structuredClone(data)]);
  }

  /** Updates one existing entry (no-op when the query has no data). */
  update<T>(queryKey: QueryKey, fn: (old: T) => T): void {
    const old = this.#qc.getQueryData<T>(queryKey);
    if (old === undefined) return;
    const next = fn(old);
    if (next === old) return;
    this.#remember(queryKey, old);
    this.#qc.setQueryData<T>(queryKey, next);
  }

  /** Creates or replaces one entry. */
  set<T>(queryKey: QueryKey, value: T): void {
    const old = this.#qc.getQueryData<T>(queryKey);
    this.#remember(queryKey, old);
    this.#qc.setQueryData<T>(queryKey, value);
  }

  /** Removes one entry (restored on rollback). */
  remove(queryKey: QueryKey): void {
    const old = this.#qc.getQueryData(queryKey);
    if (old === undefined) return;
    this.#remember(queryKey, old);
    this.#qc.removeQueries({ queryKey, exact: true });
  }

  /** Updates every entry below a key prefix that holds data. */
  updateAll<T>(prefix: QueryKey, fn: (old: T, queryKey: QueryKey) => T): void {
    for (const [queryKey, old] of this.#qc.getQueriesData<T>({ queryKey: prefix })) {
      if (old === undefined) continue;
      const next = fn(old, queryKey);
      if (next === old) continue;
      this.#remember(queryKey, old);
      this.#qc.setQueryData<T>(queryKey, next);
    }
  }
}

/** Puts the recorded data back (entries that did not exist are removed). */
export function restoreSnapshot(qc: QueryClient, snapshot: CacheSnapshot | undefined): void {
  if (!snapshot) return;
  for (const [queryKey, data] of snapshot) {
    if (data === undefined) qc.removeQueries({ queryKey, exact: true });
    else qc.setQueryData(queryKey, data);
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

const byOccurred = (a: { occurredAt: string }, b: { occurredAt: string }) =>
  a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0;

function isoNow(now: number): string {
  return new Date(now).toISOString();
}

/** PATCH semantics: absent = unchanged, null = clear. */
function patched<T>(patch: object, key: string, current: T): T {
  return key in patch ? ((patch as Record<string, unknown>)[key] as T) : current;
}

export function cachedSettings(qc: QueryClient): Settings | undefined {
  return qc.getQueryData<Settings>(qk.settings);
}

/** Day.tz fix of a date, if the day is cached anywhere. */
export function cachedDayTz(qc: QueryClient, date: string): string | null {
  const detail = qc.getQueryData<AdminDayDetail>(qk.day(date));
  if (detail) return detail.day?.tz ?? null;
  const list = qc.getQueryData<DayListResponse>(qk.days);
  return list?.items.find((d) => d.localDate === date)?.day?.tz ?? null;
}

/** Any cached copy of a capture (detail first, then lists and day details). */
export function findCapture(qc: QueryClient, sourceKey: string): CaptureListItem | undefined {
  const direct = qc.getQueryData<CaptureListItem>(qk.capture(sourceKey));
  if (direct) return direct;
  for (const [, data] of qc.getQueriesData<CaptureLists>({ queryKey: qk.capturesAll })) {
    const hit = data?.pages.flatMap((p) => p.items).find((c) => c.sourceKey === sourceKey);
    if (hit) return hit;
  }
  for (const [, data] of qc.getQueriesData<AdminDayDetail>({ queryKey: qk.dayAll })) {
    const hit = data?.captures.find((c) => c.sourceKey === sourceKey);
    if (hit) return hit;
  }
  return undefined;
}

/** Every capture any cache holds (lists, day details, detail entries), once each. */
export function cachedCaptures(qc: QueryClient): CaptureListItem[] {
  const out = new Map<string, CaptureListItem>();
  const add = (c: CaptureListItem | undefined) => {
    if (c && !out.has(c.sourceKey)) out.set(c.sourceKey, c);
  };
  for (const [, data] of qc.getQueriesData<CaptureListItem>({ queryKey: ['admin', 'capture'] })) add(data);
  for (const [, data] of qc.getQueriesData<CaptureLists>({ queryKey: qk.capturesAll })) {
    for (const p of data?.pages ?? []) for (const c of p.items) add(c);
  }
  for (const [, data] of qc.getQueriesData<AdminDayDetail>({ queryKey: qk.dayAll })) {
    for (const c of data?.captures ?? []) add(c);
  }
  return [...out.values()];
}

export function findPost(qc: QueryClient, publicId: string): AdminPost | undefined {
  const direct = qc.getQueryData<AdminPost>(qk.post(publicId));
  if (direct) return direct;
  for (const [, data] of qc.getQueriesData<PostListResponse>({ queryKey: qk.postsAll })) {
    const hit = data?.items.find((p) => p.publicId === publicId);
    if (hit) return hit;
  }
  for (const [, data] of qc.getQueriesData<AdminDayDetail>({ queryKey: qk.dayAll })) {
    const hit = data?.posts.find((p) => p.publicId === publicId);
    if (hit) return hit;
  }
  return undefined;
}

export function findDay(qc: QueryClient, date: string): Day | null | undefined {
  const detail = qc.getQueryData<AdminDayDetail>(qk.day(date));
  if (detail) return detail.day;
  return qc.getQueryData<DayListResponse>(qk.days)?.items.find((d) => d.localDate === date)?.day;
}

/** Preview URL of a capture if any cache knows it (for optimistic covers). */
function previewOf(qc: QueryClient, sourceKey: string | null | undefined): string | null {
  if (!sourceKey) return null;
  const c = findCapture(qc, sourceKey);
  return c?.previewUrl ?? c?.posterUrl ?? null;
}

// ---------------------------------------------------------------------------------------------
// Captures

/** The capture with an annotation patch applied locally (effective fields recomputed). */
export function annotateLocally(
  c: CaptureListItem,
  patch: AnnotateVars['patch'],
  env: { settings?: Settings | undefined; now: number; dayTz?: string | null | undefined },
): CaptureListItem {
  const prev = c.annotation;
  const annotation: Annotation = {
    sourceKey: c.sourceKey,
    description: patched(patch, 'description', prev?.description ?? null),
    origLocale: patched(patch, 'origLocale', prev?.origLocale ?? null),
    visibility: patched(patch, 'visibility', prev?.visibility ?? null),
    localDateOverride: patched(patch, 'localDateOverride', prev?.localDateOverride ?? null),
    updatedAt: prev?.updatedAt ?? isoNow(env.now),
  };
  let visibility = c.effectiveVisibility;
  if (annotation.visibility) visibility = annotation.visibility;
  else if (env.settings) visibility = effectiveCaptureVisibility(c, annotation, env.settings, env.now);
  else if (prev?.visibility) visibility = 'public';
  return {
    ...c,
    annotation,
    effectiveVisibility: visibility,
    effectiveLocalDate: effectiveLocalDate(c, annotation, env.dayTz),
    effectiveTz: effectiveTz(c, annotation, env.dayTz),
  };
}

/** Replaces a capture in every cache and moves it between cached day details if needed. */
export function putCapture(tx: CacheTx, item: CaptureListItem): void {
  const swap = (c: CaptureListItem) => (c.sourceKey === item.sourceKey ? item : c);
  tx.updateAll<CaptureLists>(qk.capturesAll, (data) => {
    if (!data.pages.some((p) => p.items.some((c) => c.sourceKey === item.sourceKey))) return data;
    return { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.map(swap) })) };
  });
  tx.update<CaptureListItem>(qk.capture(item.sourceKey), () => item);
  tx.updateAll<AdminDayDetail>(qk.dayAll, (detail) => {
    const has = detail.captures.some((c) => c.sourceKey === item.sourceKey);
    const belongs = detail.localDate === item.effectiveLocalDate;
    if (belongs) {
      const captures = has ? detail.captures.map(swap) : [...detail.captures, item].sort(byOccurred);
      return { ...detail, captures };
    }
    return has ? { ...detail, captures: detail.captures.filter((c) => c.sourceKey !== item.sourceKey) } : detail;
  });
}

export function optimisticAnnotate(tx: CacheTx, vars: AnnotateVars, now: number): void {
  const current = findCapture(tx.client, vars.sourceKey);
  if (!current) return;
  const next = annotateLocally(current, vars.patch, {
    settings: cachedSettings(tx.client),
    now,
    dayTz: cachedDayTz(tx.client, current.localDate),
  });
  putCapture(tx, next);
}

// ---------------------------------------------------------------------------------------------
// Days

export function dayLocally(day: Day | null | undefined, date: string, patch: PatchDayVars['patch'], now: number): Day {
  return {
    localDate: date,
    title: patched(patch, 'title', day?.title ?? null),
    summary: patched(patch, 'summary', day?.summary ?? null),
    origLocale: patched(patch, 'origLocale', day?.origLocale ?? null),
    placeName: patched(patch, 'placeName', day?.placeName ?? null),
    countryCode: patched(patch, 'countryCode', day?.countryCode ?? null),
    lat: patched(patch, 'lat', day?.lat ?? null),
    lng: patched(patch, 'lng', day?.lng ?? null),
    coverSourceKey: patched(patch, 'coverSourceKey', day?.coverSourceKey ?? null),
    tz: patched(patch, 'tz', day?.tz ?? null),
    updatedAt: day?.updatedAt ?? isoNow(now),
  };
}

/** Writes a Day into the detail and list caches (the summary's effective cover follows). */
export function putDay(tx: CacheTx, day: Day): void {
  const qc = tx.client;
  tx.update<AdminDayDetail>(qk.day(day.localDate), (d) => ({ ...d, day }));
  tx.update<DayListResponse>(qk.days, (list) => {
    if (!list.items.some((s) => s.localDate === day.localDate)) return list;
    return {
      ...list,
      items: list.items.map((s): AdminDaySummary => {
        if (s.localDate !== day.localDate) return s;
        const coverChanged = (s.day?.coverSourceKey ?? null) !== (day.coverSourceKey ?? null);
        if (!coverChanged) return { ...s, day };
        const cover = day.coverSourceKey ?? null;
        // Clearing the explicit cover: keep showing the current one until the server answers.
        return cover
          ? { ...s, day, coverSourceKey: cover, coverPreviewUrl: previewOf(qc, cover) ?? s.coverPreviewUrl }
          : { ...s, day };
      }),
    };
  });
}

export function optimisticPatchDay(tx: CacheTx, vars: PatchDayVars, now: number): void {
  putDay(tx, dayLocally(findDay(tx.client, vars.date), vars.date, vars.patch, now));
}

/** Server answer of PATCH /days/{date}. */
export function confirmDay(tx: CacheTx, detail: AdminDayDetail): void {
  tx.set<AdminDayDetail>(qk.day(detail.localDate), detail);
  if (detail.day) putDay(tx, detail.day);
  for (const c of detail.captures) putCapture(tx, c);
}

// ---------------------------------------------------------------------------------------------
// Posts

export function postFromCreate(vars: CreatePostVars, env: { now: number; tz: string }): AdminPost {
  const body = vars.body;
  const occurredAt = body.occurredAt ?? isoNow(env.now);
  const tz = body.tz ?? env.tz;
  const base = {
    publicId: body.publicId,
    occurredAt,
    tz,
    localDate: localDateFor(occurredAt, tz),
    origLocale: body.origLocale,
    visibility: body.visibility ?? 'public',
    updatedAt: isoNow(env.now),
    changeSeq: 0,
  };
  return body.kind === 'note'
    ? { ...base, kind: 'note', content: body.content }
    : { ...base, kind: 'story', content: body.content };
}

export function postLocally(post: AdminPost, patch: UpdatePostVars['patch']): AdminPost {
  const occurredAt = patch.occurredAt ?? post.occurredAt;
  const tz = patch.tz ?? post.tz;
  const moved = occurredAt !== post.occurredAt || tz !== post.tz;
  const next = {
    ...post,
    occurredAt,
    tz,
    localDate: moved ? localDateFor(occurredAt, tz) : post.localDate,
    origLocale: patch.origLocale ?? post.origLocale,
    visibility: patch.visibility ?? post.visibility,
  };
  if (patch.content) return { ...next, content: patch.content } as AdminPost;
  return next;
}

/** Puts a post into every cache (lists, detail, the day it belongs to). */
export function putPost(tx: CacheTx, post: AdminPost): void {
  tx.set<AdminPost>(qk.post(post.publicId), post);
  tx.updateAll<PostListResponse>(qk.postsAll, (list, queryKey) => {
    const filter = (queryKey[2] ?? {}) as { date?: string; kind?: string };
    const matches = (!filter.date || filter.date === post.localDate) && (!filter.kind || filter.kind === post.kind);
    const has = list.items.some((p) => p.publicId === post.publicId);
    if (!matches) return has ? { ...list, items: list.items.filter((p) => p.publicId !== post.publicId) } : list;
    const items = has
      ? list.items.map((p) => (p.publicId === post.publicId ? post : p))
      : [post, ...list.items].sort((a, b) => -byOccurred(a, b));
    return { ...list, items };
  });
  tx.updateAll<AdminDayDetail>(qk.dayAll, (detail) => {
    const has = detail.posts.some((p) => p.publicId === post.publicId);
    if (detail.localDate === post.localDate) {
      const posts = has
        ? detail.posts.map((p) => (p.publicId === post.publicId ? post : p))
        : [...detail.posts, post].sort(byOccurred);
      return { ...detail, posts };
    }
    return has ? { ...detail, posts: detail.posts.filter((p) => p.publicId !== post.publicId) } : detail;
  });
  // A post on a date the day list does not know yet: add an empty summary (counts follow on refetch).
  tx.update<DayListResponse>(qk.days, (list) => {
    if (list.items.some((s) => s.localDate === post.localDate)) return list;
    const trips = tx.client.getQueryData<TripListResponse>(qk.trips)?.items ?? [];
    const summary: AdminDaySummary = {
      localDate: post.localDate,
      day: null,
      counts: { captures: 0, posts: 0, public: 0, hidden: 0, pending: 0 },
      firstAt: post.occurredAt,
      lastAt: post.occurredAt,
      coverSourceKey: null,
      coverPreviewUrl: null,
      trip: tripForDate(post.localDate, trips),
      changeSeq: 0,
    };
    return { ...list, items: [...list.items, summary].sort((a, b) => (a.localDate < b.localDate ? -1 : 1)) };
  });
}

export function removePost(tx: CacheTx, publicId: string): void {
  tx.updateAll<PostListResponse>(qk.postsAll, (list) =>
    list.items.some((p) => p.publicId === publicId)
      ? { ...list, items: list.items.filter((p) => p.publicId !== publicId) }
      : list,
  );
  tx.updateAll<AdminDayDetail>(qk.dayAll, (detail) =>
    detail.posts.some((p) => p.publicId === publicId)
      ? { ...detail, posts: detail.posts.filter((p) => p.publicId !== publicId) }
      : detail,
  );
  tx.remove(qk.post(publicId));
}

export function optimisticCreatePost(tx: CacheTx, vars: CreatePostVars, now: number): void {
  if (findPost(tx.client, vars.body.publicId)) return; // replay of a create that already landed
  const tz = cachedSettings(tx.client)?.['timezone.current'] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  putPost(tx, postFromCreate(vars, { now, tz }));
}

export function optimisticUpdatePost(tx: CacheTx, vars: UpdatePostVars): void {
  const current = findPost(tx.client, vars.publicId);
  if (current) putPost(tx, postLocally(current, vars.patch));
}

export function optimisticDeletePost(tx: CacheTx, vars: DeletePostVars): void {
  removePost(tx, vars.publicId);
}

// ---------------------------------------------------------------------------------------------
// Trips

function withTripsOnDays(tx: CacheTx, trips: readonly AdminTrip[]): void {
  tx.update<DayListResponse>(qk.days, (list) => {
    let changed = false;
    const items = list.items.map((s) => {
      const trip = tripForDate(s.localDate, trips);
      if (trip === s.trip) return s;
      changed = true;
      return { ...s, trip };
    });
    return changed ? { ...list, items } : list;
  });
}

export function putTrip(tx: CacheTx, trip: AdminTrip): void {
  let trips: AdminTrip[] | null = null;
  tx.update<TripListResponse>(qk.trips, (list) => {
    const others = list.items.filter((t) => t.slug !== trip.slug);
    trips = [...others, trip].sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
    return { ...list, items: trips };
  });
  if (trips) withTripsOnDays(tx, trips);
}

export function removeTrip(tx: CacheTx, slug: string): void {
  let trips: AdminTrip[] | null = null;
  tx.update<TripListResponse>(qk.trips, (list) => {
    if (!list.items.some((t) => t.slug === slug)) return list;
    trips = list.items.filter((t) => t.slug !== slug);
    return { ...list, items: trips };
  });
  if (trips) withTripsOnDays(tx, trips);
}

/**
 * PUT replaces the whole trip: a field the body leaves out is cleared (that is how the editor
 * removes a description), exactly as the API stores it.
 */
export function optimisticPutTrip(tx: CacheTx, vars: PutTripVars, now: number): void {
  const existing = tx.client.getQueryData<TripListResponse>(qk.trips)?.items.find((t) => t.slug === vars.body.slug);
  const { slug, title, description, origLocale, startDate, endDate, coverSourceKey } = vars.body;
  putTrip(tx, {
    slug,
    title,
    description: description ?? null,
    origLocale: origLocale ?? null,
    startDate,
    endDate,
    coverSourceKey: coverSourceKey ?? null,
    updatedAt: existing?.updatedAt ?? isoNow(now),
    changeSeq: existing?.changeSeq ?? 0,
  });
}

export function optimisticDeleteTrip(tx: CacheTx, vars: DeleteTripVars): void {
  removeTrip(tx, vars.slug);
}

// ---------------------------------------------------------------------------------------------
// Settings

export function settingsLocally(settings: Settings, patch: SettingsPatch, now: number): Settings {
  const next: Record<string, unknown> = { ...settings };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  // The API maintains publish.mode_since; the optimistic copy follows the same rule.
  next['publish.mode_since'] = modeSinceAfter(settings, patch, now);
  return next as Settings;
}

export function optimisticPatchSettings(tx: CacheTx, vars: PatchSettingsVars, now: number): void {
  tx.update<Settings>(qk.settings, (s) => settingsLocally(s, vars.patch, now));
}
