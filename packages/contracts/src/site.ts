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
 * - timeline.json optionally carries the owner's profile (SiteProfile: author, intro per locale,
 *   portrait); timeline v = contentHash({ trips, days }) plus `profile` only when present, so a
 *   site without a profile keeps its hashes.
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
  LocalDate,
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

// ---------------------------------------------------------------------------------------------
// Profile: whose journey it is (owner settings site.author / site.intro / site.avatar)

/**
 * Edge lengths of the portrait's own files: a round crop of the chosen photo (the circle the site
 * and the admin show), never the photo's frame. 96 CSS px is the largest portrait box (the hero),
 * so 288 covers it at DPR 3.
 */
export const AVATAR_SIZES = [96, 192, 288] as const;
/** Widest file a portrait publishes (AVATAR_SIZES; never the photo's own variants or OG image). */
export const AVATAR_MAX_WIDTH = 288;

/** One line of plain text: no control characters, no leading/trailing whitespace. */
const TRIMMED_LINE_RE = /^[^\p{Cc}\p{Z}](?:[^\p{Cc}]*[^\p{Cc}\p{Z}])?$/u;
/** Like TRIMMED_LINE_RE, but line feeds ("\n") may separate lines. */
const TRIMMED_TEXT_RE = /^[^\p{Cc}\p{Z}](?:(?:[^\p{Cc}]|\n)*[^\p{Cc}\p{Z}])?$/u;

/** Display name of the traveler, e.g. "Lea": one trimmed line, 1..60 characters. */
export const AuthorName = z.string().min(1).max(60).regex(TRIMMED_LINE_RE, {
  message: 'Expected one line without leading/trailing spaces or control characters',
});

/** A short greeting in one locale: plain text (never markdown), trimmed, 1..160 characters. */
export const IntroText = z.string().min(1).max(160).regex(TRIMMED_TEXT_RE, {
  message: 'Expected plain text without leading/trailing spaces or control characters (line feeds allowed)',
});

/** The greeting per locale (I18nText shape); at least one locale. */
export const IntroI18n = z
  .partialRecord(LocaleCode, IntroText)
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one locale' })
  .meta({ minProperties: 1 });
export type IntroI18n = z.infer<typeof IntroI18n>;

/**
 * Focus point of a portrait as fractions of the image (x from the left edge, y from the top),
 * for CSS `object-position: <x·100>% <y·100>%`. Physical image coordinates: never mirrored in RTL.
 */
export const FocusPoint = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export type FocusPoint = z.infer<typeof FocusPoint>;

const AvatarSource = ImageSource.extend({ w: z.int().positive().max(AVATAR_MAX_WIDTH) });

/**
 * The published portrait: an ImageSet of its own small square files (the backend crops the
 * chosen photo around the owner's focus point and makes the corners transparent), at most
 * AVATAR_MAX_WIDTH wide, without an OG image; w/h are those of the widest file. `focus` is for
 * portraits that are not pre-cropped (object-position); the generator's crops need none.
 */
export const AvatarImage = z.object({
  w: z.int().positive(),
  h: z.int().positive(),
  color: HexColor,
  thumbhash: Base64,
  /** Ascending by width. */
  sources: z.object({
    avif: z.array(AvatarSource).min(1),
    webp: z.array(AvatarSource).min(1),
  }),
  focus: FocusPoint.optional(),
});
export type AvatarImage = z.infer<typeof AvatarImage>;

/**
 * Who travels: present in timeline.json only when the owner set at least one part. Every part is
 * optional on its own (a portrait whose photo is unavailable is simply left out).
 */
export const SiteProfile = z.object({
  author: AuthorName.optional(),
  /** Greeting per locale (plain text, shown in the handwritten face). */
  intro: IntroI18n.optional(),
  avatar: AvatarImage.optional(),
});
export type SiteProfile = z.infer<typeof SiteProfile>;

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
  /**
   * Published trips only: a trip appears once at least one of its days has a public entry
   * (publishedTrips() in ./policy); planned trips without a public day are left out everywhere.
   */
  trips: z.array(TripSummary),
  /** Ascending by date. */
  days: z.array(DaySummary),
  /** Whose journey it is; absent when the owner set none of site.author/intro/avatar. */
  profile: SiteProfile.optional(),
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

/**
 * Setting "site.here_now" (Q2): how the current stay (the trailing run of published days at the
 * newest day's place) is shown. city_badge = city + "here now" badge (default, wave 4); city =
 * city without badge; country = the current stay's days lose their place (country kept); none =
 * they lose place and country. The generator strips the data, not just the UI.
 */
export const HereNow = z.enum(['city_badge', 'city', 'country', 'none']);
export type HereNow = z.infer<typeof HereNow>;

/**
 * Setting "site.time_precision": exact = published entry times as captured (default); part_of_day
 * = coarsened to 3-hour local buckets (coarsenToBucket in ./time), the SPA shows the part of day.
 */
export const TimePrecision = z.enum(['exact', 'part_of_day']);
export type TimePrecision = z.infer<typeof TimePrecision>;

export const SiteInfo = z.object({
  title: z.string().min(1).max(120),
  locales: z.array(LocaleCode).min(1),
  defaultLocale: LocaleCode,
  basePath: BasePath,
  indexable: z.boolean(),
  /** Absent = "city_badge". */
  hereNow: HereNow.optional(),
  /** Absent = "exact". */
  timePrecision: TimePrecision.optional(),
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

/**
 * Boot.access (gate mode). Defined here rather than imported from ./access (which imports this
 * module): `api` has the PublicApiBase pattern, `cookieMode` the CookieMode values and
 * `cookieDomain` the GateBoot.cookieDomain pattern (test/access.test.ts guards the copies).
 * cookieDomain: F1/F2 only, the Domain the SPA uses when it deletes the transfer/handoff
 * cookies; null = host-only.
 */
export const BootAccess = z.object({
  api: z.string().regex(/^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?\/api\/v1\/public\/$/),
  cookies: z.object({
    key: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    transfer: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    handoff: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  }),
  cookieMode: z.enum(['headers', 'co', 'parent']),
  cookieDomain: z
    .string()
    .regex(/^[a-z0-9.-]+$/)
    .nullable(),
});
export type BootAccess = z.infer<typeof BootAccess>;

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
  /**
   * The timeline's profile, inlined next to `day` on day/story pages: their player mounts before
   * timeline.json has arrived and shows the portrait at once (absent when there is no profile).
   */
  profile: SiteProfile.optional(),
  /** Present in gate mode only (spec-wave5 §5.4): how the SPA talks to the API about its device. */
  access: BootAccess.optional(),
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
