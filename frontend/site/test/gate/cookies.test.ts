// @vitest-environment jsdom
/**
 * Cookie strings the gate JS writes (spec-wave5 §2.3.1, §6.2): exact strings per cookie mode, the
 * Domain on writes AND deletions in F1/F2, and the browser-side behaviour in jsdom.
 */
import { gateCookies } from '@omw/contracts/access';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type CookieConfig,
  deleteCookieString,
  GateCookies,
  keyCookieString,
  readCookie,
  transferCookieString,
} from '../../src/gate/cookies';
import { K, rawCookie, resetDom, SESSION } from './harness';

/** The cookie config each mode yields (as the generator derives GateBoot from the config). */
const MODES: Record<
  'headers' | 'co' | 'parent' | 'dev',
  { names: { key: string; transfer: string }; cfg: CookieConfig }
> = {
  headers: { names: { key: '__Host-omw_k', transfer: '__Host-omw_s' }, cfg: { secure: true, domain: null } },
  co: { names: { key: 'omw_k', transfer: 'omw_s' }, cfg: { secure: true, domain: 'site.example' } },
  parent: { names: { key: 'omw_k', transfer: 'omw_s' }, cfg: { secure: true, domain: 'example' } },
  dev: { names: { key: 'omw_k', transfer: 'omw_s' }, cfg: { secure: false, domain: null } },
};

describe('cookie strings per cookie mode', () => {
  it('headers (production): __Host- names, Secure, no Domain', () => {
    const { names, cfg } = MODES.headers;
    expect(keyCookieString(names.key, K, cfg)).toBe(
      `__Host-omw_k=${K}; Path=/; Max-Age=1209600; SameSite=Strict; Secure`,
    );
    expect(transferCookieString(names.transfer, SESSION, cfg)).toBe(
      `__Host-omw_s=${SESSION}; Path=/; Max-Age=120; SameSite=Strict; Secure`,
    );
    expect(deleteCookieString(names.key, cfg)).toBe('__Host-omw_k=; Path=/; Max-Age=0; SameSite=Strict; Secure');
    expect(deleteCookieString(names.transfer, cfg)).toBe('__Host-omw_s=; Path=/; Max-Age=0; SameSite=Strict; Secure');
  });

  it('co (F1): the site host as Domain on writes and deletions', () => {
    const { names, cfg } = MODES.co;
    expect(keyCookieString(names.key, K, cfg)).toBe(
      `omw_k=${K}; Path=/; Max-Age=1209600; SameSite=Strict; Secure; Domain=site.example`,
    );
    expect(transferCookieString(names.transfer, SESSION, cfg)).toBe(
      `omw_s=${SESSION}; Path=/; Max-Age=120; SameSite=Strict; Secure; Domain=site.example`,
    );
    expect(deleteCookieString(names.key, cfg)).toBe(
      'omw_k=; Path=/; Max-Age=0; SameSite=Strict; Secure; Domain=site.example',
    );
    expect(deleteCookieString(names.transfer, cfg)).toBe(
      'omw_s=; Path=/; Max-Age=0; SameSite=Strict; Secure; Domain=site.example',
    );
  });

  it('parent (F2): the parent domain as Domain on writes and deletions', () => {
    const { names, cfg } = MODES.parent;
    expect(keyCookieString(names.key, K, cfg)).toBe(
      `omw_k=${K}; Path=/; Max-Age=1209600; SameSite=Strict; Secure; Domain=example`,
    );
    expect(deleteCookieString(names.key, cfg)).toBe(
      'omw_k=; Path=/; Max-Age=0; SameSite=Strict; Secure; Domain=example',
    );
  });

  it('http loopback dev: plain names without Secure', () => {
    const { names, cfg } = MODES.dev;
    expect(keyCookieString(names.key, K, cfg)).toBe(`omw_k=${K}; Path=/; Max-Age=1209600; SameSite=Strict`);
    expect(transferCookieString(names.transfer, SESSION, cfg)).toBe(
      `omw_s=${SESSION}; Path=/; Max-Age=120; SameSite=Strict`,
    );
  });

  it('names match what the contracts derive for each origin and mode', () => {
    expect(gateCookies('https://site.example', 'headers')).toMatchObject({ ...MODES.headers.names, secure: true });
    expect(gateCookies('https://site.example', 'co')).toMatchObject({ ...MODES.co.names, secure: true });
    expect(gateCookies('http://127.0.0.1:4174', 'headers')).toMatchObject({ ...MODES.dev.names, secure: false });
  });

  it('refuses malformed values, names and domains (nothing can be injected into a cookie string)', () => {
    const cfg = MODES.headers.cfg;
    expect(() => keyCookieString('k', `${K}; Domain=evil`, cfg)).toThrow();
    expect(() => keyCookieString('k', K.slice(1), cfg)).toThrow();
    expect(() => transferCookieString('s', `${SESSION}.extra`, cfg)).toThrow();
    expect(() => keyCookieString('a;b', K, cfg)).toThrow();
    expect(() => keyCookieString('k', K, { secure: true, domain: 'evil; Path=/x' })).toThrow();
  });

  it('reads the first cookie of a name', () => {
    expect(readCookie(`a=1; __Host-omw_k=${K}; __Host-omw_k=other`, '__Host-omw_k')).toBe(K);
    expect(readCookie('x__Host-omw_k=1', '__Host-omw_k')).toBeNull();
    expect(readCookie('', 'a')).toBeNull();
  });
});

describe('GateCookies in the browser (jsdom, https)', () => {
  beforeEach(resetDom);

  it('writes, reads and deletes the key and transfer cookies', () => {
    const cookies = new GateCookies(
      document,
      { key: '__Host-omw_k', transfer: '__Host-omw_s', handoff: '__Host-omw_h' },
      { secure: true, domain: null },
    );
    expect(cookies.readKey()).toBeNull();
    cookies.writeKey(K);
    cookies.writeTransfer(SESSION);
    expect(cookies.readKey()).toBe(K);
    expect(cookies.readTransfer()).toBe(SESSION);
    cookies.deleteTransfer();
    expect(cookies.readTransfer()).toBeNull();
    cookies.deleteKey();
    expect(cookies.readKey()).toBeNull();
  });

  it('ignores a malformed stored key or transfer value', () => {
    rawCookie('__Host-omw_k=short; Path=/; Secure; SameSite=Strict');
    rawCookie('__Host-omw_s=not-a-session; Path=/; Secure; SameSite=Strict');
    const cookies = new GateCookies(
      document,
      { key: '__Host-omw_k', transfer: '__Host-omw_s', handoff: '__Host-omw_h' },
      { secure: true, domain: null },
    );
    expect(cookies.readKey()).toBeNull();
    expect(cookies.readTransfer()).toBeNull();
  });
});
