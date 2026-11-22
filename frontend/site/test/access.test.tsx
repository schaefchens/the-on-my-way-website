/**
 * SPA access layer (spec-wave5 §6.3): AccessEndedError (403 and the neutral page instead of
 * JSON), onAccessEnded's branches, the visit pings (me/hello: 5-minute tab throttle, after a
 * handoff, after ≥ 30 minutes hidden), the gate-mode header menu and footer, the hero for the
 * four "here now" values, part-of-day labels and Boot.access parsing.
 */
import { I18nProvider } from '@lingui/react';
import type { BootAccess, DaySummary } from '@omw/contracts/site';
import { Boot } from '@omw/contracts/site';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessState, configureAccess, onAccessEnded, resetAccessForTests } from '../src/access/access';
import { AccessEndedScreen } from '../src/access/ended-screen';
import { followerName, HELLO_AFTER_HIDDEN_MS, startHello } from '../src/access/hello';
import { parseBootAccess, parseBootJson, type SiteBoot } from '../src/boot';
import { AccessMenu, LatestPlace, ScreenHeader, SiteFooter } from '../src/components/site-header';
import { formatRelativeDays, partOfDayLabel } from '../src/components/time-labels';
import { AccessEndedError, DataFetchError, fetchManifest } from '../src/data/fetch';
import { manifestPollInterval } from '../src/data/queries';
import { createPublicApi } from '../src/gate/api';
import { GateCookies } from '../src/gate/cookies';
import { activateLocale, i18n } from '../src/i18n';
import { createQueryClient, createSiteContext, type SiteContextValue, SiteProvider, shouldRetry } from '../src/site';

const K = 'kKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkK_-9';
const API = 'https://api.example.org/api/v1/public/';
const ACCESS: BootAccess = {
  api: API,
  cookies: { key: '__Host-omw_k', transfer: '__Host-omw_s', handoff: '__Host-omw_h' },
  cookieMode: 'headers',
  cookieDomain: null,
};

/** A minimal cookie jar: `cookie` reads "a=1; b=2", writes one Set-Cookie-like string. */
class Jar {
  readonly values = new Map<string, string>();
  readonly writes: string[] = [];
  get cookie(): string {
    return [...this.values].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  set cookie(line: string) {
    this.writes.push(line);
    const [pair = '', ...attrs] = line.split('; ');
    const eq = pair.indexOf('=');
    const name = pair.slice(0, eq);
    if (attrs.includes('Max-Age=0')) this.values.delete(name);
    else this.values.set(name, pair.slice(eq + 1));
  }
}

function fakeHello(answers: unknown[]) {
  const calls: unknown[] = [];
  const queue = [...answers];
  const fetch = async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    const answer = queue.length > 1 ? queue.shift() : queue[0];
    if (answer === 'network') throw new TypeError('offline');
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const api = createPublicApi({
    api: API,
    cookieMode: 'headers',
    fetch,
    schedule: (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  });
  return { api, calls };
}

const ACTIVE = (required = false) => ({
  status: 'active',
  follower: { name: 'Oma' },
  device: { id: 'qrst2345', label: 'iPhone · Safari' },
  notice: { version: 2, required },
});

function navigator() {
  const navs: string[] = [];
  return {
    navs,
    navigate: { replace: (u: string) => navs.push(`replace ${u}`), assign: (u: string) => navs.push(`assign ${u}`) },
  };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  resetAccessForTests();
  followerName.set(null);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AccessEndedError', () => {
  it('is thrown for 403 and for a 200 that is not JSON (the neutral page)', async () => {
    const forbidden = async () =>
      new Response('Forbidden\n', { status: 403, headers: { 'Content-Type': 'text/plain' } });
    await expect(fetchManifest('/x/', { fetch: forbidden })).rejects.toBeInstanceOf(AccessEndedError);
    const neutral = async () =>
      new Response('<!doctype html><title>Privat · Private</title>', { headers: { 'Content-Type': 'text/html' } });
    const err = await fetchManifest('/x/', { fetch: neutral }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccessEndedError);
    expect(err).toBeInstanceOf(DataFetchError);
    // Broken JSON served as JSON stays an ordinary data error; a 404 too.
    const broken = async () => new Response('{', { headers: { 'Content-Type': 'application/json' } });
    expect(await fetchManifest('/x/', { fetch: broken }).catch((e: unknown) => e)).not.toBeInstanceOf(AccessEndedError);
    const missing = async () => new Response('', { status: 404 });
    expect(await fetchManifest('/x/', { fetch: missing }).catch((e: unknown) => e)).not.toBeInstanceOf(
      AccessEndedError,
    );
  });

  it('is never retried and stops the manifest poll', () => {
    const err = new AccessEndedError('/data/manifest.json', 403);
    expect(shouldRetry(0, err)).toBe(false);
    expect(shouldRetry(0, new DataFetchError('/x', 0))).toBe(true);
    expect(manifestPollInterval(err)).toBe(false);
    expect(manifestPollInterval(null)).toBe(5 * 60_000);
    accessState.set('checking');
    expect(manifestPollInterval(null)).toBe(false);
  });

  it('a refused query (any query) starts the access check', async () => {
    const queryClient = createQueryClient();
    configureAccess({ access: null, queryClient });
    await queryClient
      .fetchQuery({ queryKey: ['x'], queryFn: () => Promise.reject(new AccessEndedError('/x', 403)), retry: false })
      .catch(() => undefined);
    await flush();
    expect(accessState.get()).toBe('unavailable');
  });
});

describe('onAccessEnded', () => {
  function setup(answers: unknown[], key: string | null = K) {
    const jar = new Jar();
    if (key) jar.values.set('__Host-omw_k', key);
    const { api, calls } = fakeHello(answers);
    const { navs, navigate } = navigator();
    const queryClient = createQueryClient();
    queryClient.setQueryData(['omw', 'timeline', 'v1'], { days: [] });
    configureAccess({
      access: ACCESS,
      queryClient,
      api,
      cookies: new GateCookies(jar, ACCESS.cookies, { secure: true, domain: null }),
      navigate,
    });
    return { calls, navs, queryClient };
  }

  it('open mode: unavailable, no request', async () => {
    configureAccess({ access: null, queryClient: createQueryClient() });
    await onAccessEnded();
    expect(accessState.get()).toBe('unavailable');
  });

  it('empties the query cache before asking', async () => {
    const { queryClient, calls } = setup([{ status: 'unavailable', reason: 'locked' }]);
    await onAccessEnded();
    expect(queryClient.getQueryData(['omw', 'timeline', 'v1'])).toBeUndefined();
    expect(calls).toEqual([{ k: K }]);
  });

  it('unavailable → locked; ended → /_/ended/; active → resume; network or no key → unavailable', async () => {
    setup([{ status: 'unavailable', reason: 'locked' }]);
    await onAccessEnded();
    expect(accessState.get()).toBe('locked');

    resetAccessForTests();
    let s = setup([{ status: 'ended' }]);
    await onAccessEnded();
    expect(s.navs).toEqual(['replace /_/ended/']);

    resetAccessForTests();
    s = setup([ACTIVE()]);
    await onAccessEnded();
    expect(s.navs).toEqual(['replace /_/join/#resume']);

    resetAccessForTests();
    setup(['network']);
    await onAccessEnded();
    expect(accessState.get()).toBe('unavailable');

    resetAccessForTests();
    s = setup([ACTIVE()], null);
    await onAccessEnded();
    expect(accessState.get()).toBe('unavailable');
    expect(s.calls).toEqual([]);
  });

  it('asks once, however many requests were refused', async () => {
    const { calls } = setup([{ status: 'unavailable', reason: 'locked' }]);
    await Promise.all([onAccessEnded(), onAccessEnded(), onAccessEnded()]);
    await onAccessEnded();
    expect(calls).toHaveLength(1);
  });
});

describe('me/hello (visits)', () => {
  function setup(answers: unknown[], opts: { handoff?: boolean; key?: boolean } = {}) {
    const jar = new Jar();
    if (opts.key !== false) jar.values.set('__Host-omw_k', K);
    if (opts.handoff) {
      jar.values.set('__Host-omw_h', '1');
      jar.values.set('__Host-omw_s', 'abcdefgh2345.qrst2345.A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0-_z');
    }
    const { api, calls } = fakeHello(answers);
    const { navs, navigate } = navigator();
    const store = new Map<string, string>();
    const session = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    let now = 1_800_000_000_000;
    let idle: (() => void) | null = null;
    let visibility: ((hidden: boolean) => void) | null = null;
    const start = () =>
      startHello({
        api,
        cookies: new GateCookies(jar, ACCESS.cookies, { secure: true, domain: null }),
        navigate,
        session,
        now: () => now,
        idle: (cb) => {
          idle = cb;
          return () => {
            idle = null;
          };
        },
        onVisibility: (cb) => {
          visibility = cb;
          return () => {
            visibility = null;
          };
        },
        pathname: () => '/abcdefghij0123456789/de/day/2026-11-15/',
      });
    return {
      jar,
      calls,
      navs,
      store,
      start,
      runIdle: () => idle?.(),
      setHidden: (h: boolean) => visibility?.(h),
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('says hello on start (when idle) and stores the name for the footer', async () => {
    const t = setup([ACTIVE()]);
    t.start();
    expect(t.calls).toEqual([]);
    t.runIdle();
    await flush();
    expect(t.calls).toEqual([{ k: K }]);
    expect(t.store.get('omw.name')).toBe('Oma');
    expect(followerName.get()).toBe('Oma');
    expect(t.navs).toEqual([]);
  });

  it('at most once per 5 minutes per tab', async () => {
    const t = setup([ACTIVE()]);
    t.start();
    t.runIdle();
    await flush();
    t.advance(4 * 60_000);
    t.start();
    t.runIdle();
    await flush();
    expect(t.calls).toHaveLength(1);
    t.advance(60_000);
    t.start();
    t.runIdle();
    await flush();
    expect(t.calls).toHaveLength(2);
  });

  it('always right after a handoff, and deletes the handoff and transfer cookies first', async () => {
    const t = setup([ACTIVE()], { handoff: true });
    t.store.set('omw.helloAt', String(1_800_000_000_000));
    t.start();
    t.runIdle();
    await flush();
    expect(t.calls).toHaveLength(1);
    expect(t.jar.values.has('__Host-omw_h')).toBe(false);
    expect(t.jar.values.has('__Host-omw_s')).toBe(false);
    expect(t.jar.writes).toContain('__Host-omw_h=; Path=/; Max-Age=0; SameSite=Strict; Secure');
  });

  it('again when the tab comes back after 30 minutes hidden', async () => {
    const t = setup([ACTIVE()]);
    t.start();
    t.runIdle();
    await flush();
    t.setHidden(true);
    t.advance(HELLO_AFTER_HIDDEN_MS - 1);
    t.setHidden(false);
    await flush();
    expect(t.calls).toHaveLength(1);
    t.setHidden(true);
    t.advance(HELLO_AFTER_HIDDEN_MS);
    t.setHidden(false);
    await flush();
    expect(t.calls).toHaveLength(2);
  });

  it('a changed notice goes to the info screen and back to this page', async () => {
    const t = setup([ACTIVE(true)]);
    t.start();
    t.runIdle();
    await flush();
    expect(t.navs).toEqual(['assign /_/info/#reconfirm&return=%2Fabcdefghij0123456789%2Fde%2Fday%2F2026-11-15%2F']);
  });

  it('ended → /_/ended/; errors and a missing key are ignored', async () => {
    let t = setup([{ status: 'ended' }]);
    t.start();
    t.runIdle();
    await flush();
    expect(t.navs).toEqual(['replace /_/ended/']);
    t = setup(['network']);
    t.start();
    t.runIdle();
    await flush();
    expect(t.navs).toEqual([]);
    t = setup([ACTIVE()], { key: false });
    t.start();
    t.runIdle();
    await flush();
    expect(t.calls).toEqual([]);
  });
});

function siteWith(access: BootAccess | null): SiteContextValue {
  const boot: SiteBoot = {
    basePath: '/abcdefghij0123456789/',
    locale: 'de',
    route: null,
    manifestVersion: 1,
    timelineV: null,
    day: null,
    profile: null,
    access,
    source: 'document',
  };
  return createSiteContext(boot, createQueryClient());
}

function render(site: SiteContextValue, node: React.ReactNode): string {
  return renderToStaticMarkup(
    <SiteProvider value={site}>
      <QueryClientProvider client={site.queryClient}>
        <I18nProvider i18n={i18n}>{node}</I18nProvider>
      </QueryClientProvider>
    </SiteProvider>,
  );
}

describe('gate-mode chrome', () => {
  beforeEach(async () => {
    await activateLocale('de');
  });

  it('the header menu exists only in gate mode', () => {
    const gate = render(siteWith(ACCESS), <ScreenHeader locale="de" />);
    expect(gate).toContain('data-testid="access-menu"');
    expect(gate).toContain('href="/_/me/"');
    expect(gate).toContain('href="/_/me/#signout"');
    expect(gate).toContain('Deine Daten');
    expect(gate).toContain('Auf diesem Gerät abmelden');
    const open = render(siteWith(null), <ScreenHeader locale="de" />);
    expect(open).not.toContain('access-menu');
    expect(open).not.toContain('/_/me/');
  });

  it('the footer names the person once known, in gate mode only', () => {
    expect(render(siteWith(ACCESS), <SiteFooter />)).toBe('');
    followerName.set('Oma');
    expect(render(siteWith(ACCESS), <SiteFooter />)).toContain('Persönlich geteilt mit <bdi>Oma</bdi>');
    expect(render(siteWith(ACCESS), <AccessMenu />)).toContain('Persönlich geteilt mit');
    expect(render(siteWith(null), <SiteFooter />)).toBe('');
  });

  it('the access screens', () => {
    const locked = render(siteWith(ACCESS), <AccessEndedScreen state="locked" gate />);
    expect(locked).toContain('Die Reise ist gerade nicht verfügbar.');
    expect(locked).toContain('href="/_/me/"');
    expect(render(siteWith(null), <AccessEndedScreen state="unavailable" gate={false} />)).not.toContain('/_/me/');
  });
});

describe('hero: here now', () => {
  const NOW = Date.parse('2026-11-20T12:00:00.000Z');
  const day = (over: Partial<DaySummary> = {}) =>
    ({
      date: '2026-11-20',
      place: 'Hội An',
      country: 'VN',
      tz: 'Asia/Ho_Chi_Minh',
      firstAt: '2026-11-20T01:00:00.000Z',
      lastAt: '2026-11-20T11:48:00.000Z',
      ...over,
    }) as DaySummary;
  const hero = (
    hereNow: 'city_badge' | 'city' | 'country' | 'none',
    d = day(),
    timePrecision: 'exact' | 'part_of_day' = 'exact',
  ) =>
    render(
      siteWith(ACCESS),
      <LatestPlace day={d} locale="de" now={NOW} hereNow={hereNow} timePrecision={timePrecision} />,
    );

  beforeEach(async () => {
    await activateLocale('de');
  });

  it('city_badge: live pill with the relative time (today)', () => {
    const html = hero('city_badge');
    expect(html).toContain('data-live');
    expect(html).toContain('Gerade in');
    expect(html).toContain('Hội An');
    expect(html).toMatch(/vor 12 Minuten/);
  });

  it('city_badge with part-of-day precision: days only', () => {
    expect(hero('city_badge', day(), 'part_of_day')).toContain('heute');
    expect(hero('city_badge', day(), 'part_of_day')).not.toMatch(/Minute/);
  });

  it('city: "Zuletzt in {place}" without live styling or relative time', () => {
    const html = hero('city');
    expect(html).not.toContain('data-live');
    expect(html).toContain('Zuletzt in');
    expect(html).toContain('Hội An');
    expect(html).not.toMatch(/vor \d+/);
  });

  it('country: "Zuletzt in {flag} {country}"', () => {
    const html = hero('country', day({ place: undefined }));
    expect(html).toContain('Zuletzt in');
    expect(html).toContain('🇻🇳');
    expect(html).toContain('Vietnam');
    expect(html).not.toContain('Hội An');
  });

  it('none: no pill', () => {
    expect(hero('none')).toBe('');
  });
});

describe('part-of-day labels', () => {
  it('name the part of the day in the traveler zone', async () => {
    await activateLocale('de');
    expect(partOfDayLabel('2026-11-20T01:30:00.000Z', 'Asia/Ho_Chi_Minh')).toBe('morgens'); // 08:30
    expect(partOfDayLabel('2026-11-20T05:00:00.000Z', 'Asia/Ho_Chi_Minh')).toBe('mittags'); // 12:00
    expect(partOfDayLabel('2026-11-20T08:00:00.000Z', 'Asia/Ho_Chi_Minh')).toBe('nachmittags'); // 15:00
    expect(partOfDayLabel('2026-11-20T11:00:00.000Z', 'Asia/Ho_Chi_Minh')).toBe('abends'); // 18:00
    expect(partOfDayLabel('2026-11-20T16:00:00.000Z', 'Asia/Ho_Chi_Minh')).toBe('nachts'); // 23:00
    await activateLocale('en');
    expect(partOfDayLabel('2026-11-20T01:30:00.000Z', 'Asia/Ho_Chi_Minh')).toBe('in the morning');
    expect(partOfDayLabel('nonsense', 'Asia/Ho_Chi_Minh')).toBe('');
  });

  it('relative days: today, yesterday, n days ago', () => {
    const now = new Date(2026, 10, 20, 12, 0).getTime();
    expect(formatRelativeDays(new Date(2026, 10, 20, 0, 5).toISOString(), 'de', now)).toBe('heute');
    expect(formatRelativeDays(new Date(2026, 10, 19, 23, 55).toISOString(), 'de', now)).toBe('gestern');
    expect(formatRelativeDays(new Date(2026, 10, 17, 9, 0).toISOString(), 'de', now)).toBe('vor 3 Tagen');
    expect(formatRelativeDays(new Date(2026, 10, 19, 9, 0).toISOString(), 'en', now)).toBe('yesterday');
  });
});

describe('Boot.access', () => {
  const base = {
    basePath: '/abcdefghij0123456789/',
    locale: 'de',
    route: { name: 'home', params: {} },
    manifestVersion: 3,
    timelineV: 'de6ce259c71ad5ca',
  };

  it('is read like the contract defines it', () => {
    const raw = { ...base, access: ACCESS };
    expect(Boot.safeParse(raw).success).toBe(true);
    expect(parseBootJson(JSON.stringify(raw))?.access).toEqual(ACCESS);
    expect(parseBootJson(JSON.stringify(base))?.access).toBeNull();
    const f1 = {
      ...ACCESS,
      cookieMode: 'co' as const,
      cookieDomain: 'site.example',
      cookies: { key: 'omw_k', transfer: 'omw_s', handoff: 'omw_h' },
    };
    expect(parseBootAccess(f1)).toEqual(f1);
  });

  it('a malformed access block means open mode (no API calls)', () => {
    for (const bad of [
      { ...ACCESS, api: 'https://evil.example/' },
      { ...ACCESS, cookieMode: 'x' },
      { ...ACCESS, cookieDomain: 'a; b' },
      { ...ACCESS, cookies: { ...ACCESS.cookies, key: 'a=b' } },
      'gate',
    ]) {
      expect(parseBootAccess(bad)).toBeNull();
    }
  });
});
