/**
 * Mock world for the gate pages' e2e (spec-wave5 §8.5), entirely inside Playwright's request
 * routing, so nothing listens on a port and nothing leaves the machine:
 *
 *   https://site.gate.test   the site host. /_/<page>/ are gate pages built like the generator's
 *                            (§2.6: GateBoot JSON, the production gate bundle from
 *                            OMW_GATE_E2E_DIST, CSP {{CSP_G}}); /_/h/ and every other path follow
 *                            the gate rules of §2.4 against an in-memory session store (handoff:
 *                            Strict key cookie + transfer cookie + marker + session → 303 into
 *                            the content with Set-Cookie; refusals → the neutral page / 403).
 *   https://api.gate.test    the public API (§3.4) for one invited person "Oma", with the state
 *                            the tests drive (approve, revoke, lock, publish a notice).
 *
 * The content behind the gate is a stub page: the SPA's own access handling has unit tests.
 * Redirects are answered as a tiny page with a meta refresh (same cookies, same target): the
 * Chromium shell does not follow a 3xx that a route fulfils.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Request, Route } from '@playwright/test';

export const SITE = 'https://site.gate.test';
export const API_ORIGIN = 'https://api.gate.test';
export const API = `${API_ORIGIN}/api/v1/public/`;
export const SECRET = 'abcdefghij0123456789';
export const LINK = 'tTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtT-_0';
export const PANIC_KEY = 'pPpPpPpPpPpPpPpPpPpPpPpPpPpPpPpPpPpPpPpPp_0';
const FID = 'abcdefgh2345';
const NAMES = { session: '__Host-omw', key: '__Host-omw_k', transfer: '__Host-omw_s', handoff: '__Host-omw_h' };

const NEUTRAL_SCRIPT = `(function(){try{var c=document.cookie.split('; '),h=function(n){return c.some(function(x){return x.indexOf(n+'=')===0})};if(h('__Host-omw_k')&&!h('__Host-omw_r')){document.cookie='__Host-omw_r=1; Path=/; Max-Age=300; Secure; SameSite=Strict';location.replace('/_/join/#resume');return;}}catch(e){}var f=document.getElementById('p');if(f)f.addEventListener('submit',function(e){e.preventDefault();var m=/#t=([A-Za-z0-9_-]{43})/.exec(document.getElementById('u').value);if(m)location.assign('/_/join/#t='+m[1]);});})();`;
const NEUTRAL_CSS = 'body{font-family:system-ui;margin:2rem}';
const NEUTRAL_PAGE = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Privat · Private</title><style>${NEUTRAL_CSS}</style></head><body><main><h1><span lang="de">Privat</span> · <span lang="en">Private</span></h1><p lang="de">Diese Seite ist nur mit persönlicher Einladung sichtbar.</p><form id="p"><input id="u" type="url" aria-label="Link"><button type="submit">→</button></form></main><script>${NEUTRAL_SCRIPT}</script></body></html>`;
const hash = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
const CSP_N = `default-src 'none'; script-src ${hash(NEUTRAL_SCRIPT)}; style-src ${hash(NEUTRAL_CSS)}; img-src data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`;
const CSP_G = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src ${API_ORIGIN}; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`;

const token = () => randomBytes(32).toString('base64url');
const did = () =>
  Array.from(randomBytes(8))
    .map((b) => 'abcdefghijklmnopqrstuvwxyz234567'[b % 32])
    .join('');

export interface Device {
  did: string;
  k: string;
  state: 'pending' | 'active' | 'revoked' | 'declined';
  label: string;
  createdAt: string;
  sid: string | null;
  marker: boolean;
  consented: number[];
}

function notice(version: number) {
  const texts = (lang: string) => ({
    title: lang === 'de' ? `Datenschutzhinweise (Version ${version})` : `Privacy information (version ${version})`,
    intro: `${lang}: Diese Seite ist nur für eingeladene Menschen.`,
    collected: `${lang}: Name, Geräte, Bestätigungen.`,
    audience: `${lang}: Die einladende Person.`,
    purpose: `${lang}: Zugang.`,
    retention: `${lang}: Bis zur Löschung.`,
    rights: `${lang}: Auskunft und Löschung.`,
  });
  return {
    controller: { name: 'Erika Muster', email: 'erika@example.org' },
    texts: { de: texts('de'), en: texts('en') },
    version,
    publishedAt: '2026-11-20T10:00:00.000Z',
  };
}

/** A redirect as a page (see the header), carrying the Set-Cookie lines a 303 would carry. */
function redirect(route: Route, location: string, cookies: string[] = []): Promise<void> {
  return route.fulfill({
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...(cookies.length > 0 ? { 'set-cookie': cookies.join('\n') } : {}),
    },
    body: `<!doctype html><meta http-equiv="refresh" content="0;url=${location}">`,
  });
}

function cookieOf(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [n, ...rest] = part.trim().split('=');
    if (n === name) return rest.join('=');
  }
  return null;
}

export class GateMock {
  readonly devices: Device[] = [];
  locked = false;
  deleted = false;
  noticeVersion = 1;
  /** Every request any page made (method + full URL), for the leak checks. */
  readonly requests: { url: string; method: string }[] = [];
  readonly foreign: string[] = [];
  readonly gatePages: Record<string, string>;
  readonly assets: Map<string, { body: Buffer; type: string }>;

  constructor(dist: string) {
    const manifest = JSON.parse(readFileSync(join(dist, '.vite/manifest.json'), 'utf8')) as Record<
      string,
      { file: string; css?: string[] }
    >;
    const entry = manifest['src/gate/main.ts'];
    if (!entry) throw new Error('gate bundle manifest without src/gate/main.ts');
    this.assets = new Map();
    for (const rel of [entry.file, ...(entry.css ?? [])]) {
      this.assets.set(`/_/${rel}`, {
        body: readFileSync(join(dist, rel)),
        type: rel.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
      });
    }
    this.gatePages = {};
    for (const page of ['join', 'info', 'wait', 'ended', 'me', 'panic']) {
      const boot = {
        page,
        api: API,
        locales: ['de', 'en'],
        defaultLocale: 'de',
        cookies: { ...NAMES, resume: '__Host-omw_r', secure: true },
        cookieMode: 'headers',
        cookieDomain: null,
        build: 'e2e',
      };
      this.gatePages[page] = [
        '<!doctype html>',
        '<html lang="de" dir="ltr"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>Privat · Private</title>',
        ...(entry.css ?? []).map((c) => `<link rel="stylesheet" href="/_/${c}">`),
        `<script type="module" src="/_/${entry.file}"></script>`,
        `<script type="application/json" id="omw-gate">${JSON.stringify(boot)}</script>`,
        '</head><body><noscript><p>Bitte JavaScript aktivieren / Please enable JavaScript</p></noscript>',
        '<main id="omw-gate-root"></main></body></html>',
      ].join('\n');
    }
  }

  device(k: string | null): Device | undefined {
    return k ? this.devices.find((d) => d.k === k) : undefined;
  }

  sessionValue(d: Device): string {
    return `${FID}.${d.did}.${d.sid}`;
  }

  /** The session values and keys the mock ever handed out (none may appear in a URL). */
  secrets(): string[] {
    return this.devices.flatMap((d) => [d.k, ...(d.sid ? [d.sid, this.sessionValue(d)] : [])]);
  }

  approve(index: number): void {
    const d = this.devices.filter((x) => x.state === 'pending')[index];
    if (d) d.state = 'active';
  }

  revoke(d: Device): void {
    d.state = 'revoked';
    d.sid = null;
    d.marker = false;
  }

  async install(context: BrowserContext): Promise<void> {
    context.on('request', (req: Request) => this.requests.push({ url: req.url(), method: req.method() }));
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === SITE) return this.site(route, url);
      if (url.origin === API_ORIGIN) return this.api(route, url);
      this.foreign.push(url.href);
      return route.abort();
    });
  }

  // ------------------------------------------------------------------------------------------
  // Site host (Apache + .htaccess, §2.4)

  private async site(route: Route, url: URL): Promise<void> {
    const cookie = (await route.request().allHeaders()).cookie;
    const path = url.pathname;
    const asset = this.assets.get(path);
    if (asset) return route.fulfill({ status: 200, headers: { 'content-type': asset.type }, body: asset.body });
    const page = /^\/_\/(join|info|wait|ended|me|panic)\/$/.exec(path)?.[1];
    if (page) {
      return route.fulfill({
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': CSP_G,
          'cache-control': 'no-store',
        },
        body: this.gatePages[page] as string,
      });
    }
    if (path === '/_/h/') {
      const k = cookieOf(cookie, NAMES.key);
      const transfer = cookieOf(cookie, NAMES.transfer);
      const d = this.devices.find((x) => x.sid && this.sessionValue(x) === transfer);
      if (k && /^[A-Za-z0-9_-]{43}$/.test(k) && d?.marker && d.state === 'active' && !this.locked) {
        return redirect(route, `/${SECRET}/`, [
          `${NAMES.session}=${transfer}; Path=/; Max-Age=34560000; Secure; HttpOnly; SameSite=Lax`,
          `${NAMES.key}=${k}; Path=/; Max-Age=34560000; Secure; SameSite=Strict`,
          `${NAMES.transfer}=; Path=/; Max-Age=0; Secure; SameSite=Strict`,
          `${NAMES.handoff}=1; Path=/; Max-Age=600; Secure; SameSite=Strict`,
        ]);
      }
      return redirect(route, '/_/join/#handoff-failed');
    }
    const session = cookieOf(cookie, NAMES.session);
    const d = this.devices.find((x) => x.sid && this.sessionValue(x) === session && x.state === 'active');
    if (d && !this.locked) {
      if (path === '/') return redirect(route, `/${SECRET}/`);
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Inhalt</title></head><body><main><h1 id="content">Die Seite hinter dem Tor</h1></main></body></html>',
      });
    }
    if (/^\/[^/]+\/(?:data|media)\//.test(path)) {
      return route.fulfill({ status: 403, headers: { 'content-type': 'text/plain' }, body: 'Forbidden\n' });
    }
    return route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': CSP_N,
        'cache-control': 'no-store',
      },
      body: NEUTRAL_PAGE,
    });
  }

  // ------------------------------------------------------------------------------------------
  // Public API (§3.4)

  private async api(route: Route, url: URL): Promise<void> {
    const cors = {
      'access-control-allow-origin': SITE,
      'access-control-expose-headers': 'Content-Disposition, Retry-After',
    };
    const json = (body: unknown, extra: Record<string, string> = {}) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json', ...cors, ...extra },
        body: JSON.stringify(body),
      });
    const req = route.request();
    if (req.method() !== 'POST') return route.fulfill({ status: 405, headers: cors, body: '' });
    const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>;
    const k = typeof body.k === 'string' ? body.k : null;
    const d = this.device(k);
    const issue = (dev: Device) => {
      dev.sid = token();
      dev.marker = true;
      return { status: 'active', handoff: '/_/h/', session: this.sessionValue(dev) };
    };
    switch (url.pathname.slice('/api/v1/public/'.length)) {
      case 'join/check': {
        if (body.t !== LINK || this.deleted) return json({ status: 'invalid' });
        if (this.locked) return json({ status: 'unavailable', reason: 'locked' });
        if (d?.state === 'active') return json({ status: 'known_device', noticeRequired: false });
        if (d?.state === 'pending') return json({ status: 'pending_device' });
        const mustWait = this.devices.some((x) => x.state === 'active' || x.state === 'revoked');
        return json({
          status: 'ok',
          follower: { name: 'Oma' },
          notice: notice(this.noticeVersion),
          deviceMustWait: mustWait,
        });
      }
      case 'join': {
        if (body.resume === true) {
          if (d?.state !== 'active') return json({ status: 'ended' });
          if (this.locked) return json({ status: 'unavailable', reason: 'locked' });
          return json(issue(d));
        }
        if (body.t !== LINK || this.deleted) return json({ status: 'invalid' });
        if (body.consentVersion !== this.noticeVersion)
          return json({ status: 'consent_outdated', notice: notice(this.noticeVersion) });
        if (d?.state === 'pending') return json({ status: 'pending', pollAfterMs: 10_000 });
        if (d?.state === 'active') return json(issue(d));
        const first = !this.devices.some((x) => x.state === 'active' || x.state === 'revoked');
        const dev: Device = {
          did: did(),
          k: token(),
          state: first ? 'active' : 'pending',
          label: 'Chrome · Desktop',
          createdAt: new Date().toISOString(),
          sid: null,
          marker: false,
          consented: [this.noticeVersion],
        };
        this.devices.push(dev);
        if (first) return json({ ...issue(dev), deviceKey: dev.k });
        return json({ status: 'pending', pollAfterMs: 10_000, deviceKey: dev.k });
      }
      case 'device/poll':
        if (!d || d.state === 'revoked' || d.state === 'declined') return json({ status: 'ended' });
        if (d.state === 'pending') return json({ status: 'pending', pollAfterMs: 10_000 });
        if (d.sid) return json({ status: 'active', handoff: '/' });
        return json(issue(d));
      case 'me/hello':
        if (d?.state !== 'active') return json({ status: 'ended' });
        return json({
          status: 'active',
          follower: { name: 'Oma' },
          device: { id: d.did, label: d.label },
          notice: { version: this.noticeVersion, required: !d.consented.includes(this.noticeVersion) },
        });
      case 'me/notice':
        if (!d || (d.state !== 'active' && d.state !== 'pending')) return json({ status: 'ended' });
        return json({ status: 'ok', notice: notice(this.noticeVersion), confirmedVersion: Math.max(...d.consented) });
      case 'me/consent':
        if (!d || (d.state !== 'active' && d.state !== 'pending')) return json({ status: 'ended' });
        if (body.version === this.noticeVersion) d.consented.push(this.noticeVersion);
        if (d.state === 'pending') {
          // Like the API: a waiting device learns nothing about the person (no name).
          const required = !d.consented.includes(this.noticeVersion);
          return json({ status: 'pending', notice: { version: this.noticeVersion, required } });
        }
        return json({
          status: 'active',
          follower: { name: 'Oma' },
          device: { id: d.did, label: d.label },
          notice: { version: this.noticeVersion, required: !d.consented.includes(this.noticeVersion) },
        });
      case 'me/data':
        if (!d || this.deleted) return json({ status: 'ended' });
        if (d.state !== 'active')
          return json({ status: 'limited', device: { label: d.label, state: d.state, createdAt: d.createdAt } });
        return json({
          status: 'ok',
          data: {
            follower: { id: FID, name: 'Oma', since: '2026-11-01T09:00:00.000Z', state: 'active' },
            devices: this.devices.map((x) => ({
              id: x.did,
              label: x.label,
              state: x.state,
              createdAt: x.createdAt,
              lastSeenAt: null,
              thisDevice: x === d,
            })),
            consents: d.consented.map((v) => ({ version: v, confirmedAt: '2026-11-20T10:00:00.000Z', locale: 'de' })),
            categories: [
              { key: 'devices', count: this.devices.length },
              { key: 'consents', count: d.consented.length },
            ],
            noticeVersion: this.noticeVersion,
          },
        });
      case 'me/export':
        if (d?.state !== 'active') return json({ status: 'ended' });
        return json(
          { format: 'omw-follower-data/1', exportedAt: new Date().toISOString(), follower: { id: FID, name: 'Oma' } },
          { 'content-disposition': 'attachment; filename="on-my-way-data-2026-11-21.json"' },
        );
      case 'me/signout':
        if (!d || d.state === 'revoked' || d.state === 'declined') return json({ status: 'ended' });
        if (d.state === 'pending') d.state = 'declined';
        else this.revoke(d);
        return json({ status: 'signed_out' });
      case 'me/delete':
        if (d?.state !== 'active' || body.confirm !== 'delete-all-my-data') return json({ status: 'ended' });
        this.deleted = true;
        for (const x of this.devices) this.revoke(x);
        return json({ status: 'deleted' });
      case 'panic':
        if (body.key === PANIC_KEY) this.locked = true;
        return json({ ok: true });
      default:
        return route.fulfill({ status: 404, headers: cors, body: '' });
    }
  }
}
