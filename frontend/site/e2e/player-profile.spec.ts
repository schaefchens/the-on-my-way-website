/**
 * The owner's profile in the journey player (playwright.player.config.ts, production build; the
 * dev data set has the fixtures' demo profile: "Lea", a greeting, the Hà Nội photo as portrait).
 * - The avatar ring shows the portrait, from the page's Boot JSON already while timeline.json is
 *   still on its way (no swap from the day's picture to the portrait).
 * - The day-end card signs off with the name.
 * - Without a profile the ring shows the day's first picture and the card has no sign-off.
 */
import type { DayDetail, Manifest, TimelineIndex } from '@omw/contracts/site';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

interface Data {
  timeline: TimelineIndex;
  days: DayDetail[];
}

async function loadData(request: APIRequestContext): Promise<Data> {
  const manifest = (await (await request.get('/data/manifest.json')).json()) as Manifest;
  const timeline = (await (await request.get(`/data/timeline.json?v=${manifest.timeline.v}`)).json()) as TimelineIndex;
  const days = await Promise.all(
    timeline.days.map(
      async (d) => (await (await request.get(`/data/days/${d.date}.json?v=${d.v}`)).json()) as DayDetail,
    ),
  );
  return { timeline, days };
}

/** The <img> inside the player's avatar ring. */
const avatarImg = (page: Page) => page.getByTestId('player-session').locator('span.size-10 img').first();

/** Serves the page with its Boot JSON stripped of the profile, and timeline.json without one. */
async function withoutProfile(page: Page): Promise<void> {
  await page.route(/\/day\/[^/]+\/$/, async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(
      /(<script id="omw-boot" type="application\/json">)([\s\S]*?)(<\/script>)/,
      (_m, open: string, json: string, close: string) => {
        const boot = JSON.parse(json) as Record<string, unknown>;
        delete boot.profile;
        return open + JSON.stringify(boot).replace(/</g, '\\u003c') + close;
      },
    );
    await route.fulfill({ response: res, body });
  });
  await page.route(/\/data\/timeline\.json/, async (route) => {
    const res = await route.fetch();
    const { profile: _p, ...rest } = (await res.json()) as TimelineIndex;
    await route.fulfill({ response: res, json: rest });
  });
}

test.describe('profile in the journey player', () => {
  test('the avatar ring shows the portrait at once, even before the timeline arrives', async ({ page, request }) => {
    const data = await loadData(request);
    const portrait = data.timeline.profile?.avatar;
    test.skip(!portrait, 'the dev data set has no portrait');
    if (!portrait) return;
    const day = data.days.find((d) => d.entries.length > 0) as DayDetail;
    // The timeline never arrives: only the Boot JSON can name the portrait.
    await page.route(/\/data\/timeline\.json/, () => new Promise<void>(() => {}));
    await page.goto(`/de/day/${day.date}/`);
    await expect(page.getByTestId('player-session')).toBeVisible();
    const img = avatarImg(page);
    await expect(page.getByTestId('player-session').locator('span.size-10 source').first()).toHaveAttribute(
      'sizes',
      '40px',
    );
    const src = await img.evaluate((el) => (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src);
    expect(src).toContain(portrait.sources.webp[0]?.src.split('_')[0] ?? '-');
    if (portrait.focus) {
      const pos = await img.evaluate((el) => getComputedStyle(el).objectPosition);
      expect(pos).toBe(`${portrait.focus.x * 100}% ${portrait.focus.y * 100}%`);
    }
  });

  test('the day-end card signs off with the name', async ({ page, request }) => {
    const data = await loadData(request);
    const author = data.timeline.profile?.author;
    test.skip(!author, 'the dev data set has no author');
    const day = data.days.find((d) => d.entries.length > 0 && d.next) as DayDetail;
    await page.goto(`/de/day/${day.date}/`);
    const s = page.getByTestId('player-session');
    await expect(s).toBeVisible();
    for (let i = 0; i < day.entries.length; i++) await page.keyboard.press('ArrowRight');
    await expect(s).toHaveAttribute('data-status', 'dayEnd');
    await page.getByTestId('player-stay').click();
    const signOff = page.getByTestId('day-end-signoff');
    await expect(signOff).toContainText('Schön, dass du mitreist!');
    await expect(signOff).toContainText(`— ${author}`);
  });

  test('without a profile: the day’s picture in the ring, no sign-off', async ({ page, request }) => {
    const data = await loadData(request);
    const day = data.days.find((d) => d.entries.length > 0 && d.entries.some((e) => e.kind === 'photo')) as DayDetail;
    const first = day.entries.find((e) => e.kind === 'photo' || e.kind === 'video' || e.kind === 'gif');
    const firstSrc =
      first?.kind === 'photo' ? first.image.sources.webp[0]?.src : first ? first.video.poster.sources.webp[0]?.src : '';
    await withoutProfile(page);
    await page.goto(`/de/day/${day.date}/`);
    const s = page.getByTestId('player-session');
    await expect(s).toBeVisible();
    const src = await avatarImg(page).evaluate(
      (el) => (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src,
    );
    expect(src).toContain(firstSrc?.split('_')[0] ?? '-');
    for (let i = 0; i < day.entries.length; i++) await page.keyboard.press('ArrowRight');
    await expect(s).toHaveAttribute('data-status', 'dayEnd');
    await expect(page.getByText('Ende des Tages', { exact: true })).toBeVisible();
    await expect(page.getByTestId('day-end-signoff')).toHaveCount(0);
  });
});
