import {
  dayDataPath,
  MANIFEST_PATH,
  resolveSitePath,
  TIMELINE_PATH,
  tripDataPath,
  withVersion,
} from '@omw/contracts/site';
import { describe, expect, it } from 'vitest';
import { DATA_PATHS } from '../src/config';
import { dayUrl, manifestUrl, siteUrl, timelineUrl, tripUrl } from '../src/data/urls';

const BASES = ['/', '/travel/', '/a/b/'];

describe('data URLs (D3)', () => {
  it('use the same relative paths as the contracts', () => {
    expect(DATA_PATHS.manifest).toBe(MANIFEST_PATH);
    expect(DATA_PATHS.timeline).toBe(TIMELINE_PATH);
  });

  it('prefix the runtime basePath and append the content hash', () => {
    for (const base of BASES) {
      expect(timelineUrl(base, 'abc123')).toBe(resolveSitePath(base, withVersion(TIMELINE_PATH, 'abc123')));
      expect(dayUrl(base, '2026-11-18', 'v1234')).toBe(
        resolveSitePath(base, withVersion(dayDataPath('2026-11-18'), 'v1234')),
      );
      expect(tripUrl(base, 'vietnam-2026', 'v1234')).toBe(
        resolveSitePath(base, withVersion(tripDataPath('vietnam-2026'), 'v1234')),
      );
    }
    expect(dayUrl('/travel/', '2026-11-18', 'de6ce259c71ad5ca')).toBe(
      '/travel/data/days/2026-11-18.json?v=de6ce259c71ad5ca',
    );
    expect(siteUrl('/travel/', 'media/ab/x_w320.avif')).toBe('/travel/media/ab/x_w320.avif');
  });

  it('cache-busts the manifest with a timestamp instead of a hash', () => {
    expect(manifestUrl('/travel/', 1_763_600_000_123)).toBe('/travel/data/manifest.json?t=1763600000123');
  });

  it('rejects malformed input instead of building odd URLs', () => {
    expect(() => dayUrl('/', '2026-11-1', 'abcd')).toThrow(RangeError);
    expect(() => dayUrl('/', '../x', 'abcd')).toThrow(RangeError);
    expect(() => tripUrl('/', 'Vietnam', 'abcd')).toThrow(RangeError);
    expect(() => timelineUrl('/', 'a b')).toThrow(RangeError);
    expect(() => timelineUrl('travel/', 'abcd')).toThrow(RangeError);
  });
});
