/**
 * Public API client (spec-wave5 §3.4, §6.2): request shape, 15 s deadline, 429 with Retry-After,
 * server and network errors, the dev-only contract check, the export download, and the
 * navigation filter every gate page uses.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicApi, exportFilename, PUBLIC_API_TIMEOUT_MS, PublicApiError } from '../../src/gate/api';
import { safeTarget } from '../../src/gate/env';

const API = 'https://api.example.org/api/v1/public/';
const K = 'kKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkK_-9';

function api(
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  cookieMode: 'headers' | 'parent' = 'headers',
) {
  return createPublicApi({
    api: API,
    cookieMode,
    fetch,
    schedule: (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  });
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });

afterEach(() => {
  vi.useRealTimers();
});

describe('public API client', () => {
  it('posts a text/plain JSON body without cookies or referrer', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const client = api(async (url, init) => {
      seen.push({ url, init });
      return json({ status: 'ended' });
    });
    await expect(client.post('me/hello', { k: K })).resolves.toEqual({ status: 'ended' });
    expect(seen[0]?.url).toBe(`${API}me/hello`);
    expect(seen[0]?.init).toMatchObject({
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify({ k: K }),
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    });
  });

  it('includes credentials only in the parent cookie mode (F2)', async () => {
    let credentials: RequestCredentials | undefined;
    await api(async (_url, init) => {
      credentials = init.credentials;
      return json({ status: 'ended' });
    }, 'parent').post('me/hello', { k: K });
    expect(credentials).toBe('include');
  });

  it('maps 429 (with Retry-After), 5xx and network failures', async () => {
    await expect(
      api(async () => new Response('', { status: 429, headers: { 'Retry-After': '42' } })).post('me/hello', { k: K }),
    ).rejects.toMatchObject({
      kind: 'rate_limited',
      status: 429,
      retryAfter: 42,
    });
    await expect(api(async () => new Response('', { status: 503 })).post('me/hello', { k: K })).rejects.toMatchObject({
      kind: 'server',
      status: 503,
    });
    await expect(
      api(async () => {
        throw new TypeError('Failed to fetch');
      }).post('me/hello', { k: K }),
    ).rejects.toMatchObject({ kind: 'network', status: 0 });
    await expect(
      api(async () => new Response('<html>', { status: 200 })).post('me/hello', { k: K }),
    ).rejects.toBeInstanceOf(PublicApiError);
  });

  it('gives up after 15 s', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const client = api(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          signal = init.signal ?? undefined;
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const result = client.post('me/hello', { k: K }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(PUBLIC_API_TIMEOUT_MS);
    expect(signal?.aborted).toBe(true);
    expect(await result).toMatchObject({ kind: 'network' });
  });

  it('checks answers against the contract in dev builds', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(api(async () => json({ status: 'active' })).post('me/hello', { k: K })).rejects.toBeInstanceOf(
      PublicApiError,
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('downloads the export, or reports "ended"', async () => {
    const file = await api(async () =>
      json(
        { format: 'omw-follower-data/1' },
        { headers: { 'Content-Disposition': 'attachment; filename="on-my-way-data-2026-11-21.json"' } },
      ),
    ).exportData({ k: K });
    expect(file).toMatchObject({ kind: 'file', filename: 'on-my-way-data-2026-11-21.json' });
    expect(await api(async () => json({ status: 'ended' })).exportData({ k: K })).toEqual({ kind: 'ended' });
  });

  it('reduces export file names to safe characters', () => {
    expect(exportFilename('attachment; filename="on-my-way-data-2026-11-21.json"')).toBe(
      'on-my-way-data-2026-11-21.json',
    );
    expect(exportFilename('attachment; filename=".htaccess"')).toBe('data.json');
    expect(exportFilename('attachment; filename="../x.json"')).toBe('data.json');
    expect(exportFilename(null)).toBe('data.json');
  });
});

describe('safeTarget (gate navigations)', () => {
  it('lets the fixed gate targets through', () => {
    for (const url of [
      '/',
      '/_/h/',
      '/_/join/',
      '/_/join/#resume',
      '/_/wait/',
      '/_/ended/',
      '/_/ended/#deleted',
      '/_/me/',
      '/_/me/#signout',
      '/_/info/#reconfirm',
      '/_/info/#view',
      '/_/info/#reconfirm&return=%2Fabcdefghij0123456789%2Fde%2F',
      '/abcdefghij0123456789/de/day/2026-11-15/',
    ]) {
      expect(safeTarget(url), url).toBe(url);
    }
  });

  it('turns everything else into "/" (other origins, //, secrets)', () => {
    for (const url of [
      'https://evil.example/',
      '//evil.example/',
      'javascript:alert(1)',
      `/_/h/${'a'.repeat(43)}`,
      `/_/join/#t=${K}`,
      `/x/?k=${K}`,
      '/_/join/#other',
      '/a\\b',
      '/a//b',
    ]) {
      expect(safeTarget(url), url).toBe('/');
    }
  });
});
