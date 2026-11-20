/**
 * Locale helpers shared by site and admin (D5): text direction from the contracts' LOCALES
 * table, <html lang dir> sync, and cached Intl formatters.
 *
 * Owner content is formatted in the traveler's zone (`tz` of the entry/day), never in the
 * viewer's zone, so "08:40" means 08:40 where the photo was taken.
 */
import { LOCALES, type LocaleCode, type TextDirection } from '@omw/contracts/i18n';
import { useLayoutEffect } from 'react';

/**
 * BCP 47 tag handed to Intl per app locale. Region/numbering choices are deliberate (plan C,
 * "RTL readiness": calendar and digits are chosen per locale); "ar" is the dev-only pseudo-locale.
 */
export const INTL_LOCALES: Readonly<Record<LocaleCode, string>> = {
  de: 'de-DE',
  en: 'en-GB',
  ar: 'ar',
};

export function intlLocale(locale: LocaleCode): string {
  return INTL_LOCALES[locale];
}

export function dirOf(locale: LocaleCode): TextDirection {
  return LOCALES.find((l) => l.code === locale)?.dir ?? 'ltr';
}

export function isRtl(locale: LocaleCode): boolean {
  return dirOf(locale) === 'rtl';
}

/** +1 for LTR, -1 for RTL: multiply physical x offsets/drag thresholds by it (plan C). */
export function forwardSign(locale: LocaleCode): 1 | -1 {
  return isRtl(locale) ? -1 : 1;
}

/** Locales a build may offer: dev builds add the dev-only pseudo-locales. */
export function availableLocales(includeDevOnly: boolean): LocaleCode[] {
  return LOCALES.filter((l) => includeDevOnly || !l.devOnly).map((l) => l.code);
}

/**
 * Locales a site serves at RUNTIME: the configured ones (Manifest.site.locales, i.e. the setting
 * "site.locales" — may include the pseudo-locale "ar" on test deployments) that this app knows,
 * plus the dev-only pseudo-locales in dev builds. Without a configuration (manifest not loaded)
 * the build's defaults apply. Order follows LOCALES.
 */
export function enabledLocales(
  configured: readonly string[] | null | undefined,
  includeDevOnly: boolean,
): LocaleCode[] {
  if (!configured) return availableLocales(includeDevOnly);
  return LOCALES.filter((l) => configured.includes(l.code) || (includeDevOnly && l.devOnly)).map((l) => l.code);
}

interface LangDirTarget {
  lang: string;
  dir: string;
}

/** Sets lang/dir on <html> (or any element-like target). Returns true if anything changed. */
export function applyDocumentLocale(locale: LocaleCode, target?: LangDirTarget): boolean {
  const el = target ?? (typeof document !== 'undefined' ? document.documentElement : undefined);
  if (!el) return false;
  const dir = dirOf(locale);
  if (el.lang === locale && el.dir === dir) return false;
  el.lang = locale;
  el.dir = dir;
  return true;
}

/** Keeps <html lang dir> in sync with the active locale. */
export function useDocumentLocale(locale: LocaleCode): void {
  useLayoutEffect(() => {
    applyDocumentLocale(locale);
  }, [locale]);
}

// ---------------------------------------------------------------------------------------------
// Intl formatters (cached: constructing them is comparatively expensive)

const cache = new Map<string, unknown>();

function cached<T>(key: string, make: () => T): T {
  let hit = cache.get(key) as T | undefined;
  if (hit === undefined) {
    hit = make();
    cache.set(key, hit);
  }
  return hit;
}

export function dateTimeFormat(locale: LocaleCode, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return cached(`dtf|${locale}|${JSON.stringify(options)}`, () => new Intl.DateTimeFormat(intlLocale(locale), options));
}

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A "YYYY-MM-DD" local date as a Date at UTC midnight (format it with timeZone 'UTC'). */
export function localDateToUtcDate(localDate: string): Date {
  const m = LOCAL_DATE_RE.exec(localDate);
  if (!m) throw new RangeError(`Invalid local date: ${localDate}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export type LocalDateStyle = 'day-header' | 'day-title' | 'short' | 'long' | 'month' | 'year' | 'weekday';

const LOCAL_DATE_OPTIONS: Record<LocalDateStyle, Intl.DateTimeFormatOptions> = {
  /** "Mi., 18. Nov." / "Wed 18 Nov" */
  'day-header': { weekday: 'short', day: 'numeric', month: 'short' },
  /** "Mittwoch, 18. November" / "Wednesday 18 November" (a day without an owner title) */
  'day-title': { weekday: 'long', day: 'numeric', month: 'long' },
  /** "18.11.2026" / "18/11/2026" */
  short: { day: '2-digit', month: '2-digit', year: 'numeric' },
  /** "Mittwoch, 18. November 2026" */
  long: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  /** "November 2026" */
  month: { month: 'long', year: 'numeric' },
  year: { year: 'numeric' },
  weekday: { weekday: 'long' },
};

/** Formats a calendar date ("YYYY-MM-DD"); no time zone shifts can occur. */
export function formatLocalDate(localDate: string, locale: LocaleCode, style: LocalDateStyle = 'day-header'): string {
  return dateTimeFormat(locale, { ...LOCAL_DATE_OPTIONS[style], timeZone: 'UTC' }).format(
    localDateToUtcDate(localDate),
  );
}

/** "18. – 21. Nov. 2026" style range of two local dates. */
export function formatLocalDateRange(start: string, end: string, locale: LocaleCode): string {
  return dateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).formatRange(
    localDateToUtcDate(start),
    localDateToUtcDate(end),
  );
}

/** Wall-clock time of an instant in the traveler's zone, e.g. "08:40". */
export function formatTime(isoUtc: string | Date, tz: string, locale: LocaleCode): string {
  return dateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(
    typeof isoUtc === 'string' ? new Date(isoUtc) : isoUtc,
  );
}

/** Date and time of an instant in a zone, e.g. for admin lists. */
export function formatDateTime(isoUtc: string | Date, tz: string, locale: LocaleCode): string {
  return dateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(
    typeof isoUtc === 'string' ? new Date(isoUtc) : isoUtc,
  );
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

/** "vor 5 Minuten" / "in 2 days" relative to `now`. */
export function formatRelative(
  instant: string | Date | number,
  locale: LocaleCode,
  now: Date | number = Date.now(),
): string {
  const t = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  const n = now instanceof Date ? now.getTime() : now;
  const diffSec = (t - n) / 1000;
  const rtf = cached(
    `rtf|${locale}`,
    () => new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto', style: 'long' }),
  );
  for (const [unit, seconds] of RELATIVE_UNITS) {
    if (Math.abs(diffSec) >= seconds || unit === 'second') {
      return rtf.format(Math.round(diffSec / seconds), unit);
    }
  }
  return rtf.format(0, 'second');
}

function displayNames(locale: LocaleCode, type: Intl.DisplayNamesType): Intl.DisplayNames {
  return cached(`dn|${locale}|${type}`, () => new Intl.DisplayNames(intlLocale(locale), { type, fallback: 'code' }));
}

/** "Vietnam" for "VN" in the UI locale. */
export function countryName(code: string, locale: LocaleCode): string {
  try {
    return displayNames(locale, 'region').of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** "Vietnamesisch" for "vi" (used for "Original: Vietnamesisch"). */
export function languageName(code: string, locale: LocaleCode): string {
  try {
    return displayNames(locale, 'language').of(code) ?? code;
  } catch {
    return code;
  }
}

/** Flag emoji for an ISO-3166 alpha-2 code ("VN" -> 🇻🇳); empty string for invalid codes. */
export function countryFlag(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return '';
  const base = 0x1f1e6;
  const upper = code.toUpperCase();
  return String.fromCodePoint(base + (upper.charCodeAt(0) - 65), base + (upper.charCodeAt(1) - 65));
}

/** Locale-aware number, e.g. counts in day headers. */
export function formatNumber(value: number, locale: LocaleCode, options?: Intl.NumberFormatOptions): string {
  return cached(
    `nf|${locale}|${JSON.stringify(options ?? {})}`,
    () => new Intl.NumberFormat(intlLocale(locale), options),
  ).format(value);
}
