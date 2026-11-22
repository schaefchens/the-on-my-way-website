/**
 * Publish policy (D11) and placement rules — pure functions, duplicated in PHP. Shared vectors:
 * fixtures/vectors/policy.json (visibility), mode-switch.json (publish.mode_since across settings
 * changes), placement.json (local date / tz), trips.json.
 *
 * Capture visibility:
 *   1. annotation.visibility if set (owner override always wins)
 *   2. else revoked && ingest.on_revoke = hide  -> hidden
 *   3. else captures that occurred BEFORE publish.mode_since are evaluated as "instant" -> public
 *      (switching to delayed/review only affects new statuses; it never unpublishes the archive)
 *   4. else publish.mode instant                -> public
 *           publish.mode delayed                -> public iff now >= occurredAt + delay, else pending
 *           publish.mode review                 -> pending
 * The API maintains "publish.mode_since" (default 1970-01-01T00:00:00.000Z; nextModeSince() here,
 * PHP Policy::nextModeSince; shared vectors fixtures/vectors/mode-switch.json). With t = now,
 * s0 = the old mode_since and d0 = the old delay:
 *   - instant -> delayed | review                    t
 *   - delayed -> review, and a changed delay while
 *     staying delayed                                 max(s0, t - d0 + 1 ms): exactly the captures
 *                                                     already public under the old delay stay public
 *   - review -> delayed                               s0 unchanged; the review backlog older than the
 *                                                     new delay is released, which the admin asks the
 *                                                     owner to confirm first
 *   - anything else (-> instant, no mode change)      s0 unchanged
 * So a settings change never turns a public capture back to pending, and it releases waiting
 * captures only in three cases: that confirmed review -> delayed release, a shorter delay while
 * delayed (what is now older than the new delay), and switching back to "instant", which
 * publishes everything still pending without an override (turning review off means "stop
 * holding things back"). mode_since is inclusive: a capture at exactly the switch instant falls
 * under the new mode. fixtures/vectors/mode-switch.json pins all of this down. The API writes
 * mode_since before delay_minutes before mode into the change feed, so a backend that applied only
 * a prefix of one change never judges the new mode with the old cut-off.
 * Posts carry their own visibility.
 *
 * Placement (local date and zone of an item):
 *   1. annotation.localDateOverride (captures only) wins; the zone stays the capture's tz.
 *   2. else, if the owner set a time-zone fix on the Day of the item's STORED localDate
 *      (Day.tz), the item is re-dated in that zone: tz = Day.tz,
 *      localDate = localDateFor(occurredAt, Day.tz). This can move an item to D-1 or D+1, so a
 *      tz change on day D invalidates D-1, D and D+1 in the generator.
 *   3. else the stored localDate/tz (zone in effect at capture time).
 *
 * Trip membership: trip date ranges are the only source (there is no per-day trip field). The
 * API rejects overlapping ranges; tripForDate() still resolves overlaps deterministically
 * (earliest start, then slug) so a bad mirror never makes runtimes disagree.
 *
 * Published trips: a trip is on the public site only once at least one of its days is public,
 * i.e. has at least one public entry (capture or post) after this policy, counted through
 * tripForDate() (publishedTrips()). A planned trip (dates, no public day yet) appears nowhere:
 * no timeline entry, trip page, data file, sitemap entry or card; a trip whose days all become
 * hidden again disappears the same way.
 *
 * Note: kind "unsupported" is not special-cased here; the generator never renders it.
 *
 * Release slots and the departure hold (wave 5, Q1; settings "publish.release_slots",
 * "publish.departure_hold", "publish.moved_on_at"; all off by default; vectors
 * fixtures/vectors/release.json). They only delay WHEN the generator emits an item that is public
 * by the rules above; they never change effectiveCaptureVisibility() (API and admin semantics stay)
 * and removals stay immediate:
 *   publishAt   = capturePublishAt() for captures, occurredAt for posts
 *   holdEnd     = holdEndAt(entryAt, leftPlaceAt(days).get(date), settings): null when the hold is
 *                 off, else the earliest of entryAt + maxDays·24 h, publish.moved_on_at (when it is
 *                 not before the entry) and the first item of the next later date at another place
 *   releaseAt   = entryReleaseAt(publishAt, holdEnd) = nextReleaseSlot(max(publishAt, holdEnd))
 * The item is emitted once releaseAt <= now. HoldDays are built from EVERY item of a date (captures
 * of any visibility except revoked-and-hidden, posts of any visibility), so held and pending days
 * still count as "she is there". Slot times are wall-clock times in timezone.current; a slot in a
 * DST gap fires at the first instant after the gap, an ambiguous one at the earlier instant.
 * The portrait follows the same rules (portraitReleaseAt), so it never appears before its photo
 * could have been published.
 */

import type { OnRevoke, PublishMode } from './api.js';
import type { Visibility } from './common.js';
import { addDays, localDateFor, zonedWallTimeToUtc } from './time.js';

/** Default of the setting "publish.mode_since": the mode applies to everything. */
export const MODE_SINCE_EPOCH = '1970-01-01T00:00:00.000Z';

export interface PolicySettings {
  'publish.mode': PublishMode;
  'publish.delay_minutes': number;
  'ingest.on_revoke': OnRevoke;
  /** When publish.mode was last changed (ISO UTC); missing = MODE_SINCE_EPOCH. */
  'publish.mode_since'?: string | undefined;
}

export interface CapturePolicyInput {
  occurredAt: string;
  revokedAt?: string | null | undefined;
}

export interface AnnotationPolicyInput {
  visibility?: Visibility | null | undefined;
  localDateOverride?: string | null | undefined;
}

type Instant = Date | number | string;

function toMillis(value: Instant, what: string): number {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(ms)) throw new RangeError(`Invalid ${what}: ${String(value)}`);
  return ms;
}

function delayMillis(settings: Pick<PolicySettings, 'publish.delay_minutes'>): number {
  const minutes = settings['publish.delay_minutes'];
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
}

/** The publish mode that applies to a capture (older captures keep "instant"). */
export function modeForCapture(capture: CapturePolicyInput, settings: PolicySettings): PublishMode {
  const mode = settings['publish.mode'];
  if (mode === 'instant') return mode;
  const since = toMillis(settings['publish.mode_since'] ?? MODE_SINCE_EPOCH, 'publish.mode_since');
  return toMillis(capture.occurredAt, 'occurredAt') < since ? 'instant' : mode;
}

export function effectiveCaptureVisibility(
  capture: CapturePolicyInput,
  annotation: AnnotationPolicyInput | null | undefined,
  settings: PolicySettings,
  now: Instant,
): Visibility {
  const override = annotation?.visibility;
  if (override) return override;
  if (capture.revokedAt && settings['ingest.on_revoke'] === 'hide') return 'hidden';
  switch (modeForCapture(capture, settings)) {
    case 'instant':
      return 'public';
    case 'delayed': {
      const publishAt = toMillis(capture.occurredAt, 'occurredAt') + delayMillis(settings);
      return toMillis(now, 'now') >= publishAt ? 'public' : 'pending';
    }
    case 'review':
      return 'pending';
  }
}

/**
 * When a capture becomes public under the current settings: ISO UTC instant, or null if it will
 * not become public by itself (review mode, hidden revoke, or a non-public override).
 * Lets the generator schedule a rebuild for delayed mode.
 */
export function capturePublishAt(
  capture: CapturePolicyInput,
  annotation: AnnotationPolicyInput | null | undefined,
  settings: PolicySettings,
): string | null {
  const occurred = toMillis(capture.occurredAt, 'occurredAt');
  const override = annotation?.visibility;
  if (override) {
    return override === 'public' ? new Date(occurred).toISOString() : null;
  }
  if (capture.revokedAt && settings['ingest.on_revoke'] === 'hide') return null;
  switch (modeForCapture(capture, settings)) {
    case 'instant':
      return new Date(occurred).toISOString();
    case 'delayed':
      return new Date(occurred + delayMillis(settings)).toISOString();
    case 'review':
      return null;
  }
}

export function effectivePostVisibility(post: { visibility: Visibility }): Visibility {
  return post.visibility;
}

/** Settings nextModeSince() reads (contract keys). */
export interface ModeSinceSettings {
  'publish.mode': PublishMode;
  'publish.delay_minutes': number;
  'publish.mode_since'?: string | undefined;
}

/**
 * publish.mode_since after a settings change from `before` to `after` at `now` (see the header;
 * PHP Policy::nextModeSince, which the API applies). With t = now, s0 = the old mode_since,
 * d0 = the old delay:
 *   instant          -> delayed | review   t
 *   delayed          -> review             max(s0, t - d0 + 1 ms)
 *   delayed (d0)     -> delayed (d1 ≠ d0)  max(s0, t - d0 + 1 ms)
 *   review           -> delayed            s0 (the backlog older than the new delay is released)
 *   anything else (-> instant, no change)  s0
 * Returns a canonical ISO instant ("…T…:…:….mmmZ").
 */
export function nextModeSince(
  before: ModeSinceSettings,
  after: Pick<ModeSinceSettings, 'publish.mode' | 'publish.delay_minutes'>,
  now: Instant,
): string {
  // An unreadable stored value counts as the default, like in PHP.
  const stored = new Date(before['publish.mode_since'] ?? MODE_SINCE_EPOCH).getTime();
  const s0 = Number.isNaN(stored) ? 0 : stored;
  const from = before['publish.mode'];
  const to = after['publish.mode'];
  const t = toMillis(now, 'now');
  if (from === 'instant' && to !== 'instant') return new Date(t).toISOString();
  const d0 = delayMillis(before);
  if (from === 'delayed' && (to === 'review' || (to === 'delayed' && d0 !== delayMillis(after)))) {
    return new Date(Math.max(s0, t - d0 + 1)).toISOString();
  }
  return new Date(s0).toISOString();
}

// ---------------------------------------------------------------------------------------------
// Placement

export interface PlacementInput {
  occurredAt: string;
  tz: string;
  /** Stored local date (calendar date of occurredAt in tz). */
  localDate: string;
}

/** Day.tz of the item's stored local date (null/undefined = no fix). */
export type DayTz = string | null | undefined;

/** Effective local date (see "Placement" above). */
export function effectiveLocalDate(
  item: PlacementInput,
  annotation: AnnotationPolicyInput | null | undefined,
  dayTz?: DayTz,
): string {
  const override = annotation?.localDateOverride;
  if (override) return override;
  if (dayTz) return localDateFor(item.occurredAt, dayTz);
  return item.localDate;
}

/** Effective zone used to show the item's wall-clock time (see "Placement" above). */
export function effectiveTz(
  item: PlacementInput,
  annotation: AnnotationPolicyInput | null | undefined,
  dayTz?: DayTz,
): string {
  if (annotation?.localDateOverride) return item.tz;
  return dayTz || item.tz;
}

// ---------------------------------------------------------------------------------------------
// Trips

export interface TripRange {
  slug: string;
  startDate: string;
  endDate: string;
}

function byStartThenSlug(a: TripRange, b: TripRange): number {
  if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/** Slug of the trip whose [startDate, endDate] contains `date`, or null. */
export function tripForDate(date: string, trips: readonly TripRange[]): string | null {
  const hit = [...trips].sort(byStartThenSlug).find((t) => t.startDate <= date && date <= t.endDate);
  return hit?.slug ?? null;
}

/** True when two inclusive date ranges share at least one day. */
export function tripRangesOverlap(a: TripRange, b: TripRange): boolean {
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

/**
 * The trips that are published (see "Published trips" above): those that tripForDate() assigns
 * at least one of `publicDates` to (dates with at least one public entry). Input order is kept.
 */
export function publishedTrips<T extends TripRange>(trips: readonly T[], publicDates: Iterable<string>): T[] {
  const slugs = new Set<string>();
  for (const date of publicDates) {
    const slug = tripForDate(date, trips);
    if (slug !== null) slugs.add(slug);
  }
  return trips.filter((t) => slugs.has(t.slug));
}

/** Slugs of existing trips that `candidate` would overlap (the API answers 422 when non-empty). */
export function overlappingTrips(candidate: TripRange, trips: readonly TripRange[]): string[] {
  return trips
    .filter((t) => t.slug !== candidate.slug && tripRangesOverlap(candidate, t))
    .map((t) => t.slug)
    .sort();
}

// ---------------------------------------------------------------------------------------------
// Release slots and departure hold (see the header)

/** The settings the release rules read (contract keys). */
export interface ReleaseSettings {
  'publish.release_slots': { enabled: boolean; times: readonly string[] };
  'publish.departure_hold': { enabled: boolean; maxDays: number };
  'publish.moved_on_at'?: string | undefined;
  'timezone.current': string;
}

const slotCache = new Map<string, number>();

function slotInstant(date: string, hhmm: string, tz: string): number {
  const key = `${tz}|${date}|${hhmm}`;
  let ms = slotCache.get(key);
  if (ms === undefined) {
    if (slotCache.size >= 4096) slotCache.clear();
    ms = Date.parse(zonedWallTimeToUtc(date, hhmm, tz));
    slotCache.set(key, ms);
  }
  return ms;
}

/**
 * First slot instant >= `at` (wall clock `times` in `tz`); `at` itself when slots are off (or no
 * time is set). DST: a slot inside a gap fires at the first instant after it; an ambiguous one at
 * the earlier. Returns a canonical ISO instant ("…T…:…:….mmmZ").
 */
export function nextReleaseSlot(at: Instant, slots: ReleaseSettings['publish.release_slots'], tz: string): string {
  const t = toMillis(at, 'at');
  if (!slots.enabled || slots.times.length === 0) return new Date(t).toISOString();
  const today = localDateFor(t, tz);
  let best = Number.POSITIVE_INFINITY;
  // Today, tomorrow and the day after (a zone may skip a whole calendar day).
  for (let i = 0; i <= 2 && best === Number.POSITIVE_INFINITY; i++) {
    const date = addDays(today, i);
    for (const time of slots.times) {
      const ms = slotInstant(date, time, tz);
      if (ms >= t && ms < best) best = ms;
    }
  }
  if (best === Number.POSITIVE_INFINITY) throw new RangeError(`No release slot after ${new Date(t).toISOString()}`);
  return new Date(best).toISOString();
}

/** "Hội An " / "hội an" → "hội an"; blank → null (NFC, trim, collapse spaces, toLowerCase). */
export function placeKey(place: string | null | undefined): string | null {
  if (typeof place !== 'string') return null;
  const key = place.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
  return key === '' ? null : key;
}

/** One local date with any item (see the header): its Day.placeName and its earliest item instant. */
export interface HoldDay {
  date: string;
  place: string | null;
  firstAt: string;
}

/**
 * For each date: firstAt of the earliest LATER date whose placeKey is non-null and differs from
 * this date's non-null placeKey; null when this date has no place or no such later date. Expects
 * one HoldDay per date (with duplicates, the one with the earliest firstAt counts).
 */
export function leftPlaceAt(days: readonly HoldDay[]): Map<string, string | null> {
  const byDate = new Map<string, HoldDay>();
  for (const day of days) {
    const seen = byDate.get(day.date);
    if (!seen || toMillis(day.firstAt, 'firstAt') < toMillis(seen.firstAt, 'firstAt')) byDate.set(day.date, day);
  }
  const sorted = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const keys = sorted.map((d) => placeKey(d.place));
  const out = new Map<string, string | null>();
  sorted.forEach((day, i) => {
    const key = keys[i];
    let left: string | null = null;
    if (key !== null && key !== undefined) {
      for (let j = i + 1; j < sorted.length; j++) {
        const other = keys[j];
        if (other !== null && other !== undefined && other !== key) {
          left = sorted[j]?.firstAt ?? null;
          break;
        }
      }
    }
    out.set(day.date, left === null ? null : new Date(toMillis(left, 'firstAt')).toISOString());
  });
  return out;
}

const DAY_MS = 86_400_000;

/**
 * End of the departure hold of an entry at `entryAt` (ISO), or null when the hold is off:
 * min(entryAt + maxDays·24 h, moved_on_at if moved_on_at >= entryAt, leftAt).
 */
export function holdEndAt(entryAt: Instant, leftAt: string | null, s: ReleaseSettings): string | null {
  const hold = s['publish.departure_hold'];
  if (!hold.enabled) return null;
  const at = toMillis(entryAt, 'entryAt');
  const days = Number.isFinite(hold.maxDays) ? Math.min(Math.max(hold.maxDays, 0), 7) : 7;
  let end = at + days * DAY_MS;
  const movedOn = s['publish.moved_on_at'];
  if (movedOn) {
    const moved = toMillis(movedOn, 'publish.moved_on_at');
    if (moved >= at) end = Math.min(end, moved);
  }
  if (leftAt !== null) end = Math.min(end, toMillis(leftAt, 'leftAt'));
  return new Date(end).toISOString();
}

/** null when publishAt is null; else nextReleaseSlot(max(publishAt, holdEnd ?? publishAt)). */
export function entryReleaseAt(publishAt: string | null, holdEnd: string | null, s: ReleaseSettings): string | null {
  if (publishAt === null) return null;
  const publish = toMillis(publishAt, 'publishAt');
  const from = holdEnd === null ? publish : Math.max(publish, toMillis(holdEnd, 'holdEnd'));
  return nextReleaseSlot(from, s['publish.release_slots'], s['timezone.current']);
}

/**
 * When the portrait cut from `capture` may be published (P0: the portrait never bypasses the
 * delay), or null when it may not by itself:
 *   override "pending" → null; revoked + ingest.on_revoke "hide" → null; an override "hidden" is
 *   ignored (a hidden photo may be the portrait); review mode → occurredAt (the pick is the
 *   review); override "public" → occurredAt; else capturePublishAt(); then entryReleaseAt with
 *   the departure hold `holdEnd` and the release slots.
 */
export function portraitReleaseAt(
  capture: CapturePolicyInput,
  annotation: AnnotationPolicyInput | null | undefined,
  settings: PolicySettings & ReleaseSettings,
  holdEnd: string | null,
): string | null {
  const override = annotation?.visibility;
  if (override === 'pending') return null;
  if (capture.revokedAt && settings['ingest.on_revoke'] === 'hide') return null;
  const occurredAt = new Date(toMillis(capture.occurredAt, 'occurredAt')).toISOString();
  let publishAt: string | null;
  if (modeForCapture(capture, settings) === 'review' || override === 'public') publishAt = occurredAt;
  else publishAt = capturePublishAt(capture, null, settings);
  return entryReleaseAt(publishAt, holdEnd, settings);
}
