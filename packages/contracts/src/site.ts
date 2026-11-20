/**
 * Static data files of the public site (A4). All paths are relative to the site root without
 * a leading slash (D3); the runtime basePath comes from the per-page Boot JSON.
 *
 *   data/manifest.json        Manifest (fetched with cache: 'no-store')
 *   data/timeline.json        TimelineIndex (fetched as ?v=<manifest.timeline.v>)
 *   data/days/<date>.json     DayDetail (fetched as ?v=<DaySummary.v>)
 *   data/trips/<slug>.json    TripDetail (fetched as ?v=<TripSummary.v>)
 *
 * Scope notes (v1):
 * - timeline.json is one file; the per-year split mentioned in plan A4 is out of scope for v1
 *   (adding it later means an additive Manifest field plus a contractVersion bump).
 * - The public origin (canonical, hreflang, og:url, sitemap.xml) comes from the backend env
 *   SITE_PUBLIC_URL (e.g. "https://example.org/travel/"); its path is the basePath baked into
 *   the generated HTML. OUT_DIR is shared by all publish targets, so every target must serve the
 *   site under that same URL (a target with a different path needs its own OUT_DIR).
 * - Owner text fields (title/summary/description) carry `orig`, the locale they were written in
 *   (fallback label "Original: …", see i18n.ts).
 */
import { z } from 'zod';
import {
  Base64,
  ContentHash,
  ContractVersion,
  Count,
  CountryCode,
  EntryId,
  HexColor,
  IsoUtc,
  Latitude,
  LocalDate,
  Longitude,
  PostPublicId,
  RelPath,
  RgbaColor,
  Slug,
  TimeZone,
} from './common.js';
import { I18nText, LocaleCode } from './i18n.js';
import { FontName } from './wa.js';

// ---------------------------------------------------------------------------------------------
// Media

export const ImageSource = z.object({ w: z.int().positive(), src: RelPath });
export type ImageSource = z.infer<typeof ImageSource>;

export const ImageSet = z.object({
  w: z.int().positive(),
  h: z.int().positive(),
  /** Dominant colour. */
  color: HexColor,
  /** ThumbHash bytes, base64. */
  thumbhash: Base64,
  /** Ascending by width. */
  sources: z.object({
    avif: z.array(ImageSource).min(1),
    webp: z.array(ImageSource).min(1),
  }),
  /** 1200x630 JPEG for og:image. */
  og: RelPath.optional(),
});
export type ImageSet = z.infer<typeof ImageSet>;

export const VideoMedia = z.object({
  src: RelPath,
  w: z.int().positive(),
  h: z.int().positive(),
  /** Seconds. */
  duration: z.number().min(0),
  /** Whether the processed file has an audio stream (no "tap to unmute" without it). */
  hasAudio: z.boolean(),
  poster: ImageSet,
});
export type VideoMedia = z.infer<typeof VideoMedia>;

export const AudioMedia = z.object({
  src: RelPath,
  duration: z.number().min(0),
  /** Waveform peaks normalised to 0..1 (64 values by convention). */
  peaks: z.array(z.number().min(0).max(1)),
});
export type AudioMedia = z.infer<typeof AudioMedia>;

/** Rendered WhatsApp text status (shared with the API capture mirror). */
export const TextStyle = z.object({
  body: z.string(),
  bg: RgbaColor,
  fg: RgbaColor,
  font: FontName,
});
export type TextStyle = z.infer<typeof TextStyle>;

// ---------------------------------------------------------------------------------------------
// Entries

const EntryBase = z.object({
  id: EntryId,
  at: IsoUtc,
  tz: TimeZone,
  /** WhatsApp caption (verbatim, untranslated). */
  caption: z.string().optional(),
  /** Owner's description per locale. */
  description: I18nText.optional(),
  descriptionOrig: LocaleCode.optional(),
});

export const PhotoEntry = EntryBase.extend({ kind: z.literal('photo'), image: ImageSet });
export const VideoEntry = EntryBase.extend({ kind: z.literal('video'), video: VideoMedia });
export const GifEntry = EntryBase.extend({
  kind: z.literal('gif'),
  /** GIFs are muted loops: hasAudio is always false. */
  video: VideoMedia.extend({ hasAudio: z.literal(false) }),
  loop: z.literal(true),
});
export const VoiceEntry = EntryBase.extend({ kind: z.literal('voice'), audio: AudioMedia });
export const TextEntry = EntryBase.extend({ kind: z.literal('text'), text: TextStyle });
export const NoteEntry = EntryBase.extend({
  kind: z.literal('note'),
  id: PostPublicId,
  note: I18nText,
  orig: LocaleCode,
});
export const StoryContent = z.object({
  title: z.string().min(1).max(200),
  /** Markdown (rendered with raw HTML disabled). */
  body: z.string(),
});
export type StoryContent = z.infer<typeof StoryContent>;
/** The story's URL is derived, never stored: routePath(locale, {name: 'story', date, id}). */
export const StoryEntry = EntryBase.extend({
  kind: z.literal('story'),
  id: PostPublicId,
  story: z.partialRecord(LocaleCode, StoryContent),
  orig: LocaleCode,
});

export const Entry = z.discriminatedUnion('kind', [
  PhotoEntry,
  VideoEntry,
  GifEntry,
  VoiceEntry,
  TextEntry,
  NoteEntry,
  StoryEntry,
]);
export type Entry = z.infer<typeof Entry>;
export type EntryKind = Entry['kind'];
export const ENTRY_KINDS = ['photo', 'video', 'gif', 'voice', 'text', 'note', 'story'] as const;

// ---------------------------------------------------------------------------------------------
// Index and detail files

export const DayCounts = z.object({
  photo: Count,
  video: Count,
  gif: Count,
  voice: Count,
  text: Count,
  note: Count,
  story: Count,
});
export type DayCounts = z.infer<typeof DayCounts>;

export const DaySummary = z.object({
  date: LocalDate,
  /** Hash of the day file (cache buster). */
  v: ContentHash,
  title: I18nText.optional(),
  /** Locale the owner wrote the day's title/summary in. */
  orig: LocaleCode.optional(),
  place: z.string().optional(),
  country: CountryCode.optional(),
  trip: Slug.optional(),
  tz: TimeZone,
  counts: DayCounts,
  cover: ImageSet.optional(),
  firstAt: IsoUtc,
  lastAt: IsoUtc,
});
export type DaySummary = z.infer<typeof DaySummary>;

export const TripSummary = z.object({
  slug: Slug,
  v: ContentHash,
  title: I18nText,
  /** Locale the owner wrote the trip's title/description in. */
  orig: LocaleCode.optional(),
  start: LocalDate,
  end: LocalDate,
  cover: ImageSet.optional(),
  countries: z.array(CountryCode),
  dayCount: Count,
});
export type TripSummary = z.infer<typeof TripSummary>;

export const TimelineIndex = z.object({
  contractVersion: ContractVersion,
  generatedAt: IsoUtc,
  trips: z.array(TripSummary),
  /** Ascending by date. */
  days: z.array(DaySummary),
});
export type TimelineIndex = z.infer<typeof TimelineIndex>;

export const DayDetail = z.object({
  contractVersion: ContractVersion,
  date: LocalDate,
  v: ContentHash,
  title: I18nText.optional(),
  summary: I18nText.optional(),
  orig: LocaleCode.optional(),
  place: z.string().optional(),
  country: CountryCode.optional(),
  lat: Latitude.optional(),
  lng: Longitude.optional(),
  tz: TimeZone,
  trip: Slug.optional(),
  prev: LocalDate.optional(),
  next: LocalDate.optional(),
  /** Chronological. */
  entries: z.array(Entry),
});
export type DayDetail = z.infer<typeof DayDetail>;

export const TripDetail = z.object({
  contractVersion: ContractVersion,
  slug: Slug,
  v: ContentHash,
  title: I18nText,
  description: I18nText.optional(),
  orig: LocaleCode.optional(),
  start: LocalDate,
  end: LocalDate,
  cover: ImageSet.optional(),
  days: z.array(LocalDate),
});
export type TripDetail = z.infer<typeof TripDetail>;

/** "/" or "/travel/" — always starts and ends with a slash. */
export const BasePath = z.string().regex(/^\/(?:[A-Za-z0-9._~-]+\/)*$/, {
  message: 'Expected "/" or "/segment/…/"',
});

export const SiteInfo = z.object({
  title: z.string().min(1).max(120),
  locales: z.array(LocaleCode).min(1),
  defaultLocale: LocaleCode,
  basePath: BasePath,
  indexable: z.boolean(),
});
export type SiteInfo = z.infer<typeof SiteInfo>;

export const Manifest = z.object({
  contractVersion: ContractVersion,
  /** Monotonic site version (increments with every generated release). */
  version: z.int().min(1),
  generatedAt: IsoUtc,
  site: SiteInfo,
  timeline: z.object({ v: ContentHash }),
});
export type Manifest = z.infer<typeof Manifest>;

/**
 * "notFound" is the boot route of /404.html (served by hosts at any URL depth): it carries the
 * runtime basePath so the SPA can load data and render its 404 screen. params is {}.
 */
export const RouteName = z.enum(['home', 'day', 'story', 'trip', 'notFound']);
export type RouteName = z.infer<typeof RouteName>;

/** Per-page boot data in <script id="omw-boot" type="application/json">. */
export const Boot = z.object({
  basePath: BasePath,
  locale: LocaleCode,
  route: z.object({ name: RouteName, params: z.record(z.string(), z.string()) }),
  /**
   * manifestVersion/timelineV: the release in which THIS page's content last changed. Home and
   * 404 always carry the current release; day, story and trip pages may be older (the generator
   * keeps unchanged pages byte-identical). The live manifest can therefore be newer at load, which
   * is not "new moments": the SPA takes the first manifest it sees as its baseline.
   */
  manifestVersion: z.int().min(1),
  timelineV: ContentHash,
  /** Inlined day data for day/story pages (saves a request for the first screen). */
  day: DayDetail.optional(),
});
export type Boot = z.infer<typeof Boot>;

// ---------------------------------------------------------------------------------------------
// Path helpers (shared by generator and SPA)

export const BOOT_ELEMENT_ID = 'omw-boot';
export const MANIFEST_PATH = 'data/manifest.json';
export const TIMELINE_PATH = 'data/timeline.json';

export function dayDataPath(date: string): string {
  return `data/days/${LocalDate.parse(date)}.json`;
}

export function tripDataPath(slug: string): string {
  return `data/trips/${Slug.parse(slug)}.json`;
}

/** Appends the cache buster: "data/days/2026-11-18.json?v=abc123". */
export function withVersion(path: string, v: string): string {
  return `${path}?v=${encodeURIComponent(v)}`;
}

export type RouteRef =
  | { name: 'home' }
  | { name: 'day'; date: string }
  | { name: 'story'; date: string; id: string }
  | { name: 'trip'; slug: string };

/** Route path relative to the site root, with trailing slash: "de/day/2026-11-18/". */
export function routePath(locale: LocaleCode, route: RouteRef): string {
  switch (route.name) {
    case 'home':
      return `${locale}/`;
    case 'day':
      return `${locale}/day/${LocalDate.parse(route.date)}/`;
    case 'story':
      return `${locale}/day/${LocalDate.parse(route.date)}/story/${PostPublicId.parse(route.id)}/`;
    case 'trip':
      return `${locale}/trip/${Slug.parse(route.slug)}/`;
  }
}

/** Absolute URL path for a site-relative path: resolveSitePath("/travel/", "media/x.avif"). */
export function resolveSitePath(basePath: string, relPath: string): string {
  const base = BasePath.parse(basePath);
  return base + relPath.replace(/^\/+/, '');
}
