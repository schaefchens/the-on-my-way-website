/**
 * src/api/client.ts (review R8): the JS request budget (2 per 10 s), the quiet time after a
 * failure for polling calls, the error mapping and the response checks. fetch is stubbed; no
 * request leaves the process. Withdrawals are not here any more: the native uploader sends them
 * durably (Uploader.withdraw).
 */
import { CONTRACT_VERSION } from '@omw/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TOKEN = `omw_${'t'.repeat(43)}`;
const ID = '01JD4Z8W3K5V7X9Y1Z3B5C7D9F';
const NOW = Date.parse('2026-11-20T10:00:00.000Z');

const HINTS = {
  archiveOnly: true,
  delayHours: 6,
  backendLastSeenAt: null,
  chunk: { minBytes: 262144, maxBytes: 8388608 },
  inboxFreeBytes: 1,
  serverNow: '2026-11-20T10:00:00.000Z',
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function apiError(status: number, code: string, headers: Record<string, string> = {}): Response {
  return json(status, { error: { code, message: code } }, headers);
}

// Fresh module state per test (the budget and the quiet time live in the module).
async function load() {
  vi.resetModules();
  return import('../src/api/client');
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('API client', () => {
  it('sends to the build’s API base with the token, never more than 2 requests per 10 s', async () => {
    const c = await load();
    fetchMock.mockImplementation(async () => json(200, HINTS));
    expect(c.apiBaseUrl()).toBe('http://127.0.0.1:8080');
    await expect(c.fetchHints(TOKEN)).resolves.toMatchObject({ archiveOnly: true });
    await expect(c.fetchHints(TOKEN)).resolves.toMatchObject({ delayHours: 6 });
    // The third within 10 s is refused without a request.
    await expect(c.fetchHints(TOKEN)).rejects.toMatchObject({ code: 'busy', status: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8080/api/v1/app/hints');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    // After the window, again.
    vi.setSystemTime(NOW + 10_001);
    await expect(c.fetchHints(TOKEN)).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps polling quiet for a minute after a failure (and longer after a Retry-After)', async () => {
    const c = await load();
    fetchMock.mockResolvedValueOnce(apiError(503, 'transfer_busy', { 'Retry-After': '120' }));
    await expect(c.fetchHints(TOKEN)).rejects.toMatchObject({ code: 'busy', status: 503 });
    expect(c.pollingAllowed()).toBe(false);
    vi.setSystemTime(NOW + 61_000);
    expect(c.pollingAllowed()).toBe(false);
    await expect(c.fetchEntryStates(TOKEN, [ID])).rejects.toMatchObject({ code: 'busy', status: null });
    vi.setSystemTime(NOW + 121_000);
    expect(c.pollingAllowed()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(c.fetchHints(TOKEN)).rejects.toMatchObject({ code: 'network' });
    expect(c.pollingAllowed()).toBe(false);
  });

  it('maps the API’s answers onto a few codes', async () => {
    const cases: [Response, string, number | null][] = [
      [apiError(401, 'token_revoked'), 'token_revoked', 401],
      [apiError(401, 'unauthorized'), 'unauthorized', 401],
      [apiError(429, 'rate_limited'), 'rate_limited', 429],
      [apiError(404, 'not_found'), 'not_found', 404],
      [apiError(507, 'inbox_full'), 'busy', 507],
      [apiError(500, 'internal'), 'server', 500],
      [new Response('<html>', { status: 502 }), 'server', 502],
      [json(200, { archiveOnly: 'yes' }), 'server', 200], // a body that is not AppHints
    ];
    for (const [response, code, status] of cases) {
      const c = await load();
      fetchMock.mockResolvedValueOnce(response);
      const error = await c.fetchHints(TOKEN).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(c.AppApiError);
      expect(error).toMatchObject({ code, status });
    }
  });

  it('pairs with the typed code, the contract version and the install id', async () => {
    const c = await load();
    const response = {
      token: TOKEN,
      info: { id: 3, name: 'Pixel 8a', scopes: ['capture'], createdAt: '2026-11-20T10:00:00.000Z', expiresAt: null },
    };
    fetchMock.mockResolvedValueOnce(json(201, response));
    const installId = 'k3J9_xQ2-vT8mN4pL6rS1w';
    await expect(
      c.pairPhone({ code: 'K7M2Q9XP', deviceName: 'Pixel 8a', appVersion: '0.5.0', installId }),
    ).resolves.toEqual(response);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8080/api/v1/app/pair');
    expect(JSON.parse(String(init.body))).toEqual({
      contractVersion: CONTRACT_VERSION,
      platform: 'android',
      code: 'K7M2Q9XP',
      deviceName: 'Pixel 8a',
      appVersion: '0.5.0',
      installId,
    });
    fetchMock.mockResolvedValueOnce(apiError(410, 'pairing_expired'));
    await expect(c.pairPhone({ code: 'K7M2Q9XP', deviceName: 'x', appVersion: '1' })).rejects.toMatchObject({
      code: 'pairing_expired',
    });
  });

  it('asks for at most 50 entry states at once and none for an empty list', async () => {
    const c = await load();
    await expect(c.fetchEntryStates(TOKEN, [])).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json(200, { items: [] }));
    const ids = Array.from({ length: 60 }, () => ID);
    await c.fetchEntryStates(TOKEN, ids);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(new URL(url).searchParams.get('ids')?.split(',')).toHaveLength(50);
  });
});
