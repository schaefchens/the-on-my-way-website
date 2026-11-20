/**
 * Startup of the production build (L3-01), against e2e/player-server.ts (generator-like pages:
 * Boot JSON, CSP, timeline preload). Data-driven from the served dev data set.
 */
import type { DayDetail, Manifest, TimelineIndex } from '@omw/contracts/site';
import { type APIRequestContext, expect, type Page, type Route, test } from '@playwright/test';

interface Data {
  manifest: Manifest;
  timeline: TimelineIndex;
  days: DayDetail[];
}

let cached: Data | null = null;

async function loadData(request: APIRequestContext): Promise<Data> {
  if (cached) return cached;
  const manifest = (await (await request.get('/data/manifest.json')).json()) as Manifest;
  const timeline = (await (await request.get(`/data/timeline.json?v=${manifest.timeline.v}`)).json()) as TimelineIndex;
  const days = await Promise.all(
    timeline.days.map(
      async (d) => (await (await request.get(`/data/days/${d.date}.json?v=${d.v}`)).json()) as DayDetail,
    ),
  );
  cached = { manifest, timeline, days };
  return cached;
}

/** Holds matching requests until release() (then lets them through unchanged). */
async function holdRequests(page: Page, pattern: RegExp) {
  const held: Route[] = [];
  let released = false;
  await page.route(pattern, (route) => {
    if (released) return route.fallback();
    held.push(route);
  });
  return {
    count: () => held.length,
    release: async () => {
      released = true;
      for (const route of held.splice(0)) await route.fallback();
    },
  };
}

/** Collects Content-Security-Policy violations reported in the page. */
async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const w = window as Window & { __csp?: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__csp?.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return () => page.evaluate(() => (window as Window & { __csp?: string[] }).__csp ?? []);
}

test.describe('startup (L3-01)', () => {
  test('a day page plays from its inlined data while manifest and timeline are still on their way', async ({
    page,
    request,
  }) => {
    const { days } = await loadData(request);
    const day = days.find((d) => d.entries.length >= 2) as DayDetail;
    const manifest = await holdRequests(page, /\/data\/manifest\.json/);
    const timeline = await holdRequests(page, /\/data\/timeline\.json/);
    const started = Date.now();
    await page.goto(`/de/day/${day.date}/`, { waitUntil: 'commit' });
    const session = page.getByTestId('player-session');
    // The player itself (not the aria-busy loading frame) shows although nothing came back yet.
    await expect(session).toBeVisible({ timeout: 3_000 });
    await expect(session).toHaveAttribute('data-count', String(day.entries.length));
    await expect(page.locator('[role="dialog"][aria-busy="true"]')).toHaveCount(0);
    expect(Date.now() - started).toBeLessThan(3_000);
    // Both requests had been started (in parallel) and were still pending all along.
    expect(manifest.count()).toBeGreaterThanOrEqual(1);
    expect(timeline.count()).toBeGreaterThanOrEqual(1);
    await manifest.release();
    await timeline.release();
    // The timeline loads behind the player: closing shows it at that day.
    await page.getByTestId('player-close').click();
    await expect(page.locator(`[data-row-date="${day.date}"]`)).toBeVisible();
  });

  test('catalog, manifest and the preloaded timeline start together; the timeline is fetched once', async ({
    page,
    request,
  }) => {
    const { manifest } = await loadData(request);
    const timelineRequests: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/data/timeline.json')) timelineRequests.push(r.url());
    });
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text());
    });
    await page.goto('/de/');
    await expect(page.locator('[data-level="days"]')).toBeVisible();
    const starts = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((e) => ({ name: e.name, start: e.startTime }))
        .filter((e) => /\/assets\/messages-|\/data\/manifest\.json|\/data\/timeline\.json/.test(e.name)),
    );
    const catalog = starts.find((e) => e.name.includes('/assets/messages-'));
    const manifestStart = starts.find((e) => e.name.includes('/data/manifest.json'));
    // The page preloads exactly this URL; the app's request for it is served by the preload.
    expect(timelineRequests).toEqual([`${new URL(page.url()).origin}/data/timeline.json?v=${manifest.timeline.v}`]);
    expect(catalog && manifestStart).toBeTruthy();
    // No request waits for another one: catalog and manifest start within ~50 ms of each other
    // (the timeline is preloaded by the page, so it starts even earlier).
    expect(Math.abs((catalog?.start ?? 0) - (manifestStart?.start ?? 1e9))).toBeLessThan(50);
    expect(warnings.filter((w) => /preload/i.test(w))).toEqual([]);
  });

  test('a page older than the site uses the newer timeline from the manifest, without a toast', async ({
    page,
    request,
  }) => {
    const { manifest, timeline } = await loadData(request);
    const newest = timeline.days.at(-1)?.date as string;
    // The site moved on: the manifest names a timeline without the newest day.
    await page.route(/\/data\/manifest\.json/, async (route) => {
      const res = await route.fetch();
      const json = (await res.json()) as Manifest;
      await route.fulfill({
        response: res,
        json: { ...json, version: manifest.version + 1, timeline: { v: 'newer0001' } },
      });
    });
    await page.route(/\/data\/timeline\.json\?v=newer0001/, (route) =>
      route.fulfill({ json: { ...timeline, days: timeline.days.slice(0, -1) } }),
    );
    await page.goto('/de/');
    await expect(page.locator('[data-level="days"]')).toBeVisible();
    await expect(page.locator(`[data-row-date="${newest}"]`)).toHaveCount(0);
    await expect(page.locator('[data-row-date]').first()).toHaveAttribute(
      'data-row-date',
      timeline.days.at(-2)?.date as string,
    );
    await page.waitForTimeout(500);
    await expect(page.getByRole('button', { name: /Neue Momente/ })).toHaveCount(0);
  });

  test('a story with a markdown image renders no <img> and violates no CSP (L1-11)', async ({ page, request }) => {
    const { days } = await loadData(request);
    const day = days.find((d) => d.entries.some((e) => e.kind === 'story')) as DayDetail;
    const story = day.entries.find((e) => e.kind === 'story') as Extract<
      DayDetail['entries'][number],
      { kind: 'story' }
    >;
    const body = 'Vorher.\n\n![Pixel](https://evil.example/p.gif)\n\nNachher.';
    const patched: DayDetail = {
      ...day,
      entries: day.entries.map((e) =>
        e.id === story.id
          ? { ...story, story: Object.fromEntries(Object.entries(story.story).map(([k, c]) => [k, { ...c, body }])) }
          : e,
      ),
    };
    const external: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('evil.example')) external.push(r.url());
    });
    const violations = await watchCsp(page);
    // The page's Boot JSON inlines the day: patch the data file and open the story in-app.
    await page.route(`**/data/days/${day.date}.json*`, (route) => route.fulfill({ json: patched }));
    await page.goto(`/de/?d=${day.date}`);
    await page.locator(`a[href="/de/day/${day.date}/story/${story.id}/"]`).first().click();
    const sheet = page.getByTestId('story-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.omw-prose')).toContainText('Nachher.');
    await expect(sheet.locator('img')).toHaveCount(0);
    await expect(sheet.getByRole('link', { name: 'Pixel' })).toHaveAttribute('href', 'https://evil.example/p.gif');
    await expect(sheet.getByRole('button', { name: 'Zurück zum Tag' })).toBeVisible();
    expect(external).toEqual([]);
    expect(await violations()).toEqual([]);
  });
});
