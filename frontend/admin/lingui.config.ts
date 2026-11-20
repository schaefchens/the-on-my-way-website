import { defineConfig } from '@lingui/conf';
import { formatter } from '@lingui/format-po';

/**
 * Catalogs: src/locales/<locale>/messages.po, compiled on import by @lingui/vite-plugin and
 * lazy-loaded per locale (src/i18n.ts). Source strings are English.
 * "ar" is the dev-only pseudo-locale (D5): pseudo-localized English wrapped in RTL marks,
 * so layout mirroring can be tested without real translations.
 */
export default defineConfig({
  sourceLocale: 'en',
  locales: ['en', 'de', 'ar'],
  pseudoLocale: { locale: 'ar', rightToLeft: true },
  fallbackLocales: { default: 'en' },
  catalogs: [
    {
      path: '<rootDir>/src/locales/{locale}/messages',
      include: ['<rootDir>/src'],
    },
  ],
  format: formatter({ lineNumbers: false }),
});
