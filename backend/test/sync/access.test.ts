/**
 * The access additions of the sync (spec-wave5 §3.6, §5.6.6): the client's access routes
 * (claim, renew, listing, ack, service session) with response validation, `access.needsWriter`
 * from the change feed to SyncDeps.onAccess, the heartbeat's `site` and the publish report's
 * `gateCheck`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/store/index.js';
import { ApiClient, ApiRequestError } from '../../src/sync/client.js';
import { createSync } from '../../src/sync/index.js';
import { fakeClock, makeTempDir } from '../helpers.js';
import { silentLog, testConfig } from './helpers.js';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeFetch(answers: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const key = `${init?.method ?? 'GET'} ${u.pathname}${u.search}`;
    calls.push({
      method: init?.method ?? 'GET',
      path: `${u.pathname}${u.search}`,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const answer = answers[key];
    if (!answer) return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 });
    return answer();
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const CLAIM = {
  lease: { until: '2026-11-21T10:01:00.000Z' },
  storeId: '0123456789abcdef',
  epoch: 'fedcba9876543210',
  ops: [{ id: 1, op: 'put', path: 'h/abcdefgh', content: null, exclusive: true }],
  listingWanted: false,
};

describe('ApiClient access routes', () => {
  it('claim, renew, listing, ack and the service session (rotate) with validated answers', async () => {
    const f = fakeFetch({
      'POST /omw/api/v1/backend/access/claim': json(CLAIM),
      'POST /omw/api/v1/backend/access/renew': json({ lease: null }),
      'POST /omw/api/v1/backend/access/listing': json({ ...CLAIM, ops: [] }),
      'POST /omw/api/v1/backend/access/ack': () => new Response(null, { status: 204 }),
      'GET /omw/api/v1/backend/access/service-session?rotate=1': json({
        cookieName: '__Host-omw',
        cookieValue: `abcdefghijkl.abcdefgh.${'A'.repeat(43)}`,
        expiresAt: '2026-11-22T10:00:00.000Z',
      }),
      'GET /omw/api/v1/backend/access/service-session': json({ error: { code: 'busy' } }, 503),
    });
    const client = new ApiClient({ baseUrl: 'https://api.example.org/omw/', token: 't', fetch: f.fetch });
    expect(await client.claim()).toEqual(CLAIM);
    expect(await client.renew({ epoch: CLAIM.epoch })).toEqual({ lease: null });
    const listing = { marker: null, locked: null, sessions: [], handoffs: [], tombstones: [], strays: [] };
    expect((await client.uploadListing({ epoch: CLAIM.epoch, listing })).ops).toEqual([]);
    await client.ack({ epoch: CLAIM.epoch, appliedThrough: 1 });
    expect((await client.serviceSession(true)).cookieName).toBe('__Host-omw');
    const busy = await client.serviceSession(false).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(ApiRequestError);
    expect((busy as ApiRequestError).status).toBe(503);
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /omw/api/v1/backend/access/claim',
      'POST /omw/api/v1/backend/access/renew',
      'POST /omw/api/v1/backend/access/listing',
      'POST /omw/api/v1/backend/access/ack',
      'GET /omw/api/v1/backend/access/service-session?rotate=1',
      'GET /omw/api/v1/backend/access/service-session',
    ]);
    expect(f.calls[0]?.body).toEqual({ holder: 'mac' });
  });

  it('refuses an answer that does not match the contract', async () => {
    const f = fakeFetch({ 'POST /api/v1/backend/access/claim': json({ lease: 'forever' }) });
    const client = new ApiClient({ baseUrl: 'https://api.example.org', token: 't', fetch: f.fetch });
    const err = await client.claim().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).kind).toBe('invalid_response');
  });
});

describe('sync: access facts', () => {
  let tmp: ReturnType<typeof makeTempDir>;
  let store: Store;
  const clock = fakeClock('2026-11-21T10:00:00.000Z');
  beforeEach(() => {
    tmp = makeTempDir('sync-access-');
    store = Store.memory({ now: clock });
  });
  afterEach(() => {
    store.close();
    tmp.cleanup();
  });

  const gateEnv = {
    ACCESS_MODE: 'gate',
    SITE_PUBLIC_URL: 'https://site.example.org/k3j9x0m2p7q4r8s1t5u6/',
    API_BASE_URL: 'https://api.example.org',
    API_TOKEN: 't',
    ACCESS_STORE_DIR: '/usr/home/omw/omw-store/site1',
  };

  it('hands access.needsWriter of every change page to onAccess', async () => {
    const seen: boolean[] = [];
    const f = fakeFetch({
      'GET /api/v1/backend/changes?after=0&limit=200': json({
        feedId: 'feed_aaaaaaaa',
        items: [],
        nextSeq: 0,
        hasMore: false,
        access: { needsWriter: true },
      }),
    });
    const config = testConfig(tmp.dir, gateEnv);
    const sync = createSync({
      config,
      log: silentLog(),
      store,
      client: new ApiClient({ baseUrl: 'https://api.example.org', token: 't', fetch: f.fetch }),
      onAccess: (a) => seen.push(a.needsWriter),
      now: clock,
    });
    await sync.pullNow();
    expect(seen).toEqual([true]);
    expect(sync.accessClient?.()).not.toBeNull();
    await sync.stop();
  });

  it('heartbeat: site {origin, access, cookieMode, storeDir}; publish report: gateCheck', async () => {
    const config = testConfig(tmp.dir, gateEnv);
    const f = fakeFetch({});
    const sync = createSync({
      config,
      log: silentLog(),
      store,
      client: new ApiClient({ baseUrl: 'https://api.example.org', token: 't', fetch: f.fetch }),
      now: clock,
      diskFree: async () => 1,
    });
    const hb = await sync.buildHeartbeat();
    expect(hb.site).toEqual({
      origin: 'https://site.example.org',
      access: 'gate',
      cookieMode: 'headers',
      storeDir: '/usr/home/omw/omw-store/site1',
    });
    const gateCheck = { at: '2026-11-21T10:00:00.000Z', by: 'mac' as const, result: 'ok' as const, detail: null };
    sync.reportPublished([{ targetId: 'live', ok: true, version: 3, uploaded: 1, deleted: 0, gateCheck }], {
      version: 3,
      feedSeq: 0,
      capturesThrough: null,
    });
    const queued = store.outbox.due(10).find((i) => i.kind === 'published');
    if (!queued) throw new Error('no publish report queued');
    expect((queued.payload as { gateCheck?: unknown }).gateCheck).toEqual(gateCheck);
    await sync.stop();
    // Open mode without URLs: no site in the heartbeat.
    const open = createSync({ config: testConfig(tmp.dir), log: silentLog(), store, client: null, now: clock });
    expect((await open.buildHeartbeat()).site).toBeUndefined();
    await open.stop();
  });
});
