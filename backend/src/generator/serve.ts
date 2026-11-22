/**
 * Tiny static server for previewing OUT_DIR like a plain static host would serve it:
 * - mounted at the site's basePath ("/" or "/travel/"); everything outside it is 404;
 * - directory index (index.html), "/dir" -> 301 "/dir/";
 * - MIME types for every file the generator writes (avif, webp, m4a, mp4, woff2, json, …);
 * - byte ranges (Safari needs them for <video>/<audio>);
 * - unknown paths answer 404 with <basePath>404.html (like ErrorDocument 404 on Apache);
 * - dotfiles are never served; cache headers mirror the generated .htaccess.
 * Binds to 127.0.0.1 by default. Default port 4173 (D12).
 *
 * Gate mode (spec-wave5 §5.7, startGatePreviewServer): GATE_OUT_DIR at "/" and OUT_DIR at
 * "/<secret>/", WITHOUT enforcing the gate (no cookie check, no neutral page for refusals): the
 * gate's behaviour is only ever tested with Apache (backend/test/gate). It says so when it starts.
 */
import { createReadStream, promises as fsp } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, extname, join, resolve, sep } from 'node:path';
import { MEDIA_FILE_PATTERN } from './extras.js';

export const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface PreviewServerOptions {
  dir: string;
  host?: string;
  port?: number;
  basePath?: string;
}

export interface PreviewServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

const MEDIA_FILE = new RegExp(MEDIA_FILE_PATTERN);

/** Same policy as the generated .htaccess (extras.ts): media private, hashed assets public. */
export function cacheControl(path: string): string {
  if (MEDIA_FILE.test(basename(path))) return 'private, max-age=31536000, immutable';
  return /\.(?:js|mjs|css|woff2|avif|webp|jpg|mp4|m4a)$/.test(path)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

async function statFile(file: string): Promise<{ size: number; isDir: boolean } | null> {
  try {
    const st = await fsp.stat(file);
    return { size: st.size, isDir: st.isDirectory() };
  } catch {
    return null;
  }
}

export function createPreviewHandler(opts: { dir: string; basePath?: string }) {
  const root = resolve(opts.dir);
  const base = opts.basePath ?? '/';
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(base)) throw new RangeError(`Invalid basePath: ${base}`);

  const sendFile = async (req: IncomingMessage, res: ServerResponse, file: string, size: number, status: number) => {
    res.setHeader('content-type', MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('cache-control', cacheControl(file));
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('accept-ranges', 'bytes');
    let start = 0;
    let end = size - 1;
    const range = status === 200 ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '') : null;
    if (range) {
      const [, a = '', b = ''] = range;
      if (a === '' && b !== '') start = Math.max(0, size - Number(b));
      else {
        start = Number(a || 0);
        end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
      }
      if (start > end || start >= size) {
        res.statusCode = 416;
        res.setHeader('content-range', `bytes */${size}`);
        res.end();
        return;
      }
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
    } else res.statusCode = status;
    res.setHeader('content-length', String(size === 0 ? 0 : end - start + 1));
    if (req.method === 'HEAD' || size === 0) {
      res.end();
      return;
    }
    createReadStream(file, { start, end }).pipe(res);
  };

  const notFound = async (req: IncomingMessage, res: ServerResponse) => {
    const page = join(root, '404.html');
    const st = await statFile(page);
    if (st && !st.isDir) return sendFile(req, res, page, st.size, 404);
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Not found');
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('allow', 'GET, HEAD');
      res.end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://preview.invalid').pathname);
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (pathname === base.slice(0, -1) && base !== '/') {
      res.statusCode = 301;
      res.setHeader('location', base);
      res.end();
      return;
    }
    if (!pathname.startsWith(base) || pathname.includes('\0')) return notFound(req, res);
    const rel = pathname.slice(base.length);
    if (rel.split('/').some((seg) => seg.startsWith('.'))) return notFound(req, res);
    const file = resolve(root, rel);
    if (file !== root && !file.startsWith(root + sep)) return notFound(req, res);
    const st = await statFile(file);
    if (!st) return notFound(req, res);
    if (st.isDir) {
      if (!pathname.endsWith('/')) {
        const search = new URL(req.url ?? '/', 'http://preview.invalid').search;
        res.statusCode = 301;
        res.setHeader('location', `${pathname}/${search}`);
        res.end();
        return;
      }
      const index = join(file, 'index.html');
      const ist = await statFile(index);
      if (!ist || ist.isDir) return notFound(req, res);
      return sendFile(req, res, index, ist.size, 200);
    }
    return sendFile(req, res, file, st.size, 200);
  };
}

export interface GatePreviewOptions {
  gateDir: string;
  outDir: string;
  /** The content folder: OUT_DIR is mounted at "/<secret>/". */
  secret: string;
  host?: string;
  port?: number;
}

/** Gate mode preview (see the module header): two trees, no gate. */
export function createGatePreviewHandler(opts: Omit<GatePreviewOptions, 'host' | 'port'>) {
  if (!/^[a-z0-9]{20}$/.test(opts.secret)) throw new RangeError('Invalid content folder');
  const content = createPreviewHandler({ dir: opts.outDir, basePath: `/${opts.secret}/` });
  const gate = createPreviewHandler({ dir: opts.gateDir, basePath: '/' });
  const prefix = `/${opts.secret}`;
  return (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    return path === prefix || path.startsWith(`${prefix}/`) ? content(req, res) : gate(req, res);
  };
}

export async function startGatePreviewServer(opts: GatePreviewOptions): Promise<PreviewServer> {
  return listen(createGatePreviewHandler(opts), { host: opts.host, port: opts.port, path: '/' });
}

export async function startPreviewServer(opts: PreviewServerOptions): Promise<PreviewServer> {
  return listen(createPreviewHandler(opts), { host: opts.host, port: opts.port, path: opts.basePath ?? '/' });
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  opts: { host?: string | undefined; port?: number | undefined; path: string },
): Promise<PreviewServer> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 4173;
  const server = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.statusCode = 500;
      res.end(String(err));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    url: `http://${host}:${actualPort}${opts.path}`,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}
