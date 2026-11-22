/**
 * The Mac fallback writer and the lock button (spec-wave5 §3.8.4, §5.6.6, §8.4) against a fake
 * API and a local store folder: claim → listing → ops → ack; refusal on a missing or foreign marker
 * (failed: store_mismatch, nothing applied); init without a marker; lease check before each op,
 * renew, stop on lease loss; ≤ 200 ops; stop at the first failure; auth failures block; the lock
 * button writes `locked` exclusively and only after finding the marker. Plus StoreRemote's path
 * rules, modes and listing, and the service session keeper.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AccessAck,
  type AccessClaim,
  type AccessRenewRequest,
  STORE_HTACCESS,
  type StoreListingUpload,
  type StoreOp,
} from '@omw/contracts/access';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccessFallback, storeTargetOf } from '../../src/access/fallback.js';
import { ServiceSessionKeeper, ServiceSessionTimeout } from '../../src/access/service-session.js';
import { openStoreRemote, StoreRemote, StoreRemoteError } from '../../src/access/store-remote.js';
import { LocalRemote } from '../../src/publisher/local.js';
import { PublishError, type StoredTarget } from '../../src/publisher/types.js';
import { Store } from '../../src/store/index.js';
import { type ApiClient, ApiRequestError } from '../../src/sync/client.js';
import { fakeClock, makeTempDir } from '../helpers.js';
import { localTarget, sftpTarget, silentLog } from '../publisher/helpers.js';

const STORE_ID = '0123456789abcdef';
const EPOCH = 'fedcba9876543210';
const F = 'abcdefghijkl';
const D = 'abcdefgh';
const SID = 'S'.repeat(43);

class FakeApi {
  claims: AccessClaim[] = [];
  listingClaim: AccessClaim | null = null;
  renewals: AccessRenewRequest[] = [];
  renewLease: { until: string } | null = null;
  listings: StoreListingUpload[] = [];
  acks: AccessAck[] = [];
  ackStatus: number | null = null;
  async claim(): Promise<AccessClaim> {
    const c = this.claims.shift();
    if (!c) throw new Error('no claim prepared');
    return c;
  }
  async renew(body: AccessRenewRequest) {
    this.renewals.push(body);
    return { lease: this.renewLease };
  }
  async uploadListing(body: StoreListingUpload): Promise<AccessClaim> {
    this.listings.push(body);
    if (!this.listingClaim) throw new Error('no listing claim');
    return this.listingClaim;
  }
  async ack(body: AccessAck): Promise<void> {
    if (this.ackStatus)
      throw new ApiRequestError('conflict', { kind: 'http', status: this.ackStatus, code: 'conflict' });
    this.acks.push(body);
  }
}

const op = (id: number, o: Partial<StoreOp> & Pick<StoreOp, 'op' | 'path'>): StoreOp => ({
  id,
  content: null,
  exclusive: true,
  ...o,
});

describe('AccessFallback (spec-wave5 §5.6.6)', () => {
  let tmp: ReturnType<typeof makeTempDir>;
  let storeDir: string;
  let store: Store;
  let api: FakeApi;
  let target: StoredTarget;
  let opens: number;
  let openError: Error | null;
  const clock = fakeClock('2026-11-21T10:00:00.000Z');

  const marker = (over: Record<string, unknown> = {}) =>
    `${JSON.stringify({ format: 1, storeId: STORE_ID, epoch: EPOCH, op: 0, at: '2026-11-21T09:00:00.000Z', ...over })}\n`;
  const lease = (ms = 60_000) => ({ until: new Date(clock().getTime() + ms).toISOString() });
  const claim = (ops: StoreOp[], over: Partial<AccessClaim> = {}): AccessClaim => ({
    lease: lease(),
    storeId: STORE_ID,
    epoch: EPOCH,
    ops,
    listingWanted: false,
    ...over,
  });

  function fallback(opts: { client?: ApiClient | null } = {}) {
    return new AccessFallback({
      log: silentLog,
      store,
      client: () => (opts.client === undefined ? (api as unknown as ApiClient) : opts.client),
      targets: () => [target],
      openStore: async (t) => {
        opens++;
        if (openError) throw openError;
        return openStoreRemote(t, { configDir: tmp.dir });
      },
      now: clock,
    });
  }

  beforeEach(() => {
    clock.set('2026-11-21T10:00:00.000Z');
    tmp = makeTempDir('access-fallback-');
    storeDir = join(tmp.dir, 'store');
    mkdirSync(storeDir, { recursive: true });
    store = Store.memory({ now: clock });
    api = new FakeApi();
    target = localTarget('www', join(tmp.dir, 'www'), { accessStoreDir: storeDir } as Partial<StoredTarget>);
    opens = 0;
    openError = null;
  });
  afterEach(() => {
    store.close();
    tmp.cleanup();
  });

  it('claim → ops → marker → ack: sessions, handoff, tombstone, prefix delete, lock', async () => {
    writeFileSync(join(storeDir, '.omw-store.json'), marker());
    mkdirSync(join(storeDir, 's', F), { recursive: true });
    writeFileSync(join(storeDir, 's', F, `${D}.${'O'.repeat(43)}`), '');
    api.claims.push(
      claim([
        op(11, { op: 'delete_prefix', path: `s/${F}/${D}.` }),
        op(12, { op: 'put', path: `s/${F}/${D}.${SID}` }),
        op(13, { op: 'put', path: `h/${D}` }),
        op(14, { op: 'put', path: `t/${F}.bbbbbbbb`, content: '{"s":"revoked","at":"2026-11-21T09:00:00.000Z"}' }),
        op(15, { op: 'put', path: 'locked', content: '{"at":"2026-11-21T09:59:00.000Z","by":"admin"}' }),
      ]),
    );
    const r = await fallback().run();
    expect(r).toEqual({ status: 'applied', applied: 5, through: 15 });
    expect(existsSync(join(storeDir, 's', F, `${D}.${'O'.repeat(43)}`))).toBe(false);
    expect(existsSync(join(storeDir, 's', F, `${D}.${SID}`))).toBe(true);
    expect(existsSync(join(storeDir, 'h', D))).toBe(true);
    expect(readFileSync(join(storeDir, 't', `${F}.bbbbbbbb`), 'utf8')).toContain('revoked');
    expect(readFileSync(join(storeDir, 'locked'), 'utf8')).toContain('admin');
    expect(api.acks).toEqual([{ epoch: EPOCH, appliedThrough: 15 }]);
    const m = JSON.parse(readFileSync(join(storeDir, '.omw-store.json'), 'utf8'));
    expect(m).toEqual({ format: 1, storeId: STORE_ID, epoch: EPOCH, op: 15, at: '2026-11-21T10:00:00.000Z' });
    // Store modes of what the writer creates: directories 0711, files 0600 (spec-wave5 §2.2).
    expect(statSync(join(storeDir, 'h')).mode & 0o777).toBe(0o711);
    expect(statSync(join(storeDir, 'h', D)).mode & 0o777).toBe(0o600);
  });

  it('listingWanted: uploads the store listing and applies the ops the API returns', async () => {
    writeFileSync(join(storeDir, '.omw-store.json'), marker());
    mkdirSync(join(storeDir, 's', F), { recursive: true });
    writeFileSync(join(storeDir, 's', F, `${D}.${SID}`), '');
    writeFileSync(join(storeDir, 's', F, 'junk'), '');
    mkdirSync(join(storeDir, 'h'));
    writeFileSync(join(storeDir, 'h', D), '');
    mkdirSync(join(storeDir, 't'));
    writeFileSync(join(storeDir, 't', 'cccccccccccc'), '{"s":"deleted","at":"2026-11-20T00:00:00.000Z"}');
    api.claims.push(claim([], { listingWanted: true }));
    api.listingClaim = claim([op(21, { op: 'delete', path: `s/${F}/junk` })]);
    const r = await fallback().run();
    expect(r).toMatchObject({ status: 'applied', applied: 1 });
    expect(api.listings).toHaveLength(1);
    expect(api.listings[0]?.listing).toEqual({
      marker: marker(),
      locked: null,
      sessions: [`s/${F}/${D}.${SID}`],
      handoffs: [D],
      tombstones: [{ path: 't/cccccccccccc', content: '{"s":"deleted","at":"2026-11-20T00:00:00.000Z"}' }],
      strays: [`s/${F}/junk`],
    });
    expect(existsSync(join(storeDir, 's', F, 'junk'))).toBe(false);
  });

  it('a store without the marker, or with another storeId: nothing applied, ack failed store_mismatch', async () => {
    api.claims.push(claim([op(31, { op: 'put', path: `s/${F}/${D}.${SID}` })]));
    const missing = await fallback().run();
    expect(missing.status).toBe('refused');
    expect(api.acks).toEqual([{ epoch: EPOCH, appliedThrough: 0, failed: { opId: 31, error: 'store_mismatch' } }]);
    expect(existsSync(join(storeDir, 's'))).toBe(false);
    writeFileSync(join(storeDir, '.omw-store.json'), marker({ storeId: 'ffffffffffffffff' }));
    api.claims.push(claim([op(31, { op: 'put', path: `s/${F}/${D}.${SID}` })]));
    const foreign = await fallback().run({ force: true });
    expect(foreign).toMatchObject({ status: 'refused', reason: expect.stringMatching(/another store/) });
    expect(existsSync(join(storeDir, 's'))).toBe(false);
    // Another epoch is only accepted for the reconcile after an API restore (listing uploaded).
    writeFileSync(join(storeDir, '.omw-store.json'), marker({ epoch: '1111111111111111' }));
    api.claims.push(claim([op(32, { op: 'put', path: `h/${D}` })]));
    expect((await fallback().run({ force: true })).status).toBe('refused');
    api.claims.push(claim([], { listingWanted: true }));
    api.listingClaim = claim([op(33, { op: 'put', path: `h/${D}` })]);
    expect((await fallback().run({ force: true })).status).toBe('applied');
  });

  it('init runs without a marker and creates it; an existing marker blocks a second init', async () => {
    const content = JSON.stringify({
      format: 1,
      storeId: STORE_ID,
      epoch: EPOCH,
      op: 0,
      at: '2026-11-21T09:00:00.000Z',
    });
    api.claims.push(claim([op(1, { op: 'init', path: '.omw-store.json', content })], { storeId: null }));
    const r = await fallback().run();
    expect(r).toMatchObject({ status: 'applied', applied: 1 });
    expect(JSON.parse(readFileSync(join(storeDir, '.omw-store.json'), 'utf8'))).toMatchObject({
      storeId: STORE_ID,
      op: 1,
    });
    // Like the API's init: the deny-all .htaccess (needed when the store sits inside a docroot, F3).
    expect(readFileSync(join(storeDir, '.htaccess'), 'utf8')).toBe(STORE_HTACCESS);
    api.claims.push(claim([op(2, { op: 'init', path: '.omw-store.json', content })], { storeId: null }));
    expect((await fallback().run({ force: true })).status).toBe('refused');
  });

  it('a run with a listing rewrites a changed store .htaccess', async () => {
    writeFileSync(join(storeDir, '.omw-store.json'), marker());
    writeFileSync(join(storeDir, '.htaccess'), 'Options +Indexes\n');
    api.claims.push(claim([], { listingWanted: true }));
    api.listingClaim = claim([]);
    expect((await fallback().run()).status).toBe('applied');
    expect(readFileSync(join(storeDir, '.htaccess'), 'utf8')).toBe(STORE_HTACCESS);
  });

  it('a person tombstone goes from "revoked" to "deleted", never back', async () => {
    writeFileSync(join(storeDir, '.omw-store.json'), marker());
    mkdirSync(join(storeDir, 't'));
    const revoked = '{"s":"revoked","at":"2026-11-20T00:00:00.000Z"}';
    const deleted = '{"s":"deleted","at":"2026-11-21T00:00:00.000Z"}';
    writeFileSync(join(storeDir, 't', F), revoked);
    api.claims.push(claim([op(41, { op: 'put', path: `t/${F}`, content: deleted })]));
    expect(await fallback().run()).toMatchObject({ status: 'applied', applied: 1 });
    expect(readFileSync(join(storeDir, 't', F), 'utf8')).toBe(deleted);
    // A later "revoked" (or a repeated op) never turns a deleted person back into a revoked one.
    api.claims.push(claim([op(42, { op: 'put', path: `t/${F}`, content: revoked })]));
    expect(await fallback().run({ force: true })).toMatchObject({ status: 'applied', applied: 1 });
    expect(readFileSync(join(storeDir, 't', F), 'utf8')).toBe(deleted);
  });

  it('without a marker, a claimed init runs first even behind other ops; no listing in that run', async () => {
    const content = JSON.stringify({
      format: 1,
      storeId: STORE_ID,
      epoch: EPOCH,
      op: 0,
      at: '2026-11-21T09:00:00.000Z',
    });
    // A session issued before the owner initialised the store, then the init op.
    api.claims.push(
      claim(
        [
          op(4, { op: 'put', path: `s/${F}/${D}.${'S'.repeat(43)}` }),
          op(5, { op: 'init', path: '.omw-store.json', content }),
        ],
        { listingWanted: true },
      ),
    );
    const r = await fallback().run({ force: true });
    expect(r).toMatchObject({ status: 'applied', applied: 2, through: 5 });
    expect(api.listings).toHaveLength(0);
    expect(existsSync(join(storeDir, 's', F, `${D}.${'S'.repeat(43)}`))).toBe(true);
    expect(JSON.parse(readFileSync(join(storeDir, '.omw-store.json'), 'utf8'))).toMatchObject({
      storeId: STORE_ID,
      op: 5,
    });
    expect(api.acks.at(-1)).toMatchObject({ appliedThrough: 5 });
    // Without an init op a missing marker still refuses everything.
    rmSync(join(storeDir, '.omw-store.json'));
    api.claims.push(claim([op(6, { op: 'delete', path: `h/${D}` })]));
    expect((await fallback().run({ force: true })).status).toBe('refused');
  });

  it('checks the lease before each op: renews, and stops at once when the lease is lost', async () => {
    writeFileSync(join(storeDir, '.omw-store.json'), marker());
    api.claims.push(
      claim(
        [op(41, { op: 'put', path: `h/${D}` }), op(42, { op: 'put', path: 'h/bbbbbbbb' })],
        { lease: lease(9_000) }, // already inside the 10 s margin
      ),
    );
    api.renewLease = lease(60_000);
    expect(await fallback().run()).toMatchObject({ status: 'applied', applied: 2 });
    expect(api.renewals).toEqual([{ epoch: EPOCH }]);
    api.claims.push(claim([op(43, { op: 'put', path: 'h/cccccccc' })], { lease: lease(5_000) }));
    api.renewLease = null;
    expect(await fallback().run({ force: true })).toEqual({ status: 'lease_lost', applied: 0 });
    expect(existsSync(join(storeDir, 'h', 'cccccccc'))).toBe(false);
    expect(api.acks).toHaveLength(1); // no ack after a lost lease
  });

  it('applies at most 200 ops per claim and stops at the first failure (order matters)', async () => {
    writeFileSync(join(storeDir, '.omw-store.json'), marker());
    const many = Array.from({ length: 250 }, (_, i) =>
      op(i + 1, {
        op: 'put',
        path: `h/${String.fromCharCode(97 + (i % 26))}${'a'.repeat(5)}${String.fromCharCode(97 + Math.floor(i / 26))}a`,
      }),
    );
    api.claims.push(claim(many));
    expect(await fallback().run()).toMatchObject({ status: 'applied', applied: 200, through: 200 });
    api.claims.push(
      claim([
        op(301, { op: 'put', path: 'h/zzzzzzzz' }),
        op(302, { op: 'put', path: '../escape' }),
        op(303, { op: 'put', path: 'h/yyyyyyyy' }),
      ]),
    );
    const failed = await fallback().run({ force: true });
    expect(failed).toMatchObject({ status: 'failed', applied: 1, opId: 302 });
    expect(api.acks.at(-1)).toMatchObject({ appliedThrough: 301, failed: { opId: 302 } });
    expect(existsSync(join(storeDir, 'h', 'yyyyyyyy'))).toBe(false);
  });

  it('an ack refused with 409 means the lease was lost (the API re-applies from its own state)', async () => {
    writeFileSync(join(storeDir, '.omw-store.json'), marker());
    api.claims.push(claim([op(51, { op: 'put', path: `h/${D}` })]));
    api.ackStatus = 409;
    expect((await fallback().run()).status).toBe('lease_lost');
  });

  it('no lease, no API, no store target, runs closer than 15 s: nothing happens', async () => {
    api.claims.push(claim([], { lease: null }));
    expect(await fallback().run()).toEqual({ status: 'no_lease' });
    expect(opens).toBe(0);
    expect((await fallback({ client: null }).run()).status).toBe('skipped');
    const fb = fallback();
    api.claims.push(claim([], { lease: null }));
    await fb.run();
    expect(await fb.run()).toEqual({ status: 'skipped', reason: 'ran less than 15 s ago' });
    target = localTarget('www', join(tmp.dir, 'www'));
    expect(await fallback().run()).toMatchObject({
      status: 'skipped',
      reason: expect.stringMatching(/no store target/),
    });
  });

  it('an SSH authentication failure blocks the store target until it is saved again', async () => {
    openError = new PublishError('auth', 'Permission denied');
    api.claims.push(claim([op(61, { op: 'put', path: `h/${D}` })]));
    const fb = fallback();
    expect((await fb.run()).status).toBe('refused');
    expect(api.acks).toEqual([{ epoch: EPOCH, appliedThrough: 0 }]);
    expect(fb.blocked(target)).toMatchObject({ message: 'Permission denied' });
    api.claims.push(claim([]));
    expect(await fb.run({ force: true })).toMatchObject({
      status: 'skipped',
      reason: expect.stringMatching(/blocked/),
    });
    expect(opens).toBe(1);
    // Saved again (new updatedAt): unblocked.
    target = { ...target, updatedAt: '2026-11-21T11:00:00.000Z' };
    expect(fb.blocked(target)).toBeNull();
  });

  it('the lock button writes locked exclusively, only after finding the marker', async () => {
    const fb = fallback();
    expect(await fb.lockSite()).toEqual({ ok: false, error: 'Website-Speicher nicht gefunden – Pfad prüfen' });
    expect(existsSync(join(storeDir, 'locked'))).toBe(false);
    writeFileSync(join(storeDir, '.omw-store.json'), marker());
    expect(await fb.lockSite()).toEqual({ ok: true, already: false });
    const body = JSON.parse(readFileSync(join(storeDir, 'locked'), 'utf8'));
    expect(body).toEqual({ at: '2026-11-21T10:00:00.000Z', by: 'mac' });
    clock.advance(60_000);
    expect(await fb.lockSite()).toEqual({ ok: true, already: true });
    expect(JSON.parse(readFileSync(join(storeDir, 'locked'), 'utf8')).at).toBe('2026-11-21T10:00:00.000Z');
    // The storeId the Mac knows from its last claim must match.
    store.meta.set('access.store_id', 'ffffffffffffffff');
    expect(await fb.lockSite()).toMatchObject({ ok: false, error: expect.stringMatching(/andere Speicher-ID/) });
  });

  it('picks a store-only target first; requires a store path', () => {
    const a = sftpTarget('a', { accessStoreRoot: '/s' });
    const b = sftpTarget('b', { accessStoreRoot: '/s', publish: false });
    const c = sftpTarget('c');
    expect(storeTargetOf([a, b, c])?.id).toBe('b');
    expect(storeTargetOf([a, c])?.id).toBe('a');
    expect(storeTargetOf([c])).toBeNull();
    expect(storeTargetOf([{ ...b, enabled: false }])).toBeNull();
  });
});

describe('StoreRemote (spec-wave5 §3.8.1)', () => {
  let tmp: ReturnType<typeof makeTempDir>;
  beforeEach(() => {
    tmp = makeTempDir('store-remote-');
  });
  afterEach(() => tmp.cleanup());

  it('rejects every path outside the store layout before touching the remote', async () => {
    const s = new StoreRemote(new LocalRemote(tmp.dir), '/');
    for (const bad of ['../x', '/etc/passwd', 's/../h/x', 'x', 's/ABCDEFGHIJKL/abcdefgh.x', 'h/abc', '.htaccess2']) {
      await expect(s.put(bad, '', true), bad).rejects.toBeInstanceOf(StoreRemoteError);
    }
    await expect(s.delete('t/abcdefghijkl')).rejects.toBeInstanceOf(StoreRemoteError); // tombstones are never deleted
    await expect(s.deleteTree('s')).rejects.toBeInstanceOf(StoreRemoteError);
    await expect(s.deletePrefix('s/abcdefghijkl', 'x')).rejects.toBeInstanceOf(StoreRemoteError);
    expect(() => new StoreRemote(new LocalRemote(tmp.dir), '/a/../b')).toThrow(StoreRemoteError);
  });

  it('exclusive puts never rewrite; deleteTree and deletePrefix remove only their entries', async () => {
    const s = new StoreRemote(new LocalRemote(tmp.dir), '/');
    expect(await s.put('locked', '{"a":1}', true)).toBe(true);
    expect(await s.put('locked', '{"a":2}', true)).toBe(false);
    expect(readFileSync(join(tmp.dir, 'locked'), 'utf8')).toBe('{"a":1}');
    await s.put(`s/${F}/${D}.${SID}`, '', true);
    await s.put(`s/${F}/bbbbbbbb.${SID}`, '', true);
    expect(await s.deletePrefix(`s/${F}`, `${D}.`)).toBe(1);
    expect(await s.list(`s/${F}`)).toEqual([`bbbbbbbb.${SID}`]);
    await s.deleteTree(`s/${F}`);
    expect(existsSync(join(tmp.dir, 's', F))).toBe(false);
    await s.deleteTree(`s/${F}`); // missing = ok
    await s.delete(`h/${D}`);
    expect(await s.list('h')).toEqual([]);
  });

  it('openStoreRemote: a local store folder is never created; SFTP needs pinned host keys', async () => {
    const missing = localTarget('x', join(tmp.dir, 'www'), {
      accessStoreDir: join(tmp.dir, 'nope'),
    } as Partial<StoredTarget>);
    const s = await openStoreRemote(missing, { configDir: tmp.dir });
    expect(await s.rootExists()).toBe(false);
    expect(existsSync(join(tmp.dir, 'nope'))).toBe(false);
    await expect(
      openStoreRemote(sftpTarget('y', { accessStoreRoot: '/store' }), { configDir: tmp.dir }),
    ).rejects.toThrow(/pin the host key/);
    await expect(openStoreRemote(sftpTarget('z'), { configDir: tmp.dir })).rejects.toThrow(/no accessStoreRoot/);
  });
});

describe('ServiceSessionKeeper (spec-wave5 §5.6.3)', () => {
  const session = (n: number) => ({
    cookieName: '__Host-omw',
    cookieValue: `abcdefghijkl.abcdefgh.${String(n).repeat(43).slice(0, 43)}`,
    expiresAt: '2026-11-22T10:00:00.000Z',
  });

  it('rotates once, then polls without rotating until the new session is applied; keeps the previous', async () => {
    const calls: boolean[] = [];
    const answers: (ReturnType<typeof session> | number)[] = [session(1), 503, 503, session(2)];
    const client = {
      serviceSession: async (rotate: boolean) => {
        calls.push(rotate);
        const a = answers.shift();
        if (typeof a === 'number') throw new ApiRequestError('busy', { kind: 'http', status: a, code: 'busy' });
        return a;
      },
    } as unknown as ApiClient;
    const sleeps: number[] = [];
    const keeper = new ServiceSessionKeeper({ client: () => client, sleep: async (ms) => void sleeps.push(ms) });
    expect(await keeper.rotate()).toEqual({
      current: { name: '__Host-omw', value: session(1).cookieValue },
      previous: null,
    });
    const second = await keeper.rotate();
    expect(second?.previous?.value).toBe(session(1).cookieValue);
    expect(second?.current.value).toBe(session(2).cookieValue);
    expect(calls).toEqual([true, true, false, false]);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('no API → null; never applied → timeout; other errors propagate', async () => {
    expect(await new ServiceSessionKeeper({ client: () => null }).rotate()).toBeNull();
    let t = 0;
    const busy = {
      serviceSession: async () => {
        throw new ApiRequestError('busy', { kind: 'http', status: 503, code: 'busy' });
      },
    } as unknown as ApiClient;
    const keeper = new ServiceSessionKeeper({
      client: () => busy,
      now: () => new Date(t),
      sleep: async (ms) => {
        t += ms;
      },
    });
    await expect(keeper.rotate()).rejects.toBeInstanceOf(ServiceSessionTimeout);
    const broken = {
      serviceSession: async () => {
        throw new ApiRequestError('nope', { kind: 'http', status: 401 });
      },
    } as unknown as ApiClient;
    await expect(new ServiceSessionKeeper({ client: () => broken }).rotate()).rejects.toThrow(/nope/);
  });
});
