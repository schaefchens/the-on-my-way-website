/** Small synthetic timelines for the row-model tests (no I/O, contract-shaped). */
import type { DaySummary, TimelineIndex, TripSummary } from '@omw/contracts/site';
import { addDays } from '@omw/contracts/time';

const COUNTS = { photo: 2, video: 0, gif: 0, voice: 0, text: 1, note: 0, story: 0 };

export function day(date: string, extra: Partial<DaySummary> = {}): DaySummary {
  return {
    date,
    v: `v${date.replaceAll('-', '')}`,
    tz: 'Europe/Berlin',
    counts: COUNTS,
    firstAt: `${date}T08:00:00Z`,
    lastAt: `${date}T18:00:00Z`,
    ...extra,
  };
}

export function trip(slug: string, start: string, end: string, countries: string[]): TripSummary {
  return { slug, v: `v-${slug}`, title: { de: slug, en: slug }, start, end, countries, dayCount: 0 };
}

export function timeline(days: DaySummary[], trips: TripSummary[] = []): TimelineIndex {
  return {
    contractVersion: 1,
    generatedAt: '2026-11-19T00:00:00Z',
    trips,
    days: [...days].sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

/**
 * Two years: home days (DE), a trip "iberia" (PT -> ES) in spring 2025, a New-Year trip
 * "winter" spanning 2025/2026 (AT), and a current trip "asia" (VN -> TH) in autumn 2026.
 */
export function bigTimeline(): TimelineIndex {
  const days: DaySummary[] = [];
  const trips = [
    trip('iberia', '2025-04-03', '2025-04-12', ['PT', 'ES']),
    trip('winter', '2025-12-29', '2026-01-03', ['AT']),
    trip('asia', '2026-10-01', '2026-10-20', ['VN', 'TH']),
  ];
  for (let i = 0; i < 10; i++) {
    days.push(
      day(addDays('2025-04-03', i), {
        trip: 'iberia',
        country: i < 5 ? 'PT' : 'ES',
        place: i < 5 ? 'Lisboa' : 'Sevilla',
      }),
    );
  }
  for (let i = 0; i < 6; i++) days.push(day(addDays('2025-12-29', i), { trip: 'winter', country: 'AT' }));
  for (let i = 0; i < 20; i += 2)
    days.push(day(addDays('2026-10-01', i), { trip: 'asia', country: i < 10 ? 'VN' : 'TH' }));
  for (const d of ['2025-01-15', '2025-02-02', '2025-06-30', '2025-07-01', '2025-11-11', '2026-03-08', '2026-05-20']) {
    days.push(day(d, { country: 'DE', place: 'Leipzig' }));
  }
  return timeline(days, trips);
}
