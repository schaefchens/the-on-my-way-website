/**
 * Lingui setup. Catalogs are .po files compiled on import (@lingui/metro-transformer). English is
 * the source, German the translation; "ar" is the dev-only pseudo-locale for RTL checks.
 */
// First: Hermes on Android has no Intl.PluralRules, which every plural message needs.
import './plural-rules';
import { i18n } from '@lingui/core';
import { getLocales } from 'expo-localization';
import { I18nManager } from 'react-native';
import { messages as ar } from '../locales/ar/messages.po';
import { messages as de } from '../locales/de/messages.po';
import { messages as en } from '../locales/en/messages.po';

export const APP_LOCALES = ['en', 'de', 'ar'] as const;
export type AppLocale = (typeof APP_LOCALES)[number];

/** Locales she can pick; "ar" only in development builds. */
export function selectableLocales(dev: boolean = __DEV__): AppLocale[] {
  return dev ? [...APP_LOCALES] : ['en', 'de'];
}

/** The system language if we have it (de, else en). The pseudo-locale is never picked by itself. */
export function systemLocale(languageCodes: readonly (string | null)[] = getLocales().map((l) => l.languageCode)) {
  return languageCodes.find((c): c is 'de' | 'en' => c === 'de' || c === 'en') ?? 'en';
}

i18n.load({ en, de, ar });

/**
 * Activates a locale. RTL needs a restart in React Native: when the direction changes, this
 * returns true and the caller asks for one (the pseudo-locale is a dev tool).
 */
export function activateLocale(locale: AppLocale): boolean {
  i18n.activate(locale);
  const rtl = locale === 'ar';
  if (I18nManager.isRTL !== rtl) {
    I18nManager.allowRTL(rtl);
    I18nManager.forceRTL(rtl);
    return true;
  }
  return false;
}

// The text direction is left alone here: the stored choice (AppSettingsProvider) sets it, and a
// change only takes effect after a restart. Forcing LTR at every start would undo the pseudo-RTL.
i18n.activate(systemLocale());

export { i18n };
