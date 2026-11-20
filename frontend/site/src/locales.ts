/**
 * Which locales the site serves, decided at RUNTIME from Manifest.site.locales (the setting
 * "site.locales"), so a production build can serve the pseudo-locale "ar" on an RTL test
 * deployment and never serves a locale the generator did not emit (contracts i18n.ts). Dev
 * builds add the dev-only pseudo-locales. Routes for other codes are 404.
 */
import { LOCALE_CODES, type LocaleCode } from '@omw/contracts/i18n';
import { enabledLocales } from '@omw/ui/locale';

export function isKnownLocale(value: unknown): value is LocaleCode {
  return typeof value === 'string' && (LOCALE_CODES as readonly string[]).includes(value);
}

/** Enabled locales for the manifest's locale list (null = manifest not available). */
export function siteLocales(manifestLocales: readonly string[] | null | undefined): LocaleCode[] {
  return enabledLocales(manifestLocales, import.meta.env.DEV);
}

/**
 * Whether `locale` may be served: enabled by the manifest, or the locale the current page was
 * generated for (still valid when the manifest cannot be fetched).
 */
export function isServedLocale(
  locale: LocaleCode,
  manifestLocales: readonly string[] | null | undefined,
  bootLocale: LocaleCode | null,
): boolean {
  return siteLocales(manifestLocales).includes(locale) || locale === bootLocale;
}
