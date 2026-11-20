/**
 * Row models of the semantic zoom (plan C, "Zoom mechanics"). Pure and deterministic: every row
 * height is a function of (level, data, width), so the prefix sums are exact and TanStack
 * Virtual's `estimateSize` never has to measure anything. Zoom anchoring maps a date between
 * levels with `anchorAt` (date under an offset) and `anchorOffset` (offset of a date).
 *
 * Order is newest first on every level (the latest day is at the top). Month grids are ordinary
 * calendars inside each month (weeks ascending, Monday first).
 *
 *   trips   year · trip | loose … · end
 *   months  month · week … · end
 *   days    divider · trip-head · day … · trip-foot · end
 */
import type { DaySummary, TimelineIndex, TripSummary } from '@omw/contracts/site';

export const ZOOM_LEVELS = ['trips', 'months', 'days'] as const;
export type ZoomLevel = (typeof ZOOM_LEVELS)[number];

// ---------------------------------------------------------------------------------------------
// Metrics

/** Below this content width the compact (phone) metrics apply. */
export const COMPACT_MAX_WIDTH = 640;
/** From this content width (lg viewports, 1024 px and up) the days level uses its wide layout. */
export const WIDE_MIN_WIDTH = 960;

export interface Metrics {
  /** Content width the metrics were computed for. */
  width: number;
  compact: boolean;
  /** Wide screens: taller filmstrips laid out as a two-row mosaic (L3-19). */
  wide: boolean;
  // trips level
  yearRow: number;
  tripRow: number;
  looseRow: number;
  // months level
  monthHead: number;
  /** Extra space after the last week of a month. */
  monthGap: number;
  cellGap: number;
  tile: number;
  /**
   * Height of a week without any moments (larger screens collapse such weeks into a slim row of
   * day numbers, so a month fits the viewport); 0 = weeks are never collapsed (phones).
   */
  slimWeek: number;
  /** 7 tiles + 6 gaps. */
  gridWidth: number;
  /** Inline offset of the grid inside the content box (the grid is centred). */
  gridStart: number;
  // days level
  divider: number;
  tripHead: number;
  tripFoot: number;
  dayRow: number;
  /** Height of the sticky day header; the anchor point of a day row is its centre. */
  dayHeader: number;
  filmstrip: number;
  // all levels
  endRow: number;
}

/** Largest month tile on phones (never reached there) and on larger screens (L3-19). */
const MAX_TILE = { compact: 112, regular: 88 } as const;

export function metricsFor(rawWidth: number): Metrics {
  const width = Math.max(280, Math.floor(rawWidth));
  const compact = width < COMPACT_MAX_WIDTH;
  const wide = width >= WIDE_MIN_WIDTH;
  const cellGap = compact ? 6 : 10;
  const tile = Math.min(compact ? MAX_TILE.compact : MAX_TILE.regular, Math.floor((width - 6 * cellGap) / 7));
  const gridWidth = 7 * tile + 6 * cellGap;
  const dayHeader = compact ? 76 : 84;
  const filmstrip = compact ? 216 : wide ? 312 : 264;
  return {
    width,
    compact,
    wide,
    yearRow: compact ? 136 : 168,
    tripRow: compact ? 420 : 320,
    looseRow: compact ? 176 : 164,
    monthHead: compact ? 104 : 124,
    monthGap: compact ? 12 : 20,
    cellGap,
    tile,
    slimWeek: compact ? 0 : 32,
    gridWidth,
    gridStart: Math.floor((width - gridWidth) / 2),
    divider: compact ? 64 : 72,
    tripHead: compact ? 152 : 160,
    tripFoot: compact ? 96 : 104,
    // header + gap + filmstrip + footer (button) + bottom padding
    dayRow: dayHeader + 8 + filmstrip + 16 + 44 + 36,
    dayHeader,
    filmstrip,
    endRow: compact ? 200 : 220,
  };
}

// ---------------------------------------------------------------------------------------------
// Rows

export interface WeekCell {
  date: string;
  /** False for the leading/trailing days of neighbouring months (rendered empty). */
  inMonth: boolean;
  day: DaySummary | null;
}

interface RowBase {
  key: string;
  size: number;
  /**
   * Dates this row stands for, newest first. Anchoring uses them: content rows (day, trip,
   * loose, week) have dates; decorative rows (year, month, divider, trip-head/foot, end) none.
   */
  dates: readonly string[];
}

export interface YearRow extends RowBase {
  kind: 'year';
  year: string;
  tripCount: number;
  dayCount: number;
  countries: string[];
}
export interface TripRow extends RowBase {
  kind: 'trip';
  trip: TripSummary;
  /** The trip's days in this segment, newest first. */
  days: DaySummary[];
  moments: number;
}
export interface LooseRow extends RowBase {
  kind: 'loose';
  /** Days outside trips, newest first. */
  days: DaySummary[];
  moments: number;
}
export interface MonthRow extends RowBase {
  kind: 'month';
  /** "YYYY-MM" */
  month: string;
  trips: TripSummary[];
  dayCount: number;
}
export interface WeekRow extends RowBase {
  kind: 'week';
  month: string;
  cells: WeekCell[];
  /** No day of this week has moments and the metrics collapse such weeks (slim row). */
  collapsed: boolean;
}
export interface DividerRow extends RowBase {
  kind: 'divider';
  month: string;
  /** The route thread passes through inside a trip (the trip continues across months). */
  inTrip: boolean;
}
export interface TripHeadRow extends RowBase {
  kind: 'trip-head';
  trip: TripSummary;
}
export interface TripFootRow extends RowBase {
  kind: 'trip-foot';
  trip: TripSummary;
  /** The trip's first (oldest) day in this segment. */
  firstDay: DaySummary;
}
export interface DayRow extends RowBase {
  kind: 'day';
  day: DaySummary;
  /** Country entered on this day (passport stamp), if it differs from the previous day's. */
  stamp: string | null;
  /** The newest day of the timeline ("here now"). */
  latest: boolean;
  trip: TripSummary | null;
}
export interface EndRow extends RowBase {
  kind: 'end';
  /** Oldest day of the timeline. */
  first: string;
}

export type Row =
  | YearRow
  | TripRow
  | LooseRow
  | MonthRow
  | WeekRow
  | DividerRow
  | TripHeadRow
  | TripFootRow
  | DayRow
  | EndRow;
export type RowKind = Row['kind'];

export interface RowModel {
  level: ZoomLevel;
  metrics: Metrics;
  rows: Row[];
  /** starts[i] = offset of row i; starts[rows.length] = total. */
  starts: number[];
  total: number;
  /** All anchorable dates, newest first, with the row that represents each. */
  dateIndex: Array<{ date: string; row: number }>;
}

export interface ModelOptions {
  /** First day of the week, 0 = Sunday … 6 = Saturday (default Monday). */
  weekStart?: number;
}

// ---------------------------------------------------------------------------------------------
// Date helpers (UTC calendar arithmetic on "YYYY-MM-DD", no zones)

function utc(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

function fromUtc(t: number): string {
  const d = new Date(t);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${m}-${day}`;
}

const DAY_MS = 86_400_000;

export function shiftDate(date: string, days: number): string {
  return fromUtc(utc(date) + days * DAY_MS);
}

export function dayDistance(a: string, b: string): number {
  return Math.round(Math.abs(utc(a) - utc(b)) / DAY_MS);
}

export function weekday(date: string): number {
  return new Date(utc(date)).getUTCDay();
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function yearOf(date: string): string {
  return date.slice(0, 4);
}

export function daysInMonth(month: string): number {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function momentCount(day: DaySummary): number {
  const c = day.counts;
  return c.photo + c.video + c.gif + c.voice + c.text + c.note + c.story;
}

// ---------------------------------------------------------------------------------------------
// Builders

/** Days newest first (the index is ascending by contract; sort defensively). */
export function daysNewestFirst(timeline: TimelineIndex): DaySummary[] {
  return [...timeline.days].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function tripMap(timeline: TimelineIndex): Map<string, TripSummary> {
  return new Map(timeline.trips.map((t) => [t.slug, t]));
}

function tripOf(day: DaySummary, trips: Map<string, TripSummary>): TripSummary | null {
  return day.trip ? (trips.get(day.trip) ?? null) : null;
}

function endRow(days: DaySummary[], m: Metrics): EndRow[] {
  const oldest = days.at(-1);
  return oldest ? [{ kind: 'end', key: 'end', size: m.endRow, dates: [], first: oldest.date }] : [];
}

function buildTripsRows(days: DaySummary[], trips: Map<string, TripSummary>, m: Metrics): Row[] {
  // Segments: maximal runs (newest first) of days with the same trip; trip-less runs are split
  // at year boundaries so that each loose card belongs to exactly one year.
  type Segment = { trip: TripSummary | null; days: DaySummary[] };
  const segments: Segment[] = [];
  for (const day of days) {
    const trip = tripOf(day, trips);
    const last = segments.at(-1);
    const prevDay = last?.days.at(-1);
    const sameYear = prevDay !== undefined && yearOf(prevDay.date) === yearOf(day.date);
    const continues = last !== undefined && (trip ? last.trip?.slug === trip.slug : last.trip === null && sameYear);
    if (last && continues) last.days.push(day);
    else segments.push({ trip, days: [day] });
  }

  const rows: Row[] = [];
  let currentYear: string | null = null;
  let yearRow: YearRow | null = null;
  const yearTrips = new Set<string>();
  const yearCountries = new Set<string>();
  for (const seg of segments) {
    const newest = seg.days[0];
    if (!newest) continue;
    const year = yearOf(newest.date);
    if (year !== currentYear) {
      currentYear = year;
      yearTrips.clear();
      yearCountries.clear();
      yearRow = {
        kind: 'year',
        key: `year:${year}`,
        size: m.yearRow,
        dates: [],
        year,
        tripCount: 0,
        dayCount: 0,
        countries: [],
      };
      rows.push(yearRow);
    }
    if (yearRow) {
      yearRow.dayCount += seg.days.length;
      if (seg.trip) yearTrips.add(seg.trip.slug);
      for (const d of seg.days) if (d.country && !yearCountries.has(d.country)) yearCountries.add(d.country);
      yearRow.tripCount = yearTrips.size;
      // Chronological order of first appearance reads naturally ("DE → VN → KH").
      yearRow.countries = [...yearCountries].reverse();
    }
    const dates = seg.days.map((d) => d.date);
    const moments = seg.days.reduce((n, d) => n + momentCount(d), 0);
    if (seg.trip) {
      rows.push({
        kind: 'trip',
        key: `trip:${seg.trip.slug}:${dates.at(-1)}`,
        size: m.tripRow,
        dates,
        trip: seg.trip,
        days: seg.days,
        moments,
      });
    } else {
      rows.push({ kind: 'loose', key: `loose:${dates.at(-1)}`, size: m.looseRow, dates, days: seg.days, moments });
    }
  }
  rows.push(...endRow(days, m));
  return rows;
}

function buildMonthsRows(days: DaySummary[], trips: Map<string, TripSummary>, m: Metrics, weekStart: number): Row[] {
  const byMonth = new Map<string, DaySummary[]>();
  for (const day of days) {
    const key = monthOf(day.date);
    const list = byMonth.get(key);
    if (list) list.push(day);
    else byMonth.set(key, [day]);
  }
  const rows: Row[] = [];
  for (const [month, monthDays] of byMonth) {
    const byDate = new Map(monthDays.map((d) => [d.date, d]));
    const tripsInMonth: TripSummary[] = [];
    for (const d of [...monthDays].reverse()) {
      const t = tripOf(d, trips);
      if (t && !tripsInMonth.includes(t)) tripsInMonth.push(t);
    }
    rows.push({
      kind: 'month',
      key: `month:${month}`,
      size: m.monthHead,
      dates: [],
      month,
      trips: tripsInMonth,
      dayCount: monthDays.length,
    });
    const first = `${month}-01`;
    const lead = (weekday(first) - weekStart + 7) % 7;
    const total = daysInMonth(month);
    const weeks = Math.ceil((lead + total) / 7);
    for (let w = 0; w < weeks; w++) {
      const cells: WeekCell[] = [];
      for (let c = 0; c < 7; c++) {
        const date = shiftDate(first, w * 7 + c - lead);
        const inMonth = monthOf(date) === month;
        cells.push({ date, inMonth, day: inMonth ? (byDate.get(date) ?? null) : null });
      }
      const dates = cells
        .filter((c) => c.inMonth)
        .map((c) => c.date)
        .reverse();
      const last = w === weeks - 1;
      const collapsed = m.slimWeek > 0 && !cells.some((c) => c.day !== null);
      rows.push({
        kind: 'week',
        key: `week:${month}:${w}`,
        size: (collapsed ? m.slimWeek : m.tile + m.cellGap) + (last ? m.monthGap : 0),
        dates,
        month,
        cells,
        collapsed,
      });
    }
  }
  rows.push(...endRow(days, m));
  return rows;
}

function buildDaysRows(days: DaySummary[], trips: Map<string, TripSummary>, m: Metrics): Row[] {
  // Country of the nearest older day that has one (for passport stamps).
  const olderCountry: Array<string | undefined> = new Array(days.length);
  let seen: string | undefined;
  for (let i = days.length - 1; i >= 0; i--) {
    olderCountry[i] = seen;
    seen = days[i]?.country ?? seen;
  }

  const rows: Row[] = [];
  let month: string | null = null;
  let open: { trip: TripSummary; oldest: DaySummary } | null = null;
  const closeTrip = () => {
    if (open) {
      rows.push({
        kind: 'trip-foot',
        key: `trip-foot:${open.trip.slug}:${open.oldest.date}`,
        size: m.tripFoot,
        dates: [],
        trip: open.trip,
        firstDay: open.oldest,
      });
    }
    open = null;
  };

  for (let i = 0; i < days.length; i++) {
    const day = days[i] as DaySummary;
    const dayTrip = tripOf(day, trips);
    if (open && dayTrip?.slug !== open.trip.slug) closeTrip();
    const dayMonth = monthOf(day.date);
    if (dayMonth !== month) {
      month = dayMonth;
      rows.push({
        kind: 'divider',
        key: `divider:${dayMonth}`,
        size: m.divider,
        dates: [],
        month: dayMonth,
        inTrip: open !== null,
      });
    }
    if (dayTrip) {
      if (!open) {
        rows.push({
          kind: 'trip-head',
          key: `trip-head:${dayTrip.slug}:${day.date}`,
          size: m.tripHead,
          dates: [],
          trip: dayTrip,
        });
      }
      open = { trip: dayTrip, oldest: day };
    }
    // Passport stamp: the first day in a country after a day elsewhere (or the very first day).
    const stamp = day.country && day.country !== olderCountry[i] ? day.country : null;
    rows.push({
      kind: 'day',
      key: `day:${day.date}`,
      size: m.dayRow,
      dates: [day.date],
      day,
      stamp,
      latest: i === 0,
      trip: dayTrip,
    });
  }
  closeTrip();
  rows.push(...endRow(days, m));
  return rows;
}

export function buildModel(
  level: ZoomLevel,
  timeline: TimelineIndex,
  width: number,
  options: ModelOptions = {},
): RowModel {
  const metrics = metricsFor(width);
  const days = daysNewestFirst(timeline);
  const trips = tripMap(timeline);
  const rows =
    level === 'trips'
      ? buildTripsRows(days, trips, metrics)
      : level === 'months'
        ? buildMonthsRows(days, trips, metrics, options.weekStart ?? 1)
        : buildDaysRows(days, trips, metrics);

  const starts = new Array<number>(rows.length + 1);
  let acc = 0;
  rows.forEach((row, i) => {
    starts[i] = acc;
    acc += row.size;
  });
  starts[rows.length] = acc;

  const dateIndex: RowModel['dateIndex'] = [];
  rows.forEach((row, i) => {
    for (const date of row.dates) dateIndex.push({ date, row: i });
  });
  dateIndex.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return { level, metrics, rows, starts, total: acc, dateIndex };
}

// ---------------------------------------------------------------------------------------------
// Queries

/** Index of the row containing `offset` (clamped to the list). -1 for an empty model. */
export function rowIndexAt(model: RowModel, offset: number): number {
  const n = model.rows.length;
  if (n === 0) return -1;
  if (offset <= 0) return 0;
  if (offset >= model.total) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((model.starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function rowStart(model: RowModel, index: number): number {
  return model.starts[index] ?? 0;
}

/** Row whose dates contain `date`, else the row of the nearest anchorable date (ties: newer). */
export function rowIndexForDate(model: RowModel, date: string): number {
  return nearestDateEntry(model, date)?.row ?? -1;
}

function nearestDateEntry(model: RowModel, date: string): { date: string; row: number } | null {
  const idx = model.dateIndex;
  if (idx.length === 0) return null;
  // Newest first: find the first entry with entry.date <= date.
  let lo = 0;
  let hi = idx.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((idx[mid]?.date ?? '') > date) lo = mid + 1;
    else hi = mid;
  }
  const older = idx[lo];
  const newer = idx[lo - 1];
  if (!older) return newer ?? null;
  if (!newer) return older;
  return dayDistance(newer.date, date) <= dayDistance(older.date, date) ? newer : older;
}

/** The anchorable date nearest to `date` (itself when the level shows it). */
export function nearestDate(model: RowModel, date: string): string | null {
  return nearestDateEntry(model, date)?.date ?? null;
}

/** Offset of the anchor point of `date` inside its row (see the module doc). */
function anchorInRow(model: RowModel, row: Row, date: string): number {
  const m = model.metrics;
  switch (row.kind) {
    // Whole pixels, so a scroll target (an integer) puts the anchor exactly at the pointer.
    case 'day':
      return Math.floor(m.dayHeader / 2);
    case 'week':
      return Math.floor((row.collapsed ? m.slimWeek : m.tile) / 2);
    case 'trip':
    case 'loose': {
      const n = row.dates.length;
      const i = Math.max(0, row.dates.indexOf(date));
      return Math.round(((i + 0.5) / n) * row.size);
    }
    default:
      return Math.floor(row.size / 2);
  }
}

export interface Anchor {
  date: string;
  row: number;
}

/**
 * Date under a list offset (and, in month grids, an inline position measured from the content
 * box's inline-start edge). Decorative rows defer to the next content row below, then above.
 */
export function anchorAt(model: RowModel, offset: number, inline?: number): Anchor | null {
  const start = rowIndexAt(model, offset);
  if (start < 0) return null;
  const n = model.rows.length;
  let index = -1;
  for (let i = start; i < n; i++) {
    if ((model.rows[i]?.dates.length ?? 0) > 0) {
      index = i;
      break;
    }
  }
  if (index < 0) {
    for (let i = start - 1; i >= 0; i--) {
      if ((model.rows[i]?.dates.length ?? 0) > 0) {
        index = i;
        break;
      }
    }
  }
  const row = model.rows[index];
  if (!row) return null;
  if (index !== start) return { date: row.dates[index > start ? 0 : row.dates.length - 1] as string, row: index };

  switch (row.kind) {
    case 'week': {
      const m = model.metrics;
      const cells = row.cells;
      let col: number;
      if (inline === undefined) {
        // No pointer: the newest day with content, else the middle of the week.
        const withContent = [...cells].reverse().find((c) => c.inMonth && c.day);
        col = withContent ? cells.indexOf(withContent) : 3;
      } else {
        col = Math.floor((inline - m.gridStart + m.cellGap / 2) / (m.tile + m.cellGap));
      }
      col = Math.min(6, Math.max(0, col));
      // Leading/trailing cells of other months snap to the nearest in-month cell.
      let best = cells[col];
      if (!best?.inMonth) {
        let bestDist = Number.POSITIVE_INFINITY;
        cells.forEach((c, i) => {
          if (c.inMonth && Math.abs(i - col) < bestDist) {
            bestDist = Math.abs(i - col);
            best = c;
          }
        });
      }
      return best ? { date: best.date, row: index } : null;
    }
    case 'trip':
    case 'loose': {
      const fraction = (offset - rowStart(model, index)) / row.size;
      const i = Math.min(row.dates.length - 1, Math.max(0, Math.floor(fraction * row.dates.length)));
      return { date: row.dates[i] as string, row: index };
    }
    default:
      return { date: row.dates[0] as string, row: index };
  }
}

/** List offset of the anchor point of `date` (nearest anchorable date when not shown). */
export function anchorOffset(model: RowModel, date: string): number | null {
  const entry = nearestDateEntry(model, date);
  if (!entry) return null;
  const row = model.rows[entry.row];
  if (!row) return null;
  return rowStart(model, entry.row) + anchorInRow(model, row, entry.date);
}

/**
 * Window scroll position that puts `date`'s anchor at viewport y `viewportY`, clamped to the
 * scrollable range. `listTop` is the list's document offset (TanStack Virtual's scrollMargin).
 */
export function scrollTargetFor(
  model: RowModel,
  date: string,
  viewportY: number,
  listTop: number,
  maxScroll: number,
): number | null {
  const offset = anchorOffset(model, date);
  if (offset === null) return null;
  return Math.round(Math.min(Math.max(0, listTop + offset - viewportY), Math.max(0, maxScroll)));
}

/** Width-independent identity of a model's content, used to decide when to re-anchor. */
export function modelSignature(model: RowModel): string {
  return `${model.level}|${model.metrics.width}|${model.rows.length}|${model.total}`;
}

/** Rows that head a stretch of the list (the reader's context: year, month). */
function isHeaderRow(row: Row): boolean {
  return row.kind === 'year' || row.kind === 'month' || row.kind === 'divider';
}

/**
 * For zooms without a pointer (keys, the zoom pill; L3-07): moves a scroll target up so the
 * header above `date` (its year or month) stays in view, as long as the date's anchor then still
 * fits on screen with `margin` to spare. Never moves it down.
 */
export function keepHeaderInView(
  model: RowModel,
  date: string,
  target: number,
  listTop: number,
  viewportHeight: number,
  margin = 96,
): number {
  const index = rowIndexForDate(model, date);
  const anchor = anchorOffset(model, date);
  if (index < 0 || anchor === null) return target;
  let header = -1;
  for (let i = index; i >= 0; i--) {
    const row = model.rows[i];
    if (row && isHeaderRow(row)) {
      header = i;
      break;
    }
  }
  if (header < 0) return target;
  const headerTop = Math.max(0, listTop + rowStart(model, header));
  if (target <= headerTop) return target;
  return listTop + anchor + margin - headerTop <= viewportHeight ? headerTop : target;
}
