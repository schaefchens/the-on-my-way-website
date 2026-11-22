// @vitest-environment jsdom
/**
 * /_/join/ state machine (spec-wave5 §6.2.1): every join/check and join answer, the information
 * screen (D11), resume, the handoff (cookies before the navigation, no secret in any URL) and the
 * one retry after #handoff-failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HANDOFF_RETRY_KEY } from '../../src/gate/handoff';
import {
  action,
  cookieValue,
  expectSafeNavs,
  fakeApi,
  flush,
  gateBoot,
  hasAction,
  K,
  mount,
  notice,
  resetDom,
  SESSION,
  setCookie,
  T,
  testEnv,
  text,
} from './harness';

const OK = { status: 'ok', follower: { name: 'Oma' }, notice: notice(1), deviceMustWait: false };
const ACTIVE = { status: 'active', handoff: '/_/h/', session: SESSION, deviceKey: K };

beforeEach(resetDom);
afterEach(() => {
  vi.useRealTimers();
});

async function open(
  hash: string,
  api: ReturnType<typeof fakeApi>,
  opts: { userAgent?: string; boot?: Parameters<typeof gateBoot>[1] } = {},
) {
  const env = testEnv({ fetch: api.fetch, hash, ...(opts.userAgent ? { userAgent: opts.userAgent } : {}) });
  await mount(env, gateBoot('join', opts.boot));
  await flush();
  return env;
}

describe('join: personal link', () => {
  it('removes the fragment before anything else and sends t only in the body', async () => {
    const api = fakeApi({ 'join/check': OK });
    const env = await open(`#t=${T}`, api);
    expect(env.replacedUrls).toEqual(['/_/join/']);
    expect(api.calls[0]?.route).toBe('join/check');
    expect(api.calls[0]?.body).toEqual({ t: T });
    expect(api.calls[0]?.url.includes(T)).toBe(false);
    const init = api.calls[0]?.init as RequestInit;
    expect(init).toMatchObject({
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    expect(init.headers).toEqual({ 'Content-Type': 'text/plain;charset=UTF-8' });
  });

  it('shows the information screen without a pre-ticked box, then joins and hands off', async () => {
    const api = fakeApi({ 'join/check': OK, join: ACTIVE });
    const env = await open(`#t=${T}`, api);
    expect(text()).toContain('Dieser Link ist für Oma.');
    expect(text()).toContain('DE Datenschutz');
    expect(text()).toContain('Was gespeichert wird');
    expect(text()).toContain('Version 1');
    expect(text()).not.toContain('muss noch bestätigt werden');
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(document.activeElement?.tagName).toBe('H1');
    action('continue').click();
    await flush();
    expect(api.calls[1]?.route).toBe('join');
    expect(api.calls[1]?.body).toEqual({ t: T, consentVersion: 1, locale: 'de' });
    expect(env.navs).toHaveLength(1);
    const nav = env.navs[0];
    expect(nav).toMatchObject({ mode: 'replace', url: '/_/h/' });
    // Key and transfer cookies exist BEFORE the navigation.
    expect(nav?.cookies).toContain(`__Host-omw_k=${K}`);
    expect(nav?.cookies).toContain(`__Host-omw_s=${SESSION}`);
    expectSafeNavs(env);
  });

  it('sends a stored device key along', async () => {
    setCookie('__Host-omw_k', K);
    const api = fakeApi({ 'join/check': OK, join: ACTIVE });
    await open(`#t=${T}`, api);
    expect(api.calls[0]?.body).toEqual({ t: T, k: K });
    action('continue').click();
    await flush();
    expect(api.calls[1]?.body).toEqual({ t: T, k: K, consentVersion: 1, locale: 'de' });
  });

  it('a further device: says it must wait, stores the key and goes to the wait page', async () => {
    const api = fakeApi({
      'join/check': { ...OK, deviceMustWait: true },
      join: { status: 'pending', pollAfterMs: 10_000, deviceKey: K },
    });
    const env = await open(`#t=${T}`, api);
    expect(text()).toContain('Dieses Gerät muss noch bestätigt werden, bevor du die Seite sehen kannst.');
    action('continue').click();
    await flush();
    expect(cookieValue('__Host-omw_k')).toBe(K);
    expect(env.navs).toEqual([{ mode: 'replace', url: '/_/wait/', cookies: expect.stringContaining(K) }]);
    expectSafeNavs(env);
  });

  it('"Cancel" leaves to the neutral page without joining', async () => {
    const api = fakeApi({ 'join/check': OK });
    const env = await open(`#t=${T}`, api);
    action('cancel').click();
    expect(env.navs.map((n) => n.url)).toEqual(['/']);
    expect(api.routes()).toEqual(['join/check']);
  });

  it('invalid link', async () => {
    const env = await open(`#t=${T}`, fakeApi({ 'join/check': { status: 'invalid' } }));
    expect(text()).toContain('Dieser Link ist nicht (mehr) gültig. Frag die Person, die ihn dir geschickt hat.');
    expect(env.navs).toEqual([]);
  });

  it('no fragment or a malformed secret: invalid without a request', async () => {
    const api = fakeApi({});
    await open(`#t=${T.slice(2)}`, api);
    expect(text()).toContain('nicht (mehr) gültig');
    expect(api.calls).toEqual([]);
  });

  it('unavailable: locked/restoring/store/notice_missing with retry, too_many_pending without', async () => {
    for (const reason of ['locked', 'restoring', 'store', 'notice_missing'] as const) {
      resetDom();
      const api = fakeApi({ 'join/check': [{ status: 'unavailable', reason }, OK] });
      await open(`#t=${T}`, api);
      expect(text()).toContain('Gerade nicht verfügbar. Bitte später noch einmal versuchen.');
      document.querySelector<HTMLButtonElement>('button[type="button"]:not([lang])')?.click();
      await flush();
      expect(text()).toContain('Dieser Link ist für Oma.');
    }
    resetDom();
    await open(`#t=${T}`, fakeApi({ 'join/check': { status: 'unavailable', reason: 'too_many_pending' } }));
    expect(text()).toContain('Für diesen Link warten schon mehrere Geräte auf Bestätigung.');
    expect(text()).not.toContain('Erneut versuchen');
  });

  it('known device: to the page, or to the changed notice first', async () => {
    let env = await open(`#t=${T}`, fakeApi({ 'join/check': { status: 'known_device', noticeRequired: false } }));
    expect(env.navs.map((n) => n.url)).toEqual(['/']);
    resetDom();
    env = await open(`#t=${T}`, fakeApi({ 'join/check': { status: 'known_device', noticeRequired: true } }));
    expect(env.navs.map((n) => n.url)).toEqual(['/_/info/#reconfirm']);
  });

  it('pending device: back to the wait page, no second device', async () => {
    setCookie('__Host-omw_k', K);
    const api = fakeApi({ 'join/check': { status: 'pending_device' } });
    const env = await open(`#t=${T}`, api);
    expect(env.navs.map((n) => n.url)).toEqual(['/_/wait/']);
    expect(api.routes()).toEqual(['join/check']);
  });

  it('consent_outdated: shows the new notice and joins with its version', async () => {
    const api = fakeApi({
      'join/check': OK,
      join: (body) => (body.consentVersion === 1 ? { status: 'consent_outdated', notice: notice(2) } : ACTIVE),
    });
    const env = await open(`#t=${T}`, api);
    action('continue').click();
    await flush();
    expect(text()).toContain('Die Datenschutzhinweise haben sich gerade geändert.');
    expect(text()).toContain('Version 2');
    action('continue').click();
    await flush();
    expect(api.calls[2]?.body).toMatchObject({ consentVersion: 2 });
    expect(env.navs.map((n) => n.url)).toEqual(['/_/h/']);
  });

  it('ended → /_/ended/', async () => {
    const env = await open(`#t=${T}`, fakeApi({ 'join/check': OK, join: { status: 'ended' } }));
    action('continue').click();
    await flush();
    expect(env.navs.map((n) => n.url)).toEqual(['/_/ended/']);
  });

  it('active without handoff (F2 or a session already in place) → /', async () => {
    const env = await open(
      `#t=${T}`,
      fakeApi({ 'join/check': OK, join: { status: 'active', handoff: '/', deviceKey: K } }),
    );
    action('continue').click();
    await flush();
    expect(env.navs.map((n) => n.url)).toEqual(['/']);
    expect(cookieValue('__Host-omw_k')).toBe(K);
    expect(cookieValue('__Host-omw_s')).toBeNull();
  });

  it('activating: polls until active, then hands off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const api = fakeApi({
      'join/check': OK,
      join: { status: 'activating', pollAfterMs: 3000, deviceKey: K },
      'device/poll': [
        { status: 'activating', pollAfterMs: 3000 },
        { status: 'active', handoff: '/_/h/', session: SESSION },
      ],
    });
    const env = await open(`#t=${T}`, api);
    action('continue').click();
    await flush();
    expect(cookieValue('__Host-omw_k')).toBe(K);
    expect(text()).toContain('gleich geht’s weiter');
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(api.routes()).toEqual(['join/check', 'join', 'device/poll']);
    expect(api.calls[2]?.body).toEqual({ k: K });
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(env.navs.map((n) => n.url)).toEqual(['/_/h/']);
    expect(env.navs[0]?.cookies).toContain(`__Host-omw_s=${SESSION}`);
    expectSafeNavs(env);
  });

  it('activating for more than 2 minutes: "taking longer" with a retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const api = fakeApi({
      'join/check': OK,
      join: { status: 'activating', pollAfterMs: 30_000, deviceKey: K },
      'device/poll': { status: 'activating', pollAfterMs: 30_000 },
    });
    const env = await open(`#t=${T}`, api);
    action('continue').click();
    await flush();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      await flush();
    }
    expect(text()).toContain('Dauert länger als gedacht');
    const polls = api.routes().filter((r) => r === 'device/poll').length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.routes().filter((r) => r === 'device/poll').length).toBe(polls);
    expect(env.navs).toEqual([]);
  });

  it('shows the in-app browser hint', async () => {
    await open(`#t=${T}`, fakeApi({ 'join/check': OK }), {
      userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Instagram 300.0',
    });
    expect(text()).toContain('Öffne den Link am besten in Safari oder Chrome');
  });

  it('renders notice texts as text, never as HTML', async () => {
    const evil = notice(1, {
      texts: {
        de: {
          title: '<b>Titel</b>',
          intro: '<img src=x onerror="window.__pwned=1">\n\n<script>window.__pwned=2</script>',
          collected: 'a',
          audience: 'b',
          purpose: 'c',
          retention: 'd',
          rights: 'e',
        },
      },
      controller: { name: '<i>X</i>', email: 'x@example.org' },
    });
    await open(`#t=${T}`, fakeApi({ 'join/check': { ...OK, follower: { name: '<em>Oma</em>' }, notice: evil } }));
    const root = document.getElementById('omw-gate-root') as HTMLElement;
    expect(root.querySelector('img, script, b, i, em')).toBeNull();
    expect(text()).toContain('<img src=x onerror="window.__pwned=1">');
    expect(text()).toContain('Dieser Link ist für <em>Oma</em>.');
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(root.querySelector('a[href="mailto:x@example.org"]')).not.toBeNull();
  });

  it('switches the language and re-renders the screen', async () => {
    await open(`#t=${T}`, fakeApi({ 'join/check': OK }));
    expect(document.documentElement.lang).toBe('de');
    const en = document.querySelector<HTMLButtonElement>('button[lang="en"]') as HTMLButtonElement;
    en.focus();
    en.click();
    expect(document.documentElement.lang).toBe('en');
    expect(document.activeElement).toBe(en);
    expect(en.getAttribute('aria-pressed')).toBe('true');
    expect(text()).toContain('This link is for Oma.');
    expect(text()).toContain('EN Datenschutz');
    expect(window.localStorage.getItem('omw.gate.lang')).toBe('en');
  });

  it('network error and 429 show their messages with a retry', async () => {
    await open(`#t=${T}`, fakeApi({ 'join/check': [{ network: true }, OK] }));
    expect(text()).toContain('Keine Verbindung.');
    expect(hasAction('continue')).toBe(false);
    document.querySelector<HTMLButtonElement>('section button')?.click();
    await flush();
    expect(text()).toContain('Dieser Link ist für Oma.');
    resetDom();
    await open(`#t=${T}`, fakeApi({ 'join/check': { http: 429, retryAfter: 60 } }));
    expect(text()).toContain('Zu viele Versuche. Bitte später noch einmal.');
  });

  it('parent cookie mode sends credentials (F2 only)', async () => {
    const api = fakeApi({ 'join/check': OK });
    await open(`#t=${T}`, api, { boot: { cookieMode: 'parent', cookieDomain: 'example' } });
    expect(api.calls[0]?.init.credentials).toBe('include');
  });
});

describe('join: resume', () => {
  it('without a key: invalid, no request', async () => {
    const api = fakeApi({});
    await open('#resume', api);
    expect(text()).toContain('nicht (mehr) gültig');
    expect(api.calls).toEqual([]);
  });

  it('with a key: join {resume, k} and hand off', async () => {
    setCookie('__Host-omw_k', K);
    const api = fakeApi({ join: { status: 'active', handoff: '/_/h/', session: SESSION } });
    const env = await open('#resume', api);
    expect(api.calls[0]?.body).toEqual({ resume: true, k: K, locale: 'de' });
    expect(env.navs.map((n) => n.url)).toEqual(['/_/h/']);
    expect(env.navs[0]?.cookies).toContain(`__Host-omw_s=${SESSION}`);
    expectSafeNavs(env);
  });

  it('revoked device → ended; locked → unavailable', async () => {
    setCookie('__Host-omw_k', K);
    let env = await open('#resume', fakeApi({ join: { status: 'ended' } }));
    expect(env.navs.map((n) => n.url)).toEqual(['/_/ended/']);
    resetDom();
    setCookie('__Host-omw_k', K);
    env = await open('#resume', fakeApi({ join: { status: 'unavailable', reason: 'locked' } }));
    expect(text()).toContain('Gerade nicht verfügbar');
    expect(env.navs).toEqual([]);
  });
});

describe('join: #handoff-failed', () => {
  it('retries once after 2 s while the transfer cookie lives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    setCookie('__Host-omw_s', SESSION);
    const api = fakeApi({});
    const env = testEnv({ fetch: api.fetch, hash: '#handoff-failed' });
    void mount(env, gateBoot('join'));
    await flush();
    expect(env.replacedUrls).toEqual(['/_/join/']);
    expect(env.navs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(env.navs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(env.navs.map((n) => n.url)).toEqual(['/_/h/']);
    expect(window.sessionStorage.getItem(HANDOFF_RETRY_KEY)).toBe('1');
    expect(api.calls).toEqual([]);
  });

  it('after the retry, or without a transfer cookie: to /', async () => {
    setCookie('__Host-omw_s', SESSION);
    window.sessionStorage.setItem(HANDOFF_RETRY_KEY, '1');
    let env = await open('#handoff-failed', fakeApi({}));
    expect(env.navs.map((n) => n.url)).toEqual(['/']);
    resetDom();
    env = await open('#handoff-failed', fakeApi({}));
    expect(env.navs.map((n) => n.url)).toEqual(['/']);
  });

  it('a new handoff gets its own retry', async () => {
    window.sessionStorage.setItem(HANDOFF_RETRY_KEY, '1');
    setCookie('__Host-omw_k', K);
    await open('#resume', fakeApi({ join: { status: 'active', handoff: '/_/h/', session: SESSION } }));
    expect(window.sessionStorage.getItem(HANDOFF_RETRY_KEY)).toBeNull();
  });
});
