/**
 * Locales (D5): "de" and "en" are real; "ar" is a dev-only pseudo-locale for RTL testing.
 * Localized owner text is an I18nText (partial record locale -> string) plus a separate
 * origLocale field that names the language it was written in.
 *
 * Decisions:
 * - `devOnly` means: hidden in the admin language picker and not offered by the API's
 *   settings UI unless in a dev build. It does NOT forbid the locale on a site: "ar" in the
 *   setting "site.locales" is valid for RTL test deployments. The generator emits pages for
 *   exactly the locales in "site.locales" (Manifest.site.locales), and the SPA enables exactly
 *   those at runtime (plus dev-only ones in dev builds).
 * - Original language (plan C "Original: …" label): owner text is always written in one of the
 *   app locales (LocaleCode), so origLocale is a LocaleCode, never an arbitrary BCP 47 tag.
 *   The fallback label names that locale via Intl.DisplayNames ("Original: Englisch").
 *   Original texts in other languages (e.g. Vietnamese) are out of scope for v1; widening
 *   origLocale/I18nText keys to BCP 47 tags later needs a contractVersion bump.
 */
import { z } from 'zod';

export const LOCALE_CODES = ['de', 'en', 'ar'] as const;
export const LocaleCode = z.enum(LOCALE_CODES);
export type LocaleCode = z.infer<typeof LocaleCode>;

export type TextDirection = 'ltr' | 'rtl';

export interface LocaleInfo {
  readonly code: LocaleCode;
  readonly dir: TextDirection;
  readonly label: string;
  readonly devOnly?: boolean;
}

export const LOCALES: readonly LocaleInfo[] = [
  { code: 'de', dir: 'ltr', label: 'Deutsch' },
  { code: 'en', dir: 'ltr', label: 'English' },
  { code: 'ar', dir: 'rtl', label: 'Pseudo-Arabisch', devOnly: true },
];

/** Locales that may be published (everything that is not dev-only). */
export const PUBLIC_LOCALES: readonly LocaleCode[] = LOCALES.filter((l) => !l.devOnly).map((l) => l.code);

export const DEFAULT_LOCALE: LocaleCode = 'de';

/** Fallback order used when neither the requested nor the original locale has text. */
export const FALLBACK_ORDER: readonly LocaleCode[] = ['de', 'en', 'ar'];

export function isLocaleCode(value: unknown): value is LocaleCode {
  return typeof value === 'string' && (LOCALE_CODES as readonly string[]).includes(value);
}

export function localeInfo(code: LocaleCode): LocaleInfo {
  const info = LOCALES.find((l) => l.code === code);
  if (!info) throw new RangeError(`Unknown locale: ${code}`);
  return info;
}

export function textDirection(code: LocaleCode): TextDirection {
  return localeInfo(code).dir;
}

/** Localized text: any subset of locales; empty strings count as missing. */
export const I18nText = z.partialRecord(LocaleCode, z.string().max(20_000));
export type I18nText = z.infer<typeof I18nText>;

export interface PickedText {
  /** The chosen text. */
  text: string;
  /** Locale the text is in. */
  locale: LocaleCode;
  /** True when `locale` differs from the requested locale (UI shows "Original: …"). */
  fallback: boolean;
}

function nonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Picks the best text for `locale`: requested locale, then `origLocale`, then FALLBACK_ORDER.
 * Returns null when no locale has non-blank text.
 */
export function pickText(
  text: I18nText | null | undefined,
  locale: LocaleCode,
  origLocale?: LocaleCode | null,
): PickedText | null {
  if (!text) return null;
  const order: LocaleCode[] = [locale];
  if (origLocale) order.push(origLocale);
  order.push(...FALLBACK_ORDER);
  for (const code of order) {
    const value = text[code];
    if (nonEmpty(value)) return { text: value, locale: code, fallback: code !== locale };
  }
  return null;
}
