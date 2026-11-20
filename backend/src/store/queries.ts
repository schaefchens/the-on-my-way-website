/**
 * Cross-repository read models for the generator.
 *
 * Never group captures by the raw captures.local_date: what the site shows is the EFFECTIVE local
 * date (contracts ./policy, "Placement"): annotation.localDateOverride, else the Day.tz fix of
 * the stored date, else the stored date.
 */
import type { Annotation } from '@omw/contracts/api';
import { effectiveLocalDate, effectiveTz } from '@omw/contracts/policy';
import { addDays } from '@omw/contracts/time';
import type { CaptureRepo } from './captures.js';
import type { OwnerRepo } from './owner.js';
import type { CaptureRow } from './types.js';

export interface PlacedCapture {
  capture: CaptureRow;
  annotation: Annotation | null;
  /** Effective local date (= the requested date). */
  localDate: string;
  /** Effective zone for wall-clock times. */
  tz: string;
}

/**
 * How far a Day.tz fix can move an item from its stored local date: UTC offsets span -12..+14 h,
 * so re-reading a wall clock in another zone shifts the date by up to two days (e.g. stored under
 * Pacific/Kiritimati, fixed to Pacific/Pago_Pago). Same window as the API (Captures::FIX_WINDOW_DAYS).
 */
export const FIX_WINDOW_DAYS = 2;

/**
 * Ready, renderable (kind != unsupported) captures placed on `date`, chronological. Visibility
 * is NOT applied here (it needs settings and "now"; use effectiveCaptureVisibility()).
 */
export function capturesForEffectiveDate(
  repos: { captures: CaptureRepo; owner: OwnerRepo },
  date: string,
): PlacedCapture[] {
  const candidates = repos.captures.effectiveDateCandidates(date, {
    from: addDays(date, -FIX_WINDOW_DAYS),
    to: addDays(date, FIX_WINDOW_DAYS),
  });
  const out: PlacedCapture[] = [];
  for (const capture of candidates) {
    const annotation = repos.owner.getAnnotation(capture.sourceKey) ?? null;
    const dayTz = repos.owner.dayTz(capture.localDate);
    if (effectiveLocalDate(capture, annotation, dayTz) !== date) continue;
    out.push({ capture, annotation, localDate: date, tz: effectiveTz(capture, annotation, dayTz) });
  }
  return out;
}
