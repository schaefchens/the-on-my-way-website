/**
 * HTTP server around MockAdminApi, same-origin like production (the PHP host serves the admin
 * under /admin/ and the API under /api/v1):
 *   /api/v1/*      mock API
 *   /admin/*       static admin build (--dist), SPA fallback to index.html; sw.js and index.html
 *                  with Cache-Control: no-cache, hashed assets immutable
 *   /__mock/*      test control: POST reset | publish | day/<date> (edit elsewhere) | alerts |
 *                  capture ({minutesAgo, caption}: a fresh status) | settings (stored as is) |
 *                  revoke/<sourceKey> (deleted on WhatsApp), GET state | log;
 *                  access (wave 5): POST access (writer mode, store, gate check, … as is) |
 *                  access/ack (the Mac applied everything) | device ({fid, label?, minutesAgo?, state?}:
 *                  a join; answers {did}) | notice ({kind}) | self-delete/<fid> (me/delete)
 *
 *   node --conditions=@omw/source --import tsx e2e/mock/server.ts --port 51750 [--dist <dir>]
 * Without --dist only the API is served (use it as OMW_API_DEV_URL for `vite` dev).
 */
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { MockAdminApi, type MockResponse } from './api';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, out: MockResponse): void {
  const headers: Record<string, string> = { 'cache-control': 'no-store', ...(out.headers ?? {}) };
  if (out.json !== undefined) {
    res.writeHead(out.status, { ...headers, 'content-type': 'application/json' });
    res.end(JSON.stringify(out.json));
  } else if (out.text !== undefined) {
    res.writeHead(out.status, { ...headers, 'content-type': out.contentType ?? 'text/plain' });
    res.end(out.text);
  } else {
    res.writeHead(out.status, headers);
    res.end();
  }
}

async function serveStatic(dist: string, pathname: string, res: ServerResponse): Promise<void> {
  const rel = normalize(decodeURIComponent(pathname.replace(/^\/admin\/?/, ''))).replace(/^(\.\.[/\\])+/, '');
  let file = join(dist, rel);
  let fallback = false;
  try {
    const s = await stat(file);
    if (s.isDirectory()) file = join(file, 'index.html');
  } catch {
    // SPA fallback for client routes (no extension); real missing assets are a 404.
    if (extname(rel)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    file = join(dist, 'index.html');
    fallback = true;
  }
  try {
    const data = await readFile(file);
    const name = file.slice(dist.length);
    const immutable = name.includes('/assets/') && !fallback;
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(name.endsWith('sw.js') ? { 'service-worker-allowed': '/admin/' } : {}),
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

export interface MockServer {
  server: Server;
  api: MockAdminApi;
  url: string;
  close(): Promise<void>;
}

export async function startMockServer(opts: {
  port: number;
  host?: string;
  dist?: string;
  api?: MockAdminApi;
}): Promise<MockServer> {
  const api = opts.api ?? new MockAdminApi();
  const dist = opts.dist ? resolve(opts.dist) : null;
  const host = opts.host ?? '127.0.0.1';
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);
      const pathname = url.pathname;
      if (pathname.startsWith('/__mock/')) {
        const body = await readBody(req);
        const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        const action = pathname.slice('/__mock/'.length);
        if (action === 'reset') api.reset();
        else if (action === 'publish') api.publishNow();
        else if (action.startsWith('day/')) api.editDayElsewhere(action.slice(4), parsed);
        else if (action === 'alerts') api.setAlerts((parsed.alerts as never) ?? []);
        else if (action === 'capture') {
          const sourceKey = api.addCapture(parsed as { minutesAgo?: number; caption?: string; id?: string });
          return send(res, { status: 200, json: { sourceKey } });
        } else if (action === 'settings') api.setSettings(parsed as never);
        else if (action.startsWith('revoke/')) {
          if (!api.revokeCapture(decodeURIComponent(action.slice('revoke/'.length)))) {
            return send(res, { status: 404, json: { error: 'unknown capture' } });
          }
        } else if (action === 'access') api.access.setState(parsed as never);
        else if (action === 'access/ack') api.access.ack();
        else if (action === 'device') {
          const { fid, ...opts } = parsed as { fid: string; label?: string; minutesAgo?: number; state?: 'pending' };
          return send(res, { status: 200, json: { did: api.access.addDevice(fid, opts) } });
        } else if (action === 'notice') {
          return send(res, {
            status: 200,
            json: { id: api.access.addNotice((parsed.kind as never) ?? 'follower_deleted') },
          });
        } else if (action.startsWith('self-delete/')) {
          if (!api.access.selfDelete(action.slice('self-delete/'.length))) {
            return send(res, { status: 404, json: { error: 'unknown follower' } });
          }
        } else if (action === 'state') return send(res, { status: 200, json: api.snapshot() });
        else if (action === 'log') return send(res, { status: 200, json: api.log });
        else return send(res, { status: 404, json: { error: 'unknown control' } });
        return send(res, { status: 200, json: { ok: true } });
      }
      if (pathname.startsWith('/api/')) {
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
        const out = api.handle({
          method: req.method ?? 'GET',
          path: pathname,
          query: url.searchParams,
          headers,
          body: await readBody(req),
        });
        return send(res, out);
      }
      if (dist && (pathname === '/admin' || pathname.startsWith('/admin/'))) {
        if (pathname === '/admin') {
          res.writeHead(301, { location: '/admin/' });
          res.end();
          return;
        }
        return await serveStatic(dist, pathname, res);
      }
      if (pathname === '/') {
        res.writeHead(302, { location: '/admin/' });
        res.end();
        return;
      }
      send(res, { status: 404, text: 'not found' });
    } catch (err) {
      send(res, { status: 500, json: { error: { code: 'internal', message: (err as Error).message } } });
    }
  });
  await new Promise<void>((ok) => server.listen(opts.port, host, ok));
  return {
    server,
    api,
    url: `http://${host}:${opts.port}`,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const { values } = parseArgs({
    options: {
      port: { type: 'string', default: '51750' },
      host: { type: 'string', default: '127.0.0.1' },
      dist: { type: 'string' },
      'publish-after': { type: 'string' },
    },
  });
  const api = new MockAdminApi(values['publish-after'] ? { publishAfterMs: Number(values['publish-after']) } : {});
  const s = await startMockServer({
    port: Number(values.port),
    host: values.host,
    api,
    ...(values.dist ? { dist: values.dist } : {}),
  });
  console.log(`mock admin API on ${s.url}${values.dist ? ` (admin build from ${values.dist})` : ''}`);
  const stop = () => void s.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
