/**
 * Static server for the journey-player e2e tests (playwright.player.config.ts). It mimics what
 * the backend generator + a static host do, using a PRODUCTION build of the site:
 *
 *   /assets/*            the Vite build (OMW_PLAYER_E2E_DIST), immutable
 *   /data/*, /media/*    the dev data set (OMW_DEV_DATA_DIR, default ./dev-data), with ranges
 *   every other path     dist/index.html with absolute asset URLs and the page's Boot JSON,
 *                        the generator's CSP (as a header) and its timeline preload
 *                        (<link rel="preload" as="fetch" crossorigin> for timeline.json?v=…)
 *
 * The manifest is served with the pseudo-locale "ar" added to site.locales, like an RTL test
 * deployment, so the production build routes /ar/. Run from frontend/site:
 *   node --conditions=@omw/source --import tsx e2e/player-server.ts
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { devBootFor, devDataMiddleware, escapeJsonForHtml, resolveDevDataDir } from '../vite/dev-data-plugin.ts';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.OMW_PLAYER_E2E_PORT ?? 51741);
const distDir = resolve(root, process.env.OMW_PLAYER_E2E_DIST ?? '../../.cache/player-e2e/dist');
const dataDir = resolveDevDataDir(root);
const LOCALES = ['de', 'en', 'ar'] as const;

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

if (!existsSync(join(distDir, 'index.html'))) {
  console.error(`player-server: no build in ${distDir}`);
  process.exit(1);
}
if (!existsSync(join(dataDir, 'data/manifest.json'))) {
  console.error(`player-server: no dev data in ${dataDir} (pnpm --filter @omw/site dev-data)`);
  process.exit(1);
}

const template = readFileSync(join(distDir, 'index.html'), 'utf8').replaceAll('"./assets/', '"/assets/');

/** The generator's page CSP (backend/src/generator/pages.ts buildCsp; these pages inline no code). */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');
const data = devDataMiddleware(() => dataDir);

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  cache = 'no-cache',
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': cache, ...extra });
  res.end(body);
}

function manifestWithRtl(): string {
  const manifest = JSON.parse(readFileSync(join(dataDir, 'data/manifest.json'), 'utf8')) as {
    site: { locales: string[] };
  };
  if (!manifest.site.locales.includes('ar')) manifest.site.locales = [...manifest.site.locales, 'ar'];
  return JSON.stringify(manifest);
}

const server = createServer((req, res) => {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://e2e.invalid').pathname);
  } catch {
    return send(res, 400, 'text/plain', 'Bad request');
  }

  if (pathname.startsWith('/assets/')) {
    const file = resolve(distDir, `.${pathname}`);
    if (!file.startsWith(distDir + sep) || !existsSync(file) || !statSync(file).isFile()) {
      return send(res, 404, 'text/plain', 'Not found');
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    createReadStream(file).pipe(res);
    return;
  }

  if (pathname === '/data/manifest.json') return send(res, 200, 'application/json', manifestWithRtl(), 'no-store');

  data(req, res, () => {
    const boot = devBootFor(pathname, dataDir, LOCALES);
    const tag = boot ? `<script id="omw-boot" type="application/json">${escapeJsonForHtml(boot)}</script>` : '';
    const v = typeof boot?.timelineV === 'string' ? boot.timelineV : null;
    const preload = v ? `<link rel="preload" href="/data/timeline.json?v=${v}" as="fetch" crossorigin>` : '';
    send(res, 200, 'text/html; charset=utf-8', template.replace('</head>', `${preload}${tag}</head>`), 'no-cache', {
      'content-security-policy': CSP,
    });
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`player-server: http://127.0.0.1:${port}/ (dist ${distDir}, data ${dataDir})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
