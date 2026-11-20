import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ControlServer, CSP, createControlServer } from '../../src/ui/server.js';
import { silentLog } from '../sync/helpers.js';
import { type FakeBackend, fakeBackend } from './fake-backend.js';

const TOKEN = 'control-token-for-tests-123';
let backend: FakeBackend;
let server: ControlServer;

beforeEach(async () => {
  backend = fakeBackend();
  server = await createControlServer({
    backend,
    token: TOKEN,
    host: '127.0.0.1',
    port: 18731,
    allowedHosts: ['omw.example.ts.net'],
    log: silentLog(),
    version: '0.1.0-test',
  });
});

afterEach(async () => {
  await server.close();
  backend.store.close();
});

const bearer = { authorization: `Bearer ${TOKEN}` };
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const formHeaders = { 'content-type': 'application/x-www-form-urlencoded' };

async function login(): Promise<{ cookie: string; csrf: string }> {
  const res = await server.app.inject({
    method: 'POST',
    url: '/login',
    headers: formHeaders,
    payload: form({ token: TOKEN, next: '/' }),
  });
  expect(res.statusCode).toBe(303);
  const setCookie = String(res.headers['set-cookie']);
  expect(setCookie).toMatch(/^omw_ctl=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  const cookie = setCookie.split(';')[0] ?? '';
  const page = await server.app.inject({ method: 'GET', url: '/', headers: { cookie } });
  const csrf = /<meta name="csrf-token" content="([^"]+)">/.exec(page.body)?.[1] ?? '';
  expect(csrf).not.toBe('');
  return { cookie, csrf };
}

describe('authentication', () => {
  it('redirects pages to the login form and answers 401 for the API', async () => {
    const page = await server.app.inject({ method: 'GET', url: '/queue?x=1' });
    expect(page.statusCode).toBe(303);
    expect(page.headers.location).toBe('/login?next=%2Fqueue%3Fx%3D1');
    const api = await server.app.inject({ method: 'GET', url: '/api/status' });
    expect(api.statusCode).toBe(401);
    expect(api.json()).toMatchObject({ error: { code: 'unauthorized' } });
    const frag = await server.app.inject({ method: 'GET', url: '/fragments/overview' });
    expect(frag.statusCode).toBe(401);
  });

  it('accepts the Bearer token', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/api/status', headers: bearer });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ app: 'omw-backend', version: '0.1.0-test' });
    const wrong = await server.app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('logs in with the token, rejects a wrong one and rate limits', async () => {
    const bad = await server.app.inject({
      method: 'POST',
      url: '/login',
      headers: formHeaders,
      payload: form({ token: 'x' }),
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.body).toContain('Wrong token');
    expect(bad.headers['set-cookie']).toBeUndefined();
    await login();
    for (let i = 0; i < 10; i++) {
      await server.app.inject({ method: 'POST', url: '/login', headers: formHeaders, payload: form({ token: 'x' }) });
    }
    const limited = await server.app.inject({
      method: 'POST',
      url: '/login',
      headers: formHeaders,
      payload: form({ token: TOKEN }),
    });
    expect(limited.statusCode).toBe(429);
  });

  it('never redirects off-site after login', async () => {
    for (const next of ['//evil.example/x', '/\t/evil.example', '/\r\nSet-Cookie: x=1']) {
      const res = await server.app.inject({
        method: 'POST',
        url: '/login',
        headers: formHeaders,
        payload: form({ token: TOKEN, next }),
      });
      expect(res.statusCode, JSON.stringify(next)).toBe(303);
      expect(res.headers.location, JSON.stringify(next)).toBe('/');
    }
  });

  it('logout revokes the session', async () => {
    const { cookie, csrf } = await login();
    const out = await server.app.inject({
      method: 'POST',
      url: '/logout',
      headers: { ...formHeaders, cookie },
      payload: form({ _csrf: csrf }),
    });
    expect(out.statusCode).toBe(303);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    const after = await server.app.inject({ method: 'GET', url: '/api/status', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('refuses foreign Host headers (DNS rebinding) but accepts loopback and allowed names', async () => {
    const evil = await server.app.inject({ method: 'GET', url: '/healthz', headers: { host: 'evil.example:8787' } });
    expect(evil.statusCode).toBe(421);
    for (const host of ['localhost:8787', '127.0.0.1:9999', '[::1]:8787', 'omw.example.ts.net']) {
      const ok = await server.app.inject({ method: 'GET', url: '/healthz', headers: { host } });
      expect(ok.statusCode, host).toBe(200);
    }
  });
});

describe('CSRF', () => {
  it('requires the CSRF token for cookie-authenticated posts', async () => {
    const { cookie, csrf } = await login();
    const missing = await server.app.inject({
      method: 'POST',
      url: '/actions/rebuild',
      headers: { ...formHeaders, cookie },
      payload: form({ full: '1' }),
    });
    expect(missing.statusCode).toBe(403);
    expect(backend.calls).not.toContain('rebuild:true');

    const ok = await server.app.inject({
      method: 'POST',
      url: '/actions/rebuild',
      headers: { ...formHeaders, cookie },
      payload: form({ full: '1', _csrf: csrf }),
    });
    expect(ok.statusCode).toBe(303);
    expect(ok.headers.location).toBe('/');
    expect(backend.calls).toContain('rebuild:true');

    // The flash message shows once on the next page.
    const page = await server.app.inject({ method: 'GET', url: '/', headers: { cookie } });
    expect(page.body).toContain('Generated v4');
    const again = await server.app.inject({ method: 'GET', url: '/', headers: { cookie } });
    expect(again.body).not.toContain('Generated v4');

    // A rebuild that changed nothing must not promise a publish.
    backend.rebuild = async () => ({ version: 4, changed: 0, removed: 0, full: true, durationMs: 9 });
    await server.app.inject({
      method: 'POST',
      url: '/actions/rebuild',
      headers: { ...formHeaders, cookie },
      payload: form({ full: '1', _csrf: csrf }),
    });
    const unchanged = await server.app.inject({ method: 'GET', url: '/', headers: { cookie } });
    expect(unchanged.body).toContain('Site v4 is up to date: no file changed');
    expect(unchanged.body).not.toContain('Publishing follows');
  });

  it('accepts the header form and rejects cross-site origins', async () => {
    const { cookie, csrf } = await login();
    const viaHeader = await server.app.inject({
      method: 'POST',
      url: '/api/sync/pull',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(viaHeader.statusCode).toBe(200);
    const crossSite = await server.app.inject({
      method: 'POST',
      url: '/api/sync/pull',
      headers: { cookie, 'x-csrf-token': csrf, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.statusCode).toBe(403);
    const crossLogin = await server.app.inject({
      method: 'POST',
      url: '/login',
      headers: { ...formHeaders, origin: 'https://evil.example' },
      payload: form({ token: TOKEN }),
    });
    expect(crossLogin.statusCode).toBe(403);
    const nullOrigin = await server.app.inject({
      method: 'POST',
      url: '/api/sync/pull',
      headers: { cookie, 'x-csrf-token': csrf, origin: 'null' },
    });
    expect(nullOrigin.statusCode).toBe(403);
  });

  it('does not need CSRF for Bearer requests', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/api/rebuild',
      headers: { ...bearer, 'content-type': 'application/json' },
      payload: JSON.stringify({ full: false }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, result: { version: 4, full: false } });
  });
});

describe('pages', () => {
  it('serves pages with a strict CSP and security headers', async () => {
    const { cookie } = await login();
    for (const url of ['/', '/link', '/queue', '/publish', '/logs', '/publish?edit=sftp-main']) {
      const res = await server.app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-security-policy']).toBe(CSP);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      // not no-referrer: that makes browsers send "Origin: null" on form posts (CSRF check fails)
      expect(res.headers['referrer-policy']).toBe('same-origin');
      expect(res.headers['cache-control']).toBe('no-store');
      // Unknown features (e.g. interest-cohort) make Chrome log a console error on every page.
      expect(res.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
      expect(res.body).not.toMatch(/<script>(?!alert)/); // only the external module script
      expect(res.body).not.toMatch(/ style="/);
    }
  });

  it('escapes untrusted text and never renders secrets', async () => {
    const { cookie } = await login();
    backend.targetList[0] = { ...backend.targetList[0], password: 'super-secret-pw' };
    const res = await server.app.inject({ method: 'GET', url: '/publish?edit=sftp-main', headers: { cookie } });
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(res.body).not.toContain('super-secret-pw');
    expect(res.body).toContain('(set — leave empty to keep)');
  });

  it('serves static assets with long caching', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/static/app.js?v=x' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/javascript');
    expect(res.headers['cache-control']).toContain('immutable');
    expect((await server.app.inject({ method: 'GET', url: '/static/nope.js' })).statusCode).toBe(404);
  });

  it('renders the overview fragment from the status', async () => {
    backend.statusValue.sync.lastPullError = 'GET /changes: HTTP 503';
    const res = await server.app.inject({ method: 'GET', url: '/fragments/overview', headers: bearer });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('GET /changes: HTTP 503');
    expect(res.body).toContain('+4915100000001');
  });
});

describe('actions', () => {
  it('saves targets from the form with write-only secrets', async () => {
    const { cookie, csrf } = await login();
    const res = await server.app.inject({
      method: 'POST',
      url: '/actions/targets/save',
      headers: { ...formHeaders, cookie },
      payload: form({
        _csrf: csrf,
        mode: 'edit',
        id: 'sftp-main',
        kind: 'sftp',
        label: 'Main',
        enabled: 'on',
        publicBaseUrl: 'https://example.org/',
        host: 'www99.your-server.de',
        port: '22',
        username: 'user',
        password: '',
        privateKey: '',
        passphrase: '',
        clear_passphrase: 'on',
        hostKeys: 'SHA256:1ckzga7xTCnKZNsqpWVAh4K85X9HmVe+5Ki1PW7tOQs',
        remoteRoot: '/',
        concurrency: '',
      }),
    });
    expect(res.statusCode).toBe(303);
    expect(backend.saved[0]).toEqual({
      id: 'sftp-main',
      kind: 'sftp',
      label: 'Main',
      enabled: true,
      publicBaseUrl: 'https://example.org/',
      host: 'www99.your-server.de',
      port: 22,
      username: 'user',
      trustOnFirstUse: false,
      remoteRoot: '/',
      privateKeyPath: null,
      passphrase: null,
      hostKeys: ['SHA256:1ckzga7xTCnKZNsqpWVAh4K85X9HmVe+5Ki1PW7tOQs'],
    });
  });

  it('shows validation errors as a flash message', async () => {
    const { cookie, csrf } = await login();
    await server.app.inject({
      method: 'POST',
      url: '/actions/targets/save',
      headers: { ...formHeaders, cookie },
      payload: form({ _csrf: csrf, id: '', kind: 'local', dir: '/x' }),
    });
    const page = await server.app.inject({ method: 'GET', url: '/publish', headers: { cookie } });
    expect(page.body).toContain('flash-error');
    expect(page.body).toContain('Expected a lowercase id');
  });

  it('runs publish, retry, skip, reprocess and target actions', async () => {
    const { cookie, csrf } = await login();
    const post = (url: string, fields: Record<string, string>) =>
      server.app.inject({
        method: 'POST',
        url,
        headers: { ...formHeaders, cookie },
        payload: form({ _csrf: csrf, ...fields }),
      });
    expect((await post('/actions/publish', { targetId: 'sftp-main' })).statusCode).toBe(303);
    await post('/actions/captures/retry', { sourceKey: 'wa:X1' });
    await post('/actions/captures/skip', { sourceKey: 'wa:X2' });
    await post('/actions/reprocess', {});
    await post('/actions/targets/test', { id: 'sftp-main' });
    await post('/actions/targets/remove', { id: 'sftp-main' });
    await post('/actions/sync/resync', {});
    await post('/actions/wa/restart', {});
    expect(backend.calls).toEqual([
      'publish:sftp-main',
      'retry:wa:X1',
      'skip:wa:X2',
      'reprocess:all',
      'targets.test:sftp-main',
      'targets.remove:sftp-main',
      'sync.resync',
      'wa.restart',
    ]);
  });

  it('JSON API: publish, queue, targets, logs, pair code', async () => {
    const pub = await server.app.inject({ method: 'POST', url: '/api/publish', headers: bearer });
    expect(pub.json()).toMatchObject({ ok: true, results: [{ targetId: 'local', ok: true }] });
    const forced = await server.app.inject({
      method: 'POST',
      url: '/api/publish',
      headers: bearer,
      payload: { targetId: 'local', force: true },
    });
    expect(forced.json()).toMatchObject({ ok: true });
    expect(backend.calls.slice(-2)).toEqual(['publish:all', 'publish:local:force']);
    expect((await server.app.inject({ method: 'GET', url: '/api/queue', headers: bearer })).json()).toMatchObject({
      captures: [],
      outbox: [],
      quarantine: [],
    });
    expect(
      (await server.app.inject({ method: 'GET', url: '/api/targets', headers: bearer })).json().items,
    ).toHaveLength(1);
    const bad = await server.app.inject({
      method: 'POST',
      url: '/api/targets',
      headers: { ...bearer, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(bad.statusCode).toBe(422);

    backend.logRing.write(`${JSON.stringify({ level: 30, time: 1, msg: 'hello', module: 'x' })}\n`);
    const logs = await server.app.inject({ method: 'GET', url: '/api/logs?after=0', headers: bearer });
    expect(logs.json().lines).toMatchObject([{ id: 1, msg: 'hello', module: 'x', levelLabel: 'info' }]);

    const code = await server.app.inject({
      method: 'POST',
      url: '/api/pair-code',
      headers: { ...bearer, 'content-type': 'application/json' },
      payload: JSON.stringify({ phone: '+49 151 0000 0009' }),
    });
    expect(code.json()).toEqual({ ok: true, code: 'ABCD-EFGH' });
    expect(backend.source.sent).toEqual([{ type: 'pair_code', phone: '4915100000009' }]);

    const invalid = await server.app.inject({
      method: 'POST',
      url: '/api/pair-code',
      headers: { ...bearer, 'content-type': 'application/json' },
      payload: JSON.stringify({ phone: '12' }),
    });
    expect(invalid.statusCode).toBe(422);
    backend.source.pairCodeReply = null;
    const timeout = await server.app.inject({
      method: 'POST',
      url: '/api/pair-code',
      headers: { ...bearer, 'content-type': 'application/json' },
      payload: JSON.stringify({ phone: '4915100000009' }),
    });
    expect(timeout.statusCode).toBe(504);
  });

  it('renders the pairing code on the link page', async () => {
    const { cookie, csrf } = await login();
    const res = await server.app.inject({
      method: 'POST',
      url: '/actions/pair-code',
      headers: { ...formHeaders, cookie },
      payload: form({ _csrf: csrf, phone: '4915100000009' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('ABCD-EFGH');
  });

  it('streams the WhatsApp state (once mode via inject)', async () => {
    backend.source.emit({ type: 'qr', code: '2@abc,def,ghi', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const res = await server.app.inject({ method: 'GET', url: '/api/wa/stream?once=1', headers: bearer });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toMatch(/^event: state\ndata: \{"state":"qr"/);
    expect(res.body).toContain('<svg');
  });
});

describe('healthz', () => {
  it('is public and minimal', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, app: 'omw-backend', version: '0.1.0-test' });
  });
});

describe('pairing (link page)', () => {
  it('after the QR window ended offers "Show a new QR code" (no confirm) instead of waiting forever', async () => {
    const { cookie } = await login();
    backend.source.update({
      process: 'stopped',
      wa: 'closed',
      qr: null,
      lastExit: { code: 7, signal: null, at: new Date().toISOString(), meaning: 'pairing window ended without a link' },
    });
    const page = await server.app.inject({ method: 'GET', url: '/link', headers: { cookie } });
    expect(page.body).toContain('This code expired — show a new one.');
    expect(page.body).not.toContain('Waiting for a QR code from the helper');
    expect(page.body).toContain('title="closed">Disconnected</span>');
    const renew = /<div class="renew" data-qr-renew >([\s\S]*?)<\/div>/.exec(page.body)?.[1] ?? '';
    expect(renew).toContain('action="/actions/wa/restart"');
    expect(renew).toContain('Show a new QR code');
    expect(renew).not.toContain('data-confirm');
  });

  it('says fixture mode has nothing to link (never "Linked ✓")', async () => {
    const { cookie } = await login();
    backend.source.update({ mode: 'fixture', wa: 'open' });
    const page = await server.app.inject({ method: 'GET', url: '/link', headers: { cookie } });
    expect(page.body).toContain('Fixture mode – nothing to link');
    expect(page.body).not.toContain('Linked ✓');
    const overview = await server.app.inject({ method: 'GET', url: '/fragments/overview', headers: bearer });
    expect(overview.body).not.toContain('Link WhatsApp</a>');
  });

  it('keeps the typed number after an error and shows how long a code is valid', async () => {
    const { cookie, csrf } = await login();
    const bad = await server.app.inject({
      method: 'POST',
      url: '/actions/pair-code',
      headers: { ...formHeaders, cookie },
      payload: form({ _csrf: csrf, phone: '0151 2345' }),
    });
    expect(bad.body).toContain('value="0151 2345"');
    expect(bad.body).toContain('is not a phone number in international format');
    expect(bad.body).toContain('+49 151 23456789');
    expect(bad.body).not.toContain('Code valid until');
    const good = await server.app.inject({
      method: 'POST',
      url: '/actions/pair-code',
      headers: { ...formHeaders, cookie },
      payload: form({ _csrf: csrf, phone: '+49 151 0000 0009' }),
    });
    expect(good.body).toContain('ABCD-EFGH');
    expect(good.body).toMatch(/Code valid until <time datetime="[^"]+" data-local-time>\d\d:\d\d UTC<\/time>/);
  });

  it('tells where the CONTROL_TOKEN comes from on the login page', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/login' });
    expect(res.body).toContain(
      'Enter the CONTROL_TOKEN of this backend (see <code>.env</code> / <code>docker compose</code>).',
    );
  });
});

describe('publish state', () => {
  it('shows no green "live" when the post-deploy HTTP check failed, and names the checked URL', async () => {
    backend.statusValue.publish.lastResults = [
      {
        targetId: 'sftp-main',
        ok: true,
        version: 5,
        uploaded: 3,
        deleted: 0,
        httpCheck: 'error',
        httpDetail: 'fetch failed',
      },
    ];
    const res = await server.app.inject({ method: 'GET', url: '/fragments/overview', headers: bearer });
    expect(res.body).toContain('<span class="badge badge-warn">deployed, site not reachable</span>');
    expect(res.body).not.toContain('<span class="badge badge-ok">live</span>');
    expect(res.body).toContain('https://example.org/data/manifest.json');
    expect(res.body).toContain('Does the host block this machine');
  });

  it('links a blocked SFTP login straight to the target form', async () => {
    const { cookie } = await login();
    backend.targetList[0] = {
      ...backend.targetList[0],
      status: { authBlocked: { message: 'All configured authentication methods failed' }, deployedVersion: 3 },
    };
    const res = await server.app.inject({ method: 'GET', url: '/publish', headers: { cookie } });
    expect(res.body).toContain('href="/publish?edit=sftp-main#target-form"');
    expect(res.body).toContain('<table class="table cards">');
    expect(res.body).toMatch(/class="nowrap cell-actions">[\s\S]*Test[\s\S]*Publish[\s\S]*Edit[\s\S]*Remove/);
  });
});
