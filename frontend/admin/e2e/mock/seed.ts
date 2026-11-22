/**
 * Seed data of the mock API: a Vietnam trip in November 2026 (mirrors fixtures/generate.ts in
 * spirit, but self-contained so e2e tests never depend on `pnpm fixtures`).
 */
import { createHash } from 'node:crypto';
import type { CaptureMirror, Day, Post, Settings, Trip } from '@omw/contracts/api';
import { SETTINGS_DEFAULTS } from '@omw/contracts/api';
import { publicIdFromSha256Hex } from '@omw/contracts/ids';
import { localDateFor } from '@omw/contracts/time';

export type SeedCapture = Omit<CaptureMirror, 'contractVersion'> & {
  /** The mock serves a preview/poster only when true (CaptureListItem.previewUrl/posterUrl). */
  hasPreview: boolean;
};

export interface SeedAnnotation {
  sourceKey: string;
  description?: Partial<Record<'de' | 'en', string>> | null;
  origLocale?: 'de' | 'en' | null;
  visibility?: 'public' | 'hidden' | 'pending' | null;
  localDateOverride?: string | null;
  updatedAt: string;
}

export interface SeedData {
  captures: SeedCapture[];
  annotations: SeedAnnotation[];
  days: Day[];
  trips: Trip[];
  posts: Post[];
  settings: Settings;
}

const SAIGON = 'Asia/Ho_Chi_Minh';
const BERLIN = 'Europe/Berlin';

function capture(
  msgId: string,
  kind: SeedCapture['kind'],
  occurredAt: string,
  tz: string,
  extra: Partial<SeedCapture> = {},
): SeedCapture {
  const sourceKey = `wa:${msgId}`;
  const publicId = publicIdFromSha256Hex(createHash('sha256').update(sourceKey).digest('hex'));
  const visual = kind === 'photo' || kind === 'video' || kind === 'gif';
  return {
    sourceKey,
    publicId,
    kind,
    occurredAt,
    tz,
    localDate: localDateFor(occurredAt, tz),
    caption: null,
    text: null,
    media: null,
    mediaState: visual || kind === 'voice' ? 'ok' : 'none',
    revokedAt: null,
    hasPreview: visual,
    ...extra,
  };
}

const photo = (w: number, h: number, color: string) => ({ w, h, color });

export function seedData(): SeedData {
  const captures: SeedCapture[] = [
    capture('3EB0D4DF9C5342C8CF0B', 'text', '2026-11-11T23:30:00.000Z', BERLIN, {
      text: {
        body: 'Koffer gepackt! Morgen geht’s los ✈️',
        bg: '#be4a74ff',
        fg: '#ffffffff',
        font: 'CALISTOGA_REGULAR',
      },
    }),
    capture('3EB014A3498BB36BA7F5', 'photo', '2026-11-12T08:15:00.000Z', BERLIN, {
      caption: 'Tschüss Berlin',
      media: photo(1600, 1200, '#8ea6c9'),
    }),
    capture('3EB0CCAE0F9B4D04143F', 'photo', '2026-11-14T01:40:00.000Z', SAIGON, {
      caption: 'Angekommen in Hà Nội',
      media: photo(1080, 1350, '#e9a46b'),
    }),
    capture('3EB04F6CD4B59C4BBA47', 'video', '2026-11-14T05:20:00.000Z', SAIGON, {
      caption: 'Mopeds überall',
      media: { w: 720, h: 1280, duration: 4, color: '#5c7d8a' },
    }),
    capture('3EB04C34FA66C18E4EE1', 'text', '2026-11-14T12:00:00.000Z', SAIGON, {
      text: { body: 'Xin chào Việt Nam! Phở ngon quá 🍜', bg: '#5d3fa0ff', fg: '#fff8f6ff', font: 'FB_SCRIPT' },
    }),
    capture('3EB0B028C9D92EFF4C5B', 'photo', '2026-11-15T02:12:00.000Z', SAIGON, {
      caption: 'Hội An',
      media: photo(1600, 1200, '#f2b36b'),
    }),
    capture('3EB0B53E4ADF9987E545', 'gif', '2026-11-15T04:30:00.000Z', SAIGON, {
      media: { w: 480, h: 480, duration: 2, color: '#d98aa6' },
    }),
    capture('3EB07AB0A895AA6DAE0C', 'voice', '2026-11-15T09:45:00.000Z', SAIGON, {
      media: { duration: 3 },
      hasPreview: false,
    }),
    capture('3EB029F28898501FA172', 'photo', '2026-11-15T11:05:00.000Z', SAIGON, {
      caption: 'Laternen (verwackelt)',
      media: photo(1080, 1350, '#c46a3c'),
      revokedAt: '2026-11-15T11:20:00.000Z',
    }),
    capture('3EB02EB54680C905FFAD', 'text', '2026-11-15T16:30:00.000Z', SAIGON, {
      text: { body: 'مرحبا من هوي آن 🏮', bg: '#1f7a4dff', fg: '#ffffffff', font: 'SYSTEM_BOLD' },
    }),
    capture('3EB0A0A7F6C40B6C176C', 'photo', '2026-11-15T18:30:00.000Z', SAIGON, {
      caption: 'Noch wach',
      media: photo(1350, 1080, '#3b3a66'),
    }),
    capture('3EB01C3C6177CF4AE3C4', 'video', '2026-11-16T03:00:00.000Z', SAIGON, {
      caption: 'Bootsfahrt',
      media: { w: 720, h: 1280, duration: 3, color: '#4e9a9a' },
    }),
    capture('3EB0A5BBCEF6DE6DB217', 'unsupported', '2026-11-16T06:00:00.000Z', SAIGON),
    capture('3EB051DDE7F36B6CBE94', 'text', '2026-11-16T15:00:00.000Z', SAIGON, {
      text: { body: 'Good night, Hội An ✨', bg: '#1b1322ff', fg: '#f4a3bcff', font: 'COURIERPRIME_BOLD' },
    }),
    capture('3EB0A95100B25384B95E', 'photo', '2026-11-17T00:50:00.000Z', SAIGON, {
      caption: 'Sài Gòn',
      media: photo(1600, 1200, '#e07a5f'),
    }),
    capture('3EB075FC4D0EBB28EBF5', 'photo', '2026-11-17T03:10:00.000Z', SAIGON, {
      caption: 'Chợ Bến Thành',
      media: photo(1080, 1350, '#d4a24c'),
    }),
    capture('3EB039918D3FBEC62243', 'video', '2026-11-17T05:00:00.000Z', SAIGON, {
      media: { w: 720, h: 1280, duration: 5 },
      mediaState: 'lost',
      hasPreview: false,
    }),
    capture('3EB002FB95C8D4FA723E', 'text', '2026-11-17T14:00:00.000Z', SAIGON, {
      text: { body: 'Bus nach Cần Thơ um 7 Uhr. Gute Nacht!', bg: '#ffffffff', fg: '#3b2341ff', font: 'SYSTEM' },
    }),
    capture('3EB0F1A2B3C4D5E6F701', 'photo', '2026-11-19T01:30:00.000Z', SAIGON, {
      caption: 'Mekong-Delta 🌴',
      media: photo(1600, 1200, '#6a9f58'),
    }),
    capture('3EB0F1A2B3C4D5E6F702', 'text', '2026-11-19T02:00:00.000Z', SAIGON, {
      text: {
        body: 'Schwimmender Markt um 6 Uhr morgens 🛶',
        bg: '#f4a3bcff',
        fg: '#3b2341ff',
        font: 'MORNINGBREEZE_REGULAR',
      },
    }),
    capture('3EB0F1A2B3C4D5E6F703', 'photo', '2026-11-19T04:00:00.000Z', SAIGON, {
      caption: 'Kokosbonbons, frisch gemacht',
      media: photo(1080, 1350, '#b98b5e'),
      mediaState: 'pending',
      hasPreview: false,
    }),
  ];

  const annotations: SeedAnnotation[] = [
    {
      sourceKey: 'wa:3EB0B028C9D92EFF4C5B',
      description: {
        de: 'Morgens um neun ist die Altstadt noch ganz still – nur die Laternen schaukeln.',
        en: 'At nine in the morning the old town is still quiet – only the lanterns sway.',
      },
      origLocale: 'de',
      updatedAt: '2026-11-15T10:00:00.000Z',
    },
    {
      sourceKey: 'wa:3EB0A5BBCEF6DE6DB217',
      visibility: 'hidden',
      updatedAt: '2026-11-16T08:00:00.000Z',
    },
  ];

  const days: Day[] = [
    {
      localDate: '2026-11-14',
      title: { de: 'Ankunft in Hà Nội', en: 'Arriving in Hà Nội' },
      origLocale: 'de',
      placeName: 'Hà Nội',
      countryCode: 'VN',
      lat: 21.0285,
      lng: 105.8542,
      coverSourceKey: 'wa:3EB0CCAE0F9B4D04143F',
      updatedAt: '2026-11-14T14:00:00.000Z',
    },
    {
      localDate: '2026-11-15',
      title: { de: 'Laternen in Hội An', en: 'Lanterns in Hội An' },
      summary: { de: 'Altstadt, Schneiderei und abends tausend Laternen am Fluss.' },
      origLocale: 'de',
      placeName: 'Hội An',
      countryCode: 'VN',
      updatedAt: '2026-11-15T20:00:00.000Z',
    },
    {
      localDate: '2026-11-16',
      title: { de: 'Auf dem Thu Bồn' },
      origLocale: 'de',
      updatedAt: '2026-11-16T20:00:00.000Z',
    },
  ];

  const trips: Trip[] = [
    {
      slug: 'vietnam-2026',
      title: { de: 'Vietnam 2026', en: 'Vietnam 2026' },
      description: { de: 'Von Hà Nội über Hội An nach Sài Gòn.', en: 'From Hà Nội via Hội An to Sài Gòn.' },
      origLocale: 'de',
      startDate: '2026-11-14',
      endDate: '2026-11-28',
      coverSourceKey: 'wa:3EB0B028C9D92EFF4C5B',
      updatedAt: '2026-11-14T00:00:00.000Z',
    },
    {
      slug: 'berlin-abschied',
      title: { de: 'Abschied aus Berlin' },
      origLocale: 'de',
      startDate: '2026-11-11',
      endDate: '2026-11-12',
      coverSourceKey: 'wa:3EB014A3498BB36BA7F5',
      updatedAt: '2026-11-12T00:00:00.000Z',
    },
  ];

  const posts: Post[] = [
    {
      publicId: 'p_01JX5HOIAN0NOTE00000000001',
      kind: 'note',
      occurredAt: '2026-11-15T13:00:00.000Z',
      tz: SAIGON,
      localDate: '2026-11-15',
      origLocale: 'de',
      visibility: 'public',
      updatedAt: '2026-11-15T13:00:00.000Z',
      content: {
        de: { body: 'In der Schneiderei Maß genommen – Kleid ist morgen fertig! 🧵' },
        en: { body: 'Got measured at the tailor – the dress is ready tomorrow! 🧵' },
      },
    },
    {
      publicId: 'p_01JX5HOIAN0STORY0000000001',
      kind: 'story',
      occurredAt: '2026-11-16T12:00:00.000Z',
      tz: SAIGON,
      localDate: '2026-11-16',
      origLocale: 'de',
      visibility: 'public',
      updatedAt: '2026-11-16T12:30:00.000Z',
      content: {
        de: {
          title: 'Ein Morgen auf dem Fluss',
          body: 'Um fünf Uhr klingelte der Wecker.\n\n**Bác Tư** wartete schon mit dem Boot. Wir sind *ganz langsam* flussabwärts getrieben.\n\n- Nebel über dem Wasser\n- Fischer mit Netzen\n- Kaffee mit Kondensmilch',
        },
      },
    },
  ];

  const settings: Settings = { ...SETTINGS_DEFAULTS, 'timezone.current': SAIGON, 'alerts.email': 'lena@example.org' };
  return { captures, annotations, days, trips, posts, settings };
}

// ---------------------------------------------------------------------------------------------
// People and access (wave 5): times relative to "now", so "seen today" stays true.

export interface SeedDevice {
  id: string;
  state: 'pending' | 'active' | 'revoked' | 'declined';
  first: boolean;
  label: string;
  createdMinutesAgo: number;
  lastSeenMinutesAgo: number | null;
  revokedBy?: 'owner' | 'follower' | 'system';
}

export interface SeedFollower {
  id: string;
  state: 'active' | 'revoked' | 'deleted';
  name: string | null;
  note: string | null;
  createdDaysAgo: number;
  devices: SeedDevice[];
  deletedBy?: 'follower' | 'owner' | 'restore';
}

export interface SeedAccess {
  followers: SeedFollower[];
  /** Notice v1 published (and consented by the active people) and the store set up. */
  noticePublished: boolean;
  storeReady: boolean;
}

export function seedAccess(): SeedAccess {
  return {
    noticePublished: true,
    storeReady: true,
    followers: [
      {
        id: 'omaomaomaoma',
        state: 'active',
        name: 'Oma',
        note: 'Mamas Mama, liest abends auf dem iPad',
        createdDaysAgo: 9,
        devices: [
          {
            id: 'ipadoma2',
            state: 'active',
            first: true,
            label: 'iPad · Safari',
            createdMinutesAgo: 9 * 1440,
            lastSeenMinutesAgo: 95,
          },
          {
            id: 'phoneoma',
            state: 'active',
            first: false,
            label: 'iPhone · WhatsApp',
            createdMinutesAgo: 6 * 1440,
            lastSeenMinutesAgo: 2 * 1440,
          },
        ],
      },
      {
        id: 'paulpaulpaul',
        state: 'active',
        name: 'Paul',
        note: null,
        createdDaysAgo: 5,
        devices: [
          {
            id: 'paulpix7',
            state: 'active',
            first: true,
            label: 'Android · Chrome',
            createdMinutesAgo: 5 * 1440,
            lastSeenMinutesAgo: 30,
          },
        ],
      },
      {
        id: 'uteuteuteute',
        state: 'revoked',
        name: 'Tante Ute',
        note: null,
        createdDaysAgo: 8,
        devices: [
          {
            id: 'utemac22',
            state: 'revoked',
            first: true,
            label: 'Mac · Safari',
            createdMinutesAgo: 8 * 1440,
            lastSeenMinutesAgo: 3 * 1440,
            revokedBy: 'owner',
          },
        ],
      },
      {
        id: 'gonegonegone',
        state: 'deleted',
        name: null,
        note: null,
        createdDaysAgo: 2,
        devices: [],
        deletedBy: 'follower',
      },
    ],
  };
}
