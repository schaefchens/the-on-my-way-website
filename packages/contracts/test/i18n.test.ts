import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  I18nText,
  isLocaleCode,
  LOCALES,
  LocaleCode,
  localeInfo,
  PUBLIC_LOCALES,
  pickText,
  textDirection,
} from '../src/i18n.js';

describe('locale table', () => {
  it('has de/en real and ar as dev-only RTL pseudo-locale', () => {
    expect(LOCALES.map((l) => l.code)).toEqual(['de', 'en', 'ar']);
    expect(PUBLIC_LOCALES).toEqual(['de', 'en']);
    expect(DEFAULT_LOCALE).toBe('de');
    expect(localeInfo('ar')).toMatchObject({ dir: 'rtl', devOnly: true });
    expect(textDirection('de')).toBe('ltr');
    expect(textDirection('ar')).toBe('rtl');
    expect(isLocaleCode('en')).toBe(true);
    expect(isLocaleCode('fr')).toBe(false);
    expect(LocaleCode.safeParse('vi').success).toBe(false);
  });
});

describe('I18nText', () => {
  it('accepts any subset of known locales', () => {
    expect(I18nText.parse({})).toEqual({});
    expect(I18nText.parse({ de: 'Hallo' })).toEqual({ de: 'Hallo' });
    expect(I18nText.parse({ de: 'Hallo', en: 'Hello' })).toEqual({ de: 'Hallo', en: 'Hello' });
  });

  it('rejects unknown locales and non-strings', () => {
    expect(I18nText.safeParse({ fr: 'Bonjour' }).success).toBe(false);
    expect(I18nText.safeParse({ de: 1 }).success).toBe(false);
  });
});

describe('pickText', () => {
  const text = { de: 'Hallo', en: 'Hello' };

  it('prefers the requested locale', () => {
    expect(pickText(text, 'en', 'de')).toEqual({ text: 'Hello', locale: 'en', fallback: false });
  });

  it('falls back to the original locale, then de/en order', () => {
    expect(pickText({ en: 'Hello' }, 'de', 'en')).toEqual({ text: 'Hello', locale: 'en', fallback: true });
    expect(pickText({ en: 'Hello' }, 'de')).toEqual({ text: 'Hello', locale: 'en', fallback: true });
    expect(pickText({ de: 'Hallo', en: 'Hello' }, 'ar', 'en')).toEqual({
      text: 'Hello',
      locale: 'en',
      fallback: true,
    });
    expect(pickText({ de: 'Hallo', en: 'Hello' }, 'ar')).toEqual({ text: 'Hallo', locale: 'de', fallback: true });
  });

  it('treats blank strings as missing', () => {
    expect(pickText({ de: '  ', en: 'Hello' }, 'de', 'de')).toEqual({
      text: 'Hello',
      locale: 'en',
      fallback: true,
    });
    expect(pickText({ de: '' }, 'de')).toBeNull();
    expect(pickText(undefined, 'de')).toBeNull();
    expect(pickText(null, 'de')).toBeNull();
  });
});
