import { expect, type Page, test } from '@playwright/test';

interface Probe {
  date: string;
  x: number;
  y: number;
}

function params(page: Page): Record<string, string> {
  return Object.fromEntries(new URL(page.url()).searchParams);
}

async function ready(page: Page, level?: string): Promise<void> {
  await page.waitForSelector(level ? `[data-level="${level}"]` : '[data-level]');
  await page.evaluate(() => document.fonts.ready);
  // Let a running zoom transition (340 ms) finish.
  await page.waitForFunction(() => !document.querySelector('[data-zoom-ghost]'));
}

/** Centre of the anchor element of `date` in the current level (null when not rendered). */
async function anchorCenter(page: Page, date: string): Promise<{ x: number; y: number; h: number } | null> {
  return page.evaluate((d) => {
    const all = [
      ...document.querySelectorAll<HTMLElement>('[data-level] [data-anchor],[data-level] [data-anchor-range]'),
    ];
    const el = all.find((e) => {
      if (e.dataset.anchor !== undefined) return e.dataset.anchor === d;
      const [from, to] = (e.dataset.anchorRange ?? '').split('..');
      return !!from && !!to && from <= d && d <= to;
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: r.height };
  }, date);
}

/** A day row whose header sits in the given viewport band (days level). */
async function dayInBand(page: Page, top: number, bottom: number): Promise<Probe> {
  const probe = await page.evaluate(
    ([t, b]) => {
      for (const row of document.querySelectorAll<HTMLElement>('[data-row-date]')) {
        const avatar = row.querySelector<HTMLElement>('[data-anchor]');
        const r = avatar?.getBoundingClientRect();
        if (r && r.top + r.height / 2 > t && r.top + r.height / 2 < b) {
          return { date: row.dataset.rowDate as string, x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    },
    [top, bottom] as const,
  );
  expect(probe, `a day header between ${top}px and ${bottom}px`).not.toBeNull();
  return probe as Probe;
}

async function ctrlWheel(page: Page, at: { x: number; y: number }, deltaY: number): Promise<void> {
  await page.mouse.move(at.x, at.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, deltaY);
  await page.keyboard.up('Control');
}

/** The manifest as served on page load; every later request (the 5-minute poll) is a newer one. */
async function newerManifestAfterLoad(page: Page): Promise<void> {
  let requests = 0;
  await page.route(/\/data\/manifest\.json/, async (route) => {
    const res = await route.fetch();
    if (requests++ === 0) return route.fulfill({ response: res });
    const json = (await res.json()) as { version: number; timeline: { v: string } };
    await route.fulfill({ response: res, json: { ...json, version: json.version + 1, timeline: { v: 'feedc0ffee' } } });
  });
}

test.describe('semantic zoom', () => {
  test('ctrl+wheel zooms out and back in around the date under the pointer', async ({ page }) => {
    await page.goto('/de/');
    await ready(page, 'days');
    await page.evaluate(() => window.scrollTo(0, 5200));
    await page.waitForTimeout(150);
    const day = await dayInBand(page, 150, 750);

    // Out: days -> months. The day's tile lands under the pointer.
    await ctrlWheel(page, day, 120);
    await expect(page).toHaveURL(/[?&]z=months/);
    expect(params(page).d).toBe(day.date);
    await ready(page, 'months');
    const tile = await anchorCenter(page, day.date);
    expect(tile).not.toBeNull();
    expect(Math.abs((tile?.y ?? 0) - day.y)).toBeLessThanOrEqual(2);

    // In again over the tile: months -> days, the day header returns under the pointer.
    await ctrlWheel(page, tile as { x: number; y: number }, -120);
    await expect(page).not.toHaveURL(/[?&]z=/);
    expect(params(page).d).toBe(day.date);
    await ready(page, 'days');
    const header = await anchorCenter(page, day.date);
    expect(Math.abs((header?.y ?? 0) - (tile?.y ?? 0))).toBeLessThanOrEqual(2);
  });

  test('keyboard: - and + step, 1-3 pick a level; zooming replaces history', async ({ page }) => {
    await page.goto('/de/');
    await ready(page, 'days');
    const length = await page.evaluate(() => history.length);
    const pill = page.getByRole('group', { name: /Zoom/ });

    await page.keyboard.press('-');
    await expect(page).toHaveURL(/z=months/);
    await expect(pill.getByRole('button', { pressed: true })).toHaveText(/Monate|Months/);
    await ready(page, 'months');
    await page.keyboard.press('-');
    await expect(page).toHaveURL(/z=trips/);
    await ready(page, 'trips');
    await page.keyboard.press('-'); // nothing further out: stays
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(/z=trips/);
    await page.keyboard.press('3');
    await expect(page).not.toHaveURL(/z=/);
    await ready(page, 'days');
    await page.keyboard.press('2');
    await expect(page).toHaveURL(/z=months/);
    await ready(page, 'months');
    await page.keyboard.press('+');
    await expect(page).not.toHaveURL(/z=/);
    await ready(page, 'days');
    expect(await page.evaluate(() => history.length)).toBe(length);
  });

  test('zoom pill switches levels and keeps the focus line date', async ({ page }) => {
    await page.goto('/de/');
    await ready(page, 'days');
    await page.evaluate(() => window.scrollTo(0, 3000));
    await expect.poll(() => params(page).d ?? null).not.toBeNull();
    const focused = params(page).d as string;
    await page.getByRole('button', { name: 'Jahre' }).click();
    await expect(page).toHaveURL(/z=trips/);
    await ready(page, 'trips');
    expect(params(page).d).toBe(focused);
    const card = await anchorCenter(page, focused);
    expect(card).not.toBeNull();
  });

  test('at the end of the list a zoom round trip keeps the focused date (keyboard and pill)', async ({ page }) => {
    await page.goto('/de/');
    await ready(page, 'days');
    // The oldest days: no anchor can reach the focus line here (the list ends).
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(() => params(page).d ?? null).not.toBeNull();
    const date = params(page).d as string;
    for (const [key, level] of [
      ['-', 'months'],
      ['-', 'trips'],
      ['+', 'months'],
      ['3', 'days'],
    ] as const) {
      await page.keyboard.press(key);
      await ready(page, level);
      expect(params(page).d, `after "${key}"`).toBe(date);
      // Our own scroll placement must not be taken for the reader scrolling (debounced sync).
      await page.waitForTimeout(700);
      expect(params(page).d, `after "${key}" + sync`).toBe(date);
      expect(await anchorCenter(page, date)).not.toBeNull();
    }
    await page.getByRole('button', { name: 'Jahre', exact: true }).click();
    await ready(page, 'trips');
    await page.getByRole('button', { name: 'Tage', exact: true }).click();
    await ready(page, 'days');
    await page.waitForTimeout(700);
    expect(params(page).d).toBe(date);
  });

  test('keyboard zoom from a focused month tile anchors on that tile', async ({ page }) => {
    await page.goto('/de/?z=months');
    await ready(page, 'months');
    const tile = page.locator('[data-level="months"] a:has([data-anchor])').nth(9);
    const date = (await tile.locator('[data-anchor]').getAttribute('data-anchor')) as string;
    await tile.focus();
    await page.keyboard.press('-');
    await ready(page, 'trips');
    expect(params(page).d).toBe(date);
    // Focus moved to the card holding that date; zooming back in keeps the date (not the
    // newest date of the card).
    await page.keyboard.press('+');
    await ready(page, 'months');
    expect(params(page).d).toBe(date);
    await expect(page.locator(`[data-level="months"] a:has([data-anchor="${date}"])`)).toBeFocused();
  });

  test('clicking a month tile zooms into that day', async ({ page }) => {
    await page.goto('/de/?z=months');
    await ready(page, 'months');
    const tile = page.locator('[data-level="months"] a:has([data-anchor])').nth(5);
    const date = (await tile.locator('[data-anchor]').getAttribute('data-anchor')) as string;
    const box = await tile.boundingBox();
    await tile.click();
    await expect(page).toHaveURL(new RegExp(`d=${date}`));
    await ready(page, 'days');
    const header = await anchorCenter(page, date);
    expect(Math.abs((header?.y ?? 0) - ((box?.y ?? 0) + (box?.height ?? 0) / 2))).toBeLessThanOrEqual(2);
  });
});

test.describe('touch pinch', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('spreading two fingers on months zooms into days; pinching zooms out', async ({ page }) => {
    await page.goto('/de/?z=months');
    await ready(page, 'months');
    const cdp = await page.context().newCDPSession(page);
    const pinch = async (from: number, to: number) => {
      const cx = 187;
      const cy = 460;
      const steps = 8;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          { x: cx - from, y: cy, id: 1 },
          { x: cx + from, y: cy, id: 2 },
        ],
      });
      for (let i = 1; i <= steps; i++) {
        const d = from + ((to - from) * i) / steps;
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            { x: cx - d, y: cy, id: 1 },
            { x: cx + d, y: cy, id: 2 },
          ],
        });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await pinch(40, 70);
    await expect(page).not.toHaveURL(/z=/);
    await ready(page, 'days');
    await pinch(80, 40);
    await expect(page).toHaveURL(/z=months/);
  });

  test('a small pinch below the threshold settles back without zooming', async ({ page }) => {
    await page.goto('/de/?z=months');
    await ready(page, 'months');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: 140, y: 460, id: 1 },
        { x: 240, y: 460, id: 2 },
      ],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: 133, y: 460, id: 1 },
        { x: 247, y: 460, id: 2 },
      ],
    });
    const scaled = await page.evaluate(() => document.querySelector<HTMLElement>('.zoom-stage')?.style.transform ?? '');
    expect(scaled).toMatch(/scale\(1\.1/);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(400);
    await expect(page).toHaveURL(/z=months/);
    expect(await page.evaluate(() => document.querySelector<HTMLElement>('.zoom-stage')?.style.transform)).toBe('');
  });
});

test.describe('deep links and history', () => {
  test('?z&d deep link restores the focused date at the focus line, also after reload', async ({ page }) => {
    await page.goto('/de/?z=months');
    await ready(page, 'months');
    const date = (await page
      .locator('[data-level="months"] [data-anchor]')
      .nth(40)
      .getAttribute('data-anchor')) as string;
    await page.goto(`/de/?z=months&d=${date}`);
    await ready(page, 'months');
    const first = await anchorCenter(page, date);
    expect(first).not.toBeNull();
    expect(first?.y ?? 0).toBeGreaterThan(100);
    expect(first?.y ?? 0).toBeLessThan(400);
    await page.reload();
    await ready(page, 'months');
    const again = await anchorCenter(page, date);
    expect(Math.abs((again?.y ?? 0) - (first?.y ?? 0))).toBeLessThanOrEqual(2);
    expect(params(page)).toEqual({ z: 'months', d: date });
  });

  test('scrolling replaces ?d= without adding history entries', async ({ page }) => {
    await page.goto('/de/');
    await ready(page, 'days');
    const length = await page.evaluate(() => history.length);
    await page.evaluate(() => window.scrollTo(0, 2500));
    await expect.poll(() => params(page).d ?? null).not.toBeNull();
    const first = params(page).d;
    await page.evaluate(() => window.scrollTo(0, 6000));
    await expect.poll(() => params(page).d).not.toBe(first);
    expect(await page.evaluate(() => history.length)).toBe(length);
  });

  test('opening a day pushes; Back returns to the same timeline position', async ({ page }) => {
    await page.goto('/de/');
    await ready(page, 'days');
    await page.evaluate(() => window.scrollTo(0, 2500));
    await expect.poll(() => params(page).d ?? null).not.toBeNull();
    const before = page.url();
    const scrollY = await page.evaluate(() => window.scrollY);
    const length = await page.evaluate(() => history.length);
    const day = await dayInBand(page, 150, 700);
    await page
      .locator(`[data-row-date="${day.date}"]`)
      .getByRole('link', { name: /Tag ansehen|Watch the day/ })
      .click();
    await expect(page).toHaveURL(new RegExp(`/de/day/${day.date}/`));
    expect(await page.evaluate(() => history.length)).toBe(length + 1);
    // The timeline stays mounted, scroll-locked and inert under the overlay.
    await expect(page.locator('html')).toHaveClass(/omw-scroll-lock/);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
    await page.goBack();
    await expect(page).toHaveURL(before);
    await expect(page.locator('html')).not.toHaveClass(/omw-scroll-lock/);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  });

  test('trip page overlay opens from a trip card and closes with Escape', async ({ page }) => {
    await page.goto('/de/?z=trips');
    await ready(page, 'trips');
    const card = page.locator('[data-level="trips"] a[href*="/trip/"]').first();
    const href = (await card.getAttribute('href')) as string;
    await card.click();
    await expect(page).toHaveURL(new RegExp(`${href.replace(/[/]/g, '\\/')}$`));
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { level: 1 })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/z=trips/);
    await expect(dialog).toHaveCount(0);
  });

  test('closing a day opened at the top keeps the page still and focuses its button again', async ({ page }) => {
    await page.goto('/de/');
    await ready(page, 'days');
    const watch = page
      .locator('[data-row="day"]')
      .first()
      .getByRole('link', { name: /Tag ansehen/ });
    await watch.focus();
    const y = await page.evaluate(() => window.scrollY);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/de\/day\/\d{4}-\d{2}-\d{2}\/$/);
    await expect.poll(() => page.title()).not.toBe('On My Way');
    await page.goBack();
    await expect(page).not.toHaveURL(/\/day\//);
    await expect(watch).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(y);
    await expect.poll(() => page.title()).toBe('On My Way');
  });

  test('closing a trip opened at the top does not jump to a day watched earlier', async ({ page }) => {
    await page.goto('/de/');
    await ready(page, 'days');
    await page.evaluate(() => window.scrollTo(0, 6000));
    await expect.poll(() => params(page).d ?? null).not.toBeNull();
    const day = await dayInBand(page, 150, 700);
    await page
      .locator(`[data-row-date="${day.date}"]`)
      .getByRole('link', { name: /Tag ansehen/ })
      .click();
    await expect(page).toHaveURL(new RegExp(`/de/day/${day.date}/`));
    await page.goBack();
    await expect(page).not.toHaveURL(/\/day\//);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => params(page).d ?? null).toBeNull();
    await page.locator('[data-row="trip-head"] a').first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.waitForTimeout(600);
    expect(params(page).d).toBeUndefined();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('the trip overlay names itself in the title and gives focus back to its card', async ({ page }) => {
    await page.goto('/de/?z=trips');
    await ready(page, 'trips');
    const card = page.locator('[data-level="trips"] a[href*="/trip/"]').first();
    await card.focus();
    await page.keyboard.press('Enter');
    const heading = page.getByRole('dialog').getByRole('heading', { level: 1 });
    await expect(heading).toBeFocused();
    const name = (await heading.textContent()) as string;
    await expect.poll(() => page.title()).toBe(`${name} · On My Way`);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(card).toBeFocused();
    await expect.poll(() => page.title()).toBe('On My Way');
  });

  test('"show in the timeline" from the years view lands on the trip\'s newest day', async ({ page }) => {
    await page.goto('/de/?z=trips');
    await ready(page, 'trips');
    await page.evaluate(() => window.scrollTo(0, 1200));
    await expect.poll(() => params(page).d ?? null).not.toBeNull();
    const card = page.locator('[data-level="trips"] a[href*="/trip/"]').last();
    await card.scrollIntoViewIfNeeded();
    await card.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'In der Zeitleiste zeigen' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).not.toHaveURL(/z=/);
    await ready(page, 'days');
    const date = params(page).d as string;
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The day is placed at the focus line (min(260, max(120, 30 % of 900 px)) = 260).
    await expect.poll(async () => Math.round((await anchorCenter(page, date))?.y ?? -1)).toBe(260);
  });

  test('unknown days and locales show the 404 screen', async ({ page }) => {
    await page.goto('/de/day/1999-01-01/');
    await expect(page.getByRole('heading', { name: 'Hier ist nichts' })).toBeVisible();
    await expect.poll(() => page.title()).toBe('Hier ist nichts · On My Way');
    await page.goto('/xx/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('404')).toBeVisible();
  });
});

test.describe('data states', () => {
  test('no days yet: the empty state instead of a timeline', async ({ page }) => {
    await page.route(/\/data\/timeline\.json/, async (route) => {
      const res = await route.fetch();
      const json = (await res.json()) as Record<string, unknown>;
      await route.fulfill({ response: res, json: { ...json, trips: [], days: [] } });
    });
    await page.goto('/de/');
    await expect(page.getByRole('heading', { name: 'Noch keine Momente' })).toBeVisible();
    await expect(page.locator('[data-level]')).toHaveCount(0);
  });

  test('a failing timeline shows the error screen; "try again" recovers', async ({ page }) => {
    let failures = 0;
    await page.route(/\/data\/timeline\.json/, async (route) => {
      if (failures < 3) {
        failures++;
        await route.fulfill({ status: 503, body: 'down' });
      } else {
        await route.fallback();
      }
    });
    await page.goto('/de/');
    // The first request and two retries fail (5xx is retried with back-off).
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible({ timeout: 15_000 });
    expect(failures).toBe(3);
    await alert.getByRole('button', { name: 'Nochmal versuchen' }).click();
    await ready(page, 'days');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a newer manifest at load is the baseline (older page stamp): no toast', async ({ page }) => {
    // Generated day/story/trip pages carry the release in which their content last changed, so
    // the first manifest may be newer than the boot: that is not news (data/hooks.ts manifestNews).
    await page.clock.install();
    await page.route(/\/data\/manifest\.json/, async (route) => {
      const res = await route.fetch();
      const json = (await res.json()) as { version: number };
      await route.fulfill({ response: res, json: { ...json, version: json.version + 1 } });
    });
    await page.goto('/de/');
    await ready(page, 'days');
    await page.clock.fastForward('05:30'); // one poll with the same (newer) manifest
    await page.waitForTimeout(300);
    await expect(page.getByRole('button', { name: /Neue Momente/ })).toHaveCount(0);
  });

  test('a newer manifest offers "new moments"; accepting loads the new timeline', async ({ page }) => {
    let newest = '';
    await page.clock.install();
    await newerManifestAfterLoad(page);
    // The "new" timeline: the same data without its newest day.
    await page.route(/\/data\/timeline\.json\?v=feedc0ffee/, async (route) => {
      const res = await route.fetch({ url: route.request().url().replace('feedc0ffee', 'original') });
      const json = (await res.json()) as { days: Array<{ date: string }> };
      newest = json.days.at(-1)?.date ?? '';
      await route.fulfill({ response: res, json: { ...json, days: json.days.slice(0, -1) } });
    });
    await page.goto('/de/');
    await ready(page, 'days');
    const firstDay = page.locator('[data-row-date]').first();
    const before = await firstDay.getAttribute('data-row-date');
    const toast = page.getByRole('button', { name: /Neue Momente/ });
    await expect(toast).toHaveCount(0);
    await page.clock.fastForward('05:30'); // the 5-minute manifest poll
    await expect(toast).toBeVisible();
    await toast.click();
    await expect(toast).toHaveCount(0);
    await expect.poll(() => firstDay.getAttribute('data-row-date')).not.toBe(before);
    expect(newest).toBe(before);
  });

  test('accepting "new moments" deep in the timeline shows its top (where they are)', async ({ page }) => {
    await page.clock.install();
    await newerManifestAfterLoad(page);
    await page.route(/\/data\/timeline\.json\?v=feedc0ffee/, async (route) => {
      const res = await route.fetch({ url: route.request().url().replace('feedc0ffee', 'original') });
      await route.fulfill({ response: res, json: await res.json() });
    });
    await page.goto('/de/?z=months');
    await ready(page, 'months');
    await page.evaluate(() => window.scrollTo(0, 6000));
    await expect.poll(() => params(page).d ?? null).not.toBeNull();
    await page.clock.fastForward('05:30'); // the 5-minute manifest poll
    await page.getByRole('button', { name: /Neue Momente/ }).click();
    await expect.poll(() => params(page)).toEqual({ z: 'months' });
    await ready(page, 'months');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    // Not undone by the timeline's own focus sync.
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(params(page)).toEqual({ z: 'months' });
  });
});

test.describe('RTL (pseudo-locale ar)', () => {
  // Production builds serve "ar" only on an RTL test deployment (Manifest.site.locales lists
  // it); dev builds always do. The preview run simulates such a deployment.
  test.beforeEach(async ({ page }) => {
    if (process.env.OMW_E2E_MODE !== 'preview') return;
    await page.route(/\/data\/manifest\.json/, async (route) => {
      const res = await route.fetch();
      const json = (await res.json()) as { site: { locales: string[] } };
      await route.fulfill({
        response: res,
        json: { ...json, site: { ...json.site, locales: [...json.site.locales, 'ar'] } },
      });
    });
  });
  test('mirrors the layout: thread, filmstrip, pill', async ({ page }) => {
    await page.goto('/ar/');
    await ready(page, 'days');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const width = await page.evaluate(() => document.documentElement.clientWidth);
    // No horizontal overflow (a mirrored page must not widen the layout viewport).
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    // The route thread runs along the right (inline-start) edge of the content.
    const thread = await page.locator('[data-row="day"] .thread').first().boundingBox();
    const content = await page.locator('[data-level="days"]').boundingBox();
    expect((thread?.x ?? 0) - (content?.x ?? 0)).toBeGreaterThan((content?.width ?? 0) - 40);
    // The filmstrip starts on the right: its first item is right of the second.
    const strip = page.locator('[data-row="day"] [data-strip]').first();
    await expect(strip.locator('li a').nth(1)).toBeVisible();
    const a = await strip.locator('li').nth(0).boundingBox();
    const b = await strip.locator('li').nth(1).boundingBox();
    expect(a?.x ?? 0).toBeGreaterThan(b?.x ?? 0);
    // Owner text keeps its own (LTR) direction but aligns with the mirrored layout.
    const userText = page.locator('[data-level="days"] [data-user-text]').first();
    await expect(userText).toBeVisible();
    expect(await userText.evaluate((el) => [getComputedStyle(el).direction, getComputedStyle(el).textAlign])).toEqual([
      'ltr',
      'right',
    ]);
    // The pill reads right to left: the first level (years) is on the right.
    const buttons = page.getByRole('group').last().getByRole('button');
    const first = await buttons.nth(0).boundingBox();
    const last = await buttons.nth(2).boundingBox();
    expect(first?.x ?? 0).toBeGreaterThan(last?.x ?? 0);
  });

  test('zoom anchoring works mirrored (month tile column from the right)', async ({ page }) => {
    await page.goto('/ar/?z=months');
    await ready(page, 'months');
    // Tiles of days with content, in different columns: the column is measured from the right.
    for (const n of [3, 10]) {
      const tile = page.locator('[data-level="months"] a [data-anchor]').nth(n);
      const date = (await tile.getAttribute('data-anchor')) as string;
      const box = (await tile.boundingBox()) as { x: number; y: number; width: number; height: number };
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await ctrlWheel(page, at, -120);
      await ready(page, 'days');
      expect(params(page).d).toBe(date);
      const header = await anchorCenter(page, date);
      expect(Math.abs((header?.y ?? 0) - at.y)).toBeLessThanOrEqual(2);
      await ctrlWheel(page, header as { x: number; y: number }, 120);
      await ready(page, 'months');
      expect(params(page).d).toBe(date);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Fixes of the L3 review / wave 2 (site)

interface DayFile {
  date: string;
  entries: Array<{
    id: string;
    kind: string;
    text?: { body: string };
    note?: Record<string, string>;
    story?: Record<string, { title: string }>;
    orig?: string;
  }>;
}

async function timelineData(page: Page) {
  const manifest = (await (await page.request.get('/data/manifest.json')).json()) as { timeline: { v: string } };
  return (await (await page.request.get(`/data/timeline.json?v=${manifest.timeline.v}`)).json()) as {
    days: Array<{ date: string; v: string; trip?: string }>;
    trips: Array<{ slug: string }>;
  };
}

async function dayFile(page: Page, date: string, v: string): Promise<DayFile> {
  return (await (await page.request.get(`/data/days/${date}.json?v=${v}`)).json()) as DayFile;
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** h1 elements a screen reader can reach: rendered, not aria-hidden, not inside an inert subtree. */
async function reachableH1s(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('h1')]
      .filter((h) => !h.closest('[inert],[aria-hidden="true"]') && h.getClientRects().length > 0)
      .map((h) => (h.textContent ?? '').trim()),
  );
}

test.describe('accessible names (L3-10)', () => {
  test('filmstrip links carry their text; the "watch the day" links all differ', async ({ page }) => {
    const tl = await timelineData(page);
    // The newest days with a note and with a text status.
    const files = await Promise.all(tl.days.slice(-12).map((d) => dayFile(page, d.date, d.v)));
    const withNote = files.findLast((f) => f.entries.some((e) => e.kind === 'note'));
    const withText = files.findLast((f) => f.entries.some((e) => e.kind === 'text'));
    expect(withNote && withText).toBeTruthy();
    for (const [file, kind, label] of [
      [withNote, 'note', 'Notiz'],
      [withText, 'text', 'Textstatus'],
    ] as const) {
      if (!file) continue;
      const entry = file.entries.find((e) => e.kind === kind);
      const text = kind === 'note' ? (entry?.note?.de ?? Object.values(entry?.note ?? {})[0]) : entry?.text?.body;
      await page.goto(`/de/?d=${file.date}`);
      await ready(page, 'days');
      const start = collapse(text ?? '').slice(0, 40);
      const link = page
        .locator(`[data-row-date="${file.date}"]`)
        .getByRole('link', { name: new RegExp(`^${label}, \\d\\d:\\d\\d: ${escapeRe(start)}`) });
      await expect(link).toHaveCount(1);
      const name = (await link.getAttribute('aria-label')) ?? '';
      expect(name.length).toBeLessThanOrEqual(`${label}, 00:00: `.length + 120);
    }
    // Every rendered "watch the day" link has its own name (visible words + the day).
    const ctas = page.getByRole('link', { name: /^Tag ansehen/ });
    expect(await ctas.count()).toBeGreaterThan(1);
    const names = await ctas.evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim()));
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^Tag ansehen: \S/);
  });
});

test.describe('one h1 per route (L3-11)', () => {
  test('home, day, story, trip and 404 each expose exactly one h1', async ({ page }) => {
    const tl = await timelineData(page);
    const files = await Promise.all(tl.days.slice(-15).map((d) => dayFile(page, d.date, d.v)));
    const withStory = files.find((f) => f.entries.some((e) => e.kind === 'story')) as DayFile;
    const story = withStory.entries.find((e) => e.kind === 'story');
    const day = tl.days.at(-1)?.date as string;
    const trip = tl.trips[0]?.slug as string;

    await page.goto('/de/');
    await ready(page, 'days');
    expect(await reachableH1s(page)).toEqual(['On My Way']);

    await page.goto(`/de/day/${day}/`);
    await expect(page.getByTestId('player-session')).toBeVisible();
    const dayH1 = await reachableH1s(page);
    expect(dayH1).toHaveLength(1);
    expect(dayH1[0]).toMatch(/^Reisetag: .+/);
    // The dialog is named by it.
    const dialogName = await page
      .getByTestId('journey-player')
      .evaluate((el) => document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent ?? '');
    expect(dialogName).toBe(dayH1[0]);

    await page.goto(`/de/day/${withStory.date}/story/${story?.id}/`);
    await expect(page.getByTestId('story-sheet')).toBeVisible();
    expect(await reachableH1s(page)).toEqual([story?.story?.de?.title ?? Object.values(story?.story ?? {})[0]?.title]);

    await page.goto(`/de/trip/${trip}/`);
    await expect(page.getByRole('dialog')).toBeVisible();
    const tripH1 = await reachableH1s(page);
    expect(tripH1).toHaveLength(1);
    await expect(page.getByRole('dialog').getByRole('heading', { level: 1 })).toHaveText(tripH1[0] as string);

    await page.goto('/de/day/1999-01-01/');
    await expect(page.getByRole('heading', { name: 'Hier ist nichts' })).toBeVisible();
    expect(await reachableH1s(page)).toEqual(['Hier ist nichts']);
  });
});

test.describe('404 screen (L3-21, L3-22)', () => {
  test('keeps the site header: brand, language switch with 44 px targets, theme', async ({ page }) => {
    await page.goto('/en/day/1999-01-01/');
    await expect(page.getByRole('heading', { level: 1, name: 'Nothing here' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'On My Way' })).toHaveAttribute('href', '/en/');
    const languages = page.getByRole('navigation', { name: 'Language' }).getByRole('link');
    await expect(languages.first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Deutsch' })).toHaveAttribute('href', '/de/day/1999-01-01/');
    await expect(page.getByRole('button', { name: /^Theme/ })).toBeVisible();
    // Each language link takes taps across at least 44 px of height (the pill stays smaller).
    for (const link of await languages.all()) {
      const box = (await link.boundingBox()) as { x: number; y: number; width: number; height: number };
      const hit = await page.evaluate(
        ({ x, top, bottom }) =>
          [top, bottom].map((y) => document.elementFromPoint(x, y)?.closest('a')?.getAttribute('hreflang') ?? null),
        { x: box.x + box.width / 2, top: box.y + box.height / 2 - 21.5, bottom: box.y + box.height / 2 + 21.5 },
      );
      const lang = await link.getAttribute('hreflang');
      expect(hit).toEqual([lang, lang]);
    }
  });
});

test.describe('wide screens (L3-07, L3-08)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('zooming out from the top stays at the top with the month heading in view (pill and key)', async ({ page }) => {
    const tl = await timelineData(page);
    const newest = tl.days.at(-1)?.date as string;
    const monthHeading = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
      new Date(`${newest.slice(0, 7)}-01T00:00:00Z`),
    );
    for (const how of ['pill', 'key'] as const) {
      await page.goto('/de/');
      await ready(page, 'days');
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      if (how === 'pill') await page.getByRole('button', { name: 'Monate', exact: true }).click();
      else await page.keyboard.press('-');
      await ready(page, 'months');
      expect(await page.evaluate(() => window.scrollY), how).toBe(0);
      const heading = page.locator('[data-level="months"] h2').filter({ hasText: monthHeading }).first();
      await expect(heading).toBeInViewport();
      await expect(page.getByRole('link', { name: 'On My Way' })).toBeInViewport();
    }
  });

  test('the end of every level stays clear of the zoom pill', async ({ page }) => {
    for (const z of ['days', 'months', 'trips'] as const) {
      await page.goto(z === 'days' ? '/de/' : `/de/?z=${z}`);
      await ready(page, z);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(300);
      const end = page.locator('[data-row="end"] p').last();
      await expect(end).toBeInViewport();
      const pill = await page.getByRole('group', { name: /Zoom/ }).boundingBox();
      const last = await end.boundingBox();
      expect((last?.y ?? 0) + (last?.height ?? 0), z).toBeLessThan(pill?.y ?? 0);
    }
  });
});

test.describe('focus after "show in the timeline" (W2-22)', () => {
  test('lands on the day row, not on <body>', async ({ page }) => {
    await page.goto('/de/?z=trips');
    await ready(page, 'trips');
    const card = page.locator('[data-level="trips"] a[href*="/trip/"]').first();
    await card.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'In der Zeitleiste zeigen' }).click();
    await expect(dialog).toHaveCount(0);
    await ready(page, 'days');
    const date = params(page).d as string;
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.closest('[data-row-date]')?.getAttribute('data-row-date')),
      )
      .toBe(date);
    await expect(page.locator(':focus')).toHaveText(/^Tag ansehen/);
  });
});

test.describe('request deadline (W2-18)', () => {
  test('a timeline request that never answers ends on the error screen, not a spinner forever', async ({ page }) => {
    await page.clock.install();
    await page.route(/\/data\/timeline\.json/, () => {
      // never answered
    });
    const firstAttempt = page.waitForRequest(/\/data\/timeline\.json/);
    await page.goto('/de/', { waitUntil: 'commit' });
    await firstAttempt;
    // 3 attempts of 15 s with 1 s and 2 s back-off in between.
    for (let i = 0; i < 60; i++) await page.clock.runFor(1_000);
    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('button', { name: 'Nochmal versuchen' })).toBeVisible();
  });
});
