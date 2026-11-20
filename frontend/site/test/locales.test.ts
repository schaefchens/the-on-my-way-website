import { describe, expect, it } from 'vitest';
import { isKnownLocale, isServedLocale, siteLocales } from '../src/locales';

describe('runtime locales (Manifest.site.locales)', () => {
  it('serves exactly the configured locales (plus dev-only ones in dev builds)', () => {
    const dev = import.meta.env.DEV;
    expect(siteLocales(['de'])).toEqual(dev ? ['de', 'ar'] : ['de']);
    expect(siteLocales(['de', 'en', 'ar'])).toEqual(['de', 'en', 'ar']);
    expect(siteLocales(null)).toEqual(dev ? ['de', 'en', 'ar'] : ['de', 'en']);
  });

  it('allows the pseudo-locale on an RTL test deployment, and never unknown codes', () => {
    expect(isServedLocale('ar', ['de', 'ar'], 'de')).toBe(true);
    expect(isServedLocale('en', ['de'], 'de')).toBe(false);
    // the page's own locale stays valid when the manifest cannot be fetched
    expect(isServedLocale('ar', null, 'ar')).toBe(true);
    expect(isKnownLocale('fr')).toBe(false);
  });
});
