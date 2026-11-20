/**
 * Journey player e2e (plan C "Journey player", "RTL readiness"), against a production build
 * (playwright.player.config.ts). Data-driven: days are picked from the served data set, so
 * the tests keep working when the dev data changes.
 */
import type { DayDetail, Entry, Manifest, TimelineIndex } from '@omw/contracts/site';
import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';

interface Data {
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
  cached = { timeline, days };
  return cached;
}

const TIMER_KINDS: ReadonlySet<Entry['kind']> = new Set(['photo', 'text', 'note', 'gif']);

/** A day whose first two items are photos/text/notes/GIFs (deterministic taps, timer-driven). */
function timerDay(data: Data, opts: { needsNext?: boolean } = {}): DayDetail {
  const day = data.days.find(
    (d) =>
      d.entries.length >= 2 &&
      d.entries.slice(0, 2).every((e) => TIMER_KINDS.has(e.kind)) &&
      (!opts.needsNext || d.next !== undefined),
  );
  if (!day) throw new Error('No suitable day in the data set');
  return day;
}

function session(page: Page): Locator {
  return page.getByTestId('player-session');
}

async function openDay(page: Page, date: string, locale = 'de'): Promise<Locator> {
  await page.goto(`/${locale}/day/${date}/`);
  const s = session(page);
  await expect(s).toBeVisible();
  return s;
}

async function tapFrame(page: Page, fx: number, fy = 0.5): Promise<void> {
  const box = await page.getByTestId('player-frame').boundingBox();
  if (!box) throw new Error('frame not visible');
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

test.describe('journey player', () => {
  test('opens a day, autoplays and advances on its own', async ({ page, request }) => {
    const data = await loadData(request);
    const day = timerDay(data);
    await page.clock.install();
    const s = await openDay(page, day.date);
    await expect(page.getByRole('dialog').first()).toHaveAttribute('aria-modal', 'true');
    await expect(s).toHaveAttribute('data-status', 'playing');
    await expect(s).toHaveAttribute('data-index', '0');
    await expect(page.getByTestId('player-live')).toContainText(`1 von ${day.entries.length}`);
    // The longest timer item is 12 s.
    await page.clock.fastForward(12_500);
    await expect(s).toHaveAttribute('data-index', '1');
    await expect(page.getByTestId('player-live')).toContainText(`2 von ${day.entries.length}`);
    // Media Session: the day is the "artist", the moment the "title".
    await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title ?? '')).toMatch(/· \d\d:\d\d$/);
    expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe('playing');
  });

  test('pauses while the tab is hidden', async ({ page, request }) => {
    const day = timerDay(await loadData(request));
    const s = await openDay(page, day.date);
    await expect(s).toHaveAttribute('data-status', 'playing');
    const setHidden = (hidden: boolean) =>
      page.evaluate((h) => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => (h ? 'hidden' : 'visible'),
        });
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);
    await setHidden(true);
    await expect(s).toHaveAttribute('data-paused', 'hidden');
    await setHidden(false);
    await expect(s).toHaveAttribute('data-paused', '');
    await expect(s).toHaveAttribute('data-status', 'playing');
  });

  test('pause button, tap zones and progress', async ({ page, request }) => {
    const day = timerDay(await loadData(request));
    const s = await openDay(page, day.date);
    await expect(s).toHaveAttribute('data-status', 'playing');

    const toggle = page.getByTestId('player-toggle');
    await expect(toggle).toHaveAccessibleName('Pausieren');
    await toggle.click();
    await expect(s).toHaveAttribute('data-paused', 'user');
    await expect(s).toHaveAttribute('data-status', 'paused');
    await expect(toggle).toHaveAccessibleName('Abspielen');

    // Paused: the active progress segment does not move.
    const fill = page.getByTestId('player-progress').locator('span > span').first();
    const before = await fill.evaluate((el) => (el as HTMLElement).style.transform);
    await page.waitForTimeout(600);
    expect(await fill.evaluate((el) => (el as HTMLElement).style.transform)).toBe(before);

    await tapFrame(page, 0.85);
    await expect(s).toHaveAttribute('data-index', '1');
    await expect(s).toHaveAttribute('data-paused', 'user'); // a pause survives navigation
    await tapFrame(page, 0.1);
    await expect(s).toHaveAttribute('data-index', '0');

    await toggle.click();
    await expect(s).toHaveAttribute('data-status', 'playing');
  });

  test('keyboard: Space/K, arrows, M and Esc (deep link closes to the timeline at that day)', async ({
    page,
    request,
  }) => {
    const day = timerDay(await loadData(request));
    const s = await openDay(page, day.date);
    await expect(s).toHaveAttribute('data-status', 'playing');
    await page.keyboard.press('k');
    await expect(s).toHaveAttribute('data-paused', 'user');
    await page.keyboard.press('ArrowRight');
    await expect(s).toHaveAttribute('data-index', '1');
    await page.keyboard.press('ArrowLeft');
    await expect(s).toHaveAttribute('data-index', '0');
    await page.keyboard.press('Space');
    await expect(s).toHaveAttribute('data-paused', '');
    await page.keyboard.press('m');
    await expect
      .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('omw.player.v1') ?? '{}').muted))
      .toBe(false);
    await page.keyboard.press('Escape');
    await expect(session(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/de/\\?d=${day.date}$`));
  });

  test('story card opens the sheet, which pauses playback; closing resumes', async ({ page, request }) => {
    const data = await loadData(request);
    const day = data.days.find((d) => d.entries.some((e) => e.kind === 'story'));
    test.skip(!day, 'no story in the data set');
    if (!day) return;
    const storyIndex = day.entries.findIndex((e) => e.kind === 'story');
    const story = day.entries[storyIndex] as Extract<Entry, { kind: 'story' }>;
    const s = await openDay(page, day.date);
    await expect(s).toHaveAttribute('data-status', 'playing');
    for (let i = 0; i < storyIndex; i++) await page.keyboard.press('ArrowRight');
    await expect(s).toHaveAttribute('data-kind', 'story');
    await expect(s).toHaveAttribute('data-status', 'playing');

    await page.getByTestId('player-read-story').click();
    await expect(page).toHaveURL(new RegExp(`/de/day/${day.date}/story/${story.id}/$`));
    const sheet = page.getByTestId('story-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('heading', { level: 1 })).toHaveText(
      (story.story.de ?? story.story[story.orig])?.title ?? '',
    );
    await expect(sheet.getByRole('button', { name: 'Zurück zum Tag' })).toBeVisible();
    await expect(s).toHaveAttribute('data-paused', 'sheet');
    await expect(sheet.locator('.omw-prose')).not.toBeEmpty();

    await page.getByTestId('story-close').click();
    await expect(sheet).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/de/day/${day.date}/$`));
    await expect(s).toHaveAttribute('data-paused', '');
    await expect(s).toHaveAttribute('data-status', 'playing');
  });

  test('day end counts down to the next day; "stay here" cancels', async ({ page, request }) => {
    const data = await loadData(request);
    const day = data.days.find((d) => d.next && d.entries.length > 0);
    test.skip(!day?.next, 'no day with a next day');
    if (!day?.next) return;
    const s = await openDay(page, day.date);
    for (let i = 0; i < day.entries.length; i++) await page.keyboard.press('ArrowRight');
    await expect(s).toHaveAttribute('data-status', 'dayEnd');
    await expect(page.getByTestId('player-next-day')).toBeVisible();
    await page.getByTestId('player-stay').click();
    await page.waitForTimeout(3_500);
    await expect(page).toHaveURL(new RegExp(`/day/${day.date}/$`));

    await page.getByTestId('player-toggle').click(); // pause …
    await page.getByTestId('player-toggle').click(); // … and resume: still cancelled
    await expect(page.getByTestId('player-stay')).toHaveCount(0);
    await page.keyboard.press('ArrowLeft');
    await expect(s).not.toHaveAttribute('data-status', 'dayEnd');
    await page.keyboard.press('ArrowRight');
    await expect(s).toHaveAttribute('data-status', 'dayEnd');
    // A fresh day-end card counts down again (3 s) and replaces the history entry.
    await expect(page).toHaveURL(new RegExp(`/day/${day.next}/$`), { timeout: 6_000 });
    await expect(session(page)).toHaveAttribute('data-index', '0');
  });

  test('swipe up = next day, pull down from the top bar = close; hold pauses', async ({ page, request }) => {
    const day = timerDay(await loadData(request), { needsNext: true });
    const s = await openDay(page, day.date);
    await expect(s).toHaveAttribute('data-status', 'playing');
    const box = await page.getByTestId('player-frame').boundingBox();
    if (!box) throw new Error('frame not visible');
    const cx = box.x + box.width / 2;

    // Hold
    await page.mouse.move(cx, box.y + box.height * 0.5);
    await page.mouse.down();
    await expect(s).toHaveAttribute('data-paused', 'hold');
    await page.waitForTimeout(300);
    await page.mouse.up();
    await expect(s).toHaveAttribute('data-paused', '');
    await expect(s).toHaveAttribute('data-index', '0'); // a hold is not a tap

    // Swipe up
    await page.mouse.move(cx, box.y + box.height * 0.7);
    await page.mouse.down();
    await page.mouse.move(cx, box.y + box.height * 0.3, { steps: 6 });
    await page.mouse.up();
    await expect(page).toHaveURL(new RegExp(`/de/day/${day.next}/$`));

    // Pull down from the top bar
    const s2 = session(page);
    await expect(s2).toBeVisible();
    const box2 = await page.getByTestId('player-frame').boundingBox();
    if (!box2) throw new Error('frame not visible');
    await page.mouse.move(cx, box2.y + 40);
    await page.mouse.down();
    await page.mouse.move(cx, box2.y + 340, { steps: 6 });
    await page.mouse.up();
    await expect(session(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/de/\\?d=${day.next}$`));
  });

  test('RTL (pseudo-ar): tap zones, arrows and progress are mirrored', async ({ page, request }) => {
    const day = timerDay(await loadData(request));
    const s = await openDay(page, day.date, 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await page.keyboard.press('k');
    await expect(s).toHaveAttribute('data-paused', 'user');

    await tapFrame(page, 0.1); // left = end of the reading direction = forward
    await expect(s).toHaveAttribute('data-index', '1');
    await tapFrame(page, 0.9); // right 30 % = back
    await expect(s).toHaveAttribute('data-index', '0');
    await page.keyboard.press('ArrowLeft');
    await expect(s).toHaveAttribute('data-index', '1');
    await page.keyboard.press('ArrowRight');
    await expect(s).toHaveAttribute('data-index', '0');

    const segments = page.getByTestId('player-progress').locator(':scope > span');
    const first = await segments.nth(0).boundingBox();
    const second = await segments.nth(1).boundingBox();
    expect(first && second && first.x > second.x).toBe(true);
    const origin = await segments
      .nth(0)
      .locator('span')
      .first()
      .evaluate((el) => getComputedStyle(el).transformOrigin);
    const width = (await segments.nth(0).boundingBox())?.width ?? 0;
    // transform-origin at the right edge (inline start in RTL), within sub-pixel rounding.
    expect(Math.abs(Number.parseFloat(origin) - width)).toBeLessThan(2);
  });

  test('focus stays in the dialog; the live region announces the moment', async ({ page, request }) => {
    const day = timerDay(await loadData(request));
    await openDay(page, day.date);
    await expect(page.getByTestId('player-live')).toHaveText(
      new RegExp(`^.+ 1 von ${day.entries.length}, \\d\\d:\\d\\d$`),
    );
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="journey-player"]'))).toBe(true);
    }
  });

  test('video plays muted with its real duration; tap for sound unmutes', async ({ page, request }) => {
    const data = await loadData(request);
    const day = data.days.find((d) => d.entries.some((e) => e.kind === 'video' && e.video.hasAudio));
    test.skip(!day, 'no video with audio in the data set');
    if (!day) return;
    const index = day.entries.findIndex((e) => e.kind === 'video' && e.video.hasAudio);
    const s = await openDay(page, day.date);
    for (let i = 0; i < index; i++) await page.keyboard.press('ArrowRight');
    await expect(s).toHaveAttribute('data-kind', 'video');
    await expect(s).toHaveAttribute('data-status', 'playing', { timeout: 10_000 });
    const video = page.locator('video[data-active="true"]');
    await expect
      .poll(() => video.evaluate((v) => (v as HTMLVideoElement).currentTime), { timeout: 5_000 })
      .toBeGreaterThan(0.2);
    expect(await video.evaluate((v) => (v as HTMLVideoElement).muted)).toBe(true);
    await expect(page.locator('video')).toHaveCount(2); // the pool never grows

    const mute = page.getByTestId('player-mute');
    await expect(mute).toHaveText('Tippen für Ton');
    await mute.click();
    await expect(mute).toHaveText('Ton an');
    expect(await video.evaluate((v) => (v as HTMLVideoElement).muted)).toBe(false);
  });

  test('a voice note never plays silently: held at 0:00 until "listen" unmutes and plays it', async ({
    page,
    request,
  }) => {
    const data = await loadData(request);
    const day = data.days.find((d) => d.entries.some((e) => e.kind === 'voice'));
    test.skip(!day, 'no voice note in the data set');
    if (!day) return;
    const voice = day.entries.find((e) => e.kind === 'voice') as Extract<Entry, { kind: 'voice' }>;
    // Default prefs (muted): the deep link starts on the voice note.
    await page.goto(`/de/day/${day.date}/#${voice.id}`);
    const s = session(page);
    await expect(s).toHaveAttribute('data-kind', 'voice');
    await expect(s).toHaveAttribute('data-paused', 'needsSound');
    await expect(s).toHaveAttribute('data-status', 'ready');
    const listen = page.getByRole('button', { name: 'Sprachnachricht anhören' });
    await expect(listen).toBeVisible();
    // The small "tap for sound" pill makes way for the big button.
    await expect(page.getByTestId('player-mute')).toHaveCount(0);
    const clock = page.getByTestId('voice-time');
    await expect(clock).toHaveText('0:00');
    await page.waitForTimeout(1_500);
    await expect(clock).toHaveText('0:00');
    await expect(s).toHaveAttribute('data-index', String(day.entries.indexOf(voice)));
    const box = await listen.boundingBox();
    expect(box && box.height >= 44).toBe(true);

    await listen.click();
    await expect(s).toHaveAttribute('data-status', 'playing');
    await expect(s).toHaveAttribute('data-paused', '');
    expect(await page.locator('audio').evaluate((a) => (a as HTMLAudioElement).muted)).toBe(false);
    // It plays (the clock runs with the audio) and the choice is remembered.
    await expect(clock).not.toHaveText('0:00', { timeout: 4_000 });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('omw.player.v1') ?? '{}').muted)).toBe(false);
  });

  test('a tap anywhere on a held voice note plays it too', async ({ page, request }) => {
    const data = await loadData(request);
    const day = data.days.find((d) => d.entries.some((e) => e.kind === 'voice'));
    test.skip(!day, 'no voice note in the data set');
    if (!day) return;
    const voice = day.entries.find((e) => e.kind === 'voice') as Extract<Entry, { kind: 'voice' }>;
    await page.goto(`/de/day/${day.date}/#${voice.id}`);
    const s = session(page);
    await expect(s).toHaveAttribute('data-paused', 'needsSound');
    await tapFrame(page, 0.85, 0.8); // the "forward" zone: on a held voice note it means "listen"
    await expect(s).toHaveAttribute('data-status', 'playing');
    await expect(s).toHaveAttribute('data-index', String(day.entries.indexOf(voice)));
  });

  test('opening from the timeline and closing goes back in history', async ({ page }) => {
    await page.goto('/de/');
    const link = page.locator('a[href*="/de/day/"]:not([href*="#"])').first();
    await expect(link).toBeVisible();
    await link.click();
    await expect(session(page)).toBeVisible();
    await page.getByTestId('player-close').click();
    await expect(session(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/de\/(\?.*)?$/);
    // Closing went back in history: forward re-opens the player.
    await page.goForward();
    await expect(session(page)).toBeVisible();
  });

  test('a moment that cannot be loaded shows an error and is skipped after 3 s', async ({ page, request }) => {
    const data = await loadData(request);
    const day = data.days.find((d) => d.entries.length >= 2 && d.entries[0]?.kind === 'photo');
    test.skip(!day, 'no day starting with a photo');
    if (!day) return;
    const photo = day.entries[0] as Extract<Entry, { kind: 'photo' }>;
    const urls = new Set([...photo.image.sources.avif, ...photo.image.sources.webp].map((src) => `/${src.src}`));
    await page.route('**/media/**', (route) =>
      urls.has(new URL(route.request().url()).pathname) ? route.abort() : route.continue(),
    );
    const s = await openDay(page, day.date);
    await expect(s).toHaveAttribute('data-status', 'error');
    await expect(page.getByRole('alert')).toContainText('konnte nicht geladen werden');
    await expect(s).toHaveAttribute('data-index', '0');
    await expect(s).toHaveAttribute('data-index', '1', { timeout: 5_000 });
  });

  test('focus returns to the opener: "Read the story" after the sheet, the timeline link after the player', async ({
    page,
    request,
  }) => {
    const data = await loadData(request);
    const day = data.days.find((d) => d.entries.some((e) => e.kind === 'story'));
    test.skip(!day, 'no story in the data set');
    if (!day) return;
    await page.goto(`/de/?d=${day.date}`);
    const link = page.locator(`a[href="/de/day/${day.date}/"]`).first();
    await link.focus();
    await page.keyboard.press('Enter');
    const s = session(page);
    await expect(s).toBeVisible();
    await page.keyboard.press('k');
    const storyIndex = day.entries.findIndex((e) => e.kind === 'story');
    for (let i = 0; i < storyIndex; i++) await page.keyboard.press('ArrowRight');
    const cta = page.getByTestId('player-read-story');
    await cta.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('story-sheet')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('story-sheet')).toHaveCount(0);
    await expect(cta).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(s).toHaveCount(0);
    await expect(link).toBeFocused();
  });

  test('after moving to another day, closing focuses that day in the timeline', async ({ page, request }) => {
    const day = timerDay(await loadData(request), { needsNext: true });
    await page.goto(`/de/?d=${day.date}`);
    await page.locator(`a[href="/de/day/${day.date}/"]`).first().focus();
    await page.keyboard.press('Enter');
    await expect(session(page)).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(page).toHaveURL(new RegExp(`/de/day/${day.next}/$`));
    await page.keyboard.press('Escape');
    await expect(session(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/de/\\?d=${day.next}$`));
    await expect(page.locator(':focus')).toHaveAttribute('href', `/de/day/${day.next}/`);
  });

  test('a held key does not repeat: holding Space pauses once', async ({ page, request }) => {
    const day = timerDay(await loadData(request));
    const s = await openDay(page, day.date);
    await expect(s).toHaveAttribute('data-status', 'playing');
    // The 2nd keydown is an auto-repeat (KeyboardEvent.repeat); toggling twice would play again.
    await page.keyboard.down(' ');
    await page.keyboard.down(' ');
    await page.keyboard.up(' ');
    await expect(s).toHaveAttribute('data-paused', 'user');
    await page.keyboard.down('ArrowRight');
    await page.keyboard.down('ArrowRight');
    await page.keyboard.up('ArrowRight');
    await expect(s).toHaveAttribute('data-index', '1');
  });

  test('a day with many moments gets one continuous progress bar inside the frame', async ({ page, request }) => {
    const day = timerDay(await loadData(request));
    const count = 45;
    const entries = Array.from({ length: count }, (_, i) => {
      const e = day.entries[i % day.entries.length] as Entry;
      return { ...e, id: `${e.id.slice(0, 2)}${String(i).padStart(12, '0')}` };
    });
    await page.route(`**/data/days/${day.date}.json*`, (route) => route.fulfill({ json: { ...day, entries } }));
    await page.goto(`/de/?d=${day.date}`);
    await page.locator(`a[href="/de/day/${day.date}/"]`).first().click();
    const s = session(page);
    await expect(s).toHaveAttribute('data-count', String(count));
    await page.keyboard.press('k');
    const bar = page.getByTestId('player-progress');
    await expect(bar).toHaveAttribute('data-mode', 'continuous');
    const frame = await page.getByTestId('player-frame').boundingBox();
    const box = await bar.boundingBox();
    expect(frame && box && box.x >= frame.x && box.x + box.width <= frame.x + frame.width).toBe(true);
    for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowRight');
    await expect(s).toHaveAttribute('data-index', '9');
    // Paused at the start of moment 10 of 45.
    await expect(bar.locator('span > span')).toHaveAttribute('style', /scaleX\(0\.20*\)/);
  });

  test('a moment link (#entry id) starts the player at that moment', async ({ page, request }) => {
    const data = await loadData(request);
    const day = data.days.find((d) => d.entries.length >= 3);
    test.skip(!day, 'no day with three moments');
    if (!day) return;
    const target = day.entries[2] as Entry;
    await page.goto(`/de/day/${day.date}/#${target.id}`);
    await expect(session(page)).toHaveAttribute('data-index', '2');
    await expect(session(page)).toHaveAttribute('data-kind', target.kind);
  });
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('no autoplay and no Ken Burns until the visitor presses play', async ({ page, request }) => {
    const data = await loadData(request);
    const day = data.days.find((d) => d.entries[0]?.kind === 'photo');
    test.skip(!day, 'no day starting with a photo');
    if (!day) return;
    const s = await openDay(page, day.date);
    await expect(s).toHaveAttribute('data-status', 'ready');
    await expect(s).toHaveAttribute('data-paused', 'user');
    await expect(page.getByTestId('player-toggle')).toHaveAccessibleName('Abspielen');
    // A big, labelled start button in the middle (with a hint how to go on), not just the
    // small icon in the top bar (L3-20).
    const start = page.getByTestId('player-center-play');
    await expect(start).toBeVisible();
    await expect(start).toHaveAccessibleName('Tag abspielen');
    await expect(page.getByText('Dann rechts tippen, um weiterzugehen')).toBeVisible();
    const box = await start.boundingBox();
    expect(box && box.height >= 44 && box.width >= 44).toBe(true);
    await page.keyboard.press('Shift'); // keyboard modality: focus rings show
    await start.focus();
    await expect(start).toBeFocused();
    expect(await start.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
    await start.click();
    await expect(s).toHaveAttribute('data-status', 'playing');
    await expect(start).toHaveCount(0);
    await page.waitForTimeout(800);
    expect(
      await page
        .getByTestId('kenburns')
        .first()
        .evaluate((el) => (el as HTMLElement).style.transform),
    ).toBe('');
  });
});

test.describe('wide screens', () => {
  test('side rails: moment buttons and the next-day preview', async ({ page, request }, info) => {
    test.skip(info.project.name !== 'desktop', 'desktop layout only');
    const day = timerDay(await loadData(request), { needsNext: true });
    const s = await openDay(page, day.date);
    await page.keyboard.press('k');
    await page.getByRole('button', { name: 'Nächster Moment' }).click();
    await expect(s).toHaveAttribute('data-index', '1');
    await page.getByRole('button', { name: 'Vorheriger Moment' }).click();
    await expect(s).toHaveAttribute('data-index', '0');
    await page.getByRole('button', { name: /^Nächster Tag: / }).click();
    await expect(page).toHaveURL(new RegExp(`/de/day/${day.next}/$`));
  });
});
