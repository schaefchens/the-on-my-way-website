/**
 * Publish policy (D11) and placement rules — pure functions, duplicated in PHP. Shared vectors:
 * fixtures/vectors/policy.json (visibility), placement.json (local date / tz), trips.json.
 *
 * Capture visibility:
 *   1. annotation.visibility if set (owner override always wins)
 *   2. else revoked && ingest.on_revoke = hide  -> hidden
 *   3. else captures that occurred BEFORE publish.mode_since are evaluated as "instant" -> public
 *      (switching to delayed/review only affects new statuses; it never unpublishes the archive)
 *   4. else publish.mode instant                -> public
 *           publish.mode delayed                -> public iff now >= occurredAt + delay, else pending
 *           publish.mode review                 -> pending
 * The API maintains "publish.mode_since" (default 1970-01-01T00:00:00.000Z; PHP
 * Policy::nextModeSince). With t = now, s0 = the old mode_since and d0 = the old delay:
 *   - instant -> delayed | review                    t
 *   - delayed -> review, and a changed delay while
 *     staying delayed                                 max(s0, t - d0 + 1 ms): exactly the captures
 *                                                     already public under the old delay stay public
 *   - review -> delayed                               s0 unchanged; the review backlog older than the
 *                                                     new delay is released, which the admin asks the
 *                                                     owner to confirm first
 *   - anything else (-> instant, no mode change)      s0 unchanged
 * So apart from that confirmed review -> delayed release, a settings change never flips a capture
 * between public and pending. Switching back to "instant" publishes everything still pending
 * without an override (turning review off means "stop holding things back"). The API writes
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

function delayMillis(settings: PolicySettings): number {
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

/** Slugs of existing trips that `candidate` would overlap (the API answers 422 when non-empty). */
export function overlappingTrips(candidate: TripRange, trips: readonly TripRange[]): string[] {
  return trips
    .filter((t) => t.slug !== candidate.slug && tripRangesOverlap(candidate, t))
    .map((t) => t.slug)
    .sort();
}
