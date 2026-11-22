// @vitest-environment jsdom
/**
 * "Your data" (D12, spec-wave5 §6.2.5–6.2.6), /_/ended/ (§6.2.3), /_/info/ (§6.2.4) and
 * /_/panic/ (§6.2.8).
 */
import type { FollowerDataView } from '@omw/contracts/access';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  action,
  cookieValue,
  DID,
  expectSafeNavs,
  FID,
  fakeApi,
  flush,
  gateBoot,
  hasAction,
  K,
  mount,
  notice,
  resetDom,
  setCookie,
  testEnv,
  text,
} from './harness';

beforeEach(() => {
  resetDom();
  setCookie('__Host-omw_k', K);
});
afterEach(() => {
  vi.useRealTimers();
});

function view(over: Partial<FollowerDataView> = {}): FollowerDataView {
  return {
    follower: { id: FID, name: 'Oma', since: '2026-11-01T09:00:00.000Z', state: 'active' },
    devices: [
      {
        id: DID,
        label: 'iPhone · Safari',
        state: 'active',
        createdAt: '2026-11-01T09:00:00.000Z',
        lastSeenAt: '2026-11-20T18:00:00.000Z',
        thisDevice: true,
      },
      {
        id: 'abcd2345',
        label: 'Mac · Firefox',
        state: 'revoked',
        createdAt: '2026-11-05T09:00:00.000Z',
        lastSeenAt: null,
        thisDevice: false,
      },
    ],
    consents: [{ version: 1, confirmedAt: '2026-11-01T09:00:00.000Z', locale: 'de' }],
    categories: [
      { key: 'devices', count: 2 },
      { key: 'consents', count: 1 },
    ],
    noticeVersion: 1,
    ...over,
  };
}

async function open(page: 'me' | 'ended' | 'info' | 'panic', api: ReturnType<typeof fakeApi>, hash = '') {
  const env = testEnv({ fetch: api.fetch, pathname: `/_/${page}/`, hash });
  await mount(env, gateBoot(page));
  await flush();
  return env;
}

describe('/_/me/ with full rights', () => {
  it('shows the name, devices, consents and stored categories', async () => {
    await open('me', fakeApi({ 'me/data': { status: 'ok', data: view() } }));
    expect(text()).toContain('Persönlich geteilt mit Oma seit');
    expect(text()).toContain('iPhone · Safari');
    expect(text()).toContain('Mac · Firefox');
    expect(text()).toContain('entfernt');
    expect(text()).toContain('Version 1 · bestätigt am');
    expect(text()).toContain('Geräte: 2');
    expect(document.querySelector('a[href="/_/info/#view"]')).not.toBeNull();
    expect(document.querySelector('a[href="/"]')?.textContent).toBe('Zur Seite');
    for (const a of ['export', 'signout', 'delete']) expect(hasAction(a)).toBe(true);
  });

  it('exports the data as a download named from Content-Disposition', async () => {
    const file = JSON.stringify({ format: 'omw-follower-data/1', exportedAt: '2026-11-21T10:00:00.000Z' });
    const env = await open(
      'me',
      fakeApi({
        'me/data': { status: 'ok', data: view() },
        'me/export': {
          raw: new Response(file, {
            headers: {
              'Content-Type': 'application/json',
              'Content-Disposition': 'attachment; filename="on-my-way-data-2026-11-21.json"',
            },
          }),
        },
      }),
    );
    action('export').click();
    await flush();
    expect(env.downloads).toHaveLength(1);
    expect(env.downloads[0]?.filename).toBe('on-my-way-data-2026-11-21.json');
    const blob = env.downloads[0]?.blob as Blob;
    const content = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(content).toBe(file);
    expect(text()).toContain('Der Download hat begonnen.');
  });

  it('a hostile file name falls back to data.json', async () => {
    const env = await open(
      'me',
      fakeApi({
        'me/data': { status: 'ok', data: view() },
        'me/export': {
          raw: new Response(JSON.stringify({ format: 'omw-follower-data/1' }), {
            headers: { 'Content-Disposition': 'attachment; filename="../../.bashrc"' },
          }),
        },
      }),
    );
    action('export').click();
    await flush();
    expect(env.downloads[0]?.filename).toBe('data.json');
  });

  it('signs out after a confirmation and clears cookie and storage', async () => {
    window.localStorage.setItem('omw-theme', 'dusk');
    window.sessionStorage.setItem('omw.name', 'Oma');
    const api = fakeApi({ 'me/data': { status: 'ok', data: view() }, 'me/signout': { status: 'signed_out' } });
    await open('me', api);
    action('signout').click();
    expect(text()).toContain('Um dieses Gerät wieder zu nutzen, öffne deinen Link erneut');
    expect(document.activeElement?.getAttribute('data-action')).toBe('cancel');
    action('confirm').click();
    await flush();
    expect(api.calls.at(-1)).toMatchObject({ route: 'me/signout', body: { k: K } });
    expect(text()).toContain('Abgemeldet.');
    expect(cookieValue('__Host-omw_k')).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('#signout opens the confirmation directly; cancel goes back to the data', async () => {
    await open('me', fakeApi({ 'me/data': { status: 'ok', data: view() } }), '#signout');
    expect(text()).toContain('Um dieses Gerät wieder zu nutzen');
    action('cancel').click();
    expect(text()).toContain('Persönlich geteilt mit Oma');
  });

  it('delete me: the button stays disabled until the box is ticked; cancel has the focus', async () => {
    const api = fakeApi({ 'me/data': { status: 'ok', data: view() }, 'me/delete': { status: 'deleted' } });
    const env = await open('me', api);
    window.sessionStorage.setItem('x', '1');
    action('delete').click();
    expect(text()).toContain(
      'Das kann nicht rückgängig gemacht werden. Du verlierst sofort den Zugang auf allen Geräten.',
    );
    expect(text()).toContain('Dein Name');
    expect(text()).toContain('Geräte: 2');
    const box = document.querySelector<HTMLInputElement>('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(action('erase').disabled).toBe(true);
    expect(document.activeElement?.getAttribute('data-action')).toBe('cancel');
    action('erase').click();
    await flush();
    expect(api.routes()).toEqual(['me/data']);
    box.click();
    expect(action('erase').disabled).toBe(false);
    action('erase').click();
    await flush();
    expect(api.calls.at(-1)).toMatchObject({ route: 'me/delete', body: { k: K, confirm: 'delete-all-my-data' } });
    expect(cookieValue('__Host-omw_k')).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
    expect(env.navs.map((n) => n.url)).toEqual(['/_/ended/#deleted']);
    expectSafeNavs(env);
  });

  it('no back link to the page for a device that ended with the person', async () => {
    const ended = view({
      follower: { id: FID, name: 'Oma', since: '2026-11-01T09:00:00.000Z', state: 'revoked' },
    });
    ended.devices = ended.devices.map((d) => (d.thisDevice ? { ...d, state: 'revoked' } : d));
    await open('me', fakeApi({ 'me/data': { status: 'ok', data: ended } }));
    expect(document.querySelector('a[href="/"]')).toBeNull();
    expect(hasAction('delete')).toBe(true);
    expect(hasAction('export')).toBe(true);
  });

  it('a device that ended with the person: no sign-out and no notice link (the API would answer ended)', async () => {
    const ended = view({
      follower: { id: FID, name: 'Oma', since: '2026-11-01T09:00:00.000Z', state: 'revoked' },
    });
    ended.devices = ended.devices.map((d) => (d.thisDevice ? { ...d, state: 'revoked' } : d));
    const api = fakeApi({ 'me/data': { status: 'ok', data: ended } });
    await open('me', api);
    expect(hasAction('signout')).toBe(false);
    expect(document.querySelector('a[href="/_/info/#view"]')).toBeNull();
    expect(text()).toContain('Der Export enthält auch die Datenschutzhinweise, die du bestätigt hast.');
    expect(text()).not.toContain('keine Daten (mehr)');
    // #signout (e.g. an old bookmark) just shows the data.
    resetDom();
    setCookie('__Host-omw_k', K);
    await open('me', api, '#signout');
    expect(text()).toContain('Persönlich geteilt mit Oma');
    expect(text()).not.toContain('Um dieses Gerät wieder zu nutzen');
    expect(api.routes().filter((r) => r !== 'me/data')).toEqual([]);
  });

  it('an active device keeps sign-out and the notice link', async () => {
    await open('me', fakeApi({ 'me/data': { status: 'ok', data: view() } }));
    expect(hasAction('signout')).toBe(true);
    expect(document.querySelector('a[href="/_/info/#view"]')?.textContent).toBe('Datenschutzhinweise ansehen');
    expect(text()).not.toContain('Der Export enthält auch');
  });
});

describe('/_/me/ with limited rights (waiting or declined device)', () => {
  const limited = {
    status: 'limited',
    device: { label: 'Android · Chrome', state: 'pending', createdAt: '2026-11-20T10:00:00.000Z' },
  };

  it('shows only this device: no name, no other device, no export or delete', async () => {
    await open('me', fakeApi({ 'me/data': limited }));
    expect(text()).toContain('Dieses Gerät: Android · Chrome · wartet · seit');
    expect(text()).toContain('Deine Daten kannst du auf einem bestätigten Gerät einsehen');
    expect(text()).not.toContain('Oma');
    expect(text()).not.toContain('Persönlich geteilt');
    for (const a of ['export', 'delete', 'signout']) expect(hasAction(a)).toBe(false);
    expect(document.querySelector('[data-device]')).toBeNull();
    expect(hasAction('withdraw')).toBe(true);
  });

  it('withdraws the request (#signout from the wait page) and forgets the key', async () => {
    const api = fakeApi({ 'me/data': limited, 'me/signout': { status: 'signed_out' } });
    await open('me', api, '#signout');
    expect(text()).toContain('Die Anfrage für dieses Gerät wird zurückgezogen.');
    action('confirm').click();
    await flush();
    expect(text()).toContain('Anfrage zurückgezogen.');
    expect(cookieValue('__Host-omw_k')).toBeNull();
  });

  it('a declined device cannot withdraw anything', async () => {
    await open('me', fakeApi({ 'me/data': { ...limited, device: { ...limited.device, state: 'declined' } } }));
    expect(text()).toContain('abgelehnt');
    expect(hasAction('withdraw')).toBe(false);
  });

  it('ended or no key: nothing stored', async () => {
    await open('me', fakeApi({ 'me/data': { status: 'ended' } }));
    expect(text()).toContain('Für dieses Gerät sind keine Daten (mehr) gespeichert.');
    resetDom();
    const api = fakeApi({});
    await open('me', api);
    expect(text()).toContain('Für dieses Gerät sind keine Daten (mehr) gespeichert.');
    expect(api.calls).toEqual([]);
  });
});

describe('/_/ended/', () => {
  it('links to "Your data" only with full rights', async () => {
    await open('ended', fakeApi({ 'me/data': { status: 'ok', data: view() } }));
    expect(text()).toContain('Kein Zugang auf diesem Gerät.');
    expect(document.querySelector('a[href="/_/me/"]')?.textContent).toBe('Deine Daten');
    for (const answer of [
      { status: 'limited', device: { label: 'x', state: 'declined', createdAt: '2026-11-20T10:00:00.000Z' } },
      { status: 'ended' },
      { network: true } as const,
    ]) {
      resetDom();
      setCookie('__Host-omw_k', K);
      await open('ended', fakeApi({ 'me/data': answer }));
      expect(text()).toContain('Kein Zugang auf diesem Gerät.');
      expect(document.querySelector('a[href="/_/me/"]')).toBeNull();
    }
  });

  it('#deleted: says so, asks nothing', async () => {
    const api = fakeApi({});
    await open('ended', api, '#deleted');
    expect(text()).toContain('Deine Daten wurden gelöscht.');
    expect(api.calls).toEqual([]);
  });
});

describe('/_/info/', () => {
  it('#reconfirm: notice, consent, back to the return path', async () => {
    const api = fakeApi({
      'me/notice': { status: 'ok', notice: notice(2), confirmedVersion: 1 },
      'me/consent': {
        status: 'active',
        follower: { name: 'Oma' },
        device: { id: DID, label: 'iPhone · Safari' },
        notice: { version: 2, required: false },
      },
    });
    const env = await open('info', api, '#reconfirm&return=%2Fabcdefghij0123456789%2Fde%2Fday%2F2026-11-15%2F');
    expect(text()).toContain('Die Datenschutzhinweise haben sich geändert.');
    expect(text()).toContain('Version 2');
    action('continue').click();
    await flush();
    expect(api.calls.at(-1)).toMatchObject({ route: 'me/consent', body: { k: K, version: 2, locale: 'de' } });
    expect(env.navs.map((n) => n.url)).toEqual(['/abcdefghij0123456789/de/day/2026-11-15/']);
    expectSafeNavs(env);
  });

  it('validates the return path (no other origin, no //)', async () => {
    const api = fakeApi({
      'me/notice': { status: 'ok', notice: notice(2), confirmedVersion: 1 },
      'me/consent': { status: 'active', follower: { name: 'Oma' }, device: { id: DID, label: '' }, notice: null },
    });
    for (const ret of ['%2F%2Fevil.example%2F', 'https%3A%2F%2Fevil.example', 'javascript%3Aalert(1)', '%2Fa%5Cb']) {
      resetDom();
      setCookie('__Host-omw_k', K);
      const env = await open('info', api, `#reconfirm&return=${ret}`);
      action('continue').click();
      await flush();
      expect(env.navs.map((n) => n.url)).toEqual(['/']);
    }
  });

  it('a waiting device confirms without learning the name and goes back to waiting', async () => {
    const api = fakeApi({
      'me/notice': { status: 'ok', notice: notice(2), confirmedVersion: 1 },
      'me/consent': { status: 'pending', notice: { version: 2, required: false } },
    });
    const env = await open('info', api, '#reconfirm&return=%2F');
    action('continue').click();
    await flush();
    expect(api.calls.at(-1)).toMatchObject({ route: 'me/consent', body: { k: K, version: 2 } });
    expect(env.navs.map((n) => n.url)).toEqual(['/_/wait/']);
    expect(text()).not.toContain('Oma');
  });

  it('already confirmed elsewhere: straight back', async () => {
    const env = await open(
      'info',
      fakeApi({ 'me/notice': { status: 'ok', notice: notice(2), confirmedVersion: 2 } }),
      '#reconfirm',
    );
    expect(env.navs.map((n) => n.url)).toEqual(['/']);
  });

  it('#view: read only with "Back"', async () => {
    const api = fakeApi({ 'me/notice': { status: 'ok', notice: notice(1), confirmedVersion: 1 } });
    await open('info', api, '#view');
    expect(text()).toContain('DE Datenschutz');
    expect(hasAction('continue')).toBe(false);
    expect(document.querySelector('a[href="/_/me/"]')?.textContent).toBe('Zurück');
  });

  it('ended or no key → /_/ended/', async () => {
    let env = await open('info', fakeApi({ 'me/notice': { status: 'ended' } }), '#reconfirm');
    expect(env.navs.map((n) => n.url)).toEqual(['/_/ended/']);
    resetDom();
    env = await open('info', fakeApi({}), '#reconfirm');
    expect(env.navs.map((n) => n.url)).toEqual(['/_/ended/']);
  });
});

describe('/_/panic/', () => {
  const PANIC_KEY = 'pPpPpPpPpPpPpPpPpPpPpPpPpPpPpPpPpPpPpPpPp_0';

  it('removes the key from the address bar and locks on the big button', async () => {
    const api = fakeApi({ panic: { ok: true } });
    const env = await open('panic', api, `#k=${PANIC_KEY}`);
    expect(env.replacedUrls).toEqual(['/_/panic/']);
    expect(api.calls).toEqual([]);
    expect(text()).toContain('Website jetzt sperren');
    action('lock').click();
    await flush();
    expect(api.calls[0]).toMatchObject({ route: 'panic', body: { key: PANIC_KEY } });
    expect(text()).toContain('Gesperrt (wenn der Link gültig war). Entsperren geht nur im Admin.');
  });

  it('without a key: invalid', async () => {
    const api = fakeApi({});
    await open('panic', api, '#k=short');
    expect(text()).toContain('nicht (mehr) gültig');
    expect(api.calls).toEqual([]);
  });
});
