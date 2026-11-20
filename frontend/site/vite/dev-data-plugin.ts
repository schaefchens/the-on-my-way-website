/**
 * Vite plugin for local development of the static site:
 *
 * 1. Serves GET/HEAD /data/* and /media/* from a static data directory (with byte ranges, which
 *    Safari needs for <video>/<audio>). Directory: OMW_DEV_DATA_DIR, else the `dir` option, else
 *    ./dev-data (built by scripts/make-dev-data.ts). Point it at backend/data/out to develop
 *    against the real generator output.
 * 2. Injects a per-page Boot JSON (<script id="omw-boot" type="application/json">) into
 *    index.html in dev, built like the generator would (basePath "/", route from the URL,
 *    manifest version + timeline hash, inlined day data on day/story pages), so the SPA's boot
 *    path is exercised during development.
 *
 * Works for `vite` (dev) and `vite preview`. Never part of a production build.
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Connect, HtmlTagDescriptor, Plugin } from 'vite';
import { parseRoutePath } from '../src/route-path.ts';

export interface DevDataOptions {
  /** Data directory (relative to the Vite root). Overridden by OMW_DEV_DATA_DIR. */
  dir?: string;
  /** Locales the dev boot JSON may name (default: de, en and the pseudo-locale ar). */
  locales?: readonly string[];
}

const MIME: Readonly<Record<string, string>> = {
  '.json': 'application/json; charset=utf-8',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
};

const PREFIXES = ['/data/', '/media/'] as const;

export function resolveDevDataDir(root: string, dir?: string): string {
  const configured = process.env.OMW_DEV_DATA_DIR || dir || 'dev-data';
  return isAbsolute(configured) ? configured : resolve(root, configured);
}

function sendStatus(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(message);
}

/** Connect middleware serving /data and /media from `getDir()`. */
export function devDataMiddleware(getDir: () => string): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://dev.invalid').pathname);
    } catch {
      return next();
    }
    if (!PREFIXES.some((p) => pathname.startsWith(p))) return next();

    const dir = getDir();
    const file = resolve(dir, `.${pathname}`);
    if (!file.startsWith(dir + sep)) return sendStatus(res, 403, 'Forbidden');
    let size: number;
    try {
      const st = statSync(file);
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
    } catch {
      return sendStatus(
        res,
        404,
        `Not found in dev data: ${pathname}\n(${dir})\nBuild it with: pnpm --filter @omw/site dev-data`,
      );
    }

    res.setHeader('content-type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('accept-ranges', 'bytes');
    // Media names are content-addressed (immutable); data files are versioned by ?v= / no-store.
    res.setHeader('cache-control', pathname.startsWith('/media/') ? 'public, max-age=31536000, immutable' : 'no-cache');

    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    let start = 0;
    let end = size - 1;
    if (range) {
      const [, a = '', b = ''] = range;
      if (a === '' && b !== '') {
        start = Math.max(0, size - Number(b));
      } else {
        start = Number(a || 0);
        end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
      }
      if (start > end || start >= size) {
        res.setHeader('content-range', `bytes */${size}`);
        return sendStatus(res, 416, 'Range Not Satisfiable');
      }
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
    } else {
      res.statusCode = 200;
    }
    res.setHeader('content-length', String(end - start + 1));
    if (req.method === 'HEAD' || size === 0) {
      res.end();
      return;
    }
    createReadStream(file, { start, end }).pipe(res);
  };
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Serialises JSON for an inline <script type="application/json"> (no "</script>", no U+2028/9). */
export function escapeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Boot JSON for a URL, from the data directory (null when there is no manifest yet). */
export function devBootFor(url: string, dir: string, locales: readonly string[]): Record<string, unknown> | null {
  const manifest = readJsonFile(join(dir, 'data/manifest.json'));
  const site = manifest?.site as { defaultLocale?: unknown } | undefined;
  const timeline = manifest?.timeline as { v?: unknown } | undefined;
  if (!manifest || typeof manifest.version !== 'number' || typeof timeline?.v !== 'string') return null;

  const parsed = parseRoutePath(url, '/');
  const known = parsed !== null && locales.includes(parsed.locale);
  const fallbackLocale = typeof site?.defaultLocale === 'string' ? site.defaultLocale : 'de';
  const boot: Record<string, unknown> = {
    basePath: '/',
    locale: known ? parsed.locale : fallbackLocale,
    route: known ? { name: parsed.name, params: parsed.params } : { name: 'home', params: {} },
    manifestVersion: manifest.version,
    timelineV: timeline.v,
  };
  const date = known ? parsed.params.date : undefined;
  if (date) {
    const day = readJsonFile(join(dir, 'data/days', `${date}.json`));
    if (day) boot.day = day;
  }
  return boot;
}

/**
 * A built index.html (Vite base './', so its asset URLs are relative and only work at "/") as a
 * generated page for `url`: asset URLs made absolute ("/assets/…", basePath "/") and the dev
 * Boot JSON injected into <head>. Mirrors what the backend generator emits (README, "Site").
 */
export function previewPageHtml(builtHtml: string, boot: Record<string, unknown> | null): string {
  const html = builtHtml.replace(/(\s(?:src|href)=")\.\/assets\//g, '$1/assets/');
  if (!boot) return html;
  const script = `<script id="omw-boot" type="application/json">${escapeJsonForHtml(boot)}</script>`;
  return html.replace('</head>', `  ${script}\n  </head>`);
}

/** `vite preview` middleware: page navigations get previewPageHtml() (see above). */
export function previewPageMiddleware(
  outDir: string,
  getDir: () => string,
  locales: readonly string[],
): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://preview.invalid').pathname;
    } catch {
      return next();
    }
    // Files (assets, data, media, favicon …) are served by Vite; pages have no extension.
    if (extname(pathname) !== '' && !pathname.endsWith('/index.html')) return next();
    let built: string;
    try {
      built = readFileSync(join(outDir, 'index.html'), 'utf8');
    } catch {
      return next();
    }
    const html = previewPageHtml(built, devBootFor(req.url ?? '/', getDir(), locales));
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.end(req.method === 'HEAD' ? undefined : html);
  };
}

export function omwDevData(options: DevDataOptions = {}): Plugin {
  let root = process.cwd();
  const getDir = () => resolveDevDataDir(root, options.dir);
  const locales = options.locales ?? ['de', 'en', 'ar'];

  return {
    name: 'omw-dev-data',
    apply: 'serve',
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use(devDataMiddleware(getDir));
      const dir = getDir();
      server.config.logger.info(
        existsSync(join(dir, 'data/manifest.json'))
          ? `  omw: serving /data and /media from ${dir}`
          : `  omw: no dev data in ${dir} — run \`pnpm --filter @omw/site dev-data\``,
      );
    },
    configurePreviewServer(server) {
      server.middlewares.use(devDataMiddleware(getDir));
      // Production build preview: answer page navigations the way generated pages would look
      // (absolute asset URLs, per-page Boot JSON), so deep links work at any depth.
      const outDir = resolve(server.config.root, server.config.build.outDir);
      server.middlewares.use(previewPageMiddleware(outDir, getDir, locales));
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!ctx.server) return html;
        const boot = devBootFor(ctx.originalUrl ?? ctx.path, getDir(), locales);
        if (!boot) return html;
        const tag: HtmlTagDescriptor = {
          tag: 'script',
          attrs: { id: 'omw-boot', type: 'application/json' },
          children: escapeJsonForHtml(boot),
          injectTo: 'head',
        };
        return { html, tags: [tag] };
      },
    },
  };
}
