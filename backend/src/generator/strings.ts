/**
 * First-screen and meta-tag strings of the generated pages (de/en), as a small typed table.
 *
 * The SPA has its own Lingui catalogs; these strings only cover what the generator renders
 * before React mounts (and what no-JS readers and crawlers see). Keep the wording close to the
 * SPA's catalog (frontend/site/src/locales/<locale>/messages.po) so the swap is not jarring.
 * `Record<LocaleCode, …>` makes a missing locale or key a compile error. The dev-only pseudo-
 * locale "ar" reuses the English strings (the page is still rendered dir="rtl" with lang="ar").
 *
 * Date/time formatting mirrors @omw/ui/locale (INTL_LOCALES: de-DE, en-GB, ar; local dates are
 * formatted at UTC midnight, wall-clock times in the entry's zone).
 */
import { LOCALES, type LocaleCode, textDirection } from '@omw/contracts/i18n';
import type { TimePrecision } from '@omw/contracts/site';
import { type PartOfDay, timeBucket } from '@omw/contracts/time';

export interface PageStrings {
  /** Shown under the site title on the home page. */
  tagline: string;
  latestDays: string;
  trips: string;
  noMoments: string;
  moments(count: number): string;
  days(count: number): string;
  previousDay: string;
  nextDay: string;
  backToTimeline: string;
  backToDay: string;
  readStory: string;
  photo: string;
  video: string;
  gif: string;
  voiceMessage(duration: string): string;
  /** "Original: Deutsch" (owner text shown in another language than the page). */
  original(language: string): string;
  trip: string;
  languages: string;
  chooseLanguage: string;
  notFoundTitle: string;
  notFoundText: string;
  toHome: string;
  /** Fallback meta description of a day page. */
  dayDescription(date: string, count: number): string;
  /** Fallback meta description of the home page. */
  homeDescription(siteTitle: string): string;
  /** Fallback meta description of a trip page. */
  tripDescription(title: string, range: string): string;
  /** og:locale value. */
  ogLocale: string;
  /**
   * og:title and meta description of every page (spec-wave5 §5.2 E10): a link preview never
   * shows the site's title, a place, a date or a picture.
   */
  privateTitle: string;
  /** Time labels with site.time_precision = part_of_day (time.ts timeBucket). */
  partOfDay: Record<PartOfDay, string>;
  /**
   * Strings of the first-screen twin (twin.ts), copied verbatim from the SPA's Lingui catalogs
   * (frontend/site/src/locales/<locale>/messages.po) so the swap to React changes no text.
   */
  spa: SpaStrings;
}

export interface SpaStrings {
  /** Hero line ("Moments from the road"). */
  tagline: string;
  nowIn: string;
  lastIn: string;
  /** aria-label of the language switch. */
  language: string;
  themeSystem: string;
  days(n: number): string;
  countries(n: number): string;
  moments(n: number): string;
  trip: string;
  story: string;
  seeTrip: string;
  watchDay: string;
  hereNow: string;
  lastSeenHere: string;
  momentsOfDay: string;
  /** "Timeline: Days" (section label of the days level). */
  timelineDays: string;
  zoomLabel: string;
  zoomYears: string;
  zoomMonths: string;
  zoomDays: string;
  journeyOf(title: string): string;
  previousMoment: string;
  nextMoment: string;
  previousDay: string;
  nextDay: string;
  slideshow: string;
  pause: string;
  options: string;
  close: string;
}

function plural(locale: string, count: number, one: string, other: string): string {
  return new Intl.PluralRules(locale).select(count) === 'one' ? one : other;
}

const de: PageStrings = {
  tagline: 'Reisetagebuch',
  latestDays: 'Neueste Tage',
  trips: 'Reisen',
  noMoments: 'Noch keine Momente.',
  moments: (n) => `${n} ${plural('de', n, 'Moment', 'Momente')}`,
  days: (n) => `${n} ${plural('de', n, 'Tag', 'Tage')}`,
  previousDay: 'Vorheriger Tag',
  nextDay: 'Nächster Tag',
  backToTimeline: 'Zur Zeitleiste',
  backToDay: 'Zurück zum Tag',
  readStory: 'Geschichte lesen',
  photo: 'Foto',
  video: 'Video',
  gif: 'GIF',
  voiceMessage: (d) => `Sprachnachricht (${d})`,
  original: (language) => `Original: ${language}`,
  trip: 'Reise',
  languages: 'Sprachen',
  chooseLanguage: 'Sprache wählen',
  notFoundTitle: 'Hier ist nichts',
  notFoundText: 'Diese Seite gibt es nicht (mehr).',
  toHome: 'Zur Startseite',
  dayDescription: (date, n) => `${date}: ${n} ${plural('de', n, 'Moment', 'Momente')} der Reise.`,
  homeDescription: (title) => `${title}: Reisetagebuch mit Fotos, Videos und Geschichten von unterwegs.`,
  tripDescription: (title, range) => `${title} (${range})`,
  ogLocale: 'de_DE',
  privateTitle: 'Privat',
  partOfDay: { night: 'Nachts', morning: 'Morgens', midday: 'Mittags', afternoon: 'Nachmittags', evening: 'Abends' },
  spa: {
    tagline: 'Momente von unterwegs',
    nowIn: 'Gerade in',
    lastIn: 'Zuletzt in',
    language: 'Sprache',
    themeSystem: 'Design: wie das Gerät',
    days: (n) => `${n} ${plural('de', n, 'Tag', 'Tage')}`,
    countries: (n) => `${n} ${plural('de', n, 'Land', 'Länder')}`,
    moments: (n) => `${n} ${plural('de', n, 'Moment', 'Momente')}`,
    trip: 'Reise',
    story: 'Geschichte',
    seeTrip: 'Zur Reise',
    watchDay: 'Tag ansehen',
    hereNow: 'Gerade hier',
    lastSeenHere: 'Zuletzt hier',
    momentsOfDay: 'Momente dieses Tages',
    timelineDays: 'Zeitleiste: Tage',
    zoomLabel: 'Zoom (Tasten + und −, 1 bis 3)',
    zoomYears: 'Jahre',
    zoomMonths: 'Monate',
    zoomDays: 'Tage',
    journeyOf: (title) => `Reisetag: ${title}`,
    previousMoment: 'Vorheriger Moment',
    nextMoment: 'Nächster Moment',
    previousDay: 'Vorheriger Tag',
    nextDay: 'Nächster Tag',
    slideshow: 'Diashow',
    pause: 'Pausieren',
    options: 'Wiedergabe-Optionen',
    close: 'Schließen',
  },
};

const en: PageStrings = {
  tagline: 'Travel diary',
  latestDays: 'Latest days',
  trips: 'Trips',
  noMoments: 'No moments yet.',
  moments: (n) => `${n} ${plural('en', n, 'moment', 'moments')}`,
  days: (n) => `${n} ${plural('en', n, 'day', 'days')}`,
  previousDay: 'Previous day',
  nextDay: 'Next day',
  backToTimeline: 'Back to the timeline',
  backToDay: 'Back to the day',
  readStory: 'Read the story',
  photo: 'Photo',
  video: 'Video',
  gif: 'GIF',
  voiceMessage: (d) => `Voice message (${d})`,
  original: (language) => `Original: ${language}`,
  trip: 'Trip',
  languages: 'Languages',
  chooseLanguage: 'Choose a language',
  notFoundTitle: 'Nothing here',
  notFoundText: 'This page does not exist (any more).',
  toHome: 'Go to the start page',
  dayDescription: (date, n) => `${date}: ${n} ${plural('en', n, 'moment', 'moments')} from the road.`,
  homeDescription: (title) => `${title}: a travel diary with photos, videos and stories from the road.`,
  tripDescription: (title, range) => `${title} (${range})`,
  ogLocale: 'en_GB',
  privateTitle: 'Private',
  partOfDay: { night: 'Night', morning: 'Morning', midday: 'Midday', afternoon: 'Afternoon', evening: 'Evening' },
  spa: {
    tagline: 'Moments from the road',
    nowIn: 'Now in',
    lastIn: 'Last in',
    language: 'Language',
    themeSystem: 'Theme: like the device',
    days: (n) => `${n} ${plural('en', n, 'day', 'days')}`,
    countries: (n) => `${n} ${plural('en', n, 'country', 'countries')}`,
    moments: (n) => `${n} ${plural('en', n, 'moment', 'moments')}`,
    trip: 'Trip',
    story: 'Story',
    seeTrip: 'See the trip',
    watchDay: 'Watch the day',
    hereNow: 'Here now',
    lastSeenHere: 'Last seen here',
    momentsOfDay: 'Moments of this day',
    timelineDays: 'Timeline: Days',
    zoomLabel: 'Zoom (keys + and −, 1 to 3)',
    zoomYears: 'Years',
    zoomMonths: 'Months',
    zoomDays: 'Days',
    journeyOf: (title) => `Journey of ${title}`,
    previousMoment: 'Previous moment',
    nextMoment: 'Next moment',
    previousDay: 'Previous day',
    nextDay: 'Next day',
    slideshow: 'slideshow',
    pause: 'Pause',
    options: 'Player options',
    close: 'Close',
  },
};

export const STRINGS: Readonly<Record<LocaleCode, PageStrings>> = {
  de,
  en,
  ar: { ...en, ogLocale: 'ar' },
};

export function stringsFor(locale: LocaleCode): PageStrings {
  return STRINGS[locale];
}

// ---------------------------------------------------------------------------------------------
// Intl formatting (mirrors @omw/ui/locale)

export const INTL_LOCALES: Readonly<Record<LocaleCode, string>> = { de: 'de-DE', en: 'en-GB', ar: 'ar' };

const formatters = new Map<string, Intl.DateTimeFormat>();
function dtf(locale: LocaleCode, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(INTL_LOCALES[locale], options);
    formatters.set(key, f);
  }
  return f;
}

function utcMidnight(localDate: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!m) throw new RangeError(`Invalid local date: ${localDate}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export type DateStyle = 'long' | 'header' | 'short' | 'title' | 'month' | 'numeric' | 'player';
const DATE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  /** "Sonntag, 15. November 2026" */
  long: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  /** "So., 15. Nov." (@omw/ui 'day-header') */
  header: { weekday: 'short', day: 'numeric', month: 'short' },
  /** "15. Nov. 2026" */
  short: { day: 'numeric', month: 'short', year: 'numeric' },
  /** "Sonntag, 15. November" (@omw/ui 'day-title': a day without an owner title) */
  title: { weekday: 'long', day: 'numeric', month: 'long' },
  /** "November 2026" (@omw/ui 'month') */
  month: { month: 'long', year: 'numeric' },
  /** "15.11.2026" (@omw/ui 'short', passport stamps) */
  numeric: { day: '2-digit', month: '2-digit', year: 'numeric' },
  /** "Sonntag, 15. Nov." (the player's title of a day without an owner title) */
  player: { weekday: 'long', day: 'numeric', month: 'short' },
};

export function formatDate(localDate: string, locale: LocaleCode, style: DateStyle = 'long'): string {
  return dtf(locale, { ...DATE_OPTIONS[style], timeZone: 'UTC' }).format(utcMidnight(localDate));
}

export function formatDateRange(start: string, end: string, locale: LocaleCode): string {
  return dtf(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).formatRange(
    utcMidnight(start),
    utcMidnight(end),
  );
}

/** Wall-clock time of an instant in the traveler's zone ("08:40"). */
export function formatTime(isoUtc: string, tz: string, locale: LocaleCode): string {
  return dtf(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(isoUtc));
}

/**
 * Time label of an entry: the wall-clock time, or with site.time_precision = part_of_day the
 * part of the day (the coarsened minutes are not a real time and are never shown).
 */
export function formatEntryTime(
  isoUtc: string,
  tz: string,
  locale: LocaleCode,
  precision: TimePrecision | undefined,
): string {
  if (precision === 'part_of_day') return stringsFor(locale).partOfDay[timeBucket(isoUtc, tz).partOfDay];
  return formatTime(isoUtc, tz, locale);
}

const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

/** "vor 5 Minuten" / "2 days ago" (mirrors @omw/ui formatRelative). */
export function formatRelative(instant: string, locale: LocaleCode, now: Date): string {
  const diffSec = (Date.parse(instant) - now.getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(INTL_LOCALES[locale], { numeric: 'auto', style: 'long' });
  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (Math.abs(diffSec) >= seconds || unit === 'second') return rtf.format(Math.round(diffSec / seconds), unit);
  }
  return rtf.format(0, 'second');
}

/** "0:42" (the SPA's strip and player format: minutes:seconds). */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "0:42" / "1:05:00". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

const displayNames = new Map<string, Intl.DisplayNames>();
function names(locale: LocaleCode, type: 'language' | 'region'): Intl.DisplayNames {
  const key = `${locale}|${type}`;
  let n = displayNames.get(key);
  if (!n) {
    n = new Intl.DisplayNames(INTL_LOCALES[locale], { type, fallback: 'code' });
    displayNames.set(key, n);
  }
  return n;
}

/** Name of a language in the page locale ("Englisch"). The pseudo-locale gets its label. */
export function languageName(code: LocaleCode, locale: LocaleCode): string {
  const info = LOCALES.find((l) => l.code === code);
  if (info?.devOnly) return info.label;
  return names(locale, 'language').of(code) ?? code;
}

/** Endonym used in language pickers ("Deutsch", "English"). */
export function localeLabel(code: LocaleCode): string {
  return LOCALES.find((l) => l.code === code)?.label ?? code;
}

export function countryName(code: string, locale: LocaleCode): string {
  try {
    return names(locale, 'region').of(code) ?? code;
  } catch {
    return code;
  }
}

/** Flag emoji for an ISO-3166 alpha-2 code ("VN" -> 🇻🇳). */
export function countryFlag(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return '';
  const base = 0x1f1e6;
  return String.fromCodePoint(base + (code.charCodeAt(0) - 65), base + (code.charCodeAt(1) - 65));
}

export { textDirection };
