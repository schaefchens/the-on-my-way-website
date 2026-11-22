/**
 * The anonymous-must-be-refused check (spec-wave5 §5.6.3, §8.4) with a fake fetch: pass,
 * gate_open (data answered anonymously, existing/missing differ, a page that is not the neutral
 * one), store_unverified (#4 refused, #5 still accepted), errors never fail it as gate_open, at
 * most 5 requests 2 s apart, redirects never followed, and when a check is due.
 */
import { describe, expect, it } from 'vitest';
import {
  type CheckCookie,
  GATE_CHECK_MAX_AGE_MS,
  type GateCheckOptions,
  gateCheckDue,
  runGateCheck,
} from '../../src/publisher/gatecheck.js';

const NEUTRAL = Buffer.from('<!doctype html><title>Privat · Private</title>\n');
const FORBIDDEN = Buffer.from('Forbidden\n');
const SECRET = 'k3j9x0m2p7q4r8s1t5u6';
const NEW: CheckCookie = { name: '__Host-omw', value: `abcdefghijkl.abcdefgh.${'N'.repeat(43)}` };
const OLD: CheckCookie = { name: '__Host-omw', value: `abcdefghijkl.abcdefgh.${'O'.repeat(43)}` };

interface Site {
  /** Session values Apache accepts. */
  valid: Set<string>;
  /** Anonymous data requests are answered (the gate is open). */
  open?: boolean;
  /** Missing data files answer differently (an oracle). */
  oracle?: boolean;
  /** Pages are not the neutral page. */
  pageLeak?: boolean;
  fail?: 'network' | 'timeout';
}

function fakeSite(site: Site) {
  const calls: { path: string; cookie: string | null; redirect: string | undefined }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    if (site.fail === 'network') throw new TypeError('fetch failed');
    if (site.fail === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const cookie = headers.cookie ?? null;
    const u = new URL(url);
    calls.push({ path: u.pathname, cookie, redirect: init?.redirect });
    const value = cookie?.split('=')[1];
    const allowed = site.open || (value !== undefined && site.valid.has(value));
    if (u.pathname.startsWith(`/${SECRET}/data/`)) {
      if (allowed && u.pathname.endsWith('manifest.json')) return new Response('{"version":12}', { status: 200 });
      if (site.oracle && u.pathname.includes('0000-00-00')) return new Response('Not Found\n', { status: 404 });
      return new Response(new Uint8Array(FORBIDDEN), { status: 403, headers: { 'content-length': '10' } });
    }
    return new Response(new Uint8Array(site.pageLeak ? Buffer.from('<p>home</p>') : NEUTRAL), { status: 200 });
  };
  return { fetch, calls };
}

function options(site: Site, over: Partial<GateCheckOptions> = {}) {
  const fake = fakeSite(site);
  const sleeps: number[] = [];
  const opts: GateCheckOptions = {
    fetch: fake.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => new Date('2026-11-21T10:00:00.000Z'),
    origin: 'https://site.example.org',
    secret: SECRET,
    defaultLocale: 'de',
    forbiddenBody: FORBIDDEN,
    neutralBody: NEUTRAL,
    expectedVersion: 12,
    rotateSession: async () => ({ current: NEW, previous: OLD }),
    ...over,
  };
  return { opts, calls: fake.calls, sleeps };
}

describe('runGateCheck', () => {
  it('passes: anonymous refused and neutral, the created session accepted, the deleted one refused', async () => {
    const { opts, calls, sleeps } = options({ valid: new Set([NEW.value]) });
    const r = await runGateCheck(opts);
    expect(r).toEqual({
      at: '2026-11-21T10:00:00.000Z',
      by: 'mac',
      result: 'ok',
      detail: 'gate ok; created session accepted, deleted session refused',
    });
    expect(calls.map((c) => [c.path, c.cookie])).toEqual([
      [`/${SECRET}/data/manifest.json`, null],
      [`/${SECRET}/data/days/0000-00-00.json`, null],
      [`/${SECRET}/de/`, null],
      [`/${SECRET}/data/manifest.json`, `__Host-omw=${NEW.value}`],
      [`/${SECRET}/data/manifest.json`, `__Host-omw=${OLD.value}`],
    ]);
    // At most 5 requests, 2 s apart; redirects are never followed.
    expect(sleeps).toEqual([2000, 2000, 2000, 2000]);
    expect(calls.every((c) => c.redirect === 'manual')).toBe(true);
    // The detail never names the content folder.
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('gate_open when data is answered anonymously, when existing and missing differ, or a page is not neutral', async () => {
    expect((await runGateCheck(options({ valid: new Set(), open: true }).opts)).result).toBe('gate_open');
    expect((await runGateCheck(options({ valid: new Set(), oracle: true }).opts)).result).toBe('gate_open');
    const leak = await runGateCheck(options({ valid: new Set(), pageLeak: true }).opts);
    expect(leak.result).toBe('gate_open');
    expect(leak.detail).toMatch(/not the neutral page/);
  });

  it('store_unverified when the created session is refused or the deleted one still accepted', async () => {
    const refused = await runGateCheck(options({ valid: new Set() }).opts);
    expect(refused.result).toBe('store_unverified');
    expect(refused.detail).toMatch(/just created is refused/);
    const stale = await runGateCheck(options({ valid: new Set([NEW.value, OLD.value]) }).opts);
    expect(stale.result).toBe('store_unverified');
    expect(stale.detail).toMatch(/just deleted is still accepted/);
  });

  it('a network error or timeout is "error", never gate_open', async () => {
    expect((await runGateCheck(options({ valid: new Set(), fail: 'network' }).opts)).result).toBe('error');
    const timeout = await runGateCheck(options({ valid: new Set(), fail: 'timeout' }).opts);
    expect(timeout).toMatchObject({ result: 'error' });
    expect(timeout.detail).toMatch(/timed out/);
  });

  it('without an API #4–#5 are skipped; without a previous session #5 is skipped; a failed rotation is an error', async () => {
    const noApi = options({ valid: new Set() }, { rotateSession: null });
    expect((await runGateCheck(noApi.opts)).result).toBe('skipped');
    expect(noApi.calls).toHaveLength(3);
    const first = options(
      { valid: new Set([NEW.value]) },
      { rotateSession: async () => ({ current: NEW, previous: null }) },
    );
    expect(await runGateCheck(first.opts)).toMatchObject({ result: 'ok' });
    expect(first.calls).toHaveLength(4);
    const broken = options(
      { valid: new Set() },
      {
        rotateSession: async () => {
          throw new Error('the service session was not applied within 30 s');
        },
      },
    );
    expect(await runGateCheck(broken.opts)).toMatchObject({ result: 'error', detail: expect.stringMatching(/30 s/) });
  });
});

describe('gateCheckDue', () => {
  const now = new Date('2026-11-21T10:00:00.000Z');
  const fresh = { okAt: '2026-11-21T09:00:00.000Z', configKey: 'k' };
  it('after a gate or .htaccess change, a config change, without a passed check, or after 6 h', () => {
    expect(gateCheckDue(fresh, { gateChanged: false, configKey: 'k', now })).toBe(false);
    expect(gateCheckDue(fresh, { gateChanged: true, configKey: 'k', now })).toBe(true);
    expect(gateCheckDue(fresh, { gateChanged: false, configKey: 'other', now })).toBe(true);
    expect(gateCheckDue({ okAt: null, configKey: 'k' }, { gateChanged: false, configKey: 'k', now })).toBe(true);
    const old = { okAt: new Date(now.getTime() - GATE_CHECK_MAX_AGE_MS).toISOString(), configKey: 'k' };
    expect(gateCheckDue(old, { gateChanged: false, configKey: 'k', now })).toBe(true);
  });
});
