// @vitest-environment jsdom
/** /_/wait/ (spec-wave5 §6.2.2): polling schedule, visibility pause, outcomes. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextPollDelay, rateLimitedDelay, WAIT_SCHEDULE } from '../../src/gate/pages/wait';
import {
  action,
  expectSafeNavs,
  fakeApi,
  flush,
  gateBoot,
  K,
  mount,
  resetDom,
  SESSION,
  setCookie,
  testEnv,
  text,
} from './harness';

const PENDING = { status: 'pending', pollAfterMs: 10_000 };

beforeEach(() => {
  resetDom();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

async function open(api: ReturnType<typeof fakeApi>) {
  const env = testEnv({ fetch: api.fetch, pathname: '/_/wait/' });
  await mount(env, gateBoot('wait'));
  await flush();
  return env;
}

const polls = (api: ReturnType<typeof fakeApi>) => api.routes().filter((r) => r === 'device/poll').length;

describe('nextPollDelay', () => {
  it('10 s for 2 minutes, then 30 s, then stop after 30 minutes', () => {
    expect(nextPollDelay(0)).toBe(10_000);
    expect(nextPollDelay(119_999)).toBe(10_000);
    expect(nextPollDelay(120_000)).toBe(30_000);
    expect(nextPollDelay(WAIT_SCHEDULE.stopAfterMs - 1)).toBe(30_000);
    expect(nextPollDelay(WAIT_SCHEDULE.stopAfterMs)).toBeNull();
  });
});

describe('wait page', () => {
  it('without a key: asks to reopen the link, no request', async () => {
    const api = fakeApi({});
    await open(api);
    expect(text()).toContain('Auf diesem Gerät ist keine Einladung gespeichert');
    expect(api.calls).toEqual([]);
  });

  it('polls at once, every 10 s for 2 min, then every 30 s, then stops with "Check again"', async () => {
    setCookie('__Host-omw_k', K);
    const api = fakeApi({ 'device/poll': PENDING });
    await open(api);
    expect(text()).toContain('Fast geschafft!');
    expect(text()).toContain('Die Person, die dich eingeladen hat, bestätigt dieses Gerät.');
    expect(api.calls[0]?.body).toEqual({ k: K });
    expect(polls(api)).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(polls(api)).toBe(2);
    await vi.advanceTimersByTimeAsync(110_000);
    expect(polls(api)).toBe(13); // 0, 10, …, 120 s
    await vi.advanceTimersByTimeAsync(30_000);
    expect(polls(api)).toBe(14);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    const atStop = polls(api);
    expect(text()).toContain('Noch keine Bestätigung.');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(polls(api)).toBe(atStop);
    action('check').click();
    await flush();
    expect(polls(api)).toBe(atStop + 1);
  });

  it('pauses while hidden and polls at once when visible again', async () => {
    setCookie('__Host-omw_k', K);
    const api = fakeApi({ 'device/poll': PENDING });
    const env = await open(api);
    expect(polls(api)).toBe(1);
    env.setHidden(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(polls(api)).toBe(1);
    env.setHidden(false);
    await flush();
    expect(polls(api)).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(polls(api)).toBe(3);
  });

  it('approved: hands off with the session (transfer cookie, no secret in the URL)', async () => {
    setCookie('__Host-omw_k', K);
    const api = fakeApi({ 'device/poll': [PENDING, { status: 'active', handoff: '/_/h/', session: SESSION }] });
    const env = await open(api);
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(env.navs.map((n) => n.url)).toEqual(['/_/h/']);
    expect(env.navs[0]?.cookies).toContain(`__Host-omw_s=${SESSION}`);
    expectSafeNavs(env);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polls(api)).toBe(2);
  });

  it('active without handoff → /, declined → /_/ended/', async () => {
    setCookie('__Host-omw_k', K);
    let env = await open(fakeApi({ 'device/poll': { status: 'active', handoff: '/' } }));
    expect(env.navs.map((n) => n.url)).toEqual(['/']);
    resetDom();
    setCookie('__Host-omw_k', K);
    env = await open(fakeApi({ 'device/poll': { status: 'ended' } }));
    expect(env.navs.map((n) => n.url)).toEqual(['/_/ended/']);
  });

  it('activating polls sooner (pollAfterMs)', async () => {
    setCookie('__Host-omw_k', K);
    const api = fakeApi({
      'device/poll': [
        { status: 'activating', pollAfterMs: 3000 },
        { status: 'active', handoff: '/_/h/', session: SESSION },
      ],
    });
    const env = await open(api);
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(env.navs.map((n) => n.url)).toEqual(['/_/h/']);
  });

  it('unavailable keeps waiting with a note; network errors offer a retry', async () => {
    setCookie('__Host-omw_k', K);
    const api = fakeApi({ 'device/poll': [{ status: 'unavailable', reason: 'locked' }, PENDING] });
    await open(api);
    expect(text()).toContain('Gerade nicht verfügbar');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(polls(api)).toBe(2);
    expect(text()).not.toContain('Gerade nicht verfügbar');
    resetDom();
    setCookie('__Host-omw_k', K);
    const failing = fakeApi({ 'device/poll': [{ network: true }, PENDING] });
    await open(failing);
    expect(text()).toContain('Keine Verbindung.');
    document.querySelector<HTMLButtonElement>('section button')?.click();
    await flush();
    expect(text()).toContain('Fast geschafft!');
  });

  it('a rate-limited poll keeps waiting and polls again after Retry-After (3–60 s)', async () => {
    expect(rateLimitedDelay(null)).toBe(10_000);
    expect(rateLimitedDelay(0)).toBe(3_000);
    expect(rateLimitedDelay(7)).toBe(7_000);
    expect(rateLimitedDelay(3600)).toBe(60_000);
    setCookie('__Host-omw_k', K);
    const api = fakeApi({
      'device/poll': [
        { http: 429, retryAfter: 6 },
        { status: 'active', handoff: '/_/h/', session: SESSION },
      ],
    });
    const env = await open(api);
    expect(text()).toContain('Fast geschafft!');
    expect(text()).not.toContain('Zu viele Versuche');
    await vi.advanceTimersByTimeAsync(5_999);
    expect(polls(api)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(polls(api)).toBe(2);
    expect(env.navs.map((n) => n.url)).toEqual(['/_/h/']);
  });

  it('links to withdrawing the request', async () => {
    setCookie('__Host-omw_k', K);
    await open(fakeApi({ 'device/poll': PENDING }));
    expect(document.querySelector('a[href="/_/me/#signout"]')?.textContent).toBe('Anfrage zurückziehen');
  });
});
