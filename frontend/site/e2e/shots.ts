/**
 * Design screenshots (not a test): every combination of viewport × colour scheme × locale for a
 * list of paths, written to .cache/shots/site/. Usage (dev server running):
 *   PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright node --import tsx frontend/site/e2e/shots.ts \
 *     [--base http://127.0.0.1:51730] [--only <substring>] [--state <state>] [--viewports m,t,d] [path …]
 * States (data faked with request interception): skeleton (data never arrives), strips (the
 * timeline loads, day files never do: ThumbHash placeholders), empty (no days yet), error (the
 * timeline request fails), toast (a newer manifest: "new moments").
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, type Page } from '@playwright/test';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string', default: 'http://127.0.0.1:51730' },
    out: { type: 'string', default: resolve(import.meta.dirname, '../../../.cache/shots/site') },
    only: { type: 'string' },
    full: { type: 'boolean', default: false },
    scroll: { type: 'string' },
    state: { type: 'string' },
    /** Comma-separated viewport names (m = 375, t = 768, d = 1440); default all. */
    viewports: { type: 'string' },
  },
});

type State = 'skeleton' | 'strips' | 'empty' | 'error' | 'toast';
const STATES: readonly State[] = ['skeleton', 'strips', 'empty', 'error', 'toast'];
const state = values.state as State | undefined;
if (state !== undefined && !STATES.includes(state)) throw new Error(`--state must be one of ${STATES.join(', ')}`);

/** Fakes the data layer for a state screenshot (see the module doc). */
async function fakeState(page: Page, s: State): Promise<void> {
  const never = () => new Promise<void>(() => {});
  if (s === 'skeleton') await page.route(/\/data\/timeline\.json/, never);
  if (s === 'strips') await page.route(/\/data\/days\//, never);
  if (s === 'error') await page.route(/\/data\/timeline\.json/, (r) => r.fulfill({ status: 503, body: 'down' }));
  if (s === 'empty') {
    await page.route(/\/data\/timeline\.json/, async (r) => {
      const res = await r.fetch();
      const json = (await res.json()) as Record<string, unknown>;
      await r.fulfill({ response: res, json: { ...json, trips: [], days: [] } });
    });
  }
  if (s === 'toast') {
    // The first manifest after load is the baseline (no toast); the next poll brings news.
    let requests = 0;
    await page.route(/\/data\/manifest\.json/, async (r) => {
      const res = await r.fetch();
      if (requests++ === 0) return r.fulfill({ response: res });
      const json = (await res.json()) as { version: number; timeline: { v: string } };
      await r.fulfill({ response: res, json: { ...json, version: json.version + 1, timeline: { v: 'feedc0ffee' } } });
    });
  }
}

const ALL_VIEWPORTS = [
  { name: 'm', width: 375, height: 812, mobile: true },
  { name: 't', width: 768, height: 1024, mobile: false },
  { name: 'd', width: 1440, height: 900, mobile: false },
] as const;
const wanted = values.viewports?.split(',').map((v) => v.trim());
const VIEWPORTS = ALL_VIEWPORTS.filter((vp) => !wanted || wanted.includes(vp.name));
const SCHEMES = ['light', 'dark'] as const;
const paths = positionals.length > 0 ? positionals : ['/de/', '/ar/'];

mkdirSync(values.out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    for (const scheme of SCHEMES) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.mobile ? 2 : 1,
        isMobile: vp.mobile,
        hasTouch: vp.mobile,
        colorScheme: scheme,
      });
      const page = await ctx.newPage();
      let clockInstalled = false;
      page.on('pageerror', (e) => console.error('pageerror', e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') console.error('console', m.text());
      });
      for (const p of paths) {
        const slug = p.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'root';
        const name = `${state ? `${state}-` : ''}${slug}-${vp.name}-${scheme}`;
        if (values.only && !name.includes(values.only)) continue;
        await page.unrouteAll();
        if (state) await fakeState(page, state);
        if (state === 'toast' && !clockInstalled) {
          await page.clock.install();
          clockInstalled = true;
        }
        await page.goto(values.base + p, {
          waitUntil: state === 'skeleton' || state === 'strips' ? 'load' : 'networkidle',
        });
        // Failed requests are retried twice (with back-off) before the error screen shows.
        if (state === 'error') await page.waitForSelector('[role="alert"]', { timeout: 20_000 });
        if (state === 'toast') await page.clock.fastForward('05:30'); // the 5-minute manifest poll
        await page.evaluate(() => document.fonts.ready);
        if (values.scroll) await page.evaluate((y) => window.scrollTo(0, Number(y)), values.scroll);
        await page.waitForTimeout(700);
        const file = join(values.out, `${name}.png`);
        await page.screenshot({ path: file, fullPage: values.full });
        console.log(file);
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
