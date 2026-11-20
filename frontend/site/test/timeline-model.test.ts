import { describe, expect, it } from 'vitest';
import {
  anchorAt,
  anchorOffset,
  buildModel,
  type DayRow,
  keepHeaderInView,
  metricsFor,
  nearestDate,
  type Row,
  rowIndexAt,
  rowIndexForDate,
  rowStart,
  scrollTargetFor,
  shiftDate,
  type TripRow,
  type WeekRow,
  ZOOM_LEVELS,
  type ZoomLevel,
} from '../src/timeline/model';
import { bigTimeline, day, timeline } from './timeline-fixture';

const WIDTHS = [343, 600, 1024];

describe('metrics', () => {
  it('are deterministic and switch to compact below 640px', () => {
    expect(metricsFor(343)).toEqual(metricsFor(343.7));
    expect(metricsFor(343).compact).toBe(true);
    expect(metricsFor(1024).compact).toBe(false);
  });

  it('fit seven tiles into the content width, capped and centred', () => {
    for (const w of [280, 343, 600, 1024]) {
      const m = metricsFor(w);
      expect(m.gridWidth).toBe(7 * m.tile + 6 * m.cellGap);
      expect(m.gridWidth).toBeLessThanOrEqual(m.width);
      expect(m.gridStart * 2 + m.gridWidth).toBeLessThanOrEqual(m.width);
      expect(m.tile).toBeLessThanOrEqual(112);
    }
  });

  it('cap month tiles at 88 px beyond phones and switch the days level to wide from 960 px', () => {
    expect(metricsFor(1024).tile).toBe(88);
    expect(metricsFor(704).tile).toBe(88);
    expect(metricsFor(358).tile).toBe(Math.floor((358 - 36) / 7));
    expect([metricsFor(959).wide, metricsFor(960).wide, metricsFor(343).wide]).toEqual([false, true, false]);
    expect(metricsFor(1024).filmstrip).toBe(312);
    expect(metricsFor(704).filmstrip).toBe(264);
    expect(metricsFor(343).slimWeek).toBe(0);
  });

  it('a month (head + six full weeks) fits a 900 px viewport on wide screens', () => {
    const m = metricsFor(1024);
    expect(m.monthHead + 6 * (m.tile + m.cellGap) + m.monthGap).toBeLessThanOrEqual(900 - 100);
  });
});

describe('row models', () => {
  const t = bigTimeline();

  it('prefix sums are exact for every level and width', () => {
    for (const level of ZOOM_LEVELS) {
      for (const w of WIDTHS) {
        const model = buildModel(level, t, w);
        let acc = 0;
        model.rows.forEach((row, i) => {
          expect(model.starts[i]).toBe(acc);
          expect(row.size).toBeGreaterThan(0);
          expect(Number.isInteger(row.size)).toBe(true);
          acc += row.size;
        });
        expect(model.total).toBe(acc);
        expect(model.starts[model.rows.length]).toBe(acc);
        // Heights depend only on (level, width, data): rebuilding gives identical rows.
        expect(buildModel(level, t, w).starts).toEqual(model.starts);
      }
    }
  });

  it('has unique row keys on every level', () => {
    for (const level of ZOOM_LEVELS) {
      const keys = buildModel(level, t, 343).rows.map((r) => r.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('days level: newest first, month dividers, trip head/foot, passport stamps, latest flag', () => {
    const model = buildModel('days', t, 343);
    const kinds = model.rows.map((r) => r.kind);
    expect(kinds[0]).toBe('divider');
    expect(kinds.at(-1)).toBe('end');
    const dayRows = model.rows.filter((r): r is DayRow => r.kind === 'day');
    expect(dayRows.map((r) => r.day.date)).toEqual(t.days.map((d) => d.date).reverse());
    expect(dayRows.filter((r) => r.latest).map((r) => r.day.date)).toEqual(['2026-10-19']);
    // Every trip block is enclosed by exactly one head and one foot.
    expect(kinds.filter((k) => k === 'trip-head')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'trip-foot')).toHaveLength(3);
    // Stamps: first day in a country after a day elsewhere.
    const stamps = dayRows.filter((r) => r.stamp).map((r) => `${r.day.date}:${r.stamp}`);
    expect(stamps).toContain('2026-10-11:TH');
    expect(stamps).toContain('2026-10-01:VN');
    expect(stamps).toContain('2025-04-08:ES');
    expect(stamps).toContain('2025-04-03:PT');
    expect(stamps).not.toContain('2026-10-13:TH');
  });

  it('days level: a trip crossing a month boundary keeps the thread rose through the divider', () => {
    const model = buildModel('days', t, 343);
    const janDivider = model.rows.find((r) => r.kind === 'divider' && r.month === '2026-01');
    const decDivider = model.rows.find((r) => r.kind === 'divider' && r.month === '2025-12');
    expect(janDivider && 'inTrip' in janDivider && janDivider.inTrip).toBe(false);
    expect(decDivider && 'inTrip' in decDivider && decDivider.inTrip).toBe(true);
  });

  it('months level: calendar weeks (Monday first) for months with days only', () => {
    const model = buildModel('months', t, 343);
    const months = model.rows.filter((r) => r.kind === 'month').map((r) => (r as { month: string }).month);
    expect(months[0]).toBe('2026-10');
    expect(months).not.toContain('2026-09');
    const weeks = model.rows.filter((r): r is WeekRow => r.kind === 'week' && r.month === '2026-10');
    // 1 Oct 2026 is a Thursday: three leading cells from September.
    expect(weeks[0]?.cells.map((c) => c.inMonth)).toEqual([false, false, false, true, true, true, true]);
    expect(weeks[0]?.cells[3]?.date).toBe('2026-10-01');
    expect(weeks.flatMap((w) => w.cells.filter((c) => c.inMonth))).toHaveLength(31);
    for (const w of weeks) expect(new Date(`${w.cells[0]?.date}T00:00:00Z`).getUTCDay()).toBe(1);
    // A week shared by two months appears in both, but is a different row.
    expect(weeks.at(-1)?.cells.at(-1)?.date).toBe('2026-11-01');
  });

  it('months level: weekStart can be Sunday', () => {
    const model = buildModel('months', t, 343, { weekStart: 0 });
    const week = model.rows.find((r): r is WeekRow => r.kind === 'week');
    expect(new Date(`${week?.cells[0]?.date}T00:00:00Z`).getUTCDay()).toBe(0);
  });

  it('trips level: year markers, trips under the year they end in, loose days split per year', () => {
    const model = buildModel('trips', t, 343);
    const summary = model.rows.map((r) =>
      r.kind === 'year'
        ? `Y${r.year}`
        : r.kind === 'trip'
          ? `T:${r.trip.slug}`
          : r.kind === 'loose'
            ? `L${r.dates.length}`
            : r.kind,
    );
    expect(summary).toEqual(['Y2026', 'T:asia', 'L2', 'T:winter', 'Y2025', 'L3', 'T:iberia', 'L2', 'end']);
    const year2026 = model.rows[0];
    expect(year2026?.kind === 'year' && year2026.tripCount).toBe(2);
    const asia = model.rows[1] as TripRow;
    expect(asia.dates[0]).toBe('2026-10-19');
    expect(asia.dates.at(-1)).toBe('2026-10-01');
    expect(asia.moments).toBe(30);
  });

  it('empty timeline: no rows at all', () => {
    for (const level of ZOOM_LEVELS) {
      const model = buildModel(level, timeline([]), 343);
      expect(model.rows).toEqual([]);
      expect(model.total).toBe(0);
      expect(rowIndexAt(model, 100)).toBe(-1);
      expect(anchorAt(model, 0)).toBeNull();
      expect(anchorOffset(model, '2026-01-01')).toBeNull();
    }
  });
});

describe('queries and anchoring', () => {
  const t = bigTimeline();

  it('rowIndexAt finds the row containing an offset (binary search)', () => {
    const model = buildModel('days', t, 343);
    model.rows.forEach((row, i) => {
      const start = rowStart(model, i);
      expect(rowIndexAt(model, start)).toBe(i);
      expect(rowIndexAt(model, start + row.size - 1)).toBe(i);
    });
    expect(rowIndexAt(model, -50)).toBe(0);
    expect(rowIndexAt(model, model.total + 50)).toBe(model.rows.length - 1);
  });

  it('nearestDate snaps to the closest anchorable date (ties prefer newer)', () => {
    const days = buildModel('days', t, 343);
    expect(nearestDate(days, '2026-10-02')).toBe('2026-10-03');
    expect(nearestDate(days, '2030-01-01')).toBe('2026-10-19');
    expect(nearestDate(days, '2000-01-01')).toBe('2025-01-15');
    const months = buildModel('months', t, 343);
    // Every calendar date of a shown month is anchorable on the months level.
    expect(nearestDate(months, '2026-10-02')).toBe('2026-10-02');
  });

  it('round trip: the date at any content offset maps back into the same row on every level', () => {
    for (const level of ZOOM_LEVELS) {
      const model = buildModel(level, t, 600);
      for (const d of t.days) {
        const offset = anchorOffset(model, d.date);
        expect(offset).not.toBeNull();
        const at = anchorAt(
          model,
          offset as number,
          inlineFor(model.rows[rowIndexForDate(model, d.date)], d.date, model),
        );
        expect(at?.date).toBe(d.date);
      }
    }
  });

  it('zoom anchoring: the pointer date lands at the same viewport y on the next level', () => {
    const pairs: Array<[ZoomLevel, ZoomLevel]> = [
      ['days', 'months'],
      ['months', 'trips'],
      ['trips', 'months'],
      ['months', 'days'],
    ];
    const listTop = 240;
    const viewportY = 380;
    for (const [from, to] of pairs) {
      const a = buildModel(from, t, 343);
      const b = buildModel(to, t, 343);
      for (const d of ['2025-04-05', '2025-12-31', '2026-10-09', '2025-07-01']) {
        // Put the date under the pointer on level A...
        const scrollA = listTop + (anchorOffset(a, d) as number) - viewportY;
        const at = anchorAt(a, scrollA + viewportY - listTop, inlineFor(a.rows[rowIndexForDate(a, d)], d, a));
        expect(at?.date).toBe(d);
        // ...then on level B its anchor sits exactly at the pointer (when the range allows).
        const scrollB = scrollTargetFor(b, d, viewportY, listTop, 1e9) as number;
        expect(listTop + (anchorOffset(b, d) as number) - scrollB).toBe(viewportY);
      }
    }
  });

  it('scrollTargetFor clamps to the scrollable range', () => {
    const model = buildModel('days', t, 343);
    expect(scrollTargetFor(model, '2026-10-19', 2000, 200, 99999)).toBe(0);
    expect(scrollTargetFor(model, '2025-01-15', 0, 200, 5000)).toBe(5000);
  });

  it('decorative rows defer to the next content row', () => {
    const model = buildModel('days', t, 343);
    // Row 0 is the month divider; the first content row below is the newest day.
    expect(anchorAt(model, 1)?.date).toBe('2026-10-19');
    const end = model.rows.length - 1;
    expect(anchorAt(model, rowStart(model, end) + 5)?.date).toBe('2025-01-15');
  });

  it('trip cards map their height onto their dates (top = newest)', () => {
    const model = buildModel('trips', t, 343);
    const i = model.rows.findIndex((r) => r.kind === 'trip' && r.trip.slug === 'iberia');
    const row = model.rows[i] as TripRow;
    expect(anchorAt(model, rowStart(model, i) + 1)?.date).toBe(row.dates[0]);
    expect(anchorAt(model, rowStart(model, i) + row.size - 1)?.date).toBe(row.dates.at(-1));
  });

  it('week rows: the column under the pointer picks the date; other months snap inwards', () => {
    const model = buildModel('months', t, 343);
    const m = model.metrics;
    const i = model.rows.findIndex((r) => r.kind === 'week' && r.month === '2026-10');
    const y = rowStart(model, i) + 5;
    const col = (c: number) => m.gridStart + c * (m.tile + m.cellGap) + m.tile / 2;
    expect(anchorAt(model, y, col(4))?.date).toBe('2026-10-02');
    expect(anchorAt(model, y, col(0))?.date).toBe('2026-10-01');
    // Without a pointer: the newest day with content in that week.
    expect(anchorAt(model, y)?.date).toBe('2026-10-03');
  });
});

describe('date helpers', () => {
  it('shiftDate crosses months and years', () => {
    expect(shiftDate('2025-12-31', 1)).toBe('2026-01-01');
    expect(shiftDate('2024-03-01', -1)).toBe('2024-02-29');
  });

  it('a lone day builds a minimal model on every level', () => {
    const single = timeline([day('2026-11-18', { country: 'VN' })]);
    expect(buildModel('days', single, 343).rows.map((r) => r.kind)).toEqual(['divider', 'day', 'end']);
    expect(buildModel('trips', single, 343).rows.map((r) => r.kind)).toEqual(['year', 'loose', 'end']);
    const months = buildModel('months', single, 343).rows.map((r) => r.kind);
    expect(months[0]).toBe('month');
    expect(months.at(-1)).toBe('end');
  });
});

/** Inline position of a date in a week row (column centre), undefined for other rows. */
function inlineFor(row: Row | undefined, date: string, model: ReturnType<typeof buildModel>): number | undefined {
  if (row?.kind !== 'week') return undefined;
  const c = row.cells.findIndex((cell) => cell.date === date);
  const m = model.metrics;
  return m.gridStart + c * (m.tile + m.cellGap) + m.tile / 2;
}

describe('months level: collapsed weeks (larger screens)', () => {
  const t = bigTimeline();

  it('collapses weeks without moments into slim rows; phones keep full weeks', () => {
    const wide = buildModel('months', t, 1024);
    const weeks = wide.rows.filter((r): r is WeekRow => r.kind === 'week');
    const empty = weeks.filter((w) => !w.cells.some((c) => c.day));
    expect(empty.length).toBeGreaterThan(0);
    expect(empty.every((w) => w.collapsed)).toBe(true);
    expect(weeks.filter((w) => w.cells.some((c) => c.day)).every((w) => !w.collapsed)).toBe(true);
    const m = wide.metrics;
    for (const w of empty) expect(w.size).toBe(m.slimWeek + (w.size > m.slimWeek ? m.monthGap : 0));
    const phone = buildModel('months', t, 343);
    expect(phone.rows.filter((r): r is WeekRow => r.kind === 'week').some((w) => w.collapsed)).toBe(false);
  });

  it('anchoring still maps every date of a collapsed week to its row', () => {
    const model = buildModel('months', t, 1024);
    const week = model.rows.find((r): r is WeekRow => r.kind === 'week' && r.collapsed);
    const date = week?.dates[0] as string;
    const offset = anchorOffset(model, date) as number;
    const index = model.rows.indexOf(week as Row);
    expect(offset - rowStart(model, index)).toBe(Math.floor(model.metrics.slimWeek / 2));
    expect(anchorAt(model, offset)?.row).toBe(index);
  });
});

describe('keepHeaderInView (zooms without a pointer)', () => {
  const t = bigTimeline();

  it('moves the target up to the month header when the anchor still fits', () => {
    const model = buildModel('months', t, 1024);
    const date = '2026-10-19';
    const listTop = 400;
    const target = scrollTargetFor(model, date, 260, listTop, 1e9) as number;
    const kept = keepHeaderInView(model, date, target, listTop, 900);
    const header = model.rows.findIndex((r) => r.kind === 'month' && r.month === '2026-10');
    expect(kept).toBe(listTop + rowStart(model, header));
    expect(kept).toBeLessThanOrEqual(target);
    // The anchor stays on screen.
    expect(listTop + (anchorOffset(model, date) as number) - kept).toBeLessThan(900);
  });

  it('keeps the target when the header is too far above (or already in view)', () => {
    const model = buildModel('days', t, 1024);
    // A day deep inside a long month: its divider is many rows above.
    const date = '2026-10-01';
    const target = scrollTargetFor(model, date, 260, 0, 1e9) as number;
    expect(keepHeaderInView(model, date, target, 0, 900)).toBe(target);
    expect(keepHeaderInView(model, date, 0, 0, 900)).toBe(0);
  });
});
