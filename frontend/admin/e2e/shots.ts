/**
 * Design screenshots of the admin (not a test): every screen at 375×812 and 1440×900, dawn and
 * dusk, German and the RTL pseudo-locale. Needs the mock API and a dev server (ar exists only in
 * dev builds):
 *
 *   node --conditions=@omw/source --import tsx e2e/mock/server.ts --port 51750
 *   OMW_API_DEV_URL=http://127.0.0.1:51750 vite --port 51752 --strictPort
 *   PLAYWRIGHT_BROWSERS_PATH=../../.cache/ms-playwright node --import tsx e2e/shots.ts \
 *     [--base http://127.0.0.1:51752] [--only home,inbox] [--vp mobile] [--scheme dark] [--locale ar]
 *
 * Output: <repo>/.cache/shots/admin/<screen>-<vp>-<scheme>-<locale>.png
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type BrowserContext, chromium, type Page } from '@playwright/test';

const { values } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string', default: 'http://127.0.0.1:51752' },
    api: { type: 'string', default: 'http://127.0.0.1:51750' },
    only: { type: 'string' },
    vp: { type: 'string' },
    scheme: { type: 'string' },
    locale: { type: 'string' },
  },
});

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.cache/shots/admin');
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = { mobile: { width: 375, height: 812 }, desktop: { width: 1440, height: 900 } } as const;
const SCHEMES = ['light', 'dark'] as const;
const LOCALES = ['de', 'ar'] as const;

interface Shot {
  name: string;
  path: string;
  /** Prepare the page after navigation (open a dialog, type, …). */
  prepare?: (page: Page) => Promise<void>;
  /** Extra screenshots after scrolling the window by these offsets (px). */
  scrolls?: number[];
}

const SHOTS: Shot[] = [
  { name: 'home', path: '/admin/', scrolls: [700] },
  { name: 'inbox', path: '/admin/inbox', scrolls: [900, 2600] },
  { name: 'item', path: `/admin/inbox/${encodeURIComponent('wa:3EB0B028C9D92EFF4C5B')}` },
  { name: 'days', path: '/admin/days' },
  { name: 'day', path: '/admin/days/2026-11-15', scrolls: [800, 1600] },
  {
    name: 'compose-note',
    path: '/admin/compose?kind=note',
    prepare: async (page) => {
      await page.locator('#note-body').fill('Heute Abend Bánh mì am Fluss, die Laternen spiegeln sich im Wasser. ✨');
    },
  },
  {
    name: 'compose-story',
    path: '/admin/compose?kind=story&post=p_01JX5HOIAN0STORY0000000001',
    prepare: async (page) => {
      // Second option of the editor-mode switch ("Preview").
      await page
        .locator('fieldset')
        .filter({ has: page.locator('input[value=preview]') })
        .locator('label')
        .nth(1)
        .click();
    },
  },
  { name: 'trips', path: '/admin/trips' },
  { name: 'trip', path: '/admin/trips/vietnam-2026' },
  { name: 'settings', path: '/admin/settings', scrolls: [800, 1600, 2400] },
  {
    name: 'conflict',
    path: '/admin/days/2026-11-15',
    prepare: async (page) => {
      await page.request.post(`${values.api}/__mock/day/2026-11-15`, { data: { placeName: 'Đà Nẵng' } });
      await page.locator('input[name=placeName]').fill('Hội An, Altstadt');
      await page.locator('button[name=save-day]').click();
      await page.getByRole('dialog').waitFor();
    },
  },
  {
    name: 'offline',
    path: '/admin/inbox',
    prepare: async (page) => {
      await page.context().setOffline(true);
      await page.getByRole('article').first().getByRole('button').first().click();
      await page.waitForTimeout(400);
      await page.evaluate(() => window.scrollTo(0, 0));
    },
  },
];

async function login(context: BrowserContext): Promise<void> {
  await context.request.post(`${values.api}/__mock/reset`);
  const res = await context.request.post(`${values.base}/api/v1/admin/session`, {
    data: { email: 'owner@example.org', password: 'reisetagebuch' },
  });
  if (!res.ok()) throw new Error(`login failed: ${res.status()}`);
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450);
}

const only = values.only?.split(',');
const browser = await chromium.launch();
try {
  for (const vp of Object.keys(VIEWPORTS) as Array<keyof typeof VIEWPORTS>) {
    if (values.vp && values.vp !== vp) continue;
    for (const scheme of SCHEMES) {
      if (values.scheme && values.scheme !== scheme) continue;
      for (const locale of LOCALES) {
        if (values.locale && values.locale !== locale) continue;
        const context = await browser.newContext({
          viewport: VIEWPORTS[vp],
          deviceScaleFactor: vp === 'mobile' ? 2 : 1,
          colorScheme: scheme,
          reducedMotion: 'reduce',
          locale: locale === 'ar' ? 'ar' : 'de-DE',
          timezoneId: 'Asia/Ho_Chi_Minh',
        });
        await context.addInitScript((l) => localStorage.setItem('omw.admin.locale', l), locale);
        const page = await context.newPage();
        const tag = `${vp}-${scheme}-${locale}`;
        if (!only || only.includes('login')) {
          await page.goto(`${values.base}/admin/login`);
          await settle(page);
          await page.screenshot({ path: `${OUT}/login-${tag}.png` });
        }
        await login(context);
        for (const shot of SHOTS) {
          if (only && !only.includes(shot.name)) continue;
          await page.goto(`${values.base}${shot.path}`);
          await settle(page);
          await shot.prepare?.(page);
          await settle(page);
          await page.screenshot({ path: `${OUT}/${shot.name}-${tag}.png` });
          for (const y of shot.scrolls ?? []) {
            await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
            await page.waitForTimeout(250);
            await page.screenshot({ path: `${OUT}/${shot.name}@${y}-${tag}.png` });
          }
        }
        await context.setOffline(false);
        await context.close();
        console.log(`shots: ${tag}`);
      }
    }
  }
} finally {
  await browser.close();
}
