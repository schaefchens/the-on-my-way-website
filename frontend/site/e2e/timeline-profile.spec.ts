/**
 * The owner's profile in the home hero (timeline e2e config: Vite dev server, large synthetic data
 * set). The data set has no profile; these tests add one to timeline.json on the fly (its
 * portrait borrows a day cover's small variants), so the same pages run with and without.
 */
import type { AvatarImage, SiteProfile, TimelineIndex } from '@omw/contracts/site';
import { expect, type Page, test } from '@playwright/test';

/** Serves timeline.json with `profile` (built from the timeline itself), or as it is. */
async function serveProfile(page: Page, make: (timeline: TimelineIndex) => SiteProfile): Promise<void> {
  await page.route(/\/data\/timeline\.json/, async (route) => {
    const res = await route.fetch();
    const timeline = (await res.json()) as TimelineIndex;
    await route.fulfill({ response: res, json: { ...timeline, profile: make(timeline) } });
  });
}

/**
 * A portrait from the oldest day's cover. The generator publishes a round crop (square files up
 * to 288 px, contracts AVATAR_MAX_WIDTH); this data set has none, so the cover's smallest file
 * stands in, declared 288 wide, with a focus point (object-position, for portraits that are not
 * pre-cropped).
 */
function portraitFrom(timeline: TimelineIndex): AvatarImage {
  const cover = timeline.days.find((d) => d.cover)?.cover;
  if (!cover) throw new Error('no cover in the data set');
  const smallest = (list: { w: number; src: string }[]) => [{ w: 288, src: list[0]?.src ?? '' }];
  const { og: _og, ...set } = cover;
  return {
    ...set,
    w: 288,
    h: Math.round((cover.h * 288) / cover.w),
    sources: { avif: smallest(cover.sources.avif), webp: smallest(cover.sources.webp) },
    focus: { x: 0.5, y: 0.25 },
  };
}

const LEA = (timeline: TimelineIndex): SiteProfile => ({
  author: 'Lea',
  intro: { de: 'Hallo ihr Lieben! Schön, dass ihr mit mir unterwegs seid.', en: 'Hello, lovely people!' },
  avatar: portraitFrom(timeline),
});

async function ready(page: Page): Promise<void> {
  await page.waitForSelector('[data-level="days"]');
  await page.evaluate(() => document.fonts.ready);
}

test.describe('home hero: who travels', () => {
  test('nothing set: the tagline as before, no portrait, no name', async ({ page }) => {
    await page.goto('/de/');
    await ready(page);
    await expect(page.getByText('Momente von unterwegs')).toBeVisible();
    await expect(page.getByTestId('profile-intro')).toHaveCount(0);
    await expect(page.getByTestId('hero-portrait')).toHaveCount(0);
  });

  test('portrait, name and greeting in the visitor’s language', async ({ page }) => {
    await serveProfile(page, LEA);
    await page.goto('/de/');
    await ready(page);
    const intro = page.getByTestId('profile-intro');
    await expect(intro.getByText('Lea', { exact: true })).toBeVisible();
    const greeting = intro.getByText('Hallo ihr Lieben!', { exact: false });
    await expect(greeting).toHaveAttribute('lang', 'de');
    await expect(greeting).toHaveAttribute('dir', 'auto');
    expect(await greeting.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Playpen Sans');
    expect(await intro.getByText('Lea').evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Fraunces');
    await expect(page.getByText('Momente von unterwegs')).toHaveCount(0);
    await expect(page.getByTestId('hero-portrait').locator('source').first()).toHaveAttribute(
      'sizes',
      '(min-width: 40rem) 96px, 72px',
    );
    const img = page.getByTestId('hero-portrait').locator('img');
    expect(await img.evaluate((el) => getComputedStyle(el).objectPosition)).toBe('50% 25%');
    await page.goto('/en/');
    await ready(page);
    await expect(page.getByTestId('profile-intro').getByText('Hello, lovely people!')).toHaveAttribute('lang', 'en');
  });

  test('the portrait keeps its size while its picture loads (no layout shift)', async ({ page }) => {
    // The portrait's files never arrive: the ring still has its final size.
    let portraitSrc = '';
    await page.route(/\/media\//, async (route) => {
      if (portraitSrc && route.request().url().includes(portraitSrc)) return new Promise<void>(() => {});
      return route.continue();
    });
    await page.route(/\/data\/timeline\.json/, async (route) => {
      const res = await route.fetch();
      const timeline = (await res.json()) as TimelineIndex;
      const profile = LEA(timeline);
      portraitSrc = profile.avatar?.sources.webp[0]?.src.split('_')[0] ?? '';
      await route.fulfill({ response: res, json: { ...timeline, profile } });
    });
    await page.goto('/de/');
    await ready(page);
    const box = await page.getByTestId('hero-portrait').boundingBox();
    expect(box?.width).toBe(96);
    expect(box?.height).toBe(96);
    const chips = page.getByText(/Tage · \d+ (?:Land|Länder)/);
    const before = await chips.boundingBox();
    await page.waitForTimeout(500);
    expect(await chips.boundingBox()).toEqual(before);
  });

  test('a greeting only written in another language keeps its language (and RTL page)', async ({ page }) => {
    await serveProfile(page, (timeline) => ({ ...LEA(timeline), intro: { de: 'Hallo ihr Lieben!' } }));
    await page.goto('/ar/');
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const greeting = page.getByTestId('profile-intro').getByText('Hallo ihr Lieben!');
    await expect(greeting).toHaveAttribute('lang', 'de');
    // RTL: the portrait sits at the inline start, i.e. right of the name.
    const ring = await page.getByTestId('hero-portrait').boundingBox();
    const name = await page.getByTestId('profile-intro').getByText('Lea').boundingBox();
    expect(ring && name && ring.x > name.x).toBe(true);
  });
});
