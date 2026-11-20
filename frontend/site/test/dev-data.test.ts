import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Boot, DayDetail, dayDataPath, Manifest, TimelineIndex, TripDetail, tripDataPath } from '@omw/contracts/site';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devBootFor, devDataMiddleware, escapeJsonForHtml, previewPageHtml } from '../vite/dev-data-plugin';

const DIR = fileURLToPath(new URL('../dev-data', import.meta.url));
const HAVE_DATA = existsSync(join(DIR, 'data/manifest.json'));
const read = (rel: string): unknown => JSON.parse(readFileSync(join(DIR, rel), 'utf8'));

describe('escapeJsonForHtml', () => {
  it('cannot close the script element', () => {
    const out = escapeJsonForHtml({ s: '</script><b>&\u2028' });
    expect(out).not.toMatch(/[<>&\u2028]/);
    expect(JSON.parse(out)).toEqual({ s: '</script><b>&\u2028' });
  });
});

describe('previewPageHtml (vite preview of a production build)', () => {
  const built = [
    '<!doctype html><html><head>',
    '<script type="module" crossorigin src="./assets/index-abc.js"></script>',
    '<link rel="modulepreload" crossorigin href="./assets/react-def.js">',
    '<link rel="stylesheet" crossorigin href="./assets/index-ghi.css">',
    '</head><body><div id="omw-root"></div></body></html>',
  ].join('\n');

  it('makes asset URLs absolute, so pages at any depth load them', () => {
    const html = previewPageHtml(built, null);
    expect(html).toContain('src="/assets/index-abc.js"');
    expect(html).toContain('href="/assets/react-def.js"');
    expect(html).toContain('href="/assets/index-ghi.css"');
    expect(html).not.toContain('./assets/');
  });

  it('injects the Boot JSON into <head>, escaped', () => {
    const boot = { basePath: '/', locale: 'de', route: { name: 'home', params: {} }, t: '</script>' };
    const html = previewPageHtml(built, boot);
    const m = /<script id="omw-boot" type="application\/json">([^<]*)<\/script>\s*<\/head>/.exec(html);
    expect(m?.[1] && JSON.parse(m[1])).toEqual(boot);
  });
});

describe.skipIf(!HAVE_DATA)('dev-data (frontend/site/dev-data, from `pnpm --filter @omw/site dev-data`)', () => {
  it('every data file matches @omw/contracts/site', () => {
    const manifest = Manifest.parse(read('data/manifest.json'));
    const timeline = TimelineIndex.parse(read('data/timeline.json'));
    expect(timeline.days.length).toBeGreaterThan(0);
    expect(manifest.site.basePath).toBe('/');
    for (const d of timeline.days) expect(DayDetail.parse(read(dayDataPath(d.date))).v).toBe(d.v);
    for (const t of timeline.trips) expect(TripDetail.parse(read(tripDataPath(t.slug))).v).toBe(t.v);
  });

  it('the dev boot JSON is contract-valid and inlines the day', () => {
    const timeline = TimelineIndex.parse(read('data/timeline.json'));
    const date = timeline.days[0]?.date ?? '';
    const boot = Boot.parse(devBootFor(`/en/day/${date}/`, DIR, ['de', 'en', 'ar']));
    expect(boot).toMatchObject({ basePath: '/', locale: 'en', route: { name: 'day', params: { date } } });
    expect(boot.day?.date).toBe(date);
    expect(Boot.parse(devBootFor('/', DIR, ['de', 'en'])).route.name).toBe('home');
  });

  describe('middleware', () => {
    const middleware = devDataMiddleware(() => DIR);
    const server = createServer((req, res) =>
      middleware(req as never, res, () => {
        res.statusCode = 418; // "next()": not handled by the dev-data middleware
        res.end();
      }),
    );
    let base = '';
    beforeAll(async () => {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it('serves data with JSON type and media with byte ranges', async () => {
      const res = await fetch(`${base}/data/manifest.json?t=1`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      Manifest.parse(await res.json());

      const timeline = TimelineIndex.parse(read('data/timeline.json'));
      const cover = timeline.days.find((d) => d.cover)?.cover;
      const src = cover?.sources.avif[0]?.src ?? '';
      const ranged = await fetch(`${base}/${src}`, { headers: { range: 'bytes=0-9' } });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-type')).toBe('image/avif');
      expect(ranged.headers.get('content-range')).toMatch(/^bytes 0-9\/\d+$/);
      expect((await ranged.arrayBuffer()).byteLength).toBe(10);
    });

    it('404s unknown files, refuses traversal and ignores other paths', async () => {
      expect((await fetch(`${base}/data/nope.json`)).status).toBe(404);
      expect((await fetch(`${base}/media/..%2f..%2fpackage.json`)).status).toBe(403);
      expect((await fetch(`${base}/media/%2e%2e/%2e%2e/package.json`)).status).toBe(418); // URL-normalised away
      expect((await fetch(`${base}/de/`)).status).toBe(418);
    });
  });
});
