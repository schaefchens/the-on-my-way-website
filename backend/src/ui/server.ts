/**
 * Control UI (plan A7): Fastify on CONTROL_HOST:CONTROL_PORT (default 127.0.0.1:8787).
 *
 * Security model
 * - Every route except /healthz, /login and /static/* needs CONTROL_TOKEN: as a Bearer header
 *   (scripts, the CLI) or via the session cookie a browser gets at /login (see auth.ts).
 * - Cookie-authenticated POST/DELETE need the CSRF token (form field `_csrf` or header
 *   `X-CSRF-Token`) and a same-origin Origin/Sec-Fetch-Site when the browser sends those.
 * - Host header allow-list against DNS rebinding: loopback names plus CONTROL_ALLOWED_HOSTS.
 * - Strict CSP (no inline script/style), nosniff, frame-ancestors 'none', no-store for pages/API.
 *
 * Pages: / (overview) · /link (QR via SSE + pairing code) · /queue · /publish · /logs.
 * JSON API (Bearer or cookie): see the route table at the end of this file / backend/README.md.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Logger } from '../log.js';
import { BACKEND_ROOT } from '../paths.js';
import type { OutboxKind } from '../store/index.js';
import {
  ControlAuth,
  CSRF_FIELD,
  CSRF_HEADER,
  clearSessionCookie,
  parseCookies,
  SESSION_COOKIE,
  type Session,
  sessionCookie,
} from './auth.js';
import { type Flash, html, layout, type NavKey, type SafeHtml } from './html.js';
import {
  linkPage,
  loginPage,
  logsPage,
  overviewFragment,
  overviewPage,
  publishPage,
  qrSvg,
  queueFragment,
  queuePage,
  waTone,
} from './pages.js';
import { type FormFields, str, targetInputFromForm } from './targets.js';
import type { ControlBackend } from './types.js';
import { linkStep, PairCodeError, renewText, type WaMonitorEvent, waStateLabel } from './wa-monitor.js';

export const UI_STATIC_DIR = join(BACKEND_ROOT, 'src', 'ui', 'static');

export interface ControlServerOptions {
  backend: ControlBackend;
  token: string;
  host: string;
  port: number;
  /** Extra Host header names accepted besides loopback (e.g. a reverse-proxy name). */
  allowedHosts?: readonly string[];
  log: Logger;
  version: string;
  /** Mark the session cookie Secure (only when served over https by a proxy). */
  secureCookies?: boolean;
  staticDir?: string;
  sseKeepAliveMs?: number;
  pairCodeTimeoutMs?: number;
  /** Session/rate-limit clock (tests). */
  now?: () => number;
}

export interface ControlServer {
  readonly app: FastifyInstance;
  /** Starts listening; resolves with the address. */
  listen(): Promise<string>;
  close(): Promise<void>;
}

type Auth = { kind: 'bearer' } | { kind: 'session'; session: Session };

declare module 'fastify' {
  interface FastifyRequest {
    omwAuth: Auth | null;
  }
}

const PUBLIC_PATHS = new Set(['/healthz', '/login', '/favicon.ico']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // same-origin, not no-referrer: with no-referrer browsers send "Origin: null" on form POSTs,
  // which the CSRF origin check (rightly) refuses.
  'referrer-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  // Only features browsers know (an unknown one, e.g. interest-cohort, logs a console error).
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '[::1]' ||
    h === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Same-origin redirect target after login (no scheme, no //host, no backslashes). Control
 * characters are refused too: browsers strip tabs/newlines from a Location URL ("/\t/evil" would
 * become "//evil"), and CR/LF/NUL would make the header invalid.
 */
export function safeNext(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(next)) return '/';
  if (next.startsWith('/login') || next.startsWith('/api/') || next.startsWith('/fragments/')) return '/';
  return next.slice(0, 500);
}

function errorText(err: unknown): string {
  if (err instanceof z.ZodError) return z.prettifyError(err);
  if (err && typeof err === 'object' && 'issues' in err && Array.isArray((err as { issues: unknown }).issues)) {
    const issues = (err as { issues: { path?: unknown[]; message?: string }[] }).issues;
    return issues.map((i) => `${(i.path ?? []).join('.') || 'input'}: ${i.message ?? 'invalid'}`).join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}

interface StaticFile {
  body: Buffer;
  type: string;
  hash: string;
}

function loadStatic(dir: string): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  for (const [name, type] of [
    ['app.css', 'text/css; charset=utf-8'],
    ['app.js', 'text/javascript; charset=utf-8'],
  ] as const) {
    const body = readFileSync(join(dir, name));
    files.set(name, { body, type, hash: createHash('sha256').update(body).digest('hex').slice(0, 10) });
  }
  return files;
}

interface OutboxRowView {
  id: number;
  kind: OutboxKind;
  key: string;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  payload: unknown;
  rev: number;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
}

function failingOutbox(backend: ControlBackend, limit = 100): OutboxRowView[] {
  const rows = backend.store.db
    .prepare(
      `SELECT id, kind, key, attempts, next_attempt_at, last_error, rev, created_at, updated_at FROM sync_outbox
       WHERE done_at IS NULL AND attempts > 0 ORDER BY next_attempt_at LIMIT ?`,
    )
    .all(limit) as {
    id: number;
    kind: OutboxKind;
    key: string;
    attempts: number;
    next_attempt_at: string;
    last_error: string | null;
    rev: number;
    created_at: string;
    updated_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    key: r.key,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error,
    payload: null,
    rev: r.rev,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    doneAt: null,
  }));
}

const NOT_READY = ['awaiting_media', 'received', 'archived', 'processed', 'failed', 'media_lost'] as const;

export async function createControlServer(o: ControlServerOptions): Promise<ControlServer> {
  const log = o.log.child({ module: 'control-ui' });
  const backend = o.backend;
  const auth = new ControlAuth(o.token, o.now ? { now: o.now } : {});
  const staticFiles = loadStatic(o.staticDir ?? UI_STATIC_DIR);
  const assets = {
    css: `/static/app.css?v=${staticFiles.get('app.css')?.hash ?? '0'}`,
    js: `/static/app.js?v=${staticFiles.get('app.js')?.hash ?? '0'}`,
  };
  const allowedHosts = new Set((o.allowedHosts ?? []).map((h) => h.toLowerCase()));
  if (!['0.0.0.0', '::', ''].includes(o.host)) allowedHosts.add(o.host.toLowerCase());
  const flashes = new Map<string, Flash>();
  const sseClients = new Set<() => void>();
  let closing = false;

  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024,
    trustProxy: false,
    return503OnClosing: true,
    forceCloseConnections: true,
  });
  app.decorateRequest('omwAuth', null);
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 256 * 1024 },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  const pathOf = (req: FastifyRequest) => req.url.split('?')[0] ?? '/';
  const wantsHtml = (req: FastifyRequest) => {
    const p = pathOf(req);
    return !p.startsWith('/api/') && !p.startsWith('/fragments/') && p !== '/healthz';
  };

  app.addHook('onRequest', async (req, reply) => {
    const hostname = hostnameOf(req.headers.host);
    if (!hostname || !(isLoopbackHost(hostname) || allowedHosts.has(hostname))) {
      log.warn({ host: req.headers.host }, 'request with a foreign Host header refused');
      return reply.code(421).type('text/plain').send('Misdirected request: unknown Host header');
    }
    const path = pathOf(req);
    if (o.token && auth.checkBearer(req.headers.authorization)) {
      req.omwAuth = { kind: 'bearer' };
    } else {
      const session = auth.verifySession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
      if (session) req.omwAuth = { kind: 'session', session };
    }
    if (PUBLIC_PATHS.has(path) || path.startsWith('/static/')) return;
    if (!req.omwAuth) {
      if (req.method === 'GET' && wantsHtml(req)) {
        return reply.redirect(`/login?next=${encodeURIComponent(safeNext(req.url))}`, 303);
      }
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'CONTROL_TOKEN required' } });
    }
  });

  // CSRF: after body parsing (the token may be a form field).
  app.addHook('preHandler', async (req, reply) => {
    if (SAFE_METHODS.has(req.method)) return;
    const a = req.omwAuth;
    const path = pathOf(req);
    const originOk = () => {
      const site = req.headers['sec-fetch-site'];
      if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
      const origin = req.headers.origin;
      if (origin === undefined) return true;
      try {
        return new URL(origin).host.toLowerCase() === (req.headers.host ?? '').toLowerCase();
      } catch {
        return false;
      }
    };
    if (path === '/login') {
      if (!originOk()) return reply.code(403).send({ error: { code: 'csrf', message: 'Cross-site login refused' } });
      return;
    }
    if (!a || a.kind === 'bearer') return;
    const body = req.body as Record<string, unknown> | undefined;
    const token = req.headers[CSRF_HEADER] ?? (body && typeof body === 'object' ? body[CSRF_FIELD] : undefined);
    if (!originOk() || !auth.verifyCsrf(a.session, token)) {
      log.warn({ path, origin: req.headers.origin }, 'CSRF check failed');
      return reply.code(403).send({ error: { code: 'csrf', message: 'CSRF check failed: reload the page and retry' } });
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    const path = pathOf(req);
    if (path.startsWith('/static/')) {
      reply.header('cache-control', 'public, max-age=31536000, immutable');
    } else {
      reply.header('cache-control', 'no-store');
      reply.header('content-security-policy', CSP);
    }
    return payload;
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (status >= 500) log.error({ err, path: pathOf(req) }, 'control UI request failed');
    const message = status >= 500 ? 'Internal error (see logs)' : err.message;
    if (req.method === 'GET' && wantsHtml(req)) {
      return reply
        .code(status)
        .type('text/html; charset=utf-8')
        .send(render(req, 'Error', 'overview', html`<h1>Error</h1><p class="error">${message}</p>`));
    }
    return reply
      .code(status)
      .send({ error: { code: err.code ?? (status >= 500 ? 'internal' : 'bad_request'), message } });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && wantsHtml(req)) {
      return reply
        .code(404)
        .type('text/html; charset=utf-8')
        .send(
          render(req, 'Not found', 'overview', html`<h1>Not found</h1><p><a href="/">Back to the overview</a></p>`),
        );
    }
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  // ------------------------------------------------------------------------------- helpers

  const csrfOf = (req: FastifyRequest): string | null =>
    req.omwAuth?.kind === 'session' ? auth.csrfToken(req.omwAuth.session) : null;

  const takeFlash = (req: FastifyRequest): Flash | null => {
    if (req.omwAuth?.kind !== 'session') return null;
    const f = flashes.get(req.omwAuth.session.nonce) ?? null;
    flashes.delete(req.omwAuth.session.nonce);
    return f;
  };

  const setFlash = (req: FastifyRequest, flash: Flash) => {
    if (req.omwAuth?.kind !== 'session') return;
    flashes.set(req.omwAuth.session.nonce, flash);
    if (flashes.size > 100) flashes.delete(flashes.keys().next().value as string);
  };

  function render(req: FastifyRequest, title: string, active: NavKey, body: SafeHtml, flash?: Flash | null): string {
    return layout({
      title,
      active,
      csrf: csrfOf(req),
      body,
      flash: flash ?? takeFlash(req),
      version: o.version,
      assets,
    });
  }

  const sendPage = (reply: FastifyReply, page: string) => reply.type('text/html; charset=utf-8').send(page);

  const form = (req: FastifyRequest): FormFields => {
    const b = req.body;
    if (!b || typeof b !== 'object') return {};
    const out: FormFields = {};
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
      else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    }
    return out;
  };

  /** Form action: run, set a flash message, redirect back (PRG). */
  const action = (
    path: string,
    back: string,
    run: (fields: FormFields, req: FastifyRequest) => Promise<Flash> | Flash,
  ) => {
    app.post(path, async (req, reply) => {
      let flash: Flash;
      try {
        flash = await run(form(req), req);
      } catch (err) {
        log.warn({ err: errorText(err), path }, 'control UI action failed');
        flash = { kind: 'error', text: errorText(err).slice(0, 1000) };
      }
      setFlash(req, flash);
      return reply.redirect(back, 303);
    });
  };

  const json = (reply: FastifyReply, status: number, body: unknown) => reply.code(status).send(body);

  const fail = (reply: FastifyReply, status: number, code: string, message: string) =>
    reply.code(status).send({ error: { code, message } });

  // ------------------------------------------------------------------------------- public

  app.get('/healthz', async (_req, reply) =>
    json(reply, closing ? 503 : 200, { ok: !closing, app: 'omw-backend', version: o.version }),
  );

  app.get('/static/:name', async (req, reply) => {
    const file = staticFiles.get((req.params as { name: string }).name);
    if (!file) return fail(reply, 404, 'not_found', 'Not found');
    return reply.type(file.type).send(file.body);
  });

  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());

  app.get('/login', async (req, reply) => {
    const next = safeNext((req.query as Record<string, unknown>).next);
    if (req.omwAuth) return reply.redirect(next, 303);
    return sendPage(reply, render(req, 'Log in', 'login', loginPage(next, null), null));
  });

  app.post('/login', async (req, reply) => {
    const fields = form(req);
    const next = safeNext(fields.next);
    if (!auth.loginAllowed(req.ip)) {
      return reply
        .code(429)
        .type('text/html; charset=utf-8')
        .send(render(req, 'Log in', 'login', loginPage(next, 'Too many failed attempts. Wait a few minutes.'), null));
    }
    if (!auth.checkToken(fields.token)) {
      auth.recordLoginFailure(req.ip);
      log.warn({ ip: req.ip }, 'control UI login failed');
      return reply
        .code(401)
        .type('text/html; charset=utf-8')
        .send(render(req, 'Log in', 'login', loginPage(next, 'Wrong token.'), null));
    }
    auth.clearLoginFailures(req.ip);
    const { cookie } = auth.issueSession();
    reply.header('set-cookie', sessionCookie(cookie, auth.sessionTtlMs / 1000, o.secureCookies ?? false));
    log.info({ ip: req.ip }, 'control UI login');
    return reply.redirect(next, 303);
  });

  app.post('/logout', async (req, reply) => {
    if (req.omwAuth?.kind === 'session') auth.revoke(req.omwAuth.session);
    reply.header('set-cookie', clearSessionCookie(o.secureCookies ?? false));
    return reply.redirect('/login', 303);
  });

  // ------------------------------------------------------------------------------- pages

  const targetList = () => {
    try {
      return backend.targets.list();
    } catch (err) {
      log.warn({ err: errorText(err) }, 'listing publish targets failed');
      return [];
    }
  };

  app.get('/', async (req, reply) =>
    sendPage(
      reply,
      render(req, 'Overview', 'overview', overviewPage(await backend.status(), csrfOf(req), targetList())),
    ),
  );

  app.get('/fragments/overview', async (req, reply) =>
    sendPage(reply, overviewFragment(await backend.status(), csrfOf(req), targetList()).toString()),
  );

  app.get('/link', async (req, reply) => {
    const body = await linkPage(backend.wa.snapshot(), csrfOf(req), null, Date.now());
    return sendPage(reply, render(req, 'Link WhatsApp', 'link', body));
  });

  const queueData = (req: FastifyRequest) =>
    queueFragment(
      backend.store.captures.list({ states: NOT_READY, limit: 300 }),
      failingOutbox(backend),
      backend.quarantined(50),
      csrfOf(req),
      Date.now(),
    );

  app.get('/queue', async (req, reply) => {
    const s = await backend.status();
    return sendPage(reply, render(req, 'Queue', 'queue', queuePage(queueData(req), csrfOf(req), s.sync.enabled)));
  });

  app.get('/fragments/queue', async (req, reply) => sendPage(reply, queueData(req).toString()));

  app.get('/publish', async (req, reply) => {
    const editId = (req.query as Record<string, unknown>).edit;
    const targets = backend.targets.list();
    const editing = typeof editId === 'string' ? (targets.find((t) => str(t, 'id') === editId) ?? null) : null;
    const s = await backend.status();
    return sendPage(reply, render(req, 'Publish', 'publish', publishPage(s, targets, editing, csrfOf(req))));
  });

  app.get('/logs', async (req, reply) => {
    const body = logsPage(backend.logRing.since(0, 400), backend.store.events.recent({ limit: 100 }), Date.now());
    return sendPage(reply, render(req, 'Logs', 'logs', body));
  });

  // ------------------------------------------------------------------------------- form actions

  action('/actions/rebuild', '/', async (f) => {
    const r = await backend.rebuild(f.full !== '0');
    if (!r) return { kind: 'ok', text: 'Nothing to generate.' };
    if (r.changed === 0 && r.removed === 0) {
      return { kind: 'ok', text: `Site v${r.version} is up to date: no file changed (${r.durationMs} ms).` };
    }
    return {
      kind: 'ok',
      text: `Generated v${r.version}: ${r.changed} files changed, ${r.removed} removed (${r.durationMs} ms). Publishing follows.`,
    };
  });

  action('/actions/publish', '/publish', async (f) => {
    const results = await backend.publishNow(f.targetId || undefined);
    if (results.length === 0) return { kind: 'error', text: 'No (enabled) publish target.' };
    const failed = results.filter((r) => !r.ok);
    return failed.length === 0
      ? {
          kind: 'ok',
          text: `Published v${results[0]?.version ?? '?'} to ${results.map((r) => r.targetId).join(', ')}.`,
        }
      : { kind: 'error', text: failed.map((r) => `${r.targetId}: ${r.error ?? 'failed'}`).join('; ') };
  });

  action('/actions/reprocess', '/queue', async (f) => {
    const n = await backend.reprocess(f.sourceKey || undefined);
    return { kind: 'ok', text: `Reprocessing ${n} capture${n === 1 ? '' : 's'}.` };
  });

  action('/actions/captures/retry', '/queue', (f) => {
    const r = backend.retryCapture(f.sourceKey ?? '');
    return { kind: r.ok ? 'ok' : 'error', text: r.detail };
  });

  action('/actions/captures/skip', '/queue', (f) => {
    const r = backend.skipCapture(f.sourceKey ?? '');
    return { kind: r.ok ? 'ok' : 'error', text: r.detail };
  });

  action('/actions/sync/pull', '/', async () => {
    const n = await backend.syncPull();
    return { kind: 'ok', text: `Change feed pulled: ${n} change${n === 1 ? '' : 's'} applied.` };
  });

  action('/actions/sync/resync', '/queue', () => {
    const n = backend.resyncCaptures();
    return { kind: 'ok', text: `${n} captures queued for the API.` };
  });

  action('/actions/wa/restart', '/link', async () => {
    const r = await backend.restartWa();
    return { kind: r.ok ? 'ok' : 'error', text: r.detail };
  });

  action('/actions/access/lock', '/publish', async () => {
    if (!backend.lockSite) return { kind: 'error', text: 'Not supported by this backend.' };
    const r = await backend.lockSite();
    return { kind: r.ok ? 'ok' : 'error', text: r.detail };
  });

  action('/actions/targets/save', '/publish', (f) => {
    const saved = backend.targets.save(targetInputFromForm(f));
    return { kind: 'ok', text: `Target ${str(saved, 'id') ?? ''} saved.` };
  });

  action('/actions/targets/remove', '/publish', (f) => {
    backend.targets.remove(f.id ?? '');
    return { kind: 'ok', text: `Target ${f.id ?? ''} removed.` };
  });

  action('/actions/targets/test', '/publish', async (f) => {
    const r = await backend.targets.test(f.id ?? '');
    return { kind: r.ok ? 'ok' : 'error', text: `${f.id ?? ''}: ${r.detail}` };
  });

  // Pairing code: rendered directly (the code must be shown, not put into a redirect URL).
  app.post('/actions/pair-code', async (req, reply) => {
    const fields = form(req);
    const phone = (fields.phone ?? '').slice(0, 40);
    let code: string | null = null;
    let flash: Flash | null = null;
    try {
      code = await backend.pairCode(phone);
      flash = { kind: 'ok', text: 'Enter this code on the observer phone within a few minutes.' };
    } catch (err) {
      const invalid = err instanceof PairCodeError && err.code === 'invalid_phone';
      flash = {
        kind: 'error',
        text: invalid
          ? `“${phone}” is not a phone number in international format. Use the country code, e.g. +49 151 23456789.`
          : errorText(err),
      };
    }
    // The number stays in the field (no retyping after a typo); a code is shown with its validity.
    const body = await linkPage(backend.wa.snapshot(), csrfOf(req), { phone, code }, Date.now());
    return sendPage(reply, render(req, 'Link WhatsApp', 'link', body, flash));
  });

  // ------------------------------------------------------------------------------- JSON API

  const bodyOf = (req: FastifyRequest): Record<string, unknown> =>
    req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
  const optString = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);

  app.get('/api/status', async () => backend.status());

  app.get('/api/wa', async () => backend.wa.snapshot());

  app.get('/api/logs', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const after = Number.parseInt(q.after ?? '0', 10) || 0;
    const limit = Math.min(Math.max(Number.parseInt(q.limit ?? '500', 10) || 500, 1), 1000);
    return { lines: backend.logRing.since(after, limit), lastId: backend.logRing.lastId };
  });

  app.get('/api/events', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const limit = Math.min(Math.max(Number.parseInt(q.limit ?? '100', 10) || 100, 1), 500);
    return { items: backend.store.events.recent({ limit, ...(q.type ? { type: q.type } : {}) }) };
  });

  app.get('/api/queue', async () => ({
    captures: backend.store.captures.list({ states: NOT_READY, limit: 300 }).map((c) => ({
      sourceKey: c.sourceKey,
      kind: c.kind,
      state: c.state,
      occurredAt: c.occurredAt,
      downloadState: c.downloadState,
      downloadReason: c.downloadReason,
      downloadPermanent: c.downloadPermanent,
      attempts: c.attempts,
      nextAttemptAt: c.nextAttemptAt,
      lastError: c.lastError,
      revokedAt: c.revokedAt,
    })),
    outbox: failingOutbox(backend).map(({ payload: _p, ...rest }) => rest),
    quarantine: backend.quarantined(50),
  }));

  app.post('/api/rebuild', async (req) => {
    const full = bodyOf(req).full !== false;
    return { ok: true, result: await backend.rebuild(full) };
  });

  app.post('/api/publish', async (req) => {
    const body = bodyOf(req);
    // force: override the mass-delete guard, like `backend publish --force`.
    const results = await backend.publishNow(optString(body.targetId), { force: body.force === true });
    return { ok: results.length > 0 && results.every((r) => r.ok), results };
  });

  app.post('/api/reprocess', async (req) => ({
    ok: true,
    count: await backend.reprocess(optString(bodyOf(req).sourceKey)),
  }));

  app.post('/api/pair-code', async (req, reply) => {
    const phone = bodyOf(req).phone;
    if (typeof phone !== 'string') return fail(reply, 422, 'validation_failed', 'phone is required');
    try {
      return { ok: true, code: await backend.pairCode(phone) };
    } catch (err) {
      if (err instanceof PairCodeError) {
        const status = { invalid_phone: 422, already_linked: 409, unavailable: 503, timeout: 504 }[err.code];
        return fail(reply, status, err.code, err.message);
      }
      throw err;
    }
  });

  app.post('/api/captures/:sourceKey/retry', async (req, reply) => {
    const r = backend.retryCapture((req.params as { sourceKey: string }).sourceKey);
    return json(reply, r.ok ? 200 : 409, r);
  });

  app.post('/api/captures/:sourceKey/skip', async (req, reply) => {
    const r = backend.skipCapture((req.params as { sourceKey: string }).sourceKey);
    return json(reply, r.ok ? 200 : 409, r);
  });

  app.post('/api/sync/pull', async () => ({ ok: true, applied: await backend.syncPull() }));

  app.post('/api/sync/resync', async () => ({ ok: true, queued: backend.resyncCaptures() }));

  app.post('/api/wa/restart', async (_req, reply) => {
    const r = await backend.restartWa();
    return json(reply, r.ok ? 200 : 409, r);
  });

  app.get('/api/targets', async () => ({ items: backend.targets.list() }));

  app.post('/api/targets', async (req, reply) => {
    try {
      return { ok: true, target: backend.targets.save(bodyOf(req)) };
    } catch (err) {
      return fail(reply, 422, 'validation_failed', errorText(err));
    }
  });

  app.delete('/api/targets/:id', async (req, reply) => {
    try {
      backend.targets.remove((req.params as { id: string }).id);
      return reply.code(204).send();
    } catch (err) {
      return fail(reply, 404, 'not_found', errorText(err));
    }
  });

  app.post('/api/targets/:id/test', async (req) => backend.targets.test((req.params as { id: string }).id));

  // Live WhatsApp state for the link page (Server-Sent Events). ?once=1 sends the snapshot only.
  app.get('/api/wa/stream', async (req, reply) => {
    const once = (req.query as Record<string, unknown>).once === '1';
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...SECURITY_HEADERS,
    });
    let open = true;
    const send = (event: string, data: unknown) => {
      if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const stateEvent = async () => {
      const snap = backend.wa.snapshot();
      return {
        state: snap.state,
        // Human wording and what the link page should offer (wa-monitor.ts), so an open page
        // follows the helper's lifecycle: stopped after exit 7 -> "Show a new QR code".
        label: waStateLabel(snap),
        tone: snap.mode === 'fixture' || snap.mode === 'off' ? 'info' : waTone(snap.state),
        step: linkStep(snap),
        renewText: renewText(snap),
        process: snap.process,
        lastExit: snap.lastExit ?? null,
        nextRestartAt: snap.nextRestartAt,
        reason: snap.reason,
        jid: snap.jid,
        ...(snap.qr ? { qrSvg: await qrSvg(snap.qr.code), qrExpiresAt: snap.qr.expiresAt } : {}),
        ...(snap.pairCode
          ? {
              pairCode: snap.pairCode.code,
              ...(snap.pairCode.validUntil ? { pairCodeValidUntil: snap.pairCode.validUntil } : {}),
            }
          : {}),
      };
    };
    send('state', await stateEvent());
    if (once) {
      open = false;
      res.end();
      return;
    }
    const onEvent = (e: WaMonitorEvent) => {
      void (async () => {
        try {
          if (e.type === 'qr') send('qr', { svg: await qrSvg(e.code), expiresAt: e.expiresAt });
          else if (e.type === 'pair_code') send('pair_code', { code: e.code });
          else send('state', await stateEvent());
        } catch (err) {
          log.warn({ err: errorText(err) }, 'SSE event failed');
        }
      })();
    };
    const off = backend.wa.subscribe(onEvent);
    const keepAlive = setInterval(() => {
      if (open) res.write(': keep-alive\n\n');
    }, o.sseKeepAliveMs ?? 15_000);
    keepAlive.unref();
    const cleanup = () => {
      if (!open) return;
      open = false;
      clearInterval(keepAlive);
      off();
      sseClients.delete(cleanup);
      res.end();
    };
    sseClients.add(cleanup);
    req.raw.on('close', cleanup);
  });

  return {
    app,
    async listen() {
      const address = await app.listen({ host: o.host, port: o.port });
      log.info({ address }, 'control UI listening');
      return address;
    },
    async close() {
      closing = true;
      for (const cleanup of [...sseClients]) cleanup();
      await app.close();
    },
  };
}
