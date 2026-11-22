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

describe('mock admin API: people and access (wave 5)', () => {
  const A = '/api/v1/admin';

  it('invites a person (link once), lists tombstones without names, and rejects bad bodies', () => {
    const api = new MockAdminApi();
    const auth = login(api);
    const created = call(api, 'POST', `${A}/followers`, { name: 'Lisa' }, auth);
    expect(created.status).toBe(201);
    const body = created.json as { follower: { id: string; name: string }; link: { url: string } };
    expect(body.link.url).toMatch(/^https:\/\/site\.example\.org\/_\/join\/#t=[A-Za-z0-9_-]{43}$/);
    const list = call(api, 'GET', `${A}/followers`, undefined, auth).json as {
      items: Array<{ id: string; state: string }>;
      tombstones: Array<Record<string, unknown>>;
    };
    expect(list.items[0]?.id).toBe(body.follower.id);
    expect(list.items.at(-1)?.state).toBe('revoked');
    expect(list.tombstones).toHaveLength(1);
    expect(Object.keys(list.tombstones[0] ?? {}).sort()).toEqual(['deletedAt', 'deletedBy', 'id', 'state']);
    expect(call(api, 'POST', `${A}/followers`, { name: '' }, auth).status).toBe(422);
    api.access.setState({ siteOrigin: null });
    expect(call(api, 'POST', `${A}/followers`, { name: 'Max' }, auth).json).toMatchObject({
      error: { code: 'config_missing' },
    });
  });

  it('approves up to the device limit, applies at once or waits for the Mac', () => {
    const api = new MockAdminApi();
    const auth = login(api);
    const fid = 'paulpaulpaul';
    const dids = [1, 2, 3, 4, 5].map(() => api.access.addDevice(fid, { state: 'pending' }));
    for (const did of dids.slice(0, 4)) {
      const res = call(api, 'POST', `${A}/devices/${did}/approve`, {}, auth);
      expect(res.json).toMatchObject({ effect: { applied: true, via: 'direct' }, device: { state: 'active' } });
    }
    expect(call(api, 'POST', `${A}/devices/${dids[4]}/approve`, {}, auth).json).toMatchObject({
      error: { code: 'device_limit' },
    });
    api.access.setState({ writerMode: 'none' });
    const revoke = call(api, 'POST', `${A}/devices/${dids[0]}/revoke`, {}, auth);
    expect(revoke.json).toMatchObject({ effect: { applied: false, via: 'pending', pendingOps: 3 } });
    expect((call(api, 'GET', `${A}/access`, undefined, auth).json as { pendingOps: number }).pendingOps).toBe(3);
    api.access.ack();
    expect((call(api, 'GET', `${A}/access`, undefined, auth).json as { pendingOps: number }).pendingOps).toBe(0);
  });

  it('locks, unlocks only with the password, and the status carries counts without names', () => {
    const api = new MockAdminApi();
    const auth = login(api);
    expect(call(api, 'POST', `${A}/access/lock`, { locked: true }, auth).status).toBe(200);
    expect(call(api, 'POST', `${A}/access/lock`, { locked: false, password: 'nope' }, auth).json).toMatchObject({
      error: { code: 'forbidden' },
    });
    expect(call(api, 'POST', `${A}/access/lock`, { locked: false, password: 'reisetagebuch' }, auth).status).toBe(200);
    api.access.addDevice('omaomaomaoma', { state: 'pending', label: 'Android · Chrome' });
    const status = call(api, 'GET', `${A}/status`, undefined, auth).json as { access: { pendingDevices: number } };
    expect(status.access.pendingDevices).toBe(1);
    expect(JSON.stringify(status)).not.toContain('Oma');
    const access = call(api, 'GET', `${A}/access`, undefined, auth).json as { pending: Array<{ name: string }> };
    expect(access.pending[0]?.name).toBe('Oma');
  });

  it('publishes the privacy draft only when complete and unchanged', () => {
    const api = new MockAdminApi();
    const auth = login(api);
    api.access.setState({ noticeVersions: 0 });
    const state = call(api, 'GET', `${A}/privacy`, undefined, auth).json as {
      draftSha256: string;
      problems: string[];
      draft: { texts: Record<string, Record<string, string>> };
    };
    expect(state.problems).toContain('controller.name is empty');
    expect(call(api, 'POST', `${A}/privacy/publish`, { ifDraftSha256: state.draftSha256 }, auth).json).toMatchObject({
      error: { code: 'notice_incomplete' },
    });
    const saved = call(
      api,
      'PUT',
      `${A}/privacy/draft`,
      { controller: { name: 'Lena', email: 'lena@example.org' }, texts: state.draft.texts },
      auth,
    ).json as { draftSha256: string; problems: string[] };
    expect(saved.problems).toEqual([]);
    expect(call(api, 'POST', `${A}/privacy/publish`, { ifDraftSha256: state.draftSha256 }, auth).json).toMatchObject({
      error: { code: 'conflict' },
    });
    const published = call(api, 'POST', `${A}/privacy/publish`, { ifDraftSha256: saved.draftSha256 }, auth).json as {
      current: { version: number };
    };
    expect(published.current.version).toBe(1);
  });

  it('changes the password: wrong current one 403, others logged out, app tokens on request', () => {
    const api = new MockAdminApi();
    const auth = login(api);
    const other = login(api);
    call(api, 'POST', `${A}/tokens`, { kind: 'app', name: 'Shortcut' }, auth);
    const body = (current: string) => ({
      currentPassword: current,
      newPassword: 'ein langes neues Passwort',
      revokeAppTokens: true,
    });
    expect(call(api, 'PUT', `${A}/me/password`, body('falsch'), auth).json).toMatchObject({
      error: { code: 'wrong_password' },
    });
    expect(call(api, 'PUT', `${A}/me/password`, { ...body('reisetagebuch'), newPassword: 'kurz' }, auth).status).toBe(
      422,
    );
    expect(call(api, 'PUT', `${A}/me/password`, body('reisetagebuch'), auth).status).toBe(204);
    expect(call(api, 'GET', `${A}/days`, undefined, { cookie: other.cookie }).status).toBe(401);
    expect(call(api, 'GET', `${A}/days`, undefined, { cookie: auth.cookie }).status).toBe(200);
    const tokens = api.snapshot().tokens;
    expect(tokens.filter((t) => t.kind === 'app').every((t) => t.revokedAt !== null)).toBe(true);
    expect(tokens.filter((t) => t.kind === 'backend').every((t) => t.revokedAt === null)).toBe(true);
    expect(
      call(api, 'POST', `${A}/session`, { email: 'owner@example.org', password: 'ein langes neues Passwort' }).status,
    ).toBe(200);
  });

  it('deletes a person into an anonymous tombstone and keeps the export shape', () => {
    const api = new MockAdminApi();
    const auth = login(api);
    const exported = call(api, 'GET', `${A}/followers/omaomaomaoma/export`, undefined, auth);
    expect(exported.json).toMatchObject({ format: 'omw-follower-data/1', consents: [{ version: 1 }] });
    expect(exported.headers?.['content-disposition']).toContain('attachment');
    expect(call(api, 'POST', `${A}/followers/omaomaomaoma/delete`, { confirm: false }, auth).status).toBe(422);
    expect(call(api, 'POST', `${A}/followers/omaomaomaoma/delete`, { confirm: true }, auth).status).toBe(200);
    expect(call(api, 'GET', `${A}/followers/omaomaomaoma`, undefined, auth).status).toBe(404);
    const list = call(api, 'GET', `${A}/followers`, undefined, auth).json as {
      tombstones: Array<{ id: string; deletedBy: string }>;
    };
    expect(list.tombstones.find((t) => t.id === 'omaomaomaoma')?.deletedBy).toBe('owner');
    expect(JSON.stringify(list)).not.toContain('Oma');
  });
});
