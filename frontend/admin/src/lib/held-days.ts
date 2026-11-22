/**
 * Departure hold on Home (spec-wave5 §7.5, Q1): which days the hold keeps off the site right now,
 * computed client-side from the day list with the shared policy functions (leftPlaceAt,
 * holdEndAt), exactly like the generator decides it:
 *   - HoldDays are built from EVERY date with an item (pending and hidden ones count as "she is
 *     there");
 *   - a date is held while the hold of its latest item has not ended (an earlier item of the same
 *     date ends its hold no later than that);
 *   - only dates with something public are counted (a hidden or waiting item would not appear
 *     anyway).
 * Grouped per place (placeKey), soonest end first.
 */
import { type HoldDay, holdEndAt, leftPlaceAt, placeKey, type ReleaseSettings } from '@omw/contracts/policy';

/** The parts of AdminDaySummary the computation reads. */
export interface HoldDaySummary {
  localDate: string;
  day: { placeName?: string | null } | null;
  counts: { public: number };
  firstAt: string | null;
  lastAt: string | null;
}

export interface HeldPlace {
  /** Place as the owner wrote it on the latest held date (null: dates without a place). */
  place: string | null;
  /** Held dates at this place. */
  days: number;
  dates: string[];
  /** When the last of them is released at the latest (ISO). */
  until: string;
}

export function heldPlaces(days: readonly HoldDaySummary[], settings: ReleaseSettings, now: number): HeldPlace[] {
  if (!settings['publish.departure_hold'].enabled) return [];
  const holdDays: HoldDay[] = [];
  for (const d of days) {
    if (d.firstAt) holdDays.push({ date: d.localDate, place: d.day?.placeName ?? null, firstAt: d.firstAt });
  }
  const left = leftPlaceAt(holdDays);
  const groups = new Map<string, HeldPlace>();
  for (const d of [...days].sort((a, b) => (a.localDate < b.localDate ? -1 : a.localDate > b.localDate ? 1 : 0))) {
    if (!d.lastAt || d.counts.public <= 0) continue;
    const end = holdEndAt(d.lastAt, left.get(d.localDate) ?? null, settings);
    if (end === null || Date.parse(end) <= now) continue;
    const place = d.day?.placeName?.trim() || null;
    const key = placeKey(place) ?? '';
    const g = groups.get(key);
    if (g) {
      g.days += 1;
      g.dates.push(d.localDate);
      if (end > g.until) g.until = end;
      if (place) g.place = place;
    } else {
      groups.set(key, { place, days: 1, dates: [d.localDate], until: end });
    }
  }
  return [...groups.values()].sort((a, b) => (a.until < b.until ? -1 : a.until > b.until ? 1 : 0));
}

/**
 * The hold end of one photo (the portrait hint, §7.9): its date's departure ("left the place"),
 * the "moved on" tap or the cap; null when the hold is off.
 */
export function holdEndFor(
  occurredAt: string,
  localDate: string,
  days: readonly HoldDaySummary[] | undefined,
  settings: ReleaseSettings,
): string | null {
  if (!settings['publish.departure_hold'].enabled) return null;
  const holdDays: HoldDay[] = [];
  for (const d of days ?? []) {
    if (d.firstAt) holdDays.push({ date: d.localDate, place: d.day?.placeName ?? null, firstAt: d.firstAt });
  }
  const left = holdDays.length > 0 ? (leftPlaceAt(holdDays).get(localDate) ?? null) : null;
  return holdEndAt(occurredAt, left, settings);
}
