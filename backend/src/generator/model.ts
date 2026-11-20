/**
 * The site model: every public entry placed on its effective local day, plus the day, trip and
 * timeline files of the static site (contracts site.ts), built from one consistent snapshot of
 * the store. Pure apart from the injected `mediaExists` check, so it is deterministic for a
 * given store state and `now`.
 *
 * Rules (contracts policy.ts, plan A4):
 * - Captures: state "ready", kind != "unsupported", effectiveCaptureVisibility() === "public"
 *   (annotation override > revoke+hide > publish.mode with mode_since > instant/delayed/review).
 *   Placement: effectiveLocalDate()/effectiveTz() with the Day.tz fix of the STORED local date.
 * - Posts: visibility "public" (posts carry their own visibility); placed like captures without
 *   an annotation (the Day.tz fix applies).
 * - Days exist only when they have at least one public entry; owner Day rows without public
 *   entries are not published. Entries are chronological (instant, then id).
 * - Day tz = most common entry zone (ties: alphabetical). Cover: Day.coverSourceKey when that
 *   capture is public, has an image and is placed on that day (its effective local date), else
 *   the first entry with an image (photo or poster).
 * - Trips: every mirrored trip is published; membership from date ranges (tripForDate). Trip
 *   cover: Trip.coverSourceKey, else the first trip day with a cover.
 * - `v` = contentHash(file without v); timeline v = contentHash({ trips, days }).
 */

import { CONTRACT_VERSION } from '@omw/contracts';
import type { Annotation, Day, Post, Settings, Trip } from '@omw/contracts/api';
import { type I18nText, type LocaleCode, pickText } from '@omw/contracts/i18n';
import {
  capturePublishAt,
  effectiveCaptureVisibility,
  effectiveLocalDate,
  effectivePostVisibility,
  effectiveTz,
  tripForDate,
} from '@omw/contracts/policy';
import {
  type DayCounts,
  type DayDetail,
  type DaySummary,
  Entry,
  type ImageSet,
  type TimelineIndex,
  type TripDetail,
  type TripSummary,
} from '@omw/contracts/site';
import { toIsoUtc } from '@omw/contracts/time';
import { argbToRgbaHex } from '@omw/contracts/wa';
import type { CaptureRow, Store } from '../store/index.js';
import { contentHash } from './hash.js';
import {
  audioFrom,
  dayMediaPaths,
  entryMediaPaths,
  imageSetFrom,
  imageSetPaths,
  timelineMediaPaths,
  videoFrom,
} from './media.js';

/** WhatsApp sends no colours for some text statuses ("Conversation" messages). */
export const DEFAULT_TEXT_BG_ARGB = 0xff3b2341; // plum
export const DEFAULT_TEXT_FG_ARGB = 0xffffffff;

export interface ModelInputs {
  settings: Settings;
  /** Ready captures (any order). */
  captures: readonly CaptureRow[];
  annotations: ReadonlyMap<string, Annotation>;
  days: ReadonlyMap<string, Day>;
  posts: readonly Post[];
  trips: readonly Trip[];
  now: Date;
  /** Whether a "media/…" variant exists in MEDIA_DIR. */
  mediaExists: (relPath: string) => boolean;
}

export interface PlacedEntry {
  date: string;
  entry: Entry;
  sourceKey: string | null;
  cover: ImageSet | null;
}

export interface SiteModel {
  /** Ascending by date. */
  days: DayDetail[];
  summaries: DaySummary[];
  /** Ascending by start date, then slug. */
  trips: TripDetail[];
  tripSummaries: TripSummary[];
  timeline: Pick<TimelineIndex, 'trips' | 'days'>;
  timelineV: string;
  /** Sorted media paths referenced by public entries. */
  media: string[];
  /** Earliest future instant at which a pending capture becomes public (delayed mode). */
  nextPublishAt: string | null;
  warnings: string[];
  stats: {
    entries: number;
    captures: number;
    posts: number;
    pending: number;
    hidden: number;
    skippedMedia: number;
    /** Public items left out because they violate the site contract (see entryProblem). */
    invalid: number;
  };
}

export function loadModelInputs(store: Store, now: Date, mediaExists: (relPath: string) => boolean): ModelInputs {
  return {
    settings: store.owner.settings(),
    captures: store.captures.list({ states: ['ready'] }),
    annotations: store.owner.annotationMap(),
    days: new Map(store.owner.listDays().map((d) => [d.localDate, d])),
    posts: store.owner.listPosts(),
    trips: store.owner.listTrips(),
    now,
    mediaExists,
  };
}

/** Drops blank values; undefined when nothing is left. */
function cleanText(text: I18nText | null | undefined): I18nText | undefined {
  if (!text) return undefined;
  const out: I18nText = {};
  for (const [code, value] of Object.entries(text) as [LocaleCode, string | undefined][]) {
    if (typeof value === 'string' && value.trim().length > 0) out[code] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function nonBlank(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function compareEntries(a: PlacedEntry, b: PlacedEntry): number {
  const ta = Date.parse(a.entry.at);
  const tb = Date.parse(b.entry.at);
  if (ta !== tb) return ta - tb;
  return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
}

function mostCommon(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]?.[0];
}

function coverOf(entry: Entry): ImageSet | null {
  if (entry.kind === 'photo') return entry.image;
  if (entry.kind === 'video' || entry.kind === 'gif') return entry.video.poster;
  return null;
}

/** Contract entry for a ready capture, or a problem description. */
export function captureEntry(c: CaptureRow, annotation: Annotation | null, tz: string): Entry | string {
  const description = cleanText(annotation?.description);
  const base = {
    id: c.publicId,
    at: toIsoUtc(c.occurredAt),
    tz,
    ...(nonBlank(c.caption) ? { caption: c.caption } : {}),
    ...(description ? { description } : {}),
    ...(description && annotation?.origLocale ? { descriptionOrig: annotation.origLocale } : {}),
  };
  const variants = c.variants ?? [];
  switch (c.kind) {
    case 'text': {
      if (!c.text) return 'text status without text';
      return {
        ...base,
        kind: 'text',
        text: {
          body: c.text.body,
          bg: argbToRgbaHex(c.text.bgArgb ?? DEFAULT_TEXT_BG_ARGB),
          fg: argbToRgbaHex(c.text.textArgb ?? DEFAULT_TEXT_FG_ARGB),
          font: c.text.font ?? 'SYSTEM',
        },
      };
    }
    case 'photo': {
      const image = imageSetFrom(variants, c.processedMeta, 'image');
      return typeof image === 'string' ? image : { ...base, kind: 'photo', image };
    }
    case 'video': {
      const video = videoFrom(variants, c.processedMeta, false);
      return typeof video === 'string' ? video : { ...base, kind: 'video', video };
    }
    case 'gif': {
      const video = videoFrom(variants, c.processedMeta, true);
      if (typeof video === 'string') return video;
      return { ...base, kind: 'gif', video: { ...video, hasAudio: false }, loop: true };
    }
    case 'voice': {
      const audio = audioFrom(variants, c.processedMeta);
      return typeof audio === 'string' ? audio : { ...base, kind: 'voice', audio };
    }
    case 'unsupported':
      return 'unsupported kind';
  }
}

export function postEntry(post: Post, tz: string): Entry | null {
  const at = toIsoUtc(post.occurredAt);
  if (post.kind === 'note') {
    const note: I18nText = {};
    for (const [code, content] of Object.entries(post.content) as [LocaleCode, { body: string } | undefined][]) {
      if (content && nonBlank(content.body)) note[code] = content.body;
    }
    if (Object.keys(note).length === 0) return null;
    return { id: post.publicId, kind: 'note', at, tz, note, orig: post.origLocale };
  }
  const story: Partial<Record<LocaleCode, { title: string; body: string }>> = {};
  for (const [code, content] of Object.entries(post.content) as [
    LocaleCode,
    { title: string; body: string } | undefined,
  ][]) {
    if (content && nonBlank(content.title)) story[code] = { title: content.title, body: content.body };
  }
  if (Object.keys(story).length === 0) return null;
  return { id: post.publicId, kind: 'story', at, tz, story, orig: post.origLocale };
}

/**
 * Contract problems of one entry, or null. The mirrored owner data is validated against the API
 * contracts, which are not always as strict as the site's (e.g. a note body may be 100,000
 * characters in the API, but I18nText values are at most 20,000 in the site files). One such
 * item is left out with a warning instead of failing contract validation of the whole run.
 */
export function entryProblem(entry: Entry): string | null {
  const r = Entry.safeParse(entry);
  if (r.success) return null;
  return r.error.issues.map((i) => `${i.path.join('.') || '(entry)'}: ${i.message}`).join('; ');
}

function emptyCounts(): DayCounts {
  return { photo: 0, video: 0, gif: 0, voice: 0, text: 0, note: 0, story: 0 };
}

export function buildSiteModel(inputs: ModelInputs): SiteModel {
  const { settings, now } = inputs;
  const warnings: string[] = [];
  const stats = { entries: 0, captures: 0, posts: 0, pending: 0, hidden: 0, skippedMedia: 0, invalid: 0 };
  const dayTz = (storedDate: string) => inputs.days.get(storedDate)?.tz ?? null;
  const placed: PlacedEntry[] = [];
  let nextPublishAt: number | null = null;
  const nowMs = now.getTime();

  for (const c of inputs.captures) {
    if (c.state !== 'ready' || c.kind === 'unsupported') continue;
    const annotation = inputs.annotations.get(c.sourceKey) ?? null;
    const policyCapture = { occurredAt: c.occurredAt, revokedAt: c.revokedAt };
    const visibility = effectiveCaptureVisibility(policyCapture, annotation, settings, now);
    if (visibility !== 'public') {
      if (visibility === 'pending') {
        stats.pending++;
        const at = capturePublishAt(policyCapture, annotation, settings);
        const ms = at ? Date.parse(at) : Number.NaN;
        if (Number.isFinite(ms) && ms > nowMs && (nextPublishAt === null || ms < nextPublishAt)) nextPublishAt = ms;
      } else stats.hidden++;
      continue;
    }
    const fix = dayTz(c.localDate);
    const tz = effectiveTz(c, annotation, fix);
    const entry = captureEntry(c, annotation, tz);
    if (typeof entry === 'string') {
      stats.skippedMedia++;
      warnings.push(`capture ${c.publicId} (${c.kind}) left out: ${entry}`);
      continue;
    }
    const missing = [...entryMediaPaths(entry, new Set())].filter((p) => !inputs.mediaExists(p));
    if (missing.length > 0) {
      stats.skippedMedia++;
      warnings.push(`capture ${c.publicId} (${c.kind}) left out: missing in MEDIA_DIR: ${missing.join(', ')}`);
      continue;
    }
    const problem = entryProblem(entry);
    if (problem) {
      stats.invalid++;
      warnings.push(`capture ${c.publicId} (${c.kind}) left out: violates the site contract: ${problem}`);
      continue;
    }
    stats.captures++;
    placed.push({
      date: effectiveLocalDate(c, annotation, fix),
      entry,
      sourceKey: c.sourceKey,
      cover: coverOf(entry),
    });
  }

  for (const post of inputs.posts) {
    if (effectivePostVisibility(post) !== 'public') {
      if (post.visibility === 'pending') stats.pending++;
      else stats.hidden++;
      continue;
    }
    const fix = dayTz(post.localDate);
    const entry = postEntry(post, effectiveTz(post, null, fix));
    if (!entry) {
      warnings.push(`post ${post.publicId} left out: no content`);
      continue;
    }
    const problem = entryProblem(entry);
    if (problem) {
      stats.invalid++;
      warnings.push(`post ${post.publicId} (${post.kind}) left out: violates the site contract: ${problem}`);
      continue;
    }
    stats.posts++;
    placed.push({ date: effectiveLocalDate(post, null, fix), entry, sourceKey: null, cover: null });
  }
  placed.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : compareEntries(a, b)));
  stats.entries = placed.length;

  const coverBySourceKey = new Map<string, ImageSet>();
  for (const p of placed) if (p.sourceKey && p.cover) coverBySourceKey.set(p.sourceKey, p.cover);
  const byDate = new Map<string, PlacedEntry[]>();
  for (const p of placed) {
    const list = byDate.get(p.date);
    if (list) list.push(p);
    else byDate.set(p.date, [p]);
  }
  const dates = [...byDate.keys()].sort();
  const trips = [...inputs.trips].sort((a, b) =>
    a.startDate !== b.startDate ? (a.startDate < b.startDate ? -1 : 1) : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
  );

  const days: DayDetail[] = [];
  const summaries: DaySummary[] = [];
  dates.forEach((date, i) => {
    const items = byDate.get(date) ?? [];
    const entries = items.map((p) => p.entry);
    const od = inputs.days.get(date);
    const title = cleanText(od?.title);
    const summary = cleanText(od?.summary);
    const orig = (title || summary) && od?.origLocale ? od.origLocale : undefined;
    const tz = mostCommon(entries.map((e) => e.tz)) ?? od?.tz ?? settings['timezone.current'];
    const trip = tripForDate(date, trips) ?? undefined;
    const prev = dates[i - 1];
    const next = dates[i + 1];
    const body = {
      contractVersion: CONTRACT_VERSION,
      date,
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(orig ? { orig } : {}),
      ...(nonBlank(od?.placeName) ? { place: od.placeName } : {}),
      ...(od?.countryCode ? { country: od.countryCode } : {}),
      ...(typeof od?.lat === 'number' ? { lat: od.lat } : {}),
      ...(typeof od?.lng === 'number' ? { lng: od.lng } : {}),
      tz,
      ...(trip ? { trip } : {}),
      ...(prev ? { prev } : {}),
      ...(next ? { next } : {}),
      entries,
    };
    const v = contentHash(body);
    const { contractVersion, date: _date, ...rest } = body;
    days.push({ contractVersion, date, v, ...rest });

    const counts = emptyCounts();
    for (const e of entries) counts[e.kind]++;
    // Day.coverSourceKey counts only while that capture is placed on THIS day: once the owner
    // moves it elsewhere (localDateOverride, Day.tz fix) the day falls back to its own first
    // image, like a day without a cover (L2-07).
    const cover =
      (od?.coverSourceKey ? items.find((p) => p.sourceKey === od.coverSourceKey && p.cover)?.cover : undefined) ??
      items.find((p) => p.cover)?.cover ??
      undefined;
    const first = entries[0];
    const last = entries.at(-1);
    if (!first || !last) throw new Error(`day ${date} without entries`);
    summaries.push({
      date,
      v,
      ...(title ? { title } : {}),
      ...(orig ? { orig } : {}),
      ...(nonBlank(od?.placeName) ? { place: od.placeName } : {}),
      ...(od?.countryCode ? { country: od.countryCode } : {}),
      ...(trip ? { trip } : {}),
      tz,
      counts,
      ...(cover ? { cover } : {}),
      firstAt: first.at,
      lastAt: last.at,
    });
  });

  const tripDetails: TripDetail[] = [];
  const tripSummaries: TripSummary[] = [];
  for (const t of trips) {
    const tripDays = summaries.filter((d) => d.trip === t.slug);
    const cover =
      (t.coverSourceKey ? coverBySourceKey.get(t.coverSourceKey) : undefined) ?? tripDays.find((d) => d.cover)?.cover;
    const title = cleanText(t.title) ?? { [settings['site.default_locale']]: t.slug };
    const description = cleanText(t.description);
    const body = {
      contractVersion: CONTRACT_VERSION,
      slug: t.slug,
      title,
      ...(description ? { description } : {}),
      ...(t.origLocale ? { orig: t.origLocale } : {}),
      start: t.startDate,
      end: t.endDate,
      ...(cover ? { cover } : {}),
      days: tripDays.map((d) => d.date),
    };
    const v = contentHash(body);
    const { contractVersion, slug, ...rest } = body;
    tripDetails.push({ contractVersion, slug, v, ...rest });
    const countries: string[] = [];
    for (const d of tripDays) if (d.country && !countries.includes(d.country)) countries.push(d.country);
    tripSummaries.push({
      slug: t.slug,
      v,
      title,
      ...(t.origLocale ? { orig: t.origLocale } : {}),
      start: t.startDate,
      end: t.endDate,
      ...(cover ? { cover } : {}),
      countries,
      dayCount: tripDays.length,
    });
  }

  const timeline = { trips: tripSummaries, days: summaries };
  const media = new Set<string>();
  for (const day of days) dayMediaPaths(day, media);
  // Covers come from public entries, so they add no new paths; collected anyway for safety.
  timelineMediaPaths(timeline, media);
  for (const t of tripDetails) imageSetPaths(t.cover, media);

  return {
    days,
    summaries,
    trips: tripDetails,
    tripSummaries,
    timeline,
    timelineV: contentHash(timeline),
    media: [...media].sort(),
    nextPublishAt: nextPublishAt === null ? null : new Date(nextPublishAt).toISOString(),
    warnings,
    stats,
  };
}

/** Best text for a locale (requested, then original, then fallback order). */
export function textFor(text: I18nText | undefined, locale: LocaleCode, orig?: LocaleCode | null) {
  return pickText(text, locale, orig ?? null);
}
