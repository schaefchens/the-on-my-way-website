import { createHash } from 'node:crypto';
import { type Annotation, type Day, type Post, SETTINGS_DEFAULTS, type Settings, type Trip } from '@omw/contracts/api';
import { publicIdFromSha256Hex } from '@omw/contracts/ids';
import { DayDetail, SiteProfile, TripDetail } from '@omw/contracts/site';
import { localDateFor } from '@omw/contracts/time';
import { describe, expect, it } from 'vitest';
import { contentHash } from '../../src/generator/hash.js';
import { buildSiteModel, type ModelInputs, type PortraitCrop, portraitSourceFor } from '../../src/generator/model.js';
import type { CaptureRow, ProcessedVariant } from '../../src/store/index.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function capture(
  msgId: string,
  occurredAt: string,
  over: Partial<CaptureRow> & { kind?: CaptureRow['kind'] } = {},
): CaptureRow {
  const sourceKey = `wa:${msgId}`;
  const tz = over.tz ?? 'Asia/Ho_Chi_Minh';
  const kind = over.kind ?? 'photo';
  const original = sha(msgId);
  const rel = (variant: string, ext: string) =>
    `media/${original.slice(0, 2)}/${original.slice(0, 16)}_${variant}.${ext}`;
  const v = (role: ProcessedVariant['role'], variant: string, format: ProcessedVariant['format'], w?: number) => ({
    role,
    variant,
    format,
    ...(w ? { w, h: Math.round(w * 0.75) } : {}),
    relPath: rel(variant, format),
    bytes: 10,
    sha256: original,
  });
  const image = (role: 'image' | 'poster', prefix: string) => [
    v(role, `${prefix}320`, 'avif', 320),
    v(role, `${prefix}320`, 'webp', 320),
    v(role, `${prefix}640`, 'avif', 640),
    v(role, `${prefix}640`, 'webp', 640),
    v('og', 'og', 'jpg', 1200),
  ];
  const variants: ProcessedVariant[] =
    kind === 'photo'
      ? image('image', 'w')
      : kind === 'video' || kind === 'gif'
        ? [...image('poster', 'poster_w'), v('video', 'video', 'mp4', 640)]
        : kind === 'voice'
          ? [v('audio', 'voice', 'm4a')]
          : [];
  return {
    sourceKey,
    publicId: publicIdFromSha256Hex(sha(sourceKey)),
    msgId,
    source: 'fixture',
    kind,
    occurredAt,
    receivedAt: occurredAt,
    tz,
    localDate: localDateFor(occurredAt, tz),
    caption: null,
    text: kind === 'text' ? { body: 'Hallo', bgArgb: null, textArgb: null, font: null } : null,
    media: null,
    sender: null,
    state: 'ready',
    downloadState: kind === 'text' ? 'not_applicable' : 'ok',
    downloadReason: null,
    downloadPermanent: null,
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    archivePath: 'x',
    originalSha256: original,
    variants: kind === 'text' ? null : variants,
    processedMeta:
      kind === 'text'
        ? null
        : { w: 640, h: 480, thumbhash: 'AAAA', color: '#a1b2c3', duration: 3, peaks: [0.1, 0.9], hasAudio: true },
    revokedAt: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    ...over,
  };
}

function inputs(over: Omit<Partial<ModelInputs>, 'settings'> & { settings?: Partial<Settings> } = {}): ModelInputs {
  return {
    captures: [],
    annotations: new Map(),
    days: new Map(),
    posts: [],
    trips: [],
    now: new Date('2026-11-19T12:00:00Z'),
    mediaExists: () => true,
    ...over,
    settings: { ...SETTINGS_DEFAULTS, ...over.settings },
  };
}

const ann = (sourceKey: string, a: Partial<Annotation>): [string, Annotation] => [
  sourceKey,
  { sourceKey, updatedAt: '2026-11-19T00:00:00Z', ...a },
];

const ids = (m: ReturnType<typeof buildSiteModel>) =>
  m.days.flatMap((d) => d.entries.map((e) => `${d.date}:${e.kind}`));

describe('visibility policy (D11)', () => {
  const a = capture('A1', '2026-11-15T02:00:00Z');
  const b = capture('B1', '2026-11-19T11:30:00Z'); // 30 min before "now"

  it('instant: every ready capture is public; unsupported and non-ready ones never', () => {
    const m = buildSiteModel(
      inputs({
        captures: [
          a,
          b,
          capture('U1', '2026-11-15T03:00:00Z', { kind: 'unsupported' }),
          capture('P1', '2026-11-15T04:00:00Z', { state: 'processed' }),
          capture('L1', '2026-11-15T05:00:00Z', { state: 'media_lost' }),
        ],
      }),
    );
    expect(m.stats.captures).toBe(2);
    expect(ids(m)).toEqual(['2026-11-15:photo', '2026-11-19:photo']);
    expect(m.nextPublishAt).toBeNull();
  });

  it('delayed: only captures older than the delay; nextPublishAt is the next release', () => {
    const m = buildSiteModel(
      inputs({ captures: [a, b], settings: { 'publish.mode': 'delayed', 'publish.delay_minutes': 60 } }),
    );
    expect(ids(m)).toEqual(['2026-11-15:photo']);
    expect(m.stats.pending).toBe(1);
    expect(m.nextPublishAt).toBe('2026-11-19T12:30:00.000Z');
  });

  it('review: nothing new is public, but captures before publish.mode_since stay public', () => {
    const settings = { 'publish.mode': 'review', 'publish.mode_since': '2026-11-18T00:00:00.000Z' } as const;
    const m = buildSiteModel(inputs({ captures: [a, b], settings }));
    expect(ids(m)).toEqual(['2026-11-15:photo']);
    expect(m.nextPublishAt).toBeNull();
  });

  it('owner overrides win: hidden hides, public publishes even in review mode', () => {
    const m = buildSiteModel(
      inputs({
        captures: [a, b],
        annotations: new Map([ann(a.sourceKey, { visibility: 'hidden' }), ann(b.sourceKey, { visibility: 'public' })]),
        settings: { 'publish.mode': 'review' },
      }),
    );
    expect(ids(m)).toEqual(['2026-11-19:photo']);
    expect(m.stats.hidden).toBe(1);
  });

  it('revoked: hidden with on_revoke=hide, kept with keep', () => {
    const revoked = { ...a, revokedAt: '2026-11-15T02:10:00.000Z' };
    expect(ids(buildSiteModel(inputs({ captures: [revoked] })))).toEqual([]);
    expect(ids(buildSiteModel(inputs({ captures: [revoked], settings: { 'ingest.on_revoke': 'keep' } })))).toEqual([
      '2026-11-15:photo',
    ]);
  });

  it('posts follow their own visibility', () => {
    const post = (id: string, visibility: Post['visibility']): Post => ({
      publicId: id,
      kind: 'note',
      occurredAt: '2026-11-15T06:00:00Z',
      tz: 'Asia/Ho_Chi_Minh',
      localDate: '2026-11-15',
      origLocale: 'de',
      visibility,
      updatedAt: '2026-11-15T06:00:00Z',
      content: { de: { body: 'Hallo' } },
    });
    const m = buildSiteModel(
      inputs({ posts: [post('p_pub1', 'public'), post('p_hid1', 'hidden'), post('p_pen1', 'pending')] }),
    );
    expect(m.days[0]?.entries.map((e) => e.id)).toEqual(['p_pub1']);
  });
});

describe('placement: time zones and local dates', () => {
  // 18:30 UTC = 01:30 next day in Ho Chi Minh City (UTC+7), 19:30 in Berlin (UTC+1).
  const late = capture('T1', '2026-11-15T18:30:00Z');

  it('stores the local date of the capture zone', () => {
    const m = buildSiteModel(inputs({ captures: [late] }));
    expect(m.days.map((d) => d.date)).toEqual(['2026-11-16']);
    expect(m.days[0]?.tz).toBe('Asia/Ho_Chi_Minh');
  });

  it('a Day.tz fix on the stored date re-dates the item in that zone', () => {
    const day: Day = { localDate: '2026-11-16', tz: 'Europe/Berlin', updatedAt: '2026-11-19T00:00:00Z' };
    const m = buildSiteModel(inputs({ captures: [late], days: new Map([[day.localDate, day]]) }));
    expect(m.days.map((d) => d.date)).toEqual(['2026-11-15']);
    expect(m.days[0]?.entries[0]?.tz).toBe('Europe/Berlin');
    expect(m.days[0]?.tz).toBe('Europe/Berlin');
  });

  it('annotation.localDateOverride wins and keeps the capture zone', () => {
    const day: Day = { localDate: '2026-11-16', tz: 'Europe/Berlin', updatedAt: '2026-11-19T00:00:00Z' };
    const m = buildSiteModel(
      inputs({
        captures: [late],
        days: new Map([[day.localDate, day]]),
        annotations: new Map([ann(late.sourceKey, { localDateOverride: '2026-11-20' })]),
      }),
    );
    expect(m.days.map((d) => d.date)).toEqual(['2026-11-20']);
    expect(m.days[0]?.entries[0]?.tz).toBe('Asia/Ho_Chi_Minh');
  });
});

describe('posts merged with captures', () => {
  const note: Post = {
    publicId: 'p_note0001',
    kind: 'note',
    occurredAt: '2026-11-15T02:30:00Z', // no milliseconds: must still sort by time
    tz: 'Asia/Ho_Chi_Minh',
    localDate: '2026-11-15',
    origLocale: 'en',
    visibility: 'public',
    updatedAt: '2026-11-15T03:00:00Z',
    content: { en: { body: 'Coffee' }, de: { body: '   ' } },
  };
  const story: Post = {
    publicId: 'p_story001',
    kind: 'story',
    occurredAt: '2026-11-15T01:00:00.000Z',
    tz: 'Asia/Ho_Chi_Minh',
    localDate: '2026-11-15',
    origLocale: 'de',
    visibility: 'public',
    updatedAt: '2026-11-15T03:00:00Z',
    content: { de: { title: 'Titel', body: '## Hallo' } },
  };

  it('orders entries chronologically and normalises instants', () => {
    const m = buildSiteModel(
      inputs({
        captures: [capture('C1', '2026-11-15T02:30:00.000Z'), capture('C2', '2026-11-15T02:00:00Z')],
        posts: [note, story],
      }),
    );
    const day = m.days[0];
    expect(day?.entries.map((e) => e.kind)).toEqual(['story', 'photo', 'photo', 'note']);
    const ats = day?.entries.map((e) => e.at) ?? [];
    expect(ats).toEqual([...ats].sort());
    expect(ats.every((a) => a.endsWith('.000Z'))).toBe(true);
    expect(day?.entries[0]?.kind).toBe('story');
    // Same instant: capture id (e_…) sorts before post id (p_…).
    expect(day?.entries.slice(2).map((e) => e.id[0])).toEqual(['e', 'p']);
    // Blank note text in a locale is dropped.
    const n = day?.entries.find((e) => e.kind === 'note');
    expect(n && n.kind === 'note' ? n.note : null).toEqual({ en: 'Coffee' });
    expect(DayDetail.safeParse(day).success).toBe(true);
    expect(day?.v).toMatch(/^[0-9a-f]{16}$/);
  });

  it('counts kinds per day and drops empty posts', () => {
    const empty: Post = { ...note, publicId: 'p_empty001', content: { en: { body: ' ' } } };
    const m = buildSiteModel(
      inputs({ captures: [capture('C1', '2026-11-15T02:30:00Z')], posts: [note, story, empty] }),
    );
    expect(m.summaries[0]?.counts).toEqual({ photo: 1, video: 0, gif: 0, voice: 0, text: 0, note: 1, story: 1 });
    expect(m.warnings.some((w) => w.includes('p_empty001'))).toBe(true);
  });
});

describe('days, covers and trips', () => {
  const caps = [
    capture('D1', '2026-11-14T02:00:00Z', { kind: 'text' }),
    capture('D2', '2026-11-14T03:00:00Z'),
    capture('D3', '2026-11-15T03:00:00Z', { kind: 'video' }),
    capture('D4', '2026-11-15T04:00:00Z'),
    capture('D5', '2026-11-20T04:00:00Z', { kind: 'voice' }),
  ];
  const trip: Trip = {
    slug: 'vietnam-2026',
    title: { de: 'Vietnam', en: 'Vietnam' },
    startDate: '2026-11-14',
    endDate: '2026-11-16',
    coverSourceKey: 'wa:D4',
    updatedAt: '2026-11-19T00:00:00Z',
  };
  const days = new Map<string, Day>([
    [
      '2026-11-14',
      { localDate: '2026-11-14', countryCode: 'VN', title: { de: 'Hà Nội' }, origLocale: 'de', updatedAt: 'x' },
    ],
    ['2026-11-15', { localDate: '2026-11-15', countryCode: 'KH', coverSourceKey: 'wa:D4', updatedAt: 'x' }],
  ] as [string, Day][]);

  it('links prev/next, covers and trip membership', () => {
    const m = buildSiteModel(inputs({ captures: caps, trips: [trip], days }));
    expect(m.days.map((d) => [d.date, d.prev ?? null, d.next ?? null, d.trip ?? null])).toEqual([
      ['2026-11-14', null, '2026-11-15', 'vietnam-2026'],
      ['2026-11-15', '2026-11-14', '2026-11-20', 'vietnam-2026'],
      ['2026-11-20', '2026-11-15', null, null],
    ]);
    const [d14, d15, d20] = m.summaries;
    expect(d14?.cover?.sources.webp[0]?.src).toContain(sha('D2').slice(0, 16));
    expect(d15?.cover?.sources.webp[0]?.src).toContain(sha('D4').slice(0, 16)); // owner's choice, not the video
    expect(d20?.cover).toBeUndefined();
    expect(d14?.title).toEqual({ de: 'Hà Nội' });
    expect(d14?.orig).toBe('de');
    const t = m.trips[0];
    expect(t?.days).toEqual(['2026-11-14', '2026-11-15']);
    expect(t?.cover?.sources.webp[0]?.src).toContain(sha('D4').slice(0, 16));
    expect(m.tripSummaries[0]).toMatchObject({ countries: ['VN', 'KH'], dayCount: 2 });
    expect(TripDetail.safeParse(t).success).toBe(true);
    expect(m.timelineV).toMatch(/^[0-9a-f]{16}$/);
  });

  it('a hidden cover capture falls back to the first image of the day', () => {
    const m = buildSiteModel(
      inputs({ captures: caps, trips: [trip], days, annotations: new Map([ann('wa:D4', { visibility: 'hidden' })]) }),
    );
    expect(m.summaries[1]?.cover?.sources.webp[0]?.src).toContain(sha('D3').slice(0, 16)); // the video poster
    expect(m.trips[0]?.cover?.sources.webp[0]?.src).toContain(sha('D2').slice(0, 16));
    expect(m.media.some((p) => p.includes(sha('D4').slice(0, 16)))).toBe(false);
  });

  it('a cover capture moved to another day no longer covers its old day (L2-07)', () => {
    const moved = buildSiteModel(
      inputs({
        captures: caps,
        trips: [trip],
        days,
        annotations: new Map([ann('wa:D4', { localDateOverride: '2026-11-16' })]),
      }),
    );
    const byDate = new Map(moved.summaries.map((s) => [s.date, s]));
    // 11-15 keeps only the video: its poster is the cover now, not the moved photo
    expect(byDate.get('2026-11-15')?.cover?.sources.webp[0]?.src).toContain(sha('D3').slice(0, 16));
    // the photo covers the day it moved to (first image there)
    expect(byDate.get('2026-11-16')?.cover?.sources.webp[0]?.src).toContain(sha('D4').slice(0, 16));
    // a Day.tz fix that moves the cover capture away has the same effect
    const fixed = buildSiteModel(
      inputs({
        // C1: 00:30 on the 15th in Ho Chi Minh City but 18:30 on the 14th in Berlin;
        // C2: 10:00 on the 15th in Ho Chi Minh City and 04:00 on the 15th in Berlin.
        captures: [capture('C1', '2026-11-14T17:30:00Z'), capture('C2', '2026-11-15T03:00:00Z')],
        days: new Map<string, Day>([
          ['2026-11-15', { localDate: '2026-11-15', tz: 'Europe/Berlin', coverSourceKey: 'wa:C1', updatedAt: 'x' }],
        ] as [string, Day][]),
      }),
    );
    const f = new Map(fixed.summaries.map((s) => [s.date, s]));
    expect(fixed.days.map((d) => d.date)).toEqual(['2026-11-14', '2026-11-15']);
    expect(f.get('2026-11-15')?.cover?.sources.webp[0]?.src).toContain(sha('C2').slice(0, 16));
    expect(f.get('2026-11-14')?.cover?.sources.webp[0]?.src).toContain(sha('C1').slice(0, 16));
  });

  it('maps media: video poster, hasAudio, gif muted loop, voice peaks', () => {
    const m = buildSiteModel(inputs({ captures: [...caps, capture('G1', '2026-11-20T05:00:00Z', { kind: 'gif' })] }));
    const entries = m.days.flatMap((d) => d.entries);
    const video = entries.find((e) => e.kind === 'video');
    const gif = entries.find((e) => e.kind === 'gif');
    const voice = entries.find((e) => e.kind === 'voice');
    expect(video?.kind === 'video' && video.video.hasAudio).toBe(true);
    expect(gif?.kind === 'gif' && [gif.video.hasAudio, gif.loop]).toEqual([false, true]);
    expect(voice?.kind === 'voice' && voice.audio.peaks).toEqual([0.1, 0.9]);
    const text = entries.find((e) => e.kind === 'text');
    expect(text?.kind === 'text' && text.text).toEqual({
      body: 'Hallo',
      bg: '#3b2341ff',
      fg: '#ffffffff',
      font: 'SYSTEM',
    });
  });

  it('leaves out captures with incomplete or missing media instead of referencing missing files', () => {
    const broken = capture('X1', '2026-11-15T05:00:00Z', { processedMeta: { w: 10, h: 10 } });
    const missingFile = capture('X2', '2026-11-15T06:00:00Z');
    const m = buildSiteModel(
      inputs({
        captures: [broken, missingFile],
        mediaExists: (p) => !p.includes(sha('X2').slice(0, 16)),
      }),
    );
    expect(m.days).toEqual([]);
    expect(m.stats.skippedMedia).toBe(2);
    expect(m.warnings.join('\n')).toMatch(/color\/thumbhash[\s\S]*missing in MEDIA_DIR/);
  });
});

describe('published trips: planned trips stay off the site', () => {
  const trip = (slug: string, startDate: string, endDate: string): Trip => ({
    slug,
    title: { de: slug },
    startDate,
    endDate,
    updatedAt: '2026-11-19T00:00:00Z',
  });
  const vietnam = trip('vietnam-2026', '2026-11-14', '2026-11-16');
  const japan = trip('japan-2027', '2027-03-01', '2027-03-20'); // planned: dates, no day yet
  const slugs = (m: ReturnType<typeof buildSiteModel>) => [
    m.trips.map((t) => t.slug),
    m.tripSummaries.map((t) => t.slug),
  ];

  it('a trip without a public day is not published at all', () => {
    const m = buildSiteModel(inputs({ captures: [capture('T1', '2026-11-14T03:00:00Z')], trips: [vietnam, japan] }));
    expect(slugs(m)).toEqual([['vietnam-2026'], ['vietnam-2026']]);
    expect(m.timeline.trips.map((t) => t.slug)).toEqual(['vietnam-2026']);
    expect(JSON.stringify(m)).not.toContain('japan-2027');
  });

  it('hidden, pending and unpublishable items do not make a day public; one public post does', () => {
    const hidden = capture('T2', '2026-11-15T03:00:00Z');
    const pendingPost: Post = {
      publicId: 'p_pending01',
      kind: 'note',
      occurredAt: '2026-11-15T04:00:00Z',
      tz: 'Asia/Ho_Chi_Minh',
      localDate: '2026-11-15',
      origLocale: 'de',
      visibility: 'pending',
      content: { de: { body: 'Bald' } },
      updatedAt: '2026-11-19T00:00:00Z',
    };
    const lost = capture('T3', '2026-11-15T05:00:00Z', { state: 'media_lost' });
    const base = {
      captures: [hidden, lost],
      posts: [pendingPost],
      trips: [vietnam],
      annotations: new Map([ann('wa:T2', { visibility: 'hidden' })]),
    };
    expect(slugs(buildSiteModel(inputs(base)))).toEqual([[], []]);
    // Review mode keeps a new capture back: still a planned trip.
    const review = buildSiteModel(
      inputs({
        ...base,
        annotations: new Map(),
        settings: { 'publish.mode': 'review', 'publish.mode_since': '2026-11-01T00:00:00.000Z' },
      }),
    );
    expect(slugs(review)).toEqual([[], []]);
    const published = buildSiteModel(inputs({ ...base, posts: [{ ...pendingPost, visibility: 'public' }] }));
    expect(slugs(published)).toEqual([['vietnam-2026'], ['vietnam-2026']]);
    expect(published.tripSummaries[0]).toMatchObject({ dayCount: 1, start: '2026-11-14', end: '2026-11-16' });
  });

  it('counts a day for the trip tripForDate() picks when (forbidden) ranges overlap', () => {
    const overlap = trip('a-hoi-an', '2026-11-15', '2026-11-20');
    const m = buildSiteModel(inputs({ captures: [capture('T4', '2026-11-15T03:00:00Z')], trips: [overlap, vietnam] }));
    expect(m.days[0]?.trip).toBe('vietnam-2026');
    expect(slugs(m)).toEqual([['vietnam-2026'], ['vietnam-2026']]);
  });
});

describe('profile: site.author, site.intro, site.avatar', () => {
  const big = (msgId: string, occurredAt: string, over: Partial<CaptureRow> = {}) => {
    const c = capture(msgId, occurredAt, over);
    const original = sha(msgId);
    const rel = (variant: string, ext: string) =>
      `media/${original.slice(0, 2)}/${original.slice(0, 16)}_${variant}.${ext}`;
    const large = (w: number, format: 'avif' | 'webp'): ProcessedVariant => ({
      role: 'image',
      variant: `w${w}`,
      format,
      w,
      h: Math.round(w * 1.25),
      relPath: rel(`w${w}`, format),
      bytes: 10,
      sha256: original,
    });
    return {
      ...c,
      caption: 'Geheime Bildunterschrift',
      variants: [
        ...(c.variants ?? []),
        large(1080, 'avif'),
        large(1080, 'webp'),
        large(1600, 'avif'),
        large(1600, 'webp'),
      ],
    };
  };
  const portrait = big('P1', '2026-11-14T03:00:00Z');
  const other = capture('P2', '2026-11-15T03:00:00Z');
  const avatarSetting = { sourceKey: 'wa:P1', focus: { x: 0.25, y: 0.4 } };
  const short = (p: string) => p.slice(p.lastIndexOf('_') + 1);

  it('without profile settings nothing changes (no profile, same timeline hash)', () => {
    const m = buildSiteModel(inputs({ captures: [portrait, other] }));
    expect(m.profile).toBeNull();
    expect(m.timeline).not.toHaveProperty('profile');
    expect(m.timelineV).toBe(contentHash({ trips: m.timeline.trips, days: m.timeline.days }));
  });

  it('author and intro alone; the timeline hash covers the profile', () => {
    const intro = { de: 'Hallo ihr Lieben!', en: 'Hello, lovely people!' };
    const m = buildSiteModel(inputs({ captures: [other], settings: { 'site.author': 'Lea', 'site.intro': intro } }));
    expect(m.profile).toEqual({ author: 'Lea', intro });
    expect(m.timeline.profile).toEqual(m.profile);
    expect(m.timelineV).toBe(contentHash({ trips: [], days: m.timeline.days, profile: m.profile }));
    expect(m.timelineV).not.toBe(buildSiteModel(inputs({ captures: [other] })).timelineV);
    expect(SiteProfile.safeParse(m.profile).success).toBe(true);
  });

  /** The round crop the generator run makes before the model (generate.ts preparePortrait). */
  const cropPath = (size: number, ext: string) =>
    `media/${sha('P1').slice(0, 2)}/${sha('P1').slice(0, 16)}_avatar_0123abcd_s${size}.${ext}`;
  const crop: PortraitCrop = {
    sourceKey: 'wa:P1',
    image: {
      w: 288,
      h: 288,
      color: '#c1b2a3',
      thumbhash: 'BBBB',
      sources: {
        avif: [96, 192, 288].map((w) => ({ w, src: cropPath(w, 'avif') })),
        webp: [96, 192, 288].map((w) => ({ w, src: cropPath(w, 'webp') })),
      },
    },
  };

  it('the portrait is its round crop only (no photo variant, no OG image)', () => {
    const m = buildSiteModel(
      inputs({ captures: [portrait, other], settings: { 'site.avatar': avatarSetting }, portraitCrop: crop }),
    );
    const avatar = m.profile?.avatar;
    expect(avatar).toEqual(crop.image);
    expect(m.warnings).toEqual([]);
    // The public photo's own entry still has everything; the crop is referenced besides.
    const entry = m.days[0]?.entries[0];
    expect(entry?.kind === 'photo' && entry.image.sources.webp.map((s) => s.w)).toEqual([320, 640, 1080, 1600]);
    expect(m.media).toEqual(expect.arrayContaining([cropPath(96, 'webp'), cropPath(288, 'avif')]));
  });

  it('crops the smallest WebP variant that covers the largest crop (else the largest one)', () => {
    const pick = (c: CaptureRow) => {
      const found = portraitSourceFor({ sourceKey: c.sourceKey }, inputs({ captures: [c] }));
      if (typeof found === 'string') throw new Error(found);
      return short(found.source.relPath);
    };
    expect(pick(portrait)).toBe('w640.webp'); // w320 is 320x240: its shorter side is below 288
    const tall = {
      ...portrait,
      variants: (portrait.variants ?? []).map((v) => ({ ...v, h: Math.round((v.w ?? 0) * 1.25) })),
    };
    expect(pick(tall)).toBe('w320.webp'); // 320x400 covers 288
    const tiny = { ...portrait, variants: (portrait.variants ?? []).filter((v) => v.variant === 'w320') };
    expect(pick(tiny)).toBe('w320.webp'); // nothing covers 288: the largest
    // Older rows without per-variant heights: the photo's aspect ratio (640x480 here).
    const old = { ...portrait, variants: (portrait.variants ?? []).map(({ h: _h, ...v }) => v) };
    expect(pick(old)).toBe('w640.webp');
  });

  it('the owner’s choice wins: a hidden photo can be the portrait, but only its round crop is published', () => {
    const m = buildSiteModel(
      inputs({
        captures: [portrait, other],
        annotations: new Map([ann('wa:P1', { visibility: 'hidden', description: { de: 'Privat' } })]),
        settings: { 'site.avatar': avatarSetting },
        portraitCrop: crop,
      }),
    );
    expect(m.profile?.avatar?.sources.webp.map((s) => s.w)).toEqual([96, 192, 288]);
    const mine = m.media.filter((p) => p.includes(sha('P1').slice(0, 16))).map(short);
    expect(mine.sort()).toEqual(['s192.avif', 's192.webp', 's288.avif', 's288.webp', 's96.avif', 's96.webp']);
    expect(m.days.flatMap((d) => d.entries).map((e) => e.id)).not.toContain(portrait.publicId);
    const text = JSON.stringify(m);
    const own = `${sha('P1').slice(0, 16)}_`;
    for (const secret of [
      'Geheime Bildunterschrift',
      'Privat',
      portrait.publicId,
      'wa:P1',
      'P1"',
      `${own}w`,
      `${own}og`,
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('no portrait (one warning) for a revoked photo under on_revoke=hide, a non-photo, a capture that is not ready, missing files', () => {
    const revoked = { ...portrait, revokedAt: '2026-11-14T04:00:00Z' };
    const cases: [string, Partial<ModelInputs> & { settings?: Partial<Settings> }, RegExp][] = [
      ['revoked', { captures: [revoked, other] }, /deleted on WhatsApp/],
      [
        'video',
        { captures: [capture('P1', '2026-11-14T03:00:00Z', { kind: 'video' }), other] },
        /a video status, not a photo/,
      ],
      ['unknown', { captures: [other] }, /not a ready capture/],
      ['pending', { captures: [{ ...portrait, state: 'awaiting_media' }, other] }, /not a ready capture/],
      ['unprocessed', { captures: [{ ...portrait, variants: null }, other] }, /no image variants/],
      ['no crop', { captures: [portrait, other], portraitCrop: undefined }, /no round crop made/],
      [
        'crop of another photo',
        { captures: [portrait, other], portraitCrop: { ...crop, sourceKey: 'wa:P2' } },
        /no round crop made/,
      ],
      [
        'crop failed',
        { captures: [portrait, other], portraitCrop: { sourceKey: 'wa:P1', problem: 'round crop failed: boom' } },
        /round crop failed: boom/,
      ],
      [
        'missing',
        { captures: [portrait, other], mediaExists: (p) => !p.includes('_avatar_0123abcd_s96') },
        /missing in MEDIA_DIR/,
      ],
    ];
    for (const [label, over, why] of cases) {
      const m = buildSiteModel(
        inputs({
          portraitCrop: crop,
          ...over,
          settings: { 'site.author': 'Lea', 'site.avatar': avatarSetting },
        }),
      );
      expect(m.profile, label).toEqual({ author: 'Lea' });
      const avatarWarnings = m.warnings.filter((w) => w.startsWith('site.avatar'));
      expect(avatarWarnings, label).toHaveLength(1);
      expect(avatarWarnings[0], label).toMatch(why);
      // No portrait, no crop file; a revoked (hidden) photo publishes no file at all.
      expect(
        m.media.filter((p) => p.includes('_avatar_')),
        label,
      ).toEqual([]);
      if (label === 'revoked') {
        expect(
          m.media.filter((p) => p.includes(sha('P1').slice(0, 16))),
          label,
        ).toEqual([]);
      }
    }
    // ingest.on_revoke = keep keeps it, like the capture itself.
    const kept = buildSiteModel(
      inputs({
        captures: [revoked, other],
        settings: { 'ingest.on_revoke': 'keep', 'site.avatar': avatarSetting },
        portraitCrop: crop,
      }),
    );
    expect(kept.profile?.avatar).toBeDefined();
    // Nothing usable at all: no profile.
    expect(
      buildSiteModel(inputs({ captures: [other], settings: { 'site.avatar': avatarSetting } })).profile,
    ).toBeNull();
  });
});
