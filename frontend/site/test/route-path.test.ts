import { routePath } from '@omw/contracts/site';
import { describe, expect, it } from 'vitest';
import { parseRoutePath, stripBasePath } from '../src/route-path';

describe('parseRoutePath', () => {
  it('round-trips the contracts routePath for every route kind', () => {
    const cases = [
      { name: 'home' as const },
      { name: 'day' as const, date: '2026-11-18' },
      { name: 'story' as const, date: '2026-11-18', id: 'p_s01lantern' },
      { name: 'trip' as const, slug: 'vietnam-2026' },
    ];
    for (const base of ['/', '/travel/']) {
      for (const route of cases) {
        const parsed = parseRoutePath(base + routePath('en', route), base);
        const { name, ...params } = route;
        expect(parsed).toEqual({ locale: 'en', name, params });
      }
    }
  });

  it('accepts missing trailing slashes, query strings and hashes', () => {
    expect(parseRoutePath('/de/day/2026-11-18?x=1#y')?.name).toBe('day');
  });

  it('rejects unknown shapes and paths outside the basePath', () => {
    expect(parseRoutePath('/')).toBeNull();
    expect(parseRoutePath('/de/day/18-11-2026/')).toBeNull();
    expect(parseRoutePath('/de/day/2026-11-18/story/e_abc/')).toBeNull();
    expect(parseRoutePath('/de/media/x')).toBeNull();
    expect(parseRoutePath('/other/de/', '/travel/')).toBeNull();
    expect(stripBasePath('/travel', '/travel/')).toBe('/');
  });
});
