/**
 * Integration e2e against REAL generator output (playwright.generated.config.ts): the pages,
 * data and media the backend produced from the fixtures, served like a plain static host.
 *
 * Every test fails on console errors, page errors, failed requests, unexpected HTTP errors and
 * CSP violations (the generated pages carry a strict CSP <meta>). The tests are data-driven:
 * days, the trip and the story are read from the served data files.
 *
 * Note (CSP): no string evaluation in the page (it needs 'unsafe-eval'); only page functions.
 */
import type { DayDetail, Entry, Manifest, TimelineIndex } from '@omw/contracts/site';
import { type APIRequestContext, test as base, expect, type Page } from '@playwright/test';

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

interface Problems {
  console: string[];
  pageErrors: string[];
  failed: string[];
  http: string[];
  /** HTTP statuses a test expects (e.g. 404 for the not-found test). */
  allowStatus: Set<number>;
}

declare global {
  interface Window {
    __omwCsp?: string[];
  }
}

/** Collects problems for every test and asserts there are none at the end. */
const test = base.extend<{ problems: Problems }>({
  problems: [
    async ({ page }, use) => {
      const p: Problems = { console: [], pageErrors: [], failed: [], http: [], allowStatus: new Set() };
      await page.addInitScript(() => {
        window.__omwCsp = [];
        document.addEventListener('securitypolicyviolation', (e) => {
          window.__omwCsp?.push(`${e.violatedDirective} ${e.blockedURI}`);
        });
      });
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        // Chromium logs every HTTP error response; expected ones (allowStatus) are not problems.
        const status = /status of (\d{3})/.exec(m.text())?.[1];
        if (m.text().startsWith('Failed to load resource') && status && p.allowStatus.has(Number(status))) return;
        p.console.push(m.text());
      });
      page.on('pageerror', (e) => p.pageErrors.push(e.message));
      page.on('requestfailed', (r) => {
        const err = r.failure()?.errorText ?? '';
        // Media/prefetch requests the browser cancels itself (navigation, <video> source swap)
        // are not failures of the site.
        if (err.includes('ERR_ABORTED')) return;
        p.failed.push(`${r.method()} ${r.url()} ${err}`);
      });
      page.on('response', (r) => {
        if (r.status() >= 400 && !p.allowStatus.has(r.status())) p.http.push(`${r.status()} ${r.url()}`);
      });
      await use(p);
      const csp = await page.evaluate(() => window.__omwCsp ?? []).catch(() => [] as string[]);
      expect.soft(csp, 'CSP violations').toEqual([]);
      expect.soft(p.pageErrors, 'page errors').toEqual([]);
      expect.soft(p.console, 'console errors').toEqual([]);
      expect.soft(p.failed, 'failed requests').toEqual([]);
      expect.soft(p.http, 'HTTP errors').toEqual([]);
    },
    { auto: true },
  ],
});

/**
 * The SPA mounted: the pre-rendered first screen was replaced. Since L3-02 that is the twin
 * (`.omw-twin`, a static copy of the first viewport that reuses the SPA's markup, data-level and
 * data-strip included) with the no-JS article inside <noscript>; the 404 page keeps `.omw-fs`.
 */
async function mounted(page: Page): Promise<void> {
  await expect(page.locator('#omw-root')).toBeAttached();
  await expect(page.locator('#omw-root > .omw-twin')).toHaveCount(0);
  await expect(page.locator('#omw-root > .omw-fs')).toHaveCount(0);
}

async function timelineReady(page: Page, level = 'days'): Promise<void> {
  await mounted(page);
  await expect(page.locator(`[data-level="${level}"]`)).toBeVisible();
  // A running zoom transition (340 ms) leaves a ghost layer.
  await expect(page.locator('[data-zoom-ghost]')).toHaveCount(0);
}

function storyDay(data: Data): { day: DayDetail; index: number; story: Extract<Entry, { kind: 'story' }> } {
  for (const day of data.days) {
    const index = day.entries.findIndex((e) => e.kind === 'story');
    if (index >= 0) return { day, index, story: day.entries[index] as Extract<Entry, { kind: 'story' }> };
  }
  throw new Error('The generated site has no story: import owner content first (see the config header)');
}

const LOCALES = [
  { code: 'de', dir: 'ltr', watch: 'Tag ansehen', years: 'Jahre', months: 'Monate', days: 'Tage' },
  { code: 'en', dir: 'ltr', watch: 'Watch the day', years: 'Years', months: 'Months', days: 'Days' },
  { code: 'ar', dir: 'rtl', watch: null, years: null, months: null, days: null },
] as const;

test.describe('generated site', () => {
  test('the manifest lists de, en and the RTL pseudo-locale', async ({ request }) => {
    const { manifest, timeline, days } = await loadData(request);
    expect(manifest.site.locales).toEqual(expect.arrayContaining(['de', 'en', 'ar']));
    expect(timeline.days.length).toBeGreaterThan(0);
    expect(timeline.trips.length).toBeGreaterThan(0);
    expect(days.flatMap((d) => d.entries).length).toBeGreaterThan(0);
  });

  for (const l of LOCALES) {
    test(`home timeline (${l.code}): mounts, lang/dir, one row per day, all zoom levels`, async ({ page, request }) => {
      const data = await loadData(request);
      await page.goto(`/${l.code}/`);
      await timelineReady(page);
      await expect(page.locator('html')).toHaveAttribute('lang', l.code);
      await expect(page.locator('html')).toHaveAttribute('dir', l.dir);
      // Newest day first; the virtualized list reaches the oldest day at the bottom.
      const newest = data.timeline.days
        .map((d) => d.date)
        .sort()
        .at(-1) as string;
      const oldest = data.timeline.days.map((d) => d.date).sort()[0] as string;
      await expect(page.locator('[data-row-date]').first()).toHaveAttribute('data-row-date', newest);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect(page.locator(`[data-row-date="${oldest}"]`)).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, 0));
      if (l.watch) await expect(page.getByRole('link', { name: l.watch }).first()).toBeVisible();

      // Zoom: keys - / - / 3 / 2 / + (replace history), and the pill.
      const length = await page.evaluate(() => history.length);
      await page.keyboard.press('-');
      await expect(page).toHaveURL(/[?&]z=months/);
      await timelineReady(page, 'months');
      await page.keyboard.press('-');
      await expect(page).toHaveURL(/[?&]z=trips/);
      await timelineReady(page, 'trips');
      await page.keyboard.press('3');
      await expect(page).not.toHaveURL(/[?&]z=/);
      await timelineReady(page, 'days');
      expect(await page.evaluate(() => history.length)).toBe(length);
      if (l.years && l.months && l.days) {
        const pill = page.getByRole('group', { name: /Zoom/ });
        await pill.getByRole('button', { name: l.years }).click();
        await timelineReady(page, 'trips');
        await pill.getByRole('button', { name: l.months }).click();
        await timelineReady(page, 'months');
        await pill.getByRole('button', { name: l.days }).click();
        await timelineReady(page, 'days');
      }
    });
  }

  test('timeline images load as AVIF (with WebP sources next to them)', async ({ page, request }) => {
    await loadData(request);
    const images: { url: string; type: string | null; status: number }[] = [];
    page.on('response', (r) => {
      if (r.url().includes('/media/') && r.request().resourceType() === 'image') {
        images.push({ url: r.url(), type: r.headers()['content-type'] ?? null, status: r.status() });
      }
    });
    await page.goto('/de/');
    await timelineReady(page);
    await expect.poll(() => images.length).toBeGreaterThan(0);
    for (const img of images) {
      expect(img.status).toBe(200);
      // Photo/poster variants, and the portrait's own round crop (pipeline/avatar.ts).
      expect(img.url).toMatch(/_(?:(?:poster_)?w\d+|avatar_[0-9a-f]{8}_s\d+)\.avif$/);
      expect(img.type).toBe('image/avif');
    }
    // Each AVIF <source> has a WebP sibling that is served too.
    const webp = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLSourceElement>('picture source[type="image/webp"]')].map(
        (s) => s.srcset.split(',')[0]?.trim().split(' ')[0] ?? '',
      ),
    );
    expect(webp.length).toBeGreaterThan(0);
    const res = await request.get(webp[0] as string);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/webp');
  });

  test('opening the day player from the timeline pushes history and autoplays', async ({ page, request }) => {
    const data = await loadData(request);
    await page.clock.install();
    await page.goto('/de/');
    await timelineReady(page);
    const date = data.timeline.days[data.timeline.days.length - 1]?.date as string;
    const row = page.locator(`[data-row-date="${date}"]`);
    await row.scrollIntoViewIfNeeded();
    await row.getByRole('link', { name: 'Tag ansehen' }).click();
    await expect(page).toHaveURL(new RegExp(`/de/day/${date}/$`));
    const s = page.getByTestId('player-session');
    await expect(s).toBeVisible();
    await expect(page.getByRole('dialog').first()).toHaveAttribute('aria-modal', 'true');
    await expect(s).toHaveAttribute('data-status', /playing|buffering/);
    await expect(s).toHaveAttribute('data-index', '0');
    // Autoplay advances on its own (the longest timer item is 12 s; videos have their length).
    const day = data.days.find((d) => d.date === date) as DayDetail;
    if (day.entries.length > 1 && day.entries[0]?.kind !== 'video' && day.entries[0]?.kind !== 'voice') {
      await page.clock.fastForward(12_500);
      await expect(s).toHaveAttribute('data-index', '1');
    }
    // Closing goes back in history to the timeline.
    await page.getByTestId('player-close').click();
    await expect(page).toHaveURL(/\/de\/(?:\?.*)?$/);
    await timelineReady(page);
  });

  test('player loads photo variants as AVIF and plays a video (byte ranges)', async ({ page, request }) => {
    const data = await loadData(request);
    const media: { url: string; status: number; type: string | null }[] = [];
    page.on('response', (r) => {
      if (r.url().includes('/media/'))
        media.push({ url: r.url(), status: r.status(), type: r.headers()['content-type'] ?? null });
    });
    const day = data.days.find((d) => d.entries.some((e) => e.kind === 'video')) as DayDetail;
    const videoIndex = day.entries.findIndex((e) => e.kind === 'video');
    await page.goto(`/de/day/${day.date}/`);
    const s = page.getByTestId('player-session');
    await expect(s).toBeVisible();
    for (let i = 0; i < videoIndex; i++) await page.keyboard.press('ArrowRight');
    await expect(s).toHaveAttribute('data-kind', 'video');
    await expect
      .poll(() => media.some((m) => m.url.endsWith('_video.mp4') && (m.status === 206 || m.status === 200)))
      .toBe(true);
    const mp4 = media.find((m) => m.url.endsWith('_video.mp4'));
    expect(mp4?.type).toBe('video/mp4');
    // The video element really plays (currentTime advances).
    await expect
      .poll(() =>
        page.evaluate(() => Math.max(0, ...[...document.querySelectorAll('video')].map((v) => v.currentTime))),
      )
      .toBeGreaterThan(0);
    for (const m of media.filter((x) => /\.(avif|webp)$/.test(x.url))) {
      expect(m.status).toBe(200);
      expect(m.url.endsWith('.avif')).toBe(true);
    }
  });

  test('story: the card opens the sheet (own URL), closing resumes the player', async ({ page, request }) => {
    const data = await loadData(request);
    const { day, index, story } = storyDay(data);
    await page.goto(`/de/day/${day.date}/`);
    const s = page.getByTestId('player-session');
    await expect(s).toBeVisible();
    for (let i = 0; i < index; i++) await page.keyboard.press('ArrowRight');
    await expect(s).toHaveAttribute('data-kind', 'story');
    await page.getByTestId('player-read-story').click();
    await expect(page).toHaveURL(new RegExp(`/de/day/${day.date}/story/${story.id}/$`));
    const sheet = page.getByTestId('story-sheet');
    await expect(sheet).toBeVisible();
    const title = (story.story.de ?? story.story[story.orig])?.title ?? '';
    await expect(sheet).toContainText(title);
    await expect(s).toHaveAttribute('data-paused', /sheet/);
    await page.getByTestId('story-close').click();
    await expect(sheet).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/de/day/${day.date}/$`));
  });

  test('trip page shows the trip and its days; links into the timeline', async ({ page, request }) => {
    const data = await loadData(request);
    const trip = data.timeline.trips[0] as TimelineIndex['trips'][number];
    await page.goto(`/de/trip/${trip.slug}/`);
    await mounted(page);
    const title = trip.title.de ?? Object.values(trip.title)[0] ?? '';
    // The trip is a dialog above the mounted timeline.
    const dialog = page.getByRole('dialog', { name: title });
    await expect(dialog).toBeVisible();
    // The dialog's own heading names the trip (an h2 before the site's one-h1 change, the h1 after).
    await expect(dialog.getByRole('heading', { name: title, exact: true }).first()).toBeVisible();
    // One link per public day of the trip.
    const tripDays = data.timeline.days.filter((d) => d.date >= trip.start && d.date <= trip.end);
    for (const d of tripDays) {
      await expect(dialog.locator(`a[href$="/de/day/${d.date}/"]`).first()).toBeAttached();
    }
    // "Show in the timeline" closes the dialog onto the days level at the trip's newest day.
    await dialog.getByRole('button', { name: 'In der Zeitleiste zeigen' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/\/de\/(?:\?.*)?$/);
    await timelineReady(page, 'days');
    const newest = tripDays
      .map((d) => d.date)
      .sort()
      .at(-1) as string;
    await expect(page.locator(`[data-row-date="${newest}"]`)).toBeVisible();
  });

  test('deep links reload on every route type (de, en, ar)', async ({ page, request }) => {
    const data = await loadData(request);
    const { day, story } = storyDay(data);
    const trip = data.timeline.trips[0]?.slug as string;
    for (const locale of ['de', 'en', 'ar']) {
      const routes: { path: string; check: () => Promise<void> }[] = [
        { path: `/${locale}/`, check: () => timelineReady(page) },
        { path: `/${locale}/?z=months`, check: () => timelineReady(page, 'months') },
        { path: `/${locale}/?z=trips`, check: () => timelineReady(page, 'trips') },
        {
          path: `/${locale}/day/${day.date}/`,
          check: async () => {
            await mounted(page);
            await expect(page.getByTestId('player-session')).toBeVisible();
          },
        },
        {
          path: `/${locale}/day/${day.date}/story/${story.id}/`,
          check: async () => {
            await mounted(page);
            await expect(page.getByTestId('story-sheet')).toBeVisible();
          },
        },
        {
          path: `/${locale}/trip/${trip}/`,
          check: async () => {
            await mounted(page);
            await expect(page.getByRole('dialog').getByRole('heading', { level: 2 })).toBeVisible();
          },
        },
      ];
      for (const r of routes) {
        const res = await page.goto(r.path);
        expect(res?.status(), r.path).toBe(200);
        await r.check();
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await page.reload();
        await r.check();
        await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      }
    }
  });

  test('404: unknown paths get 404.html and the SPA not-found screen', async ({ page, problems }) => {
    problems.allowStatus.add(404);
    for (const [path, text] of [
      ['/de/gibt-es-nicht/', 'Hier ist nichts'],
      ['/en/day/2001-01-01/', 'Nothing here'],
      ['/no/such/deep/path', 'Hier ist nichts'],
    ] as const) {
      const res = await page.goto(path);
      expect(res?.status(), path).toBe(404);
      await mounted(page);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(text);
    }
    // Only the documents were 404 (no asset or data request failed).
    expect(problems.http).toEqual([]);
  });

  test('a page stamped with an older release shows no "new moments" toast', async ({ page, request }) => {
    const data = await loadData(request);
    // Day pages keep the release in which their content last changed (generator design).
    let older: string | null = null;
    for (const d of data.timeline.days) {
      const html = await (await request.get(`/de/day/${d.date}/`)).text();
      const boot = /<script id="omw-boot" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1];
      const stamp = boot ? (JSON.parse(boot) as { manifestVersion: number | null }).manifestVersion : null;
      if (stamp !== null && stamp < data.manifest.version) {
        older = `/de/day/${d.date}/`;
        break;
      }
    }
    if (!older) {
      // A site with a single release: simulate a newer live manifest.
      older = `/de/day/${data.timeline.days[0]?.date}/`;
      await page.route(/\/data\/manifest\.json/, async (route) => {
        const res = await route.fetch();
        const json = (await res.json()) as Manifest;
        await route.fulfill({ response: res, json: { ...json, version: json.version + 1 } });
      });
    }
    await page.clock.install();
    await page.goto(older);
    await mounted(page);
    await expect(page.getByTestId('player-session')).toBeVisible();
    await page.getByTestId('player-close').click();
    await timelineReady(page);
    await page.clock.fastForward('05:30'); // one manifest poll
    await page.waitForTimeout(300);
    await expect(page.getByRole('button', { name: /Neue Momente/ })).toHaveCount(0);
  });

  test('root language picker sends the visitor to a locale home', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/de\/$/);
    await timelineReady(page);
  });
});
