/**
 * Boots the generated site in a real browser: the real SPA build (frontend/site/dist, built
 * once if missing), fixture media processed with sharp/ffmpeg (cached in
 * .cache/generator-test/media), basePath "/travel/", served by the preview server on
 * 127.0.0.1:19214 (or the next free port of 19214-19216) and loaded with Playwright's headless Chromium.
 *
 * Per page: the pre-rendered first screen is in the HTML; React mounts into #omw-root and
 * replaces it; no console errors (or "preloaded but not used" warnings), page errors, failed
 * requests, CSP violations or dialogs (XSS probes in captions/titles would open one).
 *
 * First-screen twin (L3-02): with the entry script blocked the twin is the page; after React
 * mounted, the header, the brand and the first strip/cover image sit where the twin had them
 * (at most 4 px apart) at 390x844 and 1440x900. Without JS the article is the page (the twin is
 * hidden). The theme boot script applies a stored theme before any JS (L3-16).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixturesPresent } from '../../src/generator/dev/fixtures.js';
import { DEFAULT_SITE_DIST_DIR } from '../../src/generator/index.js';
import type { PreviewServer } from '../../src/generator/serve.js';
import { verifyOutDir } from '../../src/generator/verify.js';
import { REPO_ROOT } from '../../src/paths.js';
import { createHarness, type Harness, startPreviewInRange } from './harness.js';

// Backend test ports 19200-19219: this file uses 19214-19216, serve.test.ts 19210-19213.
const PORTS = [19214, 19215, 19216];
const BASE = '/travel/';
let ORIGIN = 'http://127.0.0.1:19214';
const MEDIA_CACHE = join(REPO_ROOT, '.cache', 'generator-test', 'media');

function ensureSiteBuild(): string | null {
  // OMW_TEST_SITE_DIST: test against another build of the site (e.g. the current source built
  // into .cache while frontend/site/dist is older).
  const override = process.env.OMW_TEST_SITE_DIST;
  if (override) return existsSync(join(override, '.vite', 'manifest.json')) ? override : null;
  const manifest = join(DEFAULT_SITE_DIST_DIR, '.vite', 'manifest.json');
  if (!existsSync(manifest)) {
    const r = spawnSync('pnpm', ['--filter', '@omw/site', 'build'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 300_000,
    });
    if (r.status !== 0 || !existsSync(manifest)) {
      console.warn(`site build unavailable, skipping browser test:\n${r.stderr?.slice(-2000) ?? ''}`);
      return null;
    }
  }
  return DEFAULT_SITE_DIST_DIR;
}

/** The few browser globals the page-side functions use. */
interface BrowserGlobals {
  __csp: string[];
  document: {
    addEventListener(
      type: 'securitypolicyviolation',
      cb: (e: { violatedDirective: string; blockedURI: string; sourceFile: string; lineNumber: number }) => void,
    ): void;
    getElementById(id: string): {
      children: { length: number };
      querySelector(sel: string): unknown;
      textContent: string;
    } | null;
  };
}

interface PageReport {
  errors: string[];
  csp: string[];
  dialogs: string[];
}

async function visit(page: Page, path: string, opts: { expectStatus?: number } = {}): Promise<PageReport> {
  const errors: string[] = [];
  const dialogs: string[] = [];
  const expected = opts.expectStatus ?? 200;
  page.on('console', (m) => {
    // Chrome warns about a preload nobody used: the twin's preloads must all be consumed.
    if (m.type() === 'warning' && /preloaded using link preload but not used/.test(m.text())) {
      errors.push(`console: ${m.text()}`);
      return;
    }
    if (m.type() !== 'error') return;
    // The 404 document itself is reported by Chrome as a failed resource load.
    if (expected === 404 && /status of 404/.test(m.text())) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && !(expected === 404 && r.request().isNavigationRequest())) {
      errors.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  // Page-side functions (Playwright serialises them; strings would need 'unsafe-eval', which the
  // CSP refuses). The backend tsconfig has no DOM lib, hence the local structural types.
  await page.addInitScript(() => {
    const g = globalThis as unknown as BrowserGlobals;
    g.__csp = [];
    g.document.addEventListener('securitypolicyviolation', (e) => {
      g.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`);
    });
  });
  const response = await page.goto(ORIGIN + path, { waitUntil: 'load' });
  expect(response?.status(), path).toBe(expected);
  await page.waitForFunction(
    () => {
      const root = (globalThis as unknown as BrowserGlobals).document.getElementById('omw-root');
      return (
        !!root &&
        root.children.length > 0 &&
        !root.querySelector('.omw-fs') &&
        !root.querySelector('.omw-twin') &&
        root.textContent.trim().length > 0
      );
    },
    null,
    { timeout: 20_000 },
  );
  await page.waitForLoadState('networkidle');
  const csp = await page.evaluate(() => (globalThis as unknown as BrowserGlobals).__csp);
  return { errors, csp, dialogs };
}

describe.skipIf(!fixturesPresent())('generated site boots in a browser', () => {
  let h: Harness | null = null;
  let server: PreviewServer | null = null;
  let browser: Browser | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    const dist = ensureSiteBuild();
    if (!dist) {
      skipReason = 'no site build';
      return;
    }
    // Snapshot the build: other work may rebuild frontend/site/dist while this test runs.
    const tmpDist = join(REPO_ROOT, '.cache', 'tmp', `e2e-dist-${process.pid}`);
    cpSync(dist, tmpDist, { recursive: true });
    mkdirSync(MEDIA_CACHE, { recursive: true });
    // The server only serves a directory, so it can start first: the public URL needs its port.
    const outDir = join(REPO_ROOT, '.cache', 'tmp', `e2e-out-${process.pid}`);
    mkdirSync(outDir, { recursive: true });
    const preview = await startPreviewInRange(PORTS, { dir: outDir, basePath: BASE });
    server = preview;
    ORIGIN = `http://127.0.0.1:${preview.port}`;
    h = await createHarness({
      outDir,
      media: 'real',
      mediaDir: MEDIA_CACHE,
      siteDist: tmpDist,
      publicUrl: `${ORIGIN}${BASE}`,
      captions: {
        'berlin-photo': '<img src=x onerror=alert("caption")>',
        'hanoi-photo': '</script><script>alert("script")</script>',
      },
    });
    h.store.owner.upsertDay({
      localDate: '2026-11-12',
      title: { de: '"><svg onload=alert("title")>', en: '<b>Berlin</b>' },
      origLocale: 'de',
      updatedAt: '2026-11-19T00:00:00Z',
    });
    const result = await h.generator.generate({ reason: 'e2e' });
    expect(result.stats.days).toBe(5);
    expect((await verifyOutDir(h.outDir)).problems).toEqual([]);
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(REPO_ROOT, '.cache', 'ms-playwright');
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch();
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    h?.cleanup();
    for (const d of [`e2e-dist-${process.pid}`, `e2e-out-${process.pid}`]) {
      rmSync(join(REPO_ROOT, '.cache', 'tmp', d), { recursive: true, force: true });
    }
  });

  const pages: [string, string, number][] = [
    ['home (de)', `${BASE}de/`, 200],
    ['day (en)', `${BASE}en/day/2026-11-15/`, 200],
    ['day with XSS probes (de)', `${BASE}de/day/2026-11-12/`, 200],
    ['story (de)', `${BASE}de/day/2026-11-15/story/p_bhhhs5v54ykcijn3/`, 200],
    ['trip (en)', `${BASE}en/trip/vietnam-2026/`, 200],
    ['404', `${BASE}de/nowhere/`, 404],
  ];

  for (const [label, path, status] of pages) {
    it(`${label}: first screen in the HTML, React mounts, no errors or CSP violations`, async (ctx) => {
      if (skipReason || !browser) return ctx.skip();
      const raw = await (await fetch(ORIGIN + path)).text();
      expect(raw).toContain(
        status === 404 ? '<div id="omw-root"><div class="omw-fs">' : '<div id="omw-root"><div class="omw-twin',
      );
      const context = await browser.newContext({ locale: 'de-DE' });
      try {
        const report = await visit(await context.newPage(), path, { expectStatus: status });
        expect(report).toEqual({ errors: [], csp: [], dialogs: [] });
      } finally {
        await context.close();
      }
    }, 60_000);
  }

  it('language picker: navigator.languages, the locale cookie, and the no-JS fallback', async (ctx) => {
    if (skipReason || !browser) return ctx.skip();
    const en = await browser.newContext({ locale: 'en-US' });
    const p1 = await en.newPage();
    await p1.goto(ORIGIN + BASE);
    await p1.waitForURL(`${ORIGIN}${BASE}en/`);
    await en.addCookies([{ name: 'omw_locale', value: 'de', url: ORIGIN }]);
    const p2 = await en.newPage();
    await p2.goto(ORIGIN + BASE);
    await p2.waitForURL(`${ORIGIN}${BASE}de/`);
    await en.close();

    const noJs = await browser.newContext({ javaScriptEnabled: false, locale: 'en-US' });
    const p3 = await noJs.newPage();
    await p3.goto(ORIGIN + BASE);
    await p3.waitForURL(`${ORIGIN}${BASE}de/`);
    // Without JS the article is the page; the twin (a frame of controls) is hidden.
    expect(await p3.locator('#omw-root .omw-fs h1').textContent()).toBe('On My Way');
    expect(await p3.locator('.omw-twin').isVisible()).toBe(false);
    expect(await p3.locator('h1:visible').count()).toBe(1);
    await p3.goto(`${ORIGIN}${BASE}de/day/2026-11-15/`);
    expect(await p3.locator('.omw-twin').isVisible()).toBe(false);
    expect(await p3.locator('h1:visible').count()).toBe(1);
    expect(await p3.locator('#omw-root .omw-fs h1').textContent()).toBe('Laternen in Hội An');
    expect(await p3.locator('a[rel="next"]').getAttribute('href')).toBe(`${BASE}de/day/2026-11-16/`);
    const cover = p3.locator('main picture img').first();
    expect(
      await cover.evaluate((img) => {
        const i = img as unknown as { complete: boolean; naturalWidth: number };
        return i.complete && i.naturalWidth > 0;
      }),
    ).toBe(true);
    await noJs.close();
  }, 60_000);

  // ------------------------------------------------------------------------------- twin geometry

  interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
  }
  type Boxes = Record<string, Box | null>;

  /** Bounding boxes of the elements both the twin and the SPA render (same selectors). */
  async function boxes(page: Page, kind: 'timeline' | 'player'): Promise<Boxes> {
    const sel =
      kind === 'timeline'
        ? {
            header: '#omw-root header',
            brand: '#omw-root header a',
            image: '#omw-root [data-strip] img',
          }
        : {
            frame: '#omw-root section[aria-roledescription]',
            image: '#omw-root section[aria-roledescription] picture img',
          };
    const out: Boxes = {};
    for (const [name, css] of Object.entries(sel)) {
      const b = await page.locator(css).first().boundingBox();
      out[name] = b
        ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
        : null;
    }
    return out;
  }

  async function settle(page: Page): Promise<void> {
    await page.evaluate(async () => {
      const d = (globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } }).document;
      await d.fonts.ready;
    });
    await page.waitForTimeout(400);
  }

  const shots = join(REPO_ROOT, '.cache', 'shots', 'fix-backend');

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 },
  ]) {
    for (const [label, path, kind] of [
      ['home', `${BASE}de/`, 'timeline'],
      ['day', `${BASE}de/day/2026-11-15/`, 'player'],
    ] as const) {
      it(`twin == SPA first viewport: ${label} at ${viewport.width}x${viewport.height} (L3-02)`, async (ctx) => {
        if (skipReason || !browser) return ctx.skip();
        mkdirSync(shots, { recursive: true });
        const options = { viewport, locale: 'de-DE', reducedMotion: 'reduce' as const, colorScheme: 'light' as const };
        // 1) entry script blocked: the twin is what the visitor sees
        const blocked = await browser.newContext(options);
        const p1 = await blocked.newPage();
        await p1.route(/\/assets\/index-[^/]+\.js$/, (r) => r.abort());
        await p1.goto(ORIGIN + path, { waitUntil: 'load' });
        await settle(p1);
        expect(await p1.locator('#omw-root .omw-twin').count()).toBe(1);
        const twin = await boxes(p1, kind);
        await p1.screenshot({ path: join(shots, `twin-${label}-${viewport.width}.png`) });
        await blocked.close();
        // 2) the SPA after mounting (and the first image loaded)
        const live = await browser.newContext(options);
        const p2 = await live.newPage();
        await p2.goto(ORIGIN + path, { waitUntil: 'load' });
        await p2.waitForFunction(
          () =>
            !(globalThis as unknown as BrowserGlobals).document.getElementById('omw-root')?.querySelector('.omw-twin'),
          null,
          { timeout: 20_000 },
        );
        const imageSel =
          kind === 'timeline' ? '#omw-root [data-strip] img' : '#omw-root section[aria-roledescription] picture img';
        await p2.locator(imageSel).first().waitFor({ state: 'visible', timeout: 20_000 });
        await settle(p2);
        const spa = await boxes(p2, kind);
        await p2.screenshot({ path: join(shots, `spa-${label}-${viewport.width}.png`) });
        await live.close();
        for (const [name, b] of Object.entries(spa)) {
          const t = twin[name];
          expect(t, `${name} missing in the twin`).not.toBeNull();
          expect(b, `${name} missing in the SPA`).not.toBeNull();
          if (!t || !b) continue;
          const diff = Math.max(Math.abs(t.x - b.x), Math.abs(t.y - b.y), Math.abs(t.w - b.w), Math.abs(t.h - b.h));
          expect(diff, `${name}: twin ${JSON.stringify(t)} vs SPA ${JSON.stringify(b)}`).toBeLessThanOrEqual(4);
        }
      }, 90_000);
    }
  }

  it('applies a stored theme before any JS: dark OS + omw-theme=dawn paints dawn (L3-16)', async (ctx) => {
    if (skipReason || !browser) return ctx.skip();
    const context = await browser.newContext({ colorScheme: 'dark', viewport: { width: 390, height: 844 } });
    await context.addInitScript(() => {
      (globalThis as unknown as { localStorage: { setItem(k: string, v: string): void } }).localStorage.setItem(
        'omw-theme',
        'dawn',
      );
    });
    const page = await context.newPage();
    // The entry is held back: whatever is painted now comes from HTML + CSS + the boot script.
    await page.route(/\/assets\/index-[^/]+\.js$/, async (r) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await r.continue();
    });
    await page.goto(`${ORIGIN}${BASE}de/`, { waitUntil: 'domcontentloaded' });
    const before = await page.evaluate(() => {
      const g = globalThis as unknown as {
        document: { documentElement: { getAttribute(n: string): string | null }; body: unknown };
        getComputedStyle(el: unknown): { backgroundColor: string };
      };
      return {
        theme: g.document.documentElement.getAttribute('data-theme'),
        bg: g.getComputedStyle(g.document.body).backgroundColor,
      };
    });
    expect(before).toEqual({ theme: 'dawn', bg: 'rgb(255, 248, 246)' });
    await context.close();
  }, 60_000);
});
