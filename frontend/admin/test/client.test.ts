import { afterEach, describe, expect, it } from 'vitest';
import {
  API_BASE,
  ApiRequestError,
  apiRequest,
  CSRF_HEADER,
  type FetchLike,
  newPostPublicId,
  queryString,
  setClientHooks,
  setCsrfToken,
} from '../src/api/client';
import { loadAuth, safeRedirect } from '../src/auth';

function recorder(response: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return response();
  };
  return { calls, fetch };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => {
  setCsrfToken(null);
  setClientHooks({});
});

describe('admin API client', () => {
  it('targets /api/v1/admin with cookies and no caching', async () => {
    const r = recorder(() => json(200, { items: [] }));
    await apiRequest('/days', { fetch: r.fetch });
    expect(API_BASE).toBe('/api/v1/admin');
    expect(r.calls[0]?.url).toBe('/api/v1/admin/days');
    expect(r.calls[0]?.init).toMatchObject({ method: 'GET', credentials: 'include', cache: 'no-store' });
  });

  it('sends the CSRF token and JSON body on mutations only', async () => {
    setCsrfToken('tok123');
    const r = recorder(() => json(200, {}));
    await apiRequest('/days/2026-11-15', { method: 'PATCH', body: { placeName: 'Hội An' }, fetch: r.fetch });
    await apiRequest('/days', { fetch: r.fetch });
    const [patch, get] = r.calls;
    const headers = patch?.init.headers as Record<string, string>;
    expect(headers[CSRF_HEADER]).toBe('tok123');
    expect(headers['content-type']).toBe('application/json');
    expect(patch?.init.body).toBe('{"placeName":"Hội An"}');
    const getHeaders = (get?.init.headers ?? {}) as Record<string, string>;
    expect(getHeaders[CSRF_HEADER]).toBeUndefined();
  });

  it('maps ApiError bodies, empty 204s and network failures', async () => {
    const err = recorder(() => json(422, { error: { code: 'validation', message: 'bad', details: { field: 'x' } } }));
    await expect(apiRequest('/x', { fetch: err.fetch })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 422,
      code: 'validation',
      message: 'bad',
    });
    const empty = recorder(() => new Response(null, { status: 204 }));
    await expect(apiRequest('/session', { method: 'DELETE', fetch: empty.fetch })).resolves.toBeUndefined();
    const down = recorder(() => Promise.reject(new TypeError('fetch failed')));
    await expect(apiRequest('/me', { fetch: down.fetch })).rejects.toMatchObject({ status: 0, code: 'network' });
    const html = recorder(() => new Response('<html>', { status: 502 }));
    await expect(apiRequest('/me', { fetch: html.fetch })).rejects.toBeInstanceOf(ApiRequestError);
  });
});

describe('session hooks', () => {
  it('refreshes the CSRF token once on 403 "csrf" and retries', async () => {
    setCsrfToken('stale');
    let n = 0;
    const r = recorder(() =>
      n++ === 0 ? json(403, { error: { code: 'csrf', message: 'bad token' } }) : json(200, { ok: true }),
    );
    setClientHooks({ refreshCsrf: async () => 'fresh' });
    await expect(apiRequest('/days/2026-11-15', { method: 'PATCH', body: {}, fetch: r.fetch })).resolves.toEqual({
      ok: true,
    });
    expect(r.calls.map((c) => (c.init.headers as Record<string, string>)[CSRF_HEADER])).toEqual(['stale', 'fresh']);
  });

  it('fetches a CSRF token before a write when none is known (offline start, resumed writes)', async () => {
    const r = recorder(() => json(200, {}));
    let asked = 0;
    setClientHooks({
      refreshCsrf: async () => {
        asked++;
        return 'from-me';
      },
    });
    await apiRequest('/posts', { method: 'POST', body: { a: 1 }, fetch: r.fetch });
    await apiRequest('/session', { method: 'POST', body: {}, fetch: r.fetch });
    expect(asked).toBe(1);
    expect((r.calls[0]?.init.headers as Record<string, string> | undefined)?.[CSRF_HEADER]).toBe('from-me');
  });

  it('reports 401 outside the auth endpoints and connectivity changes', async () => {
    const events: string[] = [];
    setClientHooks({
      onUnauthorized: () => events.push('401'),
      onNetworkError: () => events.push('down'),
      onReachable: () => events.push('up'),
    });
    const unauth = recorder(() => json(401, { error: { code: 'unauthorized', message: 'no' } }));
    await expect(apiRequest('/days', { fetch: unauth.fetch })).rejects.toMatchObject({ status: 401 });
    await expect(apiRequest('/me', { fetch: unauth.fetch })).rejects.toMatchObject({ status: 401 });
    const down = recorder(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(apiRequest('/days', { fetch: down.fetch })).rejects.toMatchObject({ status: 0 });
    expect(events).toEqual(['up', '401', 'up', 'down']);
  });

  it('turns a hanging request into a network error', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      );
    await expect(apiRequest('/days', { fetch: hang, timeoutMs: 20 })).rejects.toMatchObject({
      status: 0,
      code: 'network',
    });
  });
});

describe('offline-safe requests', () => {
  it('builds list query strings from the contract query DTOs', () => {
    expect(queryString({ date: '2026-11-15', limit: 50, cursor: undefined, kind: '' })).toBe(
      '?date=2026-11-15&limit=50',
    );
    expect(queryString({})).toBe('');
  });

  it('creates sortable client-side post ids that match the contract', async () => {
    const { PostPublicId } = await import('@omw/contracts');
    const a = newPostPublicId(1_763_500_000_000, (n) => new Uint8Array(n));
    const b = newPostPublicId(1_763_500_000_001, (n) => new Uint8Array(n));
    expect(PostPublicId.safeParse(a).success).toBe(true);
    expect(a).toMatch(/^p_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(newPostPublicId()).not.toBe(newPostPublicId());
  });
});

describe('auth guard helpers', () => {
  it('treats 401 as logged out and other failures as API errors', async () => {
    expect(await loadAuth(() => Promise.reject(new ApiRequestError(401, 'unauthenticated', 'no')))).toEqual({
      me: null,
      error: null,
    });
    const down = await loadAuth(() => Promise.reject(new ApiRequestError(0, 'network', 'API unreachable')));
    expect(down).toEqual({ me: null, error: 'API unreachable' });
    const me = { email: 'owner@example.org', displayName: null, csrfToken: 'c1' };
    expect(await loadAuth(() => Promise.resolve(me))).toEqual({ me, error: null });
  });

  it('only allows same-app redirect targets', () => {
    expect(safeRedirect('/inbox?x=1')).toBe('/inbox?x=1');
    expect(safeRedirect('//evil.example/')).toBe('/');
    expect(safeRedirect('https://evil.example/')).toBe('/');
    expect(safeRedirect(undefined)).toBe('/');
    // Browsers read a backslash as "/" and drop tabs/newlines, which would turn these into "//evil…".
    expect(safeRedirect('/\\evil.example/')).toBe('/');
    expect(safeRedirect('/\t/evil.example/')).toBe('/');
    expect(safeRedirect('/days/2026-11-15\n')).toBe('/');
    expect(safeRedirect('/compose?kind=note&date=2026-11-15')).toBe('/compose?kind=note&date=2026-11-15');
  });
});
