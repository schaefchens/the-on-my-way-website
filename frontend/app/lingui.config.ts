import { defineConfig } from '@lingui/conf';
import { formatter } from '@lingui/format-po';

/**
 * Catalogs: src/locales/<locale>/messages.po, compiled on import by @lingui/metro-transformer.
 * Source strings are English with a German translation (du-form, warm and short). "ar" is the
 * dev-only pseudo-locale (D5): pseudo-localized English with RTL, for layout mirroring tests.
 */
export default defineConfig({
  sourceLocale: 'en',
  locales: ['en', 'de', 'ar'],
  pseudoLocale: { locale: 'ar', rightToLeft: true },
  fallbackLocales: { default: 'en' },
  catalogs: [
    {
      path: '<rootDir>/src/locales/{locale}/messages',
      include: ['<rootDir>/src', '<rootDir>/modules/omw-native/src'],
    },
  ],
  format: formatter({ lineNumbers: false }),
});
