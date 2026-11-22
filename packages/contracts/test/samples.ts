/** Valid sample documents, reused across schema tests. */
import type {
  AccessStatus,
  AccessSummary,
  AdminDevice,
  AdminFollower,
  GateCheckResult,
  NoticeTexts,
  PrivacyNotice,
  PublicNotice,
  SiteHeartbeat,
} from '../src/access.js';
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

// ---------------------------------------------------------------------------------------------
// Access (wave 5, src/access.ts)

/** Sample ids and tokens (the same ones fixtures/vectors/access-paths.json uses). */
export const ACCESS_IDS = {
  fid: 'abcdefgh2345',
  did: 'qrst2345',
  sid: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0-_z',
  t: 'tTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtT-_0',
  k: 'kKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkK_-9',
} as const;
export const GATE_SESSION_SAMPLE = `${ACCESS_IDS.fid}.${ACCESS_IDS.did}.${ACCESS_IDS.sid}`;
const SHA = 'ab'.repeat(32);
const EPOCH = '0123456789abcdef';
const STORE_ID = 'fedcba9876543210';

export const siteHeartbeat = (): SiteHeartbeat => ({
  origin: 'https://site.example',
  access: 'gate',
  cookieMode: 'headers',
  storeDir: '/usr/home/omw/omw-store/site1',
});

export const gateCheck = (): GateCheckResult => ({
  at: '2026-11-20T10:05:00.000Z',
  by: 'mac',
  result: 'ok',
  detail: null,
});

export const noticeTexts = (locale: 'de' | 'en'): NoticeTexts =>
  locale === 'de'
    ? {
        title: 'Datenschutzhinweise',
        intro: 'Diese Seite zeigt Reiseerlebnisse nur eingeladenen Menschen.',
        collected: 'Dein Name, deine Geräte und wann du bestätigt hast.\n\nNur nötige Cookies.',
        audience: 'Die einladende Person sieht deinen Namen und deine Geräte.',
        purpose: 'Nur damit die Seite eingeladenen Menschen gezeigt wird.',
        retention: 'Bis du oder die einladende Person die Daten löscht.',
        rights: 'Auskunft, Export, Berichtigung und Löschung jederzeit.',
      }
    : {
        title: 'Privacy information',
        intro: 'This page shows travel moments only to invited people.',
        collected: 'Your name, your devices and when you confirmed.\n\nOnly necessary cookies.',
        audience: 'The person who invited you sees your name and your devices.',
        purpose: 'Only to show the page to invited people.',
        retention: 'Until you or the person who invited you deletes it.',
        rights: 'Access, export, correction and deletion at any time.',
      };

export const privacyNotice = (): PrivacyNotice => ({
  controller: { name: 'Lea Beispiel', email: 'lea@example.org', address: 'Beispielweg 1, 12345 Musterstadt' },
  texts: { de: noticeTexts('de'), en: noticeTexts('en') },
});

export const publicNotice = (): PublicNotice => ({
  ...privacyNotice(),
  version: 2,
  publishedAt: '2026-11-19T08:00:00.000Z',
});

export const adminDevice = (): AdminDevice => ({
  id: ACCESS_IDS.did,
  state: 'active',
  label: 'iPhone · Safari',
  first: true,
  createdAt: '2026-11-19T09:00:00.000Z',
  decidedAt: null,
  revokedAt: null,
  revokedBy: null,
  lastSeenAt: '2026-11-20T09:00:00.000Z',
  sessionAt: '2026-11-19T09:00:01.000Z',
});

export const adminFollower = (): AdminFollower => ({
  id: ACCESS_IDS.fid,
  name: 'Oma',
  note: 'Mamas Mutter',
  state: 'active',
  createdAt: '2026-11-18T09:00:00.000Z',
  revokedAt: null,
  link: { createdAt: '2026-11-18T09:00:00.000Z' },
  devices: [
    adminDevice(),
    {
      ...adminDevice(),
      id: 'wxyz2345',
      state: 'pending',
      label: 'Android · Chrome',
      first: false,
      lastSeenAt: null,
      sessionAt: null,
    },
  ],
  consent: { version: 2, confirmedAt: '2026-11-19T09:00:00.000Z' },
  lastSeenAt: '2026-11-20T09:00:00.000Z',
});

export const accessSummary = (): AccessSummary => ({
  locked: false,
  lockedAt: null,
  lockedBy: null,
  pendingDevices: 1,
  pendingOps: 0,
  oldestPendingOpAt: null,
  writer: { mode: 'direct', blocked: false, error: null },
  restoring: false,
  mismatch: false,
  unreadNotices: 0,
  noticeVersion: 2,
});

export const accessStatus = (): AccessStatus => ({
  ...accessSummary(),
  panicLink: false,
  siteOrigin: 'https://site.example',
  cookieMode: 'headers',
  lastReconcile: {
    at: '2026-11-20T03:00:00.000Z',
    mode: 'normal',
    deleted: 0,
    missing: [],
    orphans: [{ fid: 'zzzzzzzzzzzz', did: 'zzzzzzzz' }],
    imported: [],
  },
  lastAppliedAt: '2026-11-20T09:59:00.000Z',
  storeId: STORE_ID,
  storeProofAt: '2026-11-20T06:00:00.000Z',
  gateCheck: gateCheck(),
  pending: [
    {
      did: 'wxyz2345',
      fid: ACCESS_IDS.fid,
      name: 'Oma',
      label: 'Android · Chrome',
      createdAt: '2026-11-20T09:30:00.000Z',
    },
  ],
});

/**
 * At least one valid body per access schema of API_SCHEMAS, covering every variant of a union.
 * Each sample uses only known keys, so parsing returns it unchanged.
 */
export const accessSamples = (): Record<string, unknown[]> => {
  const { fid, did, sid, t, k } = ACCESS_IDS;
  const dataDevice = {
    id: did,
    label: 'iPhone · Safari',
    state: 'active',
    createdAt: '2026-11-19T09:00:00.000Z',
    lastSeenAt: '2026-11-20T09:00:00.000Z',
  };
  const consent = { version: 2, confirmedAt: '2026-11-19T09:00:00.000Z', locale: 'de' };
  const categories = [
    { key: 'devices', count: 2 },
    { key: 'consents', count: 1 },
  ];
  const link = { url: `https://site.example/_/join/#t=${t}`, createdAt: '2026-11-18T09:00:00.000Z' };
  const effect = { applied: true, via: 'direct', pendingOps: 0 };
  const op = { id: 7, op: 'put', path: `s/${fid}/${did}.${sid}`, content: null, exclusive: true };
  const unavailable = { status: 'unavailable', reason: 'locked' };
  return {
    JoinCheckRequest: [{ t }, { t, k }],
    JoinCheckResponse: [
      { status: 'invalid' },
      unavailable,
      { status: 'unavailable', reason: 'notice_missing' },
      { status: 'known_device', noticeRequired: false },
      { status: 'pending_device' },
      { status: 'ok', follower: { name: 'Oma' }, notice: publicNotice(), deviceMustWait: true },
    ],
    JoinRequest: [
      { t, consentVersion: 2, locale: 'de' },
      { t, k, consentVersion: 2, locale: 'en' },
      { resume: true, k, locale: 'de' },
    ],
    JoinResponse: [
      { status: 'invalid' },
      { status: 'ended' },
      { status: 'unavailable', reason: 'too_many_pending' },
      { status: 'active', handoff: '/_/h/', session: GATE_SESSION_SAMPLE, deviceKey: k },
      { status: 'active', handoff: '/_/h/', session: GATE_SESSION_SAMPLE },
      { status: 'active', handoff: '/' },
      { status: 'activating', pollAfterMs: 3000, deviceKey: k },
      { status: 'pending', pollAfterMs: 5000, deviceKey: k },
      { status: 'consent_outdated', notice: publicNotice() },
    ],
    DeviceKeyRequest: [{ k }],
    DevicePollResponse: [
      { status: 'ended' },
      { status: 'unavailable', reason: 'restoring' },
      { status: 'active', handoff: '/_/h/', session: GATE_SESSION_SAMPLE },
      { status: 'active', handoff: '/' },
      { status: 'activating', pollAfterMs: 3000 },
      { status: 'pending', pollAfterMs: 5000 },
    ],
    MeHelloResponse: [
      { status: 'ended' },
      unavailable,
      {
        status: 'active',
        follower: { name: 'Oma' },
        device: { id: did, label: 'iPhone · Safari' },
        notice: { version: 2, required: false },
      },
      { status: 'active', follower: { name: 'Oma' }, device: { id: did, label: '' }, notice: null },
      { status: 'pending', notice: { version: 2, required: false } },
      { status: 'pending', notice: null },
    ],
    MeNoticeResponse: [
      { status: 'ended' },
      { status: 'unavailable', reason: 'notice_missing' },
      { status: 'ok', notice: publicNotice(), confirmedVersion: 1 },
      { status: 'ok', notice: publicNotice(), confirmedVersion: null },
    ],
    MeConsentRequest: [{ k, version: 2, locale: 'de' }],
    MeDeleteRequest: [{ k, confirm: 'delete-all-my-data' }],
    MeSimpleResponse: [{ status: 'signed_out' }, { status: 'deleted' }, { status: 'ended' }],
    MeDataResponse: [
      { status: 'ended' },
      {
        status: 'ok',
        data: {
          follower: { id: fid, name: 'Oma', since: '2026-11-18T09:00:00.000Z', state: 'active' },
          devices: [{ ...dataDevice, thisDevice: true }],
          consents: [consent],
          categories,
          noticeVersion: 2,
        },
      },
      {
        status: 'limited',
        device: { label: 'Android · Chrome', state: 'pending', createdAt: '2026-11-20T09:30:00.000Z' },
      },
    ],
    FollowerDataExport: [
      {
        format: 'omw-follower-data/1',
        exportedAt: '2026-11-20T10:00:00.000Z',
        follower: {
          id: fid,
          name: 'Oma',
          since: '2026-11-18T09:00:00.000Z',
          state: 'revoked',
          linkCreatedAt: null,
          revokedAt: '2026-11-20T08:00:00.000Z',
        },
        devices: [
          {
            ...dataDevice,
            state: 'revoked',
            decidedAt: null,
            revokedAt: '2026-11-20T08:00:00.000Z',
            revokedBy: 'owner',
          },
        ],
        consents: [{ ...consent, notice: privacyNotice() }],
        categories,
      },
    ],
    PanicRequest: [{ key: k }],
    PanicResponse: [{ ok: true }],
    FollowerListResponse: [
      {
        items: [adminFollower()],
        tombstones: [
          { id: 'zzzzzzzzzzzz', state: 'deleted', deletedAt: '2026-11-19T12:00:00.000Z', deletedBy: 'follower' },
        ],
      },
      { items: [], tombstones: [] },
    ],
    AdminFollower: [
      adminFollower(),
      {
        ...adminFollower(),
        note: null,
        state: 'revoked',
        revokedAt: '2026-11-20T08:00:00.000Z',
        link: null,
        devices: [],
        consent: null,
        lastSeenAt: null,
      },
    ],
    FollowerCreate: [{ name: 'Oma' }, { name: 'Oma', note: 'Mamas Mutter' }],
    FollowerPatch: [{}, { name: 'Omi' }, { note: null }, { note: '' }],
    FollowerCreated: [{ follower: adminFollower(), link }],
    PersonalLinkCreated: [{ link }],
    FollowerDeleteRequest: [{ confirm: true }],
    AccessActionResult: [
      { effect },
      { effect: { applied: false, via: 'pending', pendingOps: 3 }, follower: adminFollower(), status: accessSummary() },
      { effect: { applied: true, via: 'mac', pendingOps: 0 }, device: adminDevice() },
    ],
    AccessStatus: [
      accessStatus(),
      { ...accessStatus(), lastReconcile: null, gateCheck: null, storeId: null, pending: [] },
    ],
    LockRequest: [{ locked: true }, { locked: false, password: 'correct horse battery staple' }],
    PanicLinkCreated: [{ url: `https://site.example/_/panic/#k=${k}` }],
    PrivacyNoticeDraft: [
      { controller: { name: '', email: '' }, texts: {} },
      { controller: { name: 'Lea', email: 'lea@', address: '' }, texts: { de: { title: '', intro: 'x' }, en: {} } },
      privacyNotice(),
    ],
    PrivacyNotice: [privacyNotice(), { ...privacyNotice(), controller: { name: 'Lea', email: 'lea@example.org' } }],
    PrivacyState: [
      {
        draft: privacyNotice(),
        draftSha256: SHA,
        current: publicNotice(),
        versions: [
          { version: 1, publishedAt: '2026-11-18T08:00:00.000Z', sha256: 'cd'.repeat(32) },
          { version: 2, publishedAt: '2026-11-19T08:00:00.000Z', sha256: SHA },
        ],
        problems: [],
      },
      {
        draft: { controller: { name: '', email: '' }, texts: {} },
        draftSha256: SHA,
        current: null,
        versions: [],
        problems: ['controller.name', 'texts.de.title'],
      },
    ],
    PrivacyPublishRequest: [{ ifDraftSha256: SHA }],
    OwnerNoticeList: [
      {
        items: [
          { id: 1, kind: 'follower_deleted', createdAt: '2026-11-19T12:00:00.000Z', readAt: null },
          {
            id: 2,
            kind: 'restore_reconciled',
            createdAt: '2026-11-20T03:00:00.000Z',
            readAt: '2026-11-20T08:00:00.000Z',
          },
        ],
      },
    ],
    NoticeReadRequest: [{ ids: [1, 2] }],
    AccessClaimRequest: [{ holder: 'mac' }],
    AccessClaim: [
      {
        lease: { until: '2026-11-20T10:01:00.000Z' },
        storeId: STORE_ID,
        epoch: EPOCH,
        ops: [
          op,
          { id: 8, op: 'put', path: `h/${did}`, content: null, exclusive: true },
          { id: 9, op: 'delete_prefix', path: `s/${fid}/${did}.`, content: null, exclusive: true },
          {
            id: 10,
            op: 'put',
            path: 'locked',
            content: '{"at":"2026-11-20T10:00:00.000Z","by":"admin"}',
            exclusive: true,
          },
        ],
        listingWanted: false,
      },
      { lease: null, storeId: null, epoch: EPOCH, ops: [], listingWanted: true },
    ],
    AccessRenewRequest: [{ epoch: EPOCH }],
    AccessLease: [{ lease: { until: '2026-11-20T10:02:00.000Z' } }, { lease: null }],
    StoreListingUpload: [
      {
        epoch: EPOCH,
        listing: {
          marker: `{"format":1,"storeId":"${STORE_ID}","epoch":"${EPOCH}","op":6,"at":"2026-11-20T09:59:00.000Z"}`,
          locked: null,
          sessions: [`s/${fid}/${did}.${sid}`],
          handoffs: [did],
          tombstones: [
            { path: 't/zzzzzzzzzzzz', content: '{"s":"deleted","at":"2026-11-19T12:00:00.000Z"}' },
            { path: `t/${fid}.wxyz2345`, content: '{"s":"revoked","at":"2026-11-19T12:00:00.000Z"}' },
          ],
          strays: ['s/tmp.1'],
        },
      },
    ],
    AccessAck: [
      { epoch: EPOCH, appliedThrough: 10 },
      { epoch: EPOCH, appliedThrough: 0, failed: { opId: 7, error: 'store_mismatch' } },
    ],
    ServiceSession: [
      { cookieName: '__Host-omw', cookieValue: GATE_SESSION_SAMPLE, expiresAt: '2026-11-21T10:00:00.000Z' },
      { cookieName: 'omw', cookieValue: GATE_SESSION_SAMPLE, expiresAt: '2026-11-21T10:00:00.000Z' },
    ],
    StoreMarker: [{ format: 1, storeId: STORE_ID, epoch: EPOCH, op: 0, at: '2026-11-20T09:00:00.000Z' }],
    StoreTombstone: [
      { s: 'revoked', at: '2026-11-20T08:00:00.000Z' },
      { s: 'deleted', at: '2026-11-19T12:00:00.000Z' },
    ],
    StoreLock: [
      { at: '2026-11-20T10:00:00.000Z', by: 'admin' },
      { at: '2026-11-20T10:00:00.000Z', by: 'panic' },
      { at: '2026-11-20T10:00:00.000Z', by: 'mac' },
    ],
  };
};
