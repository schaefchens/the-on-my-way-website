import { LOCALES } from '@omw/contracts/i18n';
import { describe, expect, it } from 'vitest';
import {
  applyDocumentLocale,
  availableLocales,
  countryFlag,
  countryName,
  dirOf,
  enabledLocales,
  formatLocalDate,
  formatLocalDateRange,
  formatRelative,
  formatTime,
  forwardSign,
  languageName,
} from '../src/locale';

describe('direction', () => {
  it('follows the contracts LOCALES table', () => {
    for (const l of LOCALES) expect(dirOf(l.code)).toBe(l.dir);
    expect(dirOf('ar')).toBe('rtl');
    expect(forwardSign('ar')).toBe(-1);
    expect(forwardSign('de')).toBe(1);
  });

  it('hides dev-only locales unless asked', () => {
    expect(availableLocales(false)).toEqual(['de', 'en']);
    expect(availableLocales(true)).toEqual(['de', 'en', 'ar']);
    // runtime: the site's configured locales win; "ar" is allowed on test deployments
    expect(enabledLocales(['de'], false)).toEqual(['de']);
    expect(enabledLocales(['en', 'ar', 'xx'], false)).toEqual(['en', 'ar']);
    expect(enabledLocales(['de'], true)).toEqual(['de', 'ar']);
    expect(enabledLocales(null, false)).toEqual(['de', 'en']);
  });

  it('applies lang and dir to an element-like target', () => {
    const el = { lang: 'de', dir: 'ltr' };
    expect(applyDocumentLocale('ar', el)).toBe(true);
    expect(el).toEqual({ lang: 'ar', dir: 'rtl' });
    expect(applyDocumentLocale('ar', el)).toBe(false);
  });
});

describe('Intl formatters', () => {
  it('formats local dates without shifting them', () => {
    expect(formatLocalDate('2026-11-18', 'de')).toBe('Mi., 18. Nov.');
    expect(formatLocalDate('2026-11-18', 'en')).toBe('Wed 18 Nov');
    expect(formatLocalDate('2026-11-18', 'de', 'month')).toBe('November 2026');
    expect(formatLocalDate('2026-11-18', 'de', 'day-title')).toBe('Mittwoch, 18. November');
    expect(formatLocalDate('2026-11-18', 'en', 'day-title')).toBe('Wednesday 18 November');
    expect(formatLocalDateRange('2026-11-14', '2026-11-17', 'de')).toMatch(/14\.\s*[–-]\s*17\. Nov\. 2026/);
  });

  it('formats times in the traveler zone', () => {
    expect(formatTime('2026-11-14T01:40:00Z', 'Asia/Ho_Chi_Minh', 'de')).toBe('08:40');
    expect(formatTime('2026-11-11T23:30:00Z', 'Europe/Berlin', 'en')).toBe('00:30');
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-11-19T12:00:00Z');
    expect(formatRelative('2026-11-19T11:55:00Z', 'de', now)).toBe('vor 5 Minuten');
    expect(formatRelative('2026-11-18T12:00:00Z', 'en', now)).toBe('yesterday');
  });

  it('names countries and languages', () => {
    expect(countryName('VN', 'de')).toBe('Vietnam');
    expect(countryName('de', 'en')).toBe('Germany');
    expect(languageName('vi', 'de')).toBe('Vietnamesisch');
    expect(countryFlag('vn')).toBe('🇻🇳');
    expect(countryFlag('V1')).toBe('');
  });
});
