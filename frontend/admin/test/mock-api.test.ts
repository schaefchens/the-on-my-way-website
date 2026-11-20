/** The e2e mock API follows the contract rules the admin relies on (session, CSRF, 409, idempotency). */
import { describe, expect, it } from 'vitest';
import { csrfFor, MockAdminApi, type MockRequest, SESSION_COOKIE } from '../e2e/mock/api';

function call(api: MockAdminApi, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const url = new URL(`http://x${path}`);
  const req: MockRequest = {
    method,
    path: url.pathname,
    query: url.searchParams,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? '' : JSON.stringify(body),
  };
  return api.handle(req);
}

function login(api: MockAdminApi) {
  const res = call(api, 'POST', '/api/v1/admin/session', { email: 'owner@example.org', password: 'reisetagebuch' });
  const token = /omw_mock_session=([^;]+)/.exec(res.headers?.['set-cookie'] ?? '')?.[1] ?? '';
  return { cookie: `${SESSION_COOKIE}=${token}`, 'x-csrf-token': csrfFor(token) };
}

describe('mock admin API', () => {
  it('requires a session and the CSRF token for writes', () => {
    const api = new MockAdminApi();
    expect(call(api, 'GET', '/api/v1/admin/days').status).toBe(401);
    expect(call(api, 'POST', '/api/v1/admin/session', { email: 'owner@example.org', password: 'x' }).status).toBe(401);
    const auth = login(api);
    expect(call(api, 'GET', '/api/v1/admin/days', undefined, { cookie: auth.cookie }).status).toBe(200);
    const patch = { placeName: 'Hội An' };
    expect(call(api, 'PATCH', '/api/v1/admin/days/2026-11-19', patch, { cookie: auth.cookie }).json).toMatchObject({
      error: { code: 'csrf' },
    });
    expect(call(api, 'PATCH', '/api/v1/admin/days/2026-11-19', patch, auth).status).toBe(200);
  });

  it('answers 409 for a stale ifUpdatedAt and is idempotent for post creates', () => {
    const api = new MockAdminApi();
    const auth = login(api);
    const stale = call(
      api,
      'PATCH',
      '/api/v1/admin/days/2026-11-15',
      { placeName: 'x', ifUpdatedAt: '2026-01-01T00:00:00.000Z' },
      auth,
    );
    expect(stale.status).toBe(409);
    const body = {
      publicId: 'p_01JXMOCKTEST0000000000001',
      kind: 'note',
      origLocale: 'de',
      content: { de: { body: 'Hi' } },
    };
    expect(call(api, 'POST', '/api/v1/admin/posts', body, auth).status).toBe(201);
    expect(call(api, 'POST', '/api/v1/admin/posts', body, auth).status).toBe(200);
    expect(api.snapshot().posts.filter((p) => p.publicId === body.publicId)).toHaveLength(1);
    expect(call(api, 'POST', '/api/v1/admin/posts', { ...body, content: {} }, auth).status).toBe(422);
  });

  it('rejects overlapping trips and catches up the publish report after writes', () => {
    let now = Date.parse('2026-11-20T08:00:00Z');
    const api = new MockAdminApi({ now: () => now, publishAfterMs: 1000 });
    const auth = login(api);
    const overlap = { slug: 'mekong', title: { de: 'Mekong' }, startDate: '2026-11-20', endDate: '2026-11-22' };
    expect(call(api, 'PUT', '/api/v1/admin/trips/mekong', overlap, auth).status).toBe(422);
    call(api, 'PATCH', '/api/v1/admin/days/2026-11-19', { placeName: 'Cần Thơ' }, auth);
    const seq = api.snapshot().seq;
    expect(api.snapshot().publish?.feedSeq).toBeLessThan(seq);
    now += 1500;
    call(api, 'GET', '/api/v1/admin/status', undefined, auth);
    expect(api.snapshot().publish?.feedSeq).toBe(seq);
  });
});
