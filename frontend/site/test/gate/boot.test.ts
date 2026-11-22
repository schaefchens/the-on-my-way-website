// @vitest-environment jsdom
/** GateBoot parsing (structural, no zod in the bundle) and the language choice. */
import { GateBoot } from '@omw/contracts/access';
import { describe, expect, it } from 'vitest';
import { parseGateBoot, readGateBoot } from '../../src/gate/boot';
import { pickLocale } from '../../src/gate/dom';
import { gateBoot } from './harness';

describe('parseGateBoot', () => {
  it('accepts what the contract accepts', () => {
    for (const boot of [
      gateBoot('join'),
      gateBoot('me', { cookieMode: 'co', cookieDomain: 'site.example' }),
      gateBoot('panic', { locales: ['en'], defaultLocale: 'en' }),
    ]) {
      expect(GateBoot.safeParse(boot).success).toBe(true);
      expect(parseGateBoot(JSON.stringify(boot))).toEqual(boot);
    }
  });

  it('refuses malformed boot data', () => {
    const good = gateBoot('join');
    const bad: unknown[] = [
      { ...good, page: 'h' },
      { ...good, api: 'https://api.example.org/other/' },
      { ...good, api: 'javascript:alert(1)//api/v1/public/' },
      { ...good, locales: [] },
      { ...good, locales: ['fr'] },
      { ...good, defaultLocale: 'xx' },
      { ...good, cookieMode: 'cookie' },
      { ...good, cookieDomain: 'Evil; Path=/' },
      { ...good, cookies: { ...good.cookies, key: 'a;b' } },
      { ...good, cookies: { ...good.cookies, secure: 'yes' } },
      { ...good, build: '' },
      [],
      null,
    ];
    for (const value of bad) {
      expect(parseGateBoot(JSON.stringify(value)), JSON.stringify(value)).toBeNull();
      if (value !== null && !Array.isArray(value)) expect(GateBoot.safeParse(value).success).toBe(false);
    }
    expect(parseGateBoot('{not json')).toBeNull();
    expect(parseGateBoot(null)).toBeNull();
  });

  it('reads the boot element of the page', () => {
    document.body.innerHTML = '';
    const script = document.createElement('script');
    script.type = 'application/json';
    script.id = 'omw-gate';
    script.textContent = JSON.stringify(gateBoot('wait'));
    document.body.append(script);
    expect(readGateBoot(document)?.page).toBe('wait');
  });
});

describe('pickLocale', () => {
  const boot = { locales: ['de', 'en'] as ('de' | 'en')[], defaultLocale: 'de' as const };
  it('prefers the stored choice, then the browser languages, then the default', () => {
    expect(pickLocale(boot, ['en-US'], 'de')).toBe('de');
    expect(pickLocale(boot, ['fr-FR', 'en-GB'], null)).toBe('en');
    expect(pickLocale(boot, ['fr-FR'], null)).toBe('de');
    expect(pickLocale(boot, ['en'], 'ar')).toBe('en');
    expect(pickLocale({ locales: ['en'], defaultLocale: 'en' }, ['de-DE'], 'de')).toBe('en');
  });
});
