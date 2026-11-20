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
 */

import type { OnRevoke, PublishMode } from './api.js';
import type { Visibility } from './common.js';
import { localDateFor } from './time.js';

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
