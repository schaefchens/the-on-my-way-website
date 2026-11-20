import { Boot, BOOT_ELEMENT_ID as CONTRACT_BOOT_ID } from '@omw/contracts/site';
import { describe, expect, it } from 'vitest';
import { fallbackBoot, parseBootJson, readBoot } from '../src/boot';
import { BOOT_ELEMENT_ID } from '../src/config';
import { validateBoot } from '../src/data/validate.dev';

const valid = {
  basePath: '/travel/',
  locale: 'de',
  route: { name: 'day', params: { date: '2026-11-15' } },
  manifestVersion: 7,
  timelineV: 'de6ce259c71ad5ca',
};

describe('boot JSON', () => {
  it('uses the contracts element id', () => {
    expect(BOOT_ELEMENT_ID).toBe(CONTRACT_BOOT_ID);
  });

  it('parses a contract-valid boot', () => {
    expect(Boot.safeParse(valid).success).toBe(true);
    const boot = parseBootJson(JSON.stringify(valid));
    expect(boot).toMatchObject({
      basePath: '/travel/',
      locale: 'de',
      route: { name: 'day', params: { date: '2026-11-15' } },
      manifestVersion: 7,
      timelineV: 'de6ce259c71ad5ca',
      day: null,
      source: 'document',
    });
    expect(boot && validateBoot(boot)).toBe(true);
  });

  it('reads it from the document', () => {
    const doc = { getElementById: (id: string) => (id === 'omw-boot' ? { textContent: JSON.stringify(valid) } : null) };
    expect(readBoot(doc)?.basePath).toBe('/travel/');
    expect(readBoot({ getElementById: () => null })).toBeNull();
  });

  it('rejects broken or foreign boot data', () => {
    expect(parseBootJson('')).toBeNull();
    expect(parseBootJson('{')).toBeNull();
    expect(parseBootJson('[]')).toBeNull();
    expect(parseBootJson(JSON.stringify({ ...valid, basePath: 'travel' }))).toBeNull();
    expect(parseBootJson(JSON.stringify({ ...valid, locale: 'fr' }))).toBeNull();
  });

  it('tolerates optional parts being wrong but keeps the essentials', () => {
    const boot = parseBootJson(JSON.stringify({ ...valid, manifestVersion: 0, timelineV: '?', route: 'x' }));
    expect(boot).toMatchObject({ basePath: '/travel/', manifestVersion: null, timelineV: null, route: null });
  });

  it('accepts the boot of /404.html (basePath for any URL depth)', () => {
    const notFound = { ...valid, route: { name: 'notFound', params: {} } };
    expect(Boot.safeParse(notFound).success).toBe(true);
    const boot = parseBootJson(JSON.stringify(notFound));
    expect(boot).toMatchObject({ basePath: '/travel/', route: { name: 'notFound', params: {} } });
    expect(boot && validateBoot(boot)).toBe(true);
  });

  it('derives a fallback boot from the URL', () => {
    expect(fallbackBoot('/en/day/2026-11-15/story/p_s01lantern/')).toMatchObject({
      basePath: '/',
      locale: 'en',
      route: { name: 'story', params: { date: '2026-11-15', id: 'p_s01lantern' } },
      source: 'fallback',
    });
    expect(fallbackBoot('/travel/de/', '/travel/').route).toEqual({ name: 'home', params: {} });
    expect(fallbackBoot('/')).toMatchObject({ locale: null, route: null });
  });
});
