/** Valid sample documents, reused across schema tests. */
import type {
  Annotation,
  CaptureMirror,
  ChangesResponse,
  Day,
  Heartbeat,
  Post,
  PublishedReport,
  Trip,
} from '../src/api.js';
import type { DayDetail, ImageSet, Manifest, TimelineIndex, TripDetail } from '../src/site.js';
import type { InboxMeta } from '../src/wa.js';

export const imageSet = (): ImageSet => ({
  w: 1080,
  h: 1350,
  color: '#c88a6a',
  thumbhash: 'HBkSHYSIeHiPiHh8eJd4eTN0EEQG',
  sources: {
    avif: [
      { w: 320, src: 'media/ab/ab12cd34ef56ab78_w320.avif' },
      { w: 640, src: 'media/ab/ab12cd34ef56ab78_w640.avif' },
    ],
    webp: [
      { w: 320, src: 'media/ab/ab12cd34ef56ab78_w320.webp' },
      { w: 640, src: 'media/ab/ab12cd34ef56ab78_w640.webp' },
    ],
  },
  og: 'media/ab/ab12cd34ef56ab78_og.jpg',
});

export const inboxPhoto = (): InboxMeta => ({
  schema: 1,
  msgId: '3EB0C767D26A1D8B7A3B',
  source: 'live',
  receivedAt: '2026-11-15T02:12:03Z',
  sender: { pn: '4915100000001', lid: '100000000000001', jid: '100000000000001@lid', pushName: 'Traveler' },
  timestamp: '2026-11-15T02:12:00Z',
  kind: 'photo',
  caption: 'Hội An',
  media: {
    mimetype: 'image/jpeg',
    fileSha256B64: 'n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=',
    fileLength: 123456,
    width: 1080,
    height: 1350,
  },
  download: {
    state: 'ok',
    file: 'original.jpg',
    sha256Hex: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    attempts: 1,
  },
  rawProtoB64: 'CgVoZWxsbw==',
  addressingMode: 'lid',
  stanzaTag: 'status',
});

export const dayDetail = (): DayDetail => ({
  contractVersion: 1,
  date: '2026-11-15',
  v: 'a1b2c3d4e5f6',
  title: { de: 'Laternen in Hội An', en: 'Lanterns in Hội An' },
  orig: 'de',
  place: 'Hội An',
  country: 'VN',
  lat: 15.8801,
  lng: 108.338,
  tz: 'Asia/Ho_Chi_Minh',
  trip: 'vietnam-2026',
  prev: '2026-11-14',
  next: '2026-11-16',
  entries: [
    {
      id: 'e_abcdefgh2345',
      kind: 'photo',
      at: '2026-11-15T02:12:00Z',
      tz: 'Asia/Ho_Chi_Minh',
      caption: 'Hội An',
      description: { de: 'Altstadt' },
      descriptionOrig: 'de',
      image: imageSet(),
    },
    {
      id: 'e_bbcdefgh2345',
      kind: 'video',
      at: '2026-11-15T03:00:00Z',
      tz: 'Asia/Ho_Chi_Minh',
      video: {
        src: 'media/cd/cd12cd34ef56ab78_video.mp4',
        w: 720,
        h: 1280,
        duration: 4,
        hasAudio: true,
        poster: imageSet(),
      },
    },
    {
      id: 'e_cbcdefgh2345',
      kind: 'gif',
      at: '2026-11-15T03:10:00Z',
      tz: 'Asia/Ho_Chi_Minh',
      loop: true,
      video: {
        src: 'media/ef/ef12cd34ef56ab78_video.mp4',
        w: 480,
        h: 480,
        duration: 2,
        hasAudio: false,
        poster: imageSet(),
      },
    },
    {
      id: 'e_dbcdefgh2345',
      kind: 'voice',
      at: '2026-11-15T04:00:00Z',
      tz: 'Asia/Ho_Chi_Minh',
      audio: { src: 'media/12/1212cd34ef56ab78_voice.m4a', duration: 3.2, peaks: [0, 0.5, 1] },
    },
    {
      id: 'e_ebcdefgh2345',
      kind: 'text',
      at: '2026-11-15T05:00:00Z',
      tz: 'Asia/Ho_Chi_Minh',
      text: { body: 'Xin chào!', bg: '#c1a03fff', fg: '#ffffffff', font: 'CALISTOGA_REGULAR' },
    },
    {
      id: 'p_note0001',
      kind: 'note',
      at: '2026-11-15T06:00:00Z',
      tz: 'Asia/Ho_Chi_Minh',
      note: { de: 'Heute Regen.', en: 'Rain today.' },
      orig: 'de',
    },
    {
      id: 'p_story001',
      kind: 'story',
      at: '2026-11-15T12:00:00Z',
      tz: 'Asia/Ho_Chi_Minh',
      story: { de: { title: 'Laternen', body: '# Laternen\n\nText' }, en: { title: 'Lanterns', body: 'Text' } },
      orig: 'de',
    },
  ],
});

export const timeline = (): TimelineIndex => ({
  contractVersion: 1,
  generatedAt: '2026-11-19T10:00:00.000Z',
  trips: [
    {
      slug: 'vietnam-2026',
      v: 'ffeeddcc',
      title: { de: 'Vietnam 2026' },
      orig: 'de',
      start: '2026-11-14',
      end: '2026-11-17',
      cover: imageSet(),
      countries: ['VN'],
      dayCount: 4,
    },
  ],
  days: [
    {
      date: '2026-11-15',
      v: 'a1b2c3d4e5f6',
      title: { de: 'Laternen' },
      orig: 'de',
      place: 'Hội An',
      country: 'VN',
      trip: 'vietnam-2026',
      tz: 'Asia/Ho_Chi_Minh',
      counts: { photo: 1, video: 1, gif: 1, voice: 1, text: 1, note: 1, story: 1 },
      cover: imageSet(),
      firstAt: '2026-11-15T02:12:00Z',
      lastAt: '2026-11-15T12:00:00Z',
    },
  ],
});

export const tripDetail = (): TripDetail => ({
  contractVersion: 1,
  slug: 'vietnam-2026',
  v: 'ffeeddcc',
  title: { de: 'Vietnam 2026', en: 'Vietnam 2026' },
  description: { de: 'Von Hanoi nach Saigon.' },
  orig: 'de',
  start: '2026-11-14',
  end: '2026-11-17',
  days: ['2026-11-14', '2026-11-15'],
});

export const manifest = (): Manifest => ({
  contractVersion: 1,
  version: 42,
  generatedAt: '2026-11-19T10:00:00.000Z',
  site: { title: 'On My Way', locales: ['de', 'en'], defaultLocale: 'de', basePath: '/travel/', indexable: false },
  timeline: { v: 'abcdef12' },
});

export const captureMirror = (): CaptureMirror => ({
  contractVersion: 1,
  sourceKey: 'wa:3EB0C767D26A1D8B7A3B',
  publicId: 'e_abcdefgh2345',
  kind: 'photo',
  occurredAt: '2026-11-15T02:12:00Z',
  tz: 'Asia/Ho_Chi_Minh',
  localDate: '2026-11-15',
  caption: 'Hội An',
  media: { w: 1080, h: 1350, color: '#c88a6a', thumbhash: 'HBkSHYSIeHiPiHh8eJd4eTN0EEQG' },
  mediaState: 'ok',
  revokedAt: null,
});

export const heartbeat = (): Heartbeat => ({
  contractVersion: 1,
  at: '2026-11-19T10:00:00Z',
  backendVersion: '0.1.0',
  wa: {
    state: 'open',
    jid: '4915100000002:12@s.whatsapp.net',
    lastStatusAt: '2026-11-19T09:00:00Z',
    traveler: { pn: '4915100000001', lidKnown: true },
  },
  queue: { pending: 2, failed: 0, oldestAt: '2026-11-19T09:59:00Z' },
  sync: { feedId: '0123456789abcdef0123456789abcdef', feedSeq: 17, lastPullAt: '2026-11-19T09:59:45Z', quarantined: 0 },
  captures: { awaitingMedia: 1, failed: 0, mediaLost: 0 },
  stats: { statuses: 12, ignoredSenders: 3 },
  disk: { freeBytes: 25_000_000_000 },
  publish: { lastVersion: 41, lastAt: '2026-11-19T09:58:00Z' },
});

export const publishedReport = (): PublishedReport => ({
  contractVersion: 1,
  version: 42,
  at: '2026-11-19T10:00:00Z',
  target: 'sftp-main',
  ok: true,
  uploaded: 12,
  deleted: 1,
  feedSeq: 17,
  capturesThrough: '2026-11-19T09:58:00Z',
});

export const post = (): Post => ({
  publicId: 'p_note0001',
  kind: 'note',
  occurredAt: '2026-11-15T06:00:00Z',
  tz: 'Asia/Ho_Chi_Minh',
  localDate: '2026-11-15',
  content: { de: { body: 'Heute Regen.' }, en: { body: 'Rain today.' } },
  origLocale: 'de',
  visibility: 'public',
  updatedAt: '2026-11-15T06:00:00Z',
});

export const annotation = (): Annotation => ({
  sourceKey: 'wa:3EB0C767D26A1D8B7A3B',
  description: { de: 'Altstadt' },
  origLocale: 'de',
  visibility: null,
  localDateOverride: null,
  updatedAt: '2026-11-15T07:00:00Z',
});

export const day = (): Day => ({
  localDate: '2026-11-15',
  title: { de: 'Laternen' },
  origLocale: 'de',
  placeName: 'Hội An',
  countryCode: 'VN',
  lat: 15.88,
  lng: 108.33,
  coverSourceKey: 'wa:3EB0C767D26A1D8B7A3B',
  tz: 'Asia/Ho_Chi_Minh',
  updatedAt: '2026-11-15T08:00:00Z',
});

export const trip = (): Trip => ({
  slug: 'vietnam-2026',
  title: { de: 'Vietnam 2026', en: 'Vietnam 2026' },
  origLocale: 'de',
  startDate: '2026-11-14',
  endDate: '2026-11-17',
  coverSourceKey: null,
  updatedAt: '2026-11-14T08:00:00Z',
});

export const FEED_ID = '0123456789abcdef0123456789abcdef';

export const changes = (): ChangesResponse => ({
  feedId: FEED_ID,
  items: [
    { seq: 1, entity: 'post', key: 'p_note0001', op: 'upsert', data: post() },
    { seq: 2, entity: 'annotation', key: 'wa:3EB0C767D26A1D8B7A3B', op: 'upsert', data: annotation() },
    { seq: 3, entity: 'day', key: '2026-11-15', op: 'upsert', data: day() },
    { seq: 4, entity: 'trip', key: 'vietnam-2026', op: 'upsert', data: trip() },
    { seq: 5, entity: 'setting', key: 'publish.mode', op: 'upsert', data: { value: 'delayed' } },
    { seq: 6, entity: 'post', key: 'p_gone0001', op: 'delete' },
  ],
  nextSeq: 6,
  hasMore: false,
});
