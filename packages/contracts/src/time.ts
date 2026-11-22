/**
 * Time helpers (D6). Pure functions, isomorphic (Node + browser), DST-correct via
 * Intl.DateTimeFormat with an explicit timeZone. Duplicated in PHP; shared test vectors
 * live in fixtures/vectors/time.json.
 *
 * - occurredAt: ISO-8601 UTC instant ("…Z")
 * - tz: IANA zone
 * - localDate: "YYYY-MM-DD" = calendar date of occurredAt in tz
 */

const formatterCache = new Map<string, Intl.DateTimeFormat>();
const zoneValidity = new Map<string, boolean>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(tz, fmt);
  }
  return fmt;
}

/** Accepts a Date, epoch milliseconds or an ISO string; throws on invalid input. */
export type InstantInput = Date | number | string;

function toDate(input: InstantInput): Date {
  const d = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`Invalid instant: ${String(input)}`);
  }
  return d;
}

/** Canonical ISO UTC string with milliseconds ("2026-11-18T02:12:00.000Z"). */
export function toIsoUtc(input: InstantInput): string {
  return toDate(input).toISOString();
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(input: InstantInput, tz: string): WallClock {
  if (!isValidTimeZone(tz)) {
    throw new RangeError(`Invalid time zone: ${tz}`);
  }
  const parts = formatterFor(tz).formatToParts(toDate(input));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new RangeError(`Missing ${type} while formatting in ${tz}`);
    return Number.parseInt(part.value, 10);
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Calendar date "YYYY-MM-DD" of the instant in the given IANA zone. */
export function localDateFor(isoUtc: InstantInput, tz: string): string {
  const w = wallClock(isoUtc, tz);
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}

/** Wall-clock time "HH:mm" (24h) of the instant in the given IANA zone. */
export function localTimeFor(isoUtc: InstantInput, tz: string): string {
  const w = wallClock(isoUtc, tz);
  return `${pad(w.hour)}:${pad(w.minute)}`;
}

/** UTC offset in minutes (east positive) of the zone at that instant, e.g. 420 for +07:00. */
export function utcOffsetMinutes(isoUtc: InstantInput, tz: string): number {
  const d = toDate(isoUtc);
  const w = wallClock(d, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const truncated = Math.floor(d.getTime() / 1000) * 1000;
  return Math.round((asUtc - truncated) / 60000);
}

/**
 * True for IANA zone names known to the runtime ("Europe/Berlin", "UTC").
 * Rejects empty strings and raw offsets ("+07:00"), which Intl would otherwise accept.
 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return false;
  const cached = zoneValidity.get(tz);
  if (cached !== undefined) return cached;
  let ok: boolean;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    ok = true;
  } catch {
    ok = false;
  }
  zoneValidity.set(tz, ok);
  return ok;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(date: string): [number, number, number] {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`Invalid local date: ${date}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    throw new RangeError(`Invalid local date: ${date}`);
  }
  return [y, mo, d];
}

/** True for a real calendar date in "YYYY-MM-DD" form. */
export function isValidLocalDate(date: unknown): date is string {
  if (typeof date !== 'string') return false;
  try {
    parseDate(date);
    return true;
  } catch {
    return false;
  }
}

function formatUtcDate(t: Date): string {
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Calendar arithmetic on "YYYY-MM-DD" (no time zones involved). */
export function addDays(date: string, n: number): string {
  if (!Number.isInteger(n)) throw new RangeError(`addDays expects an integer, got ${n}`);
  const [y, m, d] = parseDate(date);
  return formatUtcDate(new Date(Date.UTC(y, m - 1, d + n)));
}

/** Comparator for "YYYY-MM-DD" strings: -1, 0 or 1. */
export function compareDates(a: string, b: string): -1 | 0 | 1 {
  parseDate(a);
  parseDate(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whole days from `a` to `b` (b - a). */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = parseDate(a);
  const [by, bm, bd] = parseDate(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Inclusive list of dates from `start` to `end` (empty if end < start). */
export function dateRange(start: string, end: string): string[] {
  const n = daysBetween(start, end);
  const out: string[] = [];
  for (let i = 0; i <= n; i++) out.push(addDays(start, i));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Wall-clock arithmetic for release slots and time buckets (wave 5; vectors
// fixtures/vectors/time-buckets.json and release.json)

/** Local wall time of the instant in `tz`, encoded as epoch ms of the same fields in UTC (+ ms). */
function wallMillis(ms: number, tz: string): number {
  const w = wallClock(ms, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) + (((ms % 1000) + 1000) % 1000);
}

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The UTC instant (ISO, ms) at which the wall clock in `tz` shows `date` `hhmm`:00. DST: a wall
 * time inside a gap (spring forward) maps to the first instant after the gap (the transition);
 * an ambiguous one (fall back) to the earlier instant.
 */
export function zonedWallTimeToUtc(date: string, hhmm: string, tz: string): string {
  const [y, mo, d] = parseDate(date);
  const m = HHMM_RE.exec(hhmm);
  if (!m) throw new RangeError(`Invalid wall time: ${hhmm}`);
  if (!isValidTimeZone(tz)) throw new RangeError(`Invalid time zone: ${tz}`);
  const wall = Date.UTC(y, mo - 1, d, Number(m[1]), Number(m[2]));
  // Offsets in force around that wall time (at most one transition in reach in practice).
  const offsets = new Set<number>();
  for (let k = -4; k <= 4; k++) offsets.add(wallMillis(wall + k * 6 * 3_600_000, tz) - (wall + k * 6 * 3_600_000));
  const exact = [...offsets].map((o) => wall - o).filter((t) => wallMillis(t, tz) === wall);
  if (exact.length > 0) return new Date(Math.min(...exact)).toISOString();
  // A gap: the first instant whose wall time is at or after `wall`.
  const candidates = [...offsets].map((o) => wall - o);
  let lo = Math.min(...candidates.filter((t) => wallMillis(t, tz) < wall));
  let hi = Math.max(...candidates.filter((t) => wallMillis(t, tz) > wall));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
    throw new RangeError(`Cannot place ${date} ${hhmm} in ${tz}`);
  }
  // Invariant: wall(lo) < wall <= wall(hi); find the smallest such hi (whole seconds suffice:
  // zone transitions happen on whole seconds).
  lo = Math.floor(lo / 1000) * 1000;
  hi = Math.ceil(hi / 1000) * 1000;
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (wallMillis(mid, tz) >= wall) hi = mid;
    else lo = mid;
  }
  return new Date(hi).toISOString();
}

export type PartOfDay = 'night' | 'morning' | 'midday' | 'afternoon' | 'evening';
export type BucketStartHour = 0 | 3 | 6 | 9 | 12 | 15 | 18 | 21;

const PART_OF_DAY: Readonly<Record<BucketStartHour, PartOfDay>> = {
  0: 'night',
  3: 'night',
  6: 'morning',
  9: 'morning',
  12: 'midday',
  15: 'afternoon',
  18: 'evening',
  21: 'night',
};

/** 3-hour bucket of the local wall time: 00,03,21 night · 06,09 morning · 12 midday · 15 afternoon · 18 evening. */
export function timeBucket(at: InstantInput, tz: string): { startHour: BucketStartHour; partOfDay: PartOfDay } {
  const startHour = (Math.floor(wallClock(at, tz).hour / 3) * 3) as BucketStartHour;
  return { startHour, partOfDay: PART_OF_DAY[startHour] };
}

/** Largest `index` coarsenToBucket accepts (the coarsened time stays inside its bucket). */
export const MAX_BUCKET_INDEX = 3599;

/**
 * Coarsens an entry time to its 3-hour local bucket (setting site.time_precision = part_of_day):
 * at − (local (hour mod 3)·3600 + minute·60 + second + ms) + index seconds, ISO with ms = 000.
 * `index` = 0-based position among the day's entries in the same bucket, ordered by the original
 * (at, id), so the coarsened times keep their order.
 */
export function coarsenToBucket(at: InstantInput, tz: string, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index > MAX_BUCKET_INDEX) {
    throw new RangeError(`Bucket index out of range: ${index}`);
  }
  const d = toDate(at);
  const w = wallClock(d, tz);
  const ms = ((d.getTime() % 1000) + 1000) % 1000;
  const intoBucket = ((w.hour % 3) * 3600 + w.minute * 60 + w.second) * 1000 + ms;
  return new Date(d.getTime() - intoBucket + index * 1000).toISOString();
}
