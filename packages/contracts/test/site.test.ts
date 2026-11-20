import { describe, expect, it } from 'vitest';
import {
  Boot,
  DayDetail,
  dayDataPath,
  Entry,
  ImageSet,
  Manifest,
  resolveSitePath,
  routePath,
  TimelineIndex,
  TripDetail,
  tripDataPath,
  withVersion,
} from '../src/site.js';
import { dayDetail, imageSet, manifest, timeline, tripDetail } from './samples.js';

describe('static data files accept valid samples', () => {
  it('DayDetail with every entry kind', () => {
    const parsed = DayDetail.parse(dayDetail());
    expect(parsed.entries.map((e) => e.kind)).toEqual(['photo', 'video', 'gif', 'voice', 'text', 'note', 'story']);
  });
  it('TimelineIndex', () => expect(TimelineIndex.parse(timeline())).toEqual(timeline()));
  it('TripDetail', () => expect(TripDetail.parse(tripDetail())).toEqual(tripDetail()));
  it('Manifest', () => expect(Manifest.parse(manifest())).toEqual(manifest()));
  it('Boot with inlined day', () => {
    const boot = {
      basePath: '/',
      locale: 'de',
      route: { name: 'day', params: { date: '2026-11-15' } },
      manifestVersion: 42,
      timelineV: 'abcdef12',
      day: dayDetail(),
    };
    expect(Boot.parse(boot)).toEqual(boot);
  });
  it('Boot of /404.html', () => {
    const boot = {
      basePath: '/travel/',
      locale: 'de',
      route: { name: 'notFound', params: {} },
      manifestVersion: 42,
      timelineV: 'abcdef12',
    };
    expect(Boot.parse(boot)).toEqual(boot);
  });
});

describe('static data files reject invalid samples', () => {
  it('ImageSet: absolute paths, path traversal, bad colours, empty sources', () => {
    const img = imageSet();
    expect(ImageSet.safeParse({ ...img, og: '/media/x.jpg' }).success).toBe(false);
    expect(ImageSet.safeParse({ ...img, og: 'media/../secret.jpg' }).success).toBe(false);
    expect(ImageSet.safeParse({ ...img, og: 'https://cdn.example/x.jpg' }).success).toBe(false);
    expect(ImageSet.safeParse({ ...img, color: '#FFF' }).success).toBe(false);
    expect(ImageSet.safeParse({ ...img, color: '#C88A6A' }).success).toBe(false);
    expect(ImageSet.safeParse({ ...img, sources: { avif: [], webp: img.sources.webp } }).success).toBe(false);
  });

  it('Entry: unknown kind, WhatsApp ids, wrong ids per kind, gif without loop', () => {
    const [photo, , gif, , , note] = dayDetail().entries;
    expect(Entry.safeParse({ ...photo, kind: 'sticker' }).success).toBe(false);
    expect(Entry.safeParse({ ...photo, id: '3EB0C767D26A1D8B7A3B' }).success).toBe(false);
    expect(Entry.safeParse({ ...note, id: 'e_abcdefgh2345' }).success).toBe(false);
    expect(Entry.safeParse({ ...gif, loop: false }).success).toBe(false);
    if (gif?.kind === 'gif') {
      expect(Entry.safeParse({ ...gif, video: { ...gif.video, hasAudio: true } }).success).toBe(false);
    }
    const story = dayDetail().entries.find((e) => e.kind === 'story');
    expect(Entry.parse({ ...story, path: 'day/x/' })).not.toHaveProperty('path'); // derived via routePath
    expect(Entry.safeParse({ ...photo, at: '2026-11-15T09:12:00+07:00' }).success).toBe(false);
    expect(Entry.safeParse({ ...photo, tz: 'Mars/Olympus' }).success).toBe(false);
  });

  it('DayDetail / Manifest / TimelineIndex invariants', () => {
    expect(DayDetail.safeParse({ ...dayDetail(), contractVersion: 2 }).success).toBe(false);
    expect(DayDetail.safeParse({ ...dayDetail(), date: '2026-02-30' }).success).toBe(false);
    expect(DayDetail.safeParse({ ...dayDetail(), country: 'vn' }).success).toBe(false);
    expect(DayDetail.safeParse({ ...dayDetail(), lat: 91 }).success).toBe(false);
    expect(Manifest.safeParse({ ...manifest(), version: 0 }).success).toBe(false);
    expect(Manifest.safeParse({ ...manifest(), site: { ...manifest().site, basePath: 'travel' } }).success).toBe(false);
    expect(Manifest.safeParse({ ...manifest(), site: { ...manifest().site, locales: [] } }).success).toBe(false);
    const t = timeline();
    expect(TimelineIndex.safeParse({ ...t, trips: [{ ...t.trips[0], slug: 'Vietnam 2026' }] }).success).toBe(false);
  });
});

describe('path helpers', () => {
  it('builds data paths and routes (D3)', () => {
    expect(dayDataPath('2026-11-18')).toBe('data/days/2026-11-18.json');
    expect(tripDataPath('vietnam-2026')).toBe('data/trips/vietnam-2026.json');
    expect(withVersion('data/timeline.json', 'ab12')).toBe('data/timeline.json?v=ab12');
    expect(routePath('de', { name: 'home' })).toBe('de/');
    expect(routePath('en', { name: 'day', date: '2026-11-18' })).toBe('en/day/2026-11-18/');
    expect(routePath('de', { name: 'story', date: '2026-11-18', id: 'p_story001' })).toBe(
      'de/day/2026-11-18/story/p_story001/',
    );
    expect(routePath('de', { name: 'trip', slug: 'vietnam-2026' })).toBe('de/trip/vietnam-2026/');
    expect(() => routePath('de', { name: 'day', date: '../../' })).toThrow();
  });

  it('resolves site paths against the basePath', () => {
    expect(resolveSitePath('/', 'media/ab/x.avif')).toBe('/media/ab/x.avif');
    expect(resolveSitePath('/travel/', 'data/manifest.json')).toBe('/travel/data/manifest.json');
    expect(() => resolveSitePath('travel', 'x')).toThrow();
  });
});
