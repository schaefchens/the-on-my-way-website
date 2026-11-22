import { describe, expect, it } from 'vitest';
import {
  AuthorName,
  AVATAR_MAX_WIDTH,
  AVATAR_SIZES,
  Boot,
  DayDetail,
  dayDataPath,
  Entry,
  HereNow,
  ImageSet,
  IntroI18n,
  IntroText,
  Manifest,
  resolveSitePath,
  routePath,
  SiteInfo,
  SiteProfile,
  TimelineIndex,
  TimePrecision,
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
    expect(Manifest.safeParse({ ...manifest(), version: 0 }).success).toBe(false);
    expect(Manifest.safeParse({ ...manifest(), site: { ...manifest().site, basePath: 'travel' } }).success).toBe(false);
    expect(Manifest.safeParse({ ...manifest(), site: { ...manifest().site, locales: [] } }).success).toBe(false);
    const t = timeline();
    expect(TimelineIndex.safeParse({ ...t, trips: [{ ...t.trips[0], slug: 'Vietnam 2026' }] }).success).toBe(false);
  });
});

describe('wave 5: no coordinates, here-now and time precision, gate boot', () => {
  it('DayDetail never carries coordinates (P0 E4): lat/lng are not part of the contract', () => {
    expect(DayDetail.shape).not.toHaveProperty('lat');
    expect(DayDetail.shape).not.toHaveProperty('lng');
    const parsed = DayDetail.parse({ ...dayDetail(), lat: 15.88, lng: 108.33 });
    expect(parsed).not.toHaveProperty('lat');
    expect(parsed).not.toHaveProperty('lng');
  });

  it('SiteInfo.hereNow / timePrecision are optional (absent = city_badge / exact)', () => {
    expect(HereNow.options).toEqual(['city_badge', 'city', 'country', 'none']);
    expect(TimePrecision.options).toEqual(['exact', 'part_of_day']);
    const site = manifest().site;
    expect(SiteInfo.parse(site)).toEqual(site);
    expect(SiteInfo.parse(site)).not.toHaveProperty('hereNow');
    for (const hereNow of HereNow.options) {
      for (const timePrecision of TimePrecision.options) {
        expect(SiteInfo.parse({ ...site, hereNow, timePrecision })).toEqual({ ...site, hereNow, timePrecision });
      }
    }
    expect(SiteInfo.safeParse({ ...site, hereNow: 'badge' }).success).toBe(false);
    expect(SiteInfo.safeParse({ ...site, timePrecision: 'hour' }).success).toBe(false);
  });

  it('Boot.access is present in gate mode only and carries no secret', () => {
    const boot = {
      basePath: '/abcdefghij0123456789/',
      locale: 'de',
      route: { name: 'home', params: {} },
      manifestVersion: 42,
      timelineV: 'abcdef12',
    };
    const access = {
      api: 'https://api.example.org/api/v1/public/',
      cookies: { key: '__Host-omw_k', transfer: '__Host-omw_s', handoff: '__Host-omw_h' },
      cookieMode: 'headers',
      cookieDomain: null,
    };
    expect(Boot.parse(boot)).not.toHaveProperty('access');
    expect(Boot.parse({ ...boot, access })).toEqual({ ...boot, access });
    expect(Boot.safeParse({ ...boot, access: { ...access, cookieMode: 'cookie' } }).success).toBe(false);
    expect(Boot.safeParse({ ...boot, access: { ...access, cookieDomain: 'Example.org' } }).success).toBe(false);
    expect(Boot.safeParse({ ...boot, access: { ...access, api: 'https://api.example.org/' } }).success).toBe(false);
    // Only cookie NAMES and the API base: the session and key values never appear in boot data.
    expect(Object.keys(access.cookies)).not.toContain('session');
  });
});

describe('profile (site.author / site.intro / site.avatar)', () => {
  /** Like the generator's: the round crop's own square files at 96/192/288 px. */
  const avatar = () => {
    const { og: _og, ...image } = imageSet();
    const files = (ext: string) =>
      AVATAR_SIZES.map((w) => ({ w, src: `media/ab/ab12cd34ef56ab78_avatar_0123abcd_s${w}.${ext}` }));
    return {
      ...image,
      w: 288,
      h: 288,
      sources: { avif: files('avif'), webp: files('webp') },
      focus: { x: 0.5, y: 0.3 },
    };
  };

  it('timeline.json carries an optional profile; without one it is unchanged', () => {
    const profile = {
      author: 'Lea',
      intro: { de: 'Schön, dass du da bist!', en: 'Glad you are here!' },
      avatar: avatar(),
    };
    expect(TimelineIndex.parse({ ...timeline(), profile })).toEqual({ ...timeline(), profile });
    expect(TimelineIndex.parse(timeline())).not.toHaveProperty('profile');
    expect(SiteProfile.parse({})).toEqual({});
    expect(SiteProfile.parse({ author: 'Lea' })).toEqual({ author: 'Lea' });
  });

  it('author: one trimmed line of 1..60 characters', () => {
    for (const ok of ['Lea', 'L', 'Léa & Tom 🌸', 'a'.repeat(60), 'مرحبا'])
      expect(AuthorName.safeParse(ok).success, ok).toBe(true);
    for (const bad of [
      '',
      ' ',
      ' Lea',
      'Lea ',
      'Lea\n',
      'Le\na',
      'Le\ta',
      '\u00a0Lea',
      'Lea\u3000',
      'a'.repeat(61),
      'x\u0000',
    ]) {
      expect(AuthorName.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('intro: trimmed plain text of 1..160 characters per locale, line feeds allowed', () => {
    for (const ok of ['Hallo!', 'Hallo ihr Lieben!\nSchön, dass ihr mitreist.', '**not markdown**', 'x'.repeat(160)]) {
      expect(IntroText.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['', ' Hallo', 'Hallo\n', 'Hal\r\nlo', 'x'.repeat(161)]) {
      expect(IntroText.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(IntroI18n.safeParse({ de: 'Hallo', en: 'Hello' }).success).toBe(true);
    expect(IntroI18n.safeParse({}).success).toBe(false);
    expect(IntroI18n.safeParse({ fr: 'Salut' }).success).toBe(false);
    expect(IntroI18n.safeParse({ de: '' }).success).toBe(false);
  });

  it('avatar: small files only (at most AVATAR_MAX_WIDTH), no OG image, focus within 0..1', () => {
    expect(AVATAR_MAX_WIDTH).toBe(Math.max(...AVATAR_SIZES));
    const photo = imageSet(); // a photo's own variants (320/640 px) are too large for a portrait
    expect(SiteProfile.safeParse({ avatar: { ...avatar(), sources: photo.sources } }).success).toBe(false);
    expect(SiteProfile.safeParse({ avatar: avatar() }).success).toBe(true);
    const { focus: _focus, ...noFocus } = avatar();
    expect(SiteProfile.safeParse({ avatar: noFocus }).success).toBe(true);
    const big = {
      ...avatar(),
      sources: { ...avatar().sources, webp: [{ w: AVATAR_MAX_WIDTH + 1, src: 'media/ab/x_w1080.webp' }] },
    };
    expect(SiteProfile.safeParse({ avatar: big }).success).toBe(false);
    expect(
      SiteProfile.parse({ avatar: { ...avatar(), og: 'media/ab/ab12cd34ef56ab78_og.jpg' } }).avatar,
    ).not.toHaveProperty('og');
    for (const focus of [{ x: -0.1, y: 0.5 }, { x: 0.5, y: 1.01 }, { x: 0.5 }]) {
      expect(SiteProfile.safeParse({ avatar: { ...avatar(), focus } }).success, JSON.stringify(focus)).toBe(false);
    }
    // An avatar is structurally an ImageSet (components that render ImageSets take it as is).
    expect(ImageSet.safeParse(avatar()).success).toBe(true);
  });

  it('Boot of a day page may inline the profile next to the day', () => {
    const boot = {
      basePath: '/',
      locale: 'de',
      route: { name: 'day', params: { date: '2026-11-15' } },
      manifestVersion: 42,
      timelineV: 'abcdef12',
      day: dayDetail(),
      profile: { author: 'Lea', avatar: avatar() },
    };
    expect(Boot.parse(boot)).toEqual(boot);
    expect(Boot.safeParse({ ...boot, profile: { author: ' Lea' } }).success).toBe(false);
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
