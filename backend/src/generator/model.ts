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
 * - Trips: membership from date ranges (tripForDate); a trip is published only once at least one
 *   of its days is public (publishedTrips): a planned trip without a public day has no timeline
 *   entry, trip file, page or sitemap entry, and one whose days all become hidden disappears again.
 *   Trip cover: Trip.coverSourceKey, else the first trip day with a cover.
 * - Profile (timeline.json `profile`, only when the owner set something): site.author, site.intro
 *   and the portrait site.avatar. The owner's choice of portrait wins over the photo's own
 *   visibility (a hidden photo can be the portrait), but only its round crop is published
 *   (`portraitCrop`, made by the generator run with pipeline/avatar.ts before the model is
 *   built), never the photo's own variants, OG image, caption or other facts. No portrait (and
 *   one warning, logged when the warnings change) when the capture is not a ready photo, was
 *   revoked while ingest.on_revoke = hide, or its crop could not be made or its files are missing.
 * - `v` = contentHash(file without v); timeline v = contentHash({ trips, days }), plus `profile`
 *   when there is one (so a site without a profile keeps its hashes).
 *
 * Wave 5 (spec-wave5 §5.2, §5.3):
 * - No coordinates: DayDetail never carries lat/lng (the owner's Day.lat/lng stay in the mirror).
 * - Post ids are hashed (E16): "p_" + base32(sha256("post:" + publicId))[0..16]
 *   (publishedPostIdFromSha256Hex); story routes use that id, so a post's ULID (which encodes
 *   its creation time) never reaches the site.
 * - Release slots and the departure hold (settings publish.release_slots / departure_hold /
 *   moved_on_at, off by default): HoldDays are built from every item of a date (captures of any
 *   visibility except revoked-and-hidden, posts of any visibility); each item public by the rules
 *   above is emitted only once entryReleaseAt(publishAt, holdEndAt(at, leftAt), settings) <= now.
 *   Days, trips, covers and counts are built from emitted items only; nextPublishAt is the
 *   smallest future release (plus the pending portrait's).
 * - The portrait respects the delay (E17): published only once portraitReleaseAt() <= now;
 *   until then the previously published portrait (store meta "portrait.published") stays when it
 *   is still a valid ready photo whose own release has passed, else there is none.
 * - Trip end clamp (E8): TripSummary/TripDetail `end` = min(trip.endDate, its last public day).
 * - Here-now (site.here_now) on the current stay (the trailing run of emitted days at the newest
 *   day's place): city_badge unchanged; city unchanged data; country strips `place`; none strips
 *   `place` and `country`. With the departure hold on, city_badge is emitted as city.
 * - Time buckets (site.time_precision = part_of_day): each entry's `at` is coarsened to its
 *   3-hour local bucket (coarsenToBucket) with the index among the day's entries in that bucket;
 *   entries are re-sorted by the coarsened time (mixed zones in one day keep a valid order).
 */

import { createHash } from 'node:crypto';
import { CONTRACT_VERSION } from '@omw/contracts';
import type { Annotation, Day, Post, Settings, SiteAvatarSetting, Trip } from '@omw/contracts/api';
import { type I18nText, type LocaleCode, pickText } from '@omw/contracts/i18n';
import { publishedPostIdFromSha256Hex } from '@omw/contracts/ids';
import {
  capturePublishAt,
  effectiveCaptureVisibility,
  effectiveLocalDate,
  effectivePostVisibility,
  effectiveTz,
  entryReleaseAt,
  type HoldDay,
  holdEndAt,
  leftPlaceAt,
  placeKey,
  portraitReleaseAt,
  publishedTrips,
  tripForDate,
} from '@omw/contracts/policy';
import {
  AvatarImage,
  type DayCounts,
  type DayDetail,
  type DaySummary,
  Entry,
  type HereNow,
  type ImageSet,
  SiteProfile,
  type TimelineIndex,
  type TimePrecision,
  type TripDetail,
  type TripSummary,
} from '@omw/contracts/site';
import { coarsenToBucket, MAX_BUCKET_INDEX, toIsoUtc } from '@omw/contracts/time';
import { argbToRgbaHex } from '@omw/contracts/wa';
import { avatarSourceVariant } from '../pipeline/avatar.js';
import type { CaptureRow, ProcessedVariant, Store } from '../store/index.js';
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
  /**
   * The round crop of the portrait photo (decidePortrait(): setting site.avatar, or the previously
   * published portrait while the new one waits for its release), made before the model is built
   * (generate.ts preparePortrait): its files, or why there are none. Absent: no portrait.
   */
  portraitCrop?: PortraitCrop | undefined;
  /** The portrait the last run published (store meta "portrait.published"), if any. */
  previousPortrait?: SiteAvatarSetting | null | undefined;
}

/** The portrait's own files for the photo `sourceKey` (see ModelInputs.portraitCrop). */
export type PortraitCrop =
  | { sourceKey: string; image: Omit<AvatarImage, 'focus'> }
  | { sourceKey: string; problem: string };

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
  /** Whose journey it is (timeline.json `profile`); null when the owner set nothing usable. */
  profile: SiteProfile | null;
  timeline: Pick<TimelineIndex, 'trips' | 'days' | 'profile'>;
  timelineV: string;
  /** Sorted media paths referenced by public entries and the portrait. */
  media: string[];
  /**
   * Earliest future instant at which a pending item is released (delayed mode, release slots,
   * departure hold) or the configured portrait may appear.
   */
  nextPublishAt: string | null;
  /** Effective site.here_now (city_badge is emitted as city while the departure hold is on). */
  hereNow: HereNow;
  timePrecision: TimePrecision;
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
    previousPortrait: store.meta.portraitPublished(),
  };
}

/** Published id of an owner post (E16): never its ULID publicId, which encodes when it was written. */
export function publishedPostIdOf(publicId: string): string {
  return publishedPostIdFromSha256Hex(createHash('sha256').update(`post:${publicId}`).digest('hex'));
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
    return { id: publishedPostIdOf(post.publicId), kind: 'note', at, tz, note, orig: post.origLocale };
  }
  const story: Partial<Record<LocaleCode, { title: string; body: string }>> = {};
  for (const [code, content] of Object.entries(post.content) as [
    LocaleCode,
    { title: string; body: string } | undefined,
  ][]) {
    if (content && nonBlank(content.title)) story[code] = { title: content.title, body: content.body };
  }
  if (Object.keys(story).length === 0) return null;
  return { id: publishedPostIdOf(post.publicId), kind: 'story', at, tz, story, orig: post.origLocale };
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

/**
 * The photo of setting site.avatar the portrait is cropped from, or why there is none. The
 * owner's explicit choice wins over the photo's own visibility, but a revoke under
 * ingest.on_revoke = hide still removes it.
 */
export function portraitSourceFor(
  setting: SiteAvatarSetting,
  inputs: Pick<ModelInputs, 'captures' | 'settings'>,
): { capture: CaptureRow; source: ProcessedVariant; sha256: string } | string {
  const c = inputs.captures.find((row) => row.sourceKey === setting.sourceKey);
  if (c?.state !== 'ready') return 'not a ready capture (not captured, media not downloaded or not processed)';
  if (c.kind !== 'photo') return `a ${c.kind} status, not a photo`;
  if (c.revokedAt && inputs.settings['ingest.on_revoke'] === 'hide')
    return 'deleted on WhatsApp (ingest.on_revoke = hide)';
  const source = avatarSourceVariant(c.variants ?? [], c.processedMeta);
  if (!source) return 'no image variants in webp to crop from';
  if (!c.originalSha256) return 'no original media hash';
  return { capture: c, source, sha256: c.originalSha256 };
}

/** The portrait of setting site.avatar (its round crop), or why there is none. */
export function avatarFor(
  setting: SiteAvatarSetting,
  inputs: Pick<ModelInputs, 'captures' | 'settings' | 'mediaExists' | 'portraitCrop'>,
): AvatarImage | string {
  const found = portraitSourceFor(setting, inputs);
  if (typeof found === 'string') return found;
  const crop = inputs.portraitCrop;
  if (crop?.sourceKey !== setting.sourceKey) return 'no round crop made';
  if ('problem' in crop) return crop.problem;
  const avatar: AvatarImage = crop.image;
  const missing = [...imageSetPaths(avatar, new Set())].filter((p) => !inputs.mediaExists(p));
  if (missing.length > 0) return `missing in MEDIA_DIR: ${missing.join(', ')}`;
  const r = AvatarImage.safeParse(avatar);
  if (!r.success) return `violates the site contract: ${r.error.issues.map((i) => i.message).join('; ')}`;
  return avatar;
}

/**
 * Release context of the departure hold (spec-wave5 §5.3 step 1): one HoldDay per effective
 * local date with any item (captures of any visibility except revoked-and-hidden, posts of any
 * visibility; held and pending days still count as "she is there"), and leftPlaceAt() of them.
 */
export function releaseContext(inputs: Pick<ModelInputs, 'captures' | 'annotations' | 'days' | 'posts' | 'settings'>): {
  leftAt: Map<string, string | null>;
  dateOf: (item: { occurredAt: string; tz: string; localDate: string }, annotation: Annotation | null) => string;
} {
  const dayTz = (storedDate: string) => inputs.days.get(storedDate)?.tz ?? null;
  const dateOf = (item: { occurredAt: string; tz: string; localDate: string }, annotation: Annotation | null) =>
    effectiveLocalDate(item, annotation, dayTz(item.localDate));
  const first = new Map<string, number>();
  const note = (date: string, at: string) => {
    const ms = Date.parse(at);
    const seen = first.get(date);
    if (Number.isFinite(ms) && (seen === undefined || ms < seen)) first.set(date, ms);
  };
  const hideRevoked = inputs.settings['ingest.on_revoke'] === 'hide';
  for (const c of inputs.captures) {
    const annotation = inputs.annotations.get(c.sourceKey) ?? null;
    if (c.revokedAt && hideRevoked && !annotation?.visibility) continue;
    note(dateOf(c, annotation), c.occurredAt);
  }
  for (const post of inputs.posts) note(dateOf(post, null), post.occurredAt);
  const holdDays: HoldDay[] = [...first.entries()].map(([date, ms]) => ({
    date,
    place: inputs.days.get(date)?.placeName ?? null,
    firstAt: new Date(ms).toISOString(),
  }));
  return { leftAt: leftPlaceAt(holdDays), dateOf };
}

/** Which portrait a run publishes (decidePortrait). */
export interface PortraitDecision {
  /** The portrait to publish: site.avatar, or the previously published one while it waits. */
  setting: SiteAvatarSetting | null;
  /** Future release instant of the configured portrait (nextRunAt), else null. */
  pendingAt: string | null;
  /** Why the configured portrait is not published (a warning), else null. */
  problem: string | null;
}

/** Release instant of the portrait cut from `setting`'s photo, or a problem (portraitSourceFor). */
function portraitRelease(
  setting: SiteAvatarSetting,
  inputs: Pick<ModelInputs, 'captures' | 'annotations' | 'days' | 'posts' | 'settings'>,
  ctx: ReturnType<typeof releaseContext>,
): { releaseAt: string | null } | string {
  const found = portraitSourceFor(setting, inputs);
  if (typeof found === 'string') return found;
  const c = found.capture;
  const annotation = inputs.annotations.get(c.sourceKey) ?? null;
  const date = ctx.dateOf(c, annotation);
  const holdEnd = holdEndAt(c.occurredAt, ctx.leftAt.get(date) ?? null, inputs.settings);
  return { releaseAt: portraitReleaseAt(c, annotation, inputs.settings, holdEnd) };
}

/**
 * The portrait never appears before its photo could have been published (P0, E17): site.avatar
 * when portraitReleaseAt() <= now; otherwise the previously published portrait (inputs
 * .previousPortrait) when it is still a valid ready photo whose own release has passed; else none.
 */
export function decidePortrait(
  inputs: Pick<ModelInputs, 'captures' | 'annotations' | 'days' | 'posts' | 'settings' | 'now' | 'previousPortrait'>,
  ctx: ReturnType<typeof releaseContext> = releaseContext(inputs),
): PortraitDecision {
  const setting = inputs.settings['site.avatar'];
  if (!setting) return { setting: null, pendingAt: null, problem: null };
  const nowMs = inputs.now.getTime();
  const own = portraitRelease(setting, inputs, ctx);
  // Problems of the photo itself (not ready, not a photo, deleted) are reported by avatarFor().
  if (typeof own === 'string') return { setting, pendingAt: null, problem: null };
  if (own.releaseAt !== null && Date.parse(own.releaseAt) <= nowMs) return { setting, pendingAt: null, problem: null };
  const pendingAt = own.releaseAt;
  const problem =
    pendingAt === null ? 'not published: its photo is not released by itself (review or a pending override)' : null;
  const prev = inputs.previousPortrait;
  if (prev && !(prev.sourceKey === setting.sourceKey && samePoint(prev.focus, setting.focus))) {
    const theirs = portraitRelease(prev, inputs, ctx);
    if (typeof theirs !== 'string' && theirs.releaseAt !== null && Date.parse(theirs.releaseAt) <= nowMs) {
      return { setting: prev, pendingAt, problem };
    }
  }
  return { setting: null, pendingAt, problem };
}

function samePoint(a: SiteAvatarSetting['focus'], b: SiteAvatarSetting['focus']): boolean {
  return (a?.x ?? null) === (b?.x ?? null) && (a?.y ?? null) === (b?.y ?? null);
}

/** timeline.json `profile` from the site.* profile settings (null when nothing is set or usable). */
export function profileFor(
  inputs: Pick<ModelInputs, 'captures' | 'settings' | 'mediaExists' | 'portraitCrop'>,
  warnings: string[],
  portrait: PortraitDecision = { setting: inputs.settings['site.avatar'] ?? null, pendingAt: null, problem: null },
): SiteProfile | null {
  const { settings } = inputs;
  const author = settings['site.author'];
  const intro = cleanText(settings['site.intro']);
  const configured = settings['site.avatar'];
  const setting = portrait.setting;
  let avatar: AvatarImage | undefined;
  if (configured && portrait.problem) warnings.push(`site.avatar ${configured.sourceKey}: ${portrait.problem}`);
  if (setting) {
    const found = avatarFor(setting, inputs);
    if (typeof found === 'string') warnings.push(`site.avatar ${setting.sourceKey}: no portrait published: ${found}`);
    else avatar = found;
  }
  const profile: SiteProfile = {
    ...(nonBlank(author) ? { author } : {}),
    ...(intro ? { intro } : {}),
    ...(avatar ? { avatar } : {}),
  };
  if (Object.keys(profile).length === 0) return null;
  const r = SiteProfile.safeParse(profile);
  if (!r.success) {
    const problem = r.error.issues.map((i) => `${i.path.map(String).join('.') || '(profile)'}: ${i.message}`);
    warnings.push(`profile left out: violates the site contract: ${problem.join('; ')}`);
    return null;
  }
  return profile;
}

/**
 * Coarsens the entries of one day to their 3-hour local buckets (site.time_precision =
 * part_of_day): index = position among the day's entries in the same bucket, by original
 * (at, id); the result is re-sorted by the coarsened time (stable).
 */
export function coarsenDayEntries(entries: readonly Entry[]): Entry[] {
  const seen = new Map<string, number>();
  const out = entries.map((e, order) => {
    const bucket = coarsenToBucket(e.at, e.tz, 0);
    const index = seen.get(bucket) ?? 0;
    seen.set(bucket, index + 1);
    return { entry: { ...e, at: coarsenToBucket(e.at, e.tz, Math.min(index, MAX_BUCKET_INDEX)) } as Entry, order };
  });
  out.sort((a, b) => Date.parse(a.entry.at) - Date.parse(b.entry.at) || a.order - b.order);
  return out.map((o) => o.entry);
}

/**
 * The current stay (spec-wave5 §5.3 step 4): the trailing run of `dates` (ascending) whose
 * placeKey equals the newest date's; just the newest date when it has no place.
 */
export function currentStay(
  dates: readonly string[],
  placeOf: (date: string) => string | null | undefined,
): Set<string> {
  const stay = new Set<string>();
  const newest = dates.at(-1);
  if (newest === undefined) return stay;
  stay.add(newest);
  const key = placeKey(placeOf(newest));
  if (key === null) return stay;
  for (let i = dates.length - 2; i >= 0; i--) {
    const date = dates[i] as string;
    if (placeKey(placeOf(date)) !== key) break;
    stay.add(date);
  }
  return stay;
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
  const noteFuture = (iso: string | null) => {
    const ms = iso ? Date.parse(iso) : Number.NaN;
    if (Number.isFinite(ms) && ms > nowMs && (nextPublishAt === null || ms < nextPublishAt)) nextPublishAt = ms;
  };
  const release = releaseContext(inputs);
  /** When an item public by today's rules (released at publishAt) is emitted: slots + hold. */
  const releaseAt = (publishAt: string, at: string, date: string) =>
    entryReleaseAt(publishAt, holdEndAt(at, release.leftAt.get(date) ?? null, settings), settings);

  for (const c of inputs.captures) {
    if (c.state !== 'ready' || c.kind === 'unsupported') continue;
    const annotation = inputs.annotations.get(c.sourceKey) ?? null;
    const policyCapture = { occurredAt: c.occurredAt, revokedAt: c.revokedAt };
    const visibility = effectiveCaptureVisibility(policyCapture, annotation, settings, now);
    if (visibility === 'hidden') {
      stats.hidden++;
      continue;
    }
    const fix = dayTz(c.localDate);
    const date = effectiveLocalDate(c, annotation, fix);
    const publishAt = capturePublishAt(policyCapture, annotation, settings);
    if (visibility !== 'public') {
      // Pending: review mode (no release by itself) or delayed (released at publishAt, then
      // slots/hold).
      stats.pending++;
      if (publishAt) noteFuture(releaseAt(publishAt, c.occurredAt, date));
      continue;
    }
    const released = releaseAt(publishAt ?? toIsoUtc(c.occurredAt), c.occurredAt, date);
    if (released !== null && Date.parse(released) > nowMs) {
      stats.pending++;
      noteFuture(released);
      continue;
    }
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
    placed.push({ date, entry, sourceKey: c.sourceKey, cover: coverOf(entry) });
  }

  for (const post of inputs.posts) {
    if (effectivePostVisibility(post) !== 'public') {
      if (post.visibility === 'pending') stats.pending++;
      else stats.hidden++;
      continue;
    }
    const fix = dayTz(post.localDate);
    const date = effectiveLocalDate(post, null, fix);
    const released = releaseAt(toIsoUtc(post.occurredAt), post.occurredAt, date);
    if (released !== null && Date.parse(released) > nowMs) {
      stats.pending++;
      noteFuture(released);
      continue;
    }
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
    placed.push({ date, entry, sourceKey: null, cover: null });
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
  // Every mirrored trip decides membership (tripForDate resolves overlaps over all of them); only
  // the trips with at least one public day are published (see the header).
  const trips = [...inputs.trips].sort((a, b) =>
    a.startDate !== b.startDate ? (a.startDate < b.startDate ? -1 : 1) : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0,
  );

  // Here-now (Q2): the current stay's place (and country) are stripped from the data itself.
  const configuredHereNow = settings['site.here_now'] ?? 'city_badge';
  const hereNow: HereNow =
    configuredHereNow === 'city_badge' && settings['publish.departure_hold']?.enabled ? 'city' : configuredHereNow;
  const stay =
    hereNow === 'country' || hereNow === 'none'
      ? currentStay(dates, (d) => inputs.days.get(d)?.placeName)
      : new Set<string>();
  const timePrecision: TimePrecision = settings['site.time_precision'] ?? 'exact';

  const days: DayDetail[] = [];
  const summaries: DaySummary[] = [];
  dates.forEach((date, i) => {
    const items = byDate.get(date) ?? [];
    const placedEntries = items.map((p) => p.entry);
    const entries = timePrecision === 'part_of_day' ? coarsenDayEntries(placedEntries) : placedEntries;
    const od = inputs.days.get(date);
    const title = cleanText(od?.title);
    const summary = cleanText(od?.summary);
    const orig = (title || summary) && od?.origLocale ? od.origLocale : undefined;
    const tz = mostCommon(entries.map((e) => e.tz)) ?? od?.tz ?? settings['timezone.current'];
    const trip = tripForDate(date, trips) ?? undefined;
    const prev = dates[i - 1];
    const next = dates[i + 1];
    const inStay = stay.has(date);
    const place = nonBlank(od?.placeName) && !inStay ? od.placeName : undefined;
    const country = od?.countryCode && !(inStay && hereNow === 'none') ? od.countryCode : undefined;
    const body = {
      contractVersion: CONTRACT_VERSION,
      date,
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
      ...(orig ? { orig } : {}),
      ...(place ? { place } : {}),
      ...(country ? { country } : {}),
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
      ...(place ? { place } : {}),
      ...(country ? { country } : {}),
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
  for (const t of publishedTrips(trips, dates)) {
    const tripDays = summaries.filter((d) => d.trip === t.slug);
    const cover =
      (t.coverSourceKey ? coverBySourceKey.get(t.coverSourceKey) : undefined) ?? tripDays.find((d) => d.cover)?.cover;
    const title = cleanText(t.title) ?? { [settings['site.default_locale']]: t.slug };
    const description = cleanText(t.description);
    // E8: a planned end date in the future is never published (it would tell when she returns).
    const lastDay = tripDays.at(-1)?.date ?? t.endDate;
    const end = [lastDay, t.endDate].sort()[0] as string;
    const body = {
      contractVersion: CONTRACT_VERSION,
      slug: t.slug,
      title,
      ...(description ? { description } : {}),
      ...(t.origLocale ? { orig: t.origLocale } : {}),
      start: t.startDate,
      end,
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
      end,
      ...(cover ? { cover } : {}),
      countries,
      dayCount: tripDays.length,
    });
  }

  const portrait = decidePortrait(inputs, release);
  noteFuture(portrait.pendingAt);
  const profile = profileFor(inputs, warnings, portrait);
  const timeline = { trips: tripSummaries, days: summaries, ...(profile ? { profile } : {}) };
  const media = new Set<string>();
  for (const day of days) dayMediaPaths(day, media);
  // Covers come from public entries, so they add no new paths; collected anyway for safety. The
  // portrait (timeline profile) adds its round crop, also of a photo that is not public itself.
  timelineMediaPaths(timeline, media);
  for (const t of tripDetails) imageSetPaths(t.cover, media);

  return {
    days,
    summaries,
    trips: tripDetails,
    tripSummaries,
    profile,
    timeline,
    timelineV: contentHash(timeline),
    media: [...media].sort(),
    nextPublishAt: nextPublishAt === null ? null : new Date(nextPublishAt).toISOString(),
    hereNow,
    timePrecision,
    warnings,
    stats,
  };
}

/** Best text for a locale (requested, then original, then fallback order). */
export function textFor(text: I18nText | undefined, locale: LocaleCode, orig?: LocaleCode | null) {
  return pickText(text, locale, orig ?? null);
}
