/**
 * Journey player e2e (plan C "Journey player", "RTL readiness"), against a production build
 * (playwright.player.config.ts). Data-driven: days are picked from the served data set, so
 * the tests keep working when the dev data changes.
 */
import type { DayDetail, Entry, Manifest, TimelineIndex } from '@omw/contracts/site';
import { type APIRequestContext, type CDPSession, expect, type Locator, type Page, test } from '@playwright/test';

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

interface Point {
  x: number;
  y: number;
}

/**
 * A real touch drag (Chromium's CDP touch input, so touch-action, pointer events and native
 * scrolling behave like on a phone). `hold` keeps the finger down at the end until it resolves,
 * so the drag feedback can be inspected mid-gesture.
 */
async function touchDrag(
  page: Page,
  from: Point,
  to: Point,
  opts: { steps?: number; stepMs?: number; hold?: () => Promise<void> } = {},
): Promise<void> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const steps = opts.steps ?? 8;
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', at?: Point) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: at ? [{ x: at.x, y: at.y }] : [] });
  try {
    await touch('touchStart', from);
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', {
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      });
      if (opts.stepMs) await page.waitForTimeout(opts.stepMs);
    }
    if (opts.hold) await opts.hold();
    await touch('touchEnd');
  } finally {
    await cdp.detach();
  }
}

/**
 * A real two-finger pinch (CDP touch input): `first` goes down, then `second`; both move apart
 * along the line between them by `spread` px each (negative: towards each other), then `first`
 * lifts, then `second`.
 */
async function pinch(page: Page, first: Point, second: Point, spread: number): Promise<void> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const len = Math.hypot(second.x - first.x, second.y - first.y) || 1;
  const ux = (first.x - second.x) / len;
  const uy = (first.y - second.y) / len;
  const at = (p: Point, sign: number, f: number) => ({
    x: p.x + sign * ux * spread * f,
    y: p.y + sign * uy * spread * f,
  });
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: (Point & { id: number })[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  try {
    await send('touchStart', [{ ...first, id: 1 }]);
    await send('touchStart', [
      { ...first, id: 1 },
      { ...second, id: 2 },
    ]);
    for (let i = 1; i <= 10; i++) {
      await send('touchMove', [
        { ...at(first, 1, i / 10), id: 1 },
        { ...at(second, -1, i / 10), id: 2 },
      ]);
      await page.waitForTimeout(16);
    }
    await send('touchEnd', [{ ...at(second, -1, 1), id: 2 }]);
    await send('touchEnd', []);
  } finally {
    await cdp.detach();
  }
}

async function frameBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.getByTestId('player-frame').boundingBox();
  if (!box) throw new Error('frame not visible');
  return box;
}

/** A point on the player frame, as fractions of its size. */
async function framePoint(page: Page, fx: number, fy: number): Promise<Point> {
  const box = await frameBox(page);
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

const inlineStyle = (page: Page, testId: string, prop: 'transform' | 'opacity') =>
  page.getByTestId(testId).evaluate((el, p) => (el as HTMLElement).style[p], prop);

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

  test('swipe up = next day, pull down mid-screen = close; hold pauses', async ({ page, request }) => {
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

    // Pull down from the middle of the stage (not just the top bar)
    const s2 = session(page);
    await expect(s2).toBeVisible();
    const box2 = await page.getByTestId('player-frame').boundingBox();
    if (!box2) throw new Error('frame not visible');
    await page.mouse.move(cx, box2.y + box2.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(cx, box2.y + box2.height * 0.4 + 300, { steps: 6 });
    await page.mouse.up();
    await expect(session(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/de/\\?d=${day.next}$`));
  });

  test('a click that slips a little down never closes; a real flick down does', async ({ page, request }) => {
    const day = timerDay(await loadData(request));
    const s = await openDay(page, day.date);
    await expect(s).toHaveAttribute('data-status', 'playing');
    await page.keyboard.press('k');
    await expect(s).toHaveAttribute('data-paused', 'user');
    const box = await frameBox(page);
    const at = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.5 };
    // 22 px down in one quick step (a tap that slides): stays, same moment.
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x, at.y + 22);
    await page.mouse.up();
    await page.waitForTimeout(500);
    await expect(s).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/de/day/${day.date}/$`));
    await expect(s).toHaveAttribute('data-index', '0');
    // A short but deliberate flick (70 px, fast, still moving at release) closes.
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x, at.y + 35);
    await page.mouse.move(at.x, at.y + 70);
    await page.mouse.up();
    await expect(session(page)).toHaveCount(0);
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

test.describe('touch', () => {
  test.use({ hasTouch: true });

  /** A day with a previous day (its first moment is timer-driven, so a back tap is a back tap). */
  function dayWithPrev(data: Data): { day: DayDetail; prev: DayDetail } {
    for (const day of data.days) {
      const prev = day.prev ? data.days.find((d) => d.date === day.prev) : undefined;
      const first = day.entries[0];
      if (prev && prev.entries.length >= 2 && first && TIMER_KINDS.has(first.kind)) return { day, prev };
    }
    throw new Error('No day with a previous day in the data set');
  }

  test('swipe down mid-screen lifts the stage and closes the player; a short pull snaps back', async ({
    page,
    request,
  }) => {
    const day = timerDay(await loadData(request));
    await page.goto(`/de/?d=${day.date}`);
    await page.locator(`a[href="/de/day/${day.date}/"]`).first().click();
    const s = session(page);
    await expect(s).toHaveAttribute('data-status', 'playing');
    await page.keyboard.press('k'); // paused: the moment cannot move on by itself meanwhile
    await expect(s).toHaveAttribute('data-status', 'paused');

    // A short, slow pull follows the finger, then snaps back: the player stays.
    const mid = await framePoint(page, 0.5, 0.45);
    await touchDrag(page, mid, { x: mid.x, y: mid.y + 60 }, { steps: 5, stepMs: 60 });
    await expect.poll(() => inlineStyle(page, 'player-frame', 'transform')).toBe('');
    await expect(s).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/de/day/${day.date}/$`));
    await expect(s).toHaveAttribute('data-index', '0');

    // A real pull: mid-gesture the stage is lifted (under the finger, smaller) and the backdrop
    // fades. (Pointer moves are frame-aligned: wait for the last one.)
    let backdrop = '';
    await touchDrag(
      page,
      mid,
      { x: mid.x, y: mid.y + 260 },
      {
        hold: async () => {
          await expect
            .poll(() => inlineStyle(page, 'player-frame', 'transform'))
            .toMatch(/^translate3d\(0px, 2(59|60)(\.\d)?px, 0px\) scale\(0\.\d+\)$/);
          backdrop = await page
            .getByTestId('journey-player')
            .locator(':scope > [data-lift-fade]')
            .evaluate((el) => (el as HTMLElement).style.opacity);
        },
      },
    );
    expect(Number(backdrop)).toBeGreaterThan(0);
    expect(Number(backdrop)).toBeLessThan(1);
    await expect(session(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/de/(\\?d=${day.date})?$`));
    // It went back in history to the timeline it was opened from.
    await page.goForward();
    await expect(session(page)).toBeVisible();
  });

  test('swipe up goes to the next day; sideways swipes move between moments', async ({ page, request }) => {
    const day = timerDay(await loadData(request), { needsNext: true });
    const s = await openDay(page, day.date);
    await expect(s).toHaveAttribute('data-status', 'playing');
    await page.keyboard.press('k');
    await expect(s).toHaveAttribute('data-paused', 'user');
    const right = await framePoint(page, 0.8, 0.5);
    const left = await framePoint(page, 0.2, 0.5);
    await touchDrag(page, right, left);
    await expect(s).toHaveAttribute('data-index', '1');
    await touchDrag(page, left, right);
    await expect(s).toHaveAttribute('data-index', '0');

    await touchDrag(page, await framePoint(page, 0.5, 0.75), await framePoint(page, 0.5, 0.3));
    await expect(page).toHaveURL(new RegExp(`/de/day/${day.next}/$`));
    await expect(session(page)).toHaveAttribute('data-index', '0');
    await expect.poll(() => inlineStyle(page, 'player-frame', 'transform')).toBe('');
  });

  test('two fingers (a pinch) neither close the player nor change the day or the moment', async ({ page, request }) => {
    const day = timerDay(await loadData(request), { needsNext: true });
    const s = await openDay(page, day.date);
    await expect(s).toHaveAttribute('data-status', 'playing');
    await page.keyboard.press('k');
    await expect(s).toHaveAttribute('data-paused', 'user');
    const upper = await framePoint(page, 0.48, 0.42);
    const lower = await framePoint(page, 0.52, 0.58);
    // Pinch out, first with the lower finger down first (it moves down: once "close"), then
    // with the upper one first (it moves up: once "next day"). Pinch in, too.
    for (const [first, second, spread] of [
      [lower, upper, 130],
      [upper, lower, 130],
      [lower, upper, -50],
    ] as const) {
      await pinch(page, first, second, spread);
      await page.waitForTimeout(400);
      await expect(session(page)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/de/day/${day.date}/$`));
      await expect(s).toHaveAttribute('data-index', '0');
      await expect.poll(() => inlineStyle(page, 'player-frame', 'transform')).toBe('');
    }
    // A one-finger swipe right after still works.
    await touchDrag(page, await framePoint(page, 0.8, 0.5), await framePoint(page, 0.2, 0.5));
    await expect(s).toHaveAttribute('data-index', '1');
  });

  test("back on a day's first moment goes to the previous day's last moment", async ({ page, request }) => {
    const data = await loadData(request);
    const { day, prev } = dayWithPrev(data);
    const s = await openDay(page, day.date);
    await expect(s).toHaveAttribute('data-index', '0');
    // In the back zone, clear of the (invisible) edge buttons of narrow screens.
    const back = await framePoint(page, 0.12, 0.68);
    await page.touchscreen.tap(back.x, back.y);
    await expect(page).toHaveURL(new RegExp(`/de/day/${prev.date}/$`));
    const p = session(page);
    await expect(p).toHaveAttribute('data-count', String(prev.entries.length));
    await expect(p).toHaveAttribute('data-index', String(prev.entries.length - 1));
    // Going on backwards stays continuous.
    await page.keyboard.press('ArrowLeft');
    await expect(p).toHaveAttribute('data-index', String(prev.entries.length - 2));

    // The keys still change days (to the day's start).
    await page.keyboard.press('PageDown');
    await expect(page).toHaveURL(new RegExp(`/de/day/${day.date}/$`));
    await expect(session(page)).toHaveAttribute('data-index', '0');
    await page.keyboard.press('PageUp');
    await expect(page).toHaveURL(new RegExp(`/de/day/${prev.date}/$`));
    await expect(session(page)).toHaveAttribute('data-index', '0');
  });

  test('back on the very first day restarts its first moment', async ({ page, request }) => {
    const data = await loadData(request);
    const first = data.days.find((d) => !d.prev && d.entries[0] && TIMER_KINDS.has(d.entries[0].kind));
    test.skip(!first, 'no first day starting with a timer moment');
    if (!first) return;
    const s = await openDay(page, first.date);
    await expect(s).toHaveAttribute('data-index', '0');
    const back = await framePoint(page, 0.12, 0.68);
    await page.touchscreen.tap(back.x, back.y);
    await page.waitForTimeout(300);
    await expect(page).toHaveURL(new RegExp(`/de/day/${first.date}/$`));
    await expect(s).toHaveAttribute('data-index', '0');
  });

  test('story sheet: scrolling its long text and pulling it down close only the sheet', async ({ page, request }) => {
    const data = await loadData(request);
    const day = data.days.find((d) => d.entries.some((e) => e.kind === 'story'));
    test.skip(!day, 'no story in the data set');
    if (!day) return;
    const storyIndex = day.entries.findIndex((e) => e.kind === 'story');
    // A long story, so its text really scrolls on every screen.
    const entries = day.entries.map((e) =>
      e.kind === 'story'
        ? {
            ...e,
            story: Object.fromEntries(
              Object.entries(e.story).map(([l, c]) => [l, c && { ...c, body: Array(12).fill(c.body).join('\n\n') }]),
            ),
          }
        : e,
    );
    await page.route(`**/data/days/${day.date}.json*`, (route) => route.fulfill({ json: { ...day, entries } }));
    await page.goto(`/de/?d=${day.date}`);
    await page.locator(`a[href="/de/day/${day.date}/"]`).first().click();
    const s = session(page);
    await expect(s).toBeVisible();
    await page.keyboard.press('k');
    for (let i = 0; i < storyIndex; i++) await page.keyboard.press('ArrowRight');
    await expect(s).toHaveAttribute('data-kind', 'story');
    await page.getByTestId('player-read-story').click();
    const sheet = page.getByTestId('story-sheet');
    await expect(sheet).toBeVisible();
    await expect(s).toHaveAttribute('data-paused', /sheet/);
    // Let the sheet's slide-in settle before measuring.
    await expect.poll(async () => (await sheet.boundingBox())?.y).toBeLessThan(200);
    const storyUrl = page.url();

    // Vertical scrolling in the story's text, both ways: nothing closes.
    const scroller = sheet.locator('.overflow-y-auto').first();
    expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight * 1.5)).toBe(true);
    const sheetBox = await sheet.boundingBox();
    if (!sheetBox) throw new Error('sheet not visible');
    const viewport = page.viewportSize() ?? { width: 400, height: 800 };
    const x = sheetBox.x + sheetBox.width / 2;
    const low = Math.min(viewport.height - 40, sheetBox.y + sheetBox.height - 40);
    const high = sheetBox.y + 160;
    await touchDrag(page, { x, y: low }, { x, y: high }, { steps: 10, stepMs: 16 });
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
    for (let i = 0; i < 3; i++) await touchDrag(page, { x, y: high }, { x, y: low }, { steps: 10, stepMs: 16 });
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
    await page.waitForTimeout(400);
    await expect(sheet).toBeVisible();
    await expect(s).toBeVisible();
    expect(page.url()).toBe(storyUrl);

    // A pull on the sheet's handle closes the sheet, not the player.
    const close = await page.getByTestId('story-close').boundingBox();
    if (!close) throw new Error('close button not visible');
    const handle = { x: sheetBox.x + 48, y: close.y + close.height / 2 };
    await touchDrag(page, handle, { x: handle.x, y: handle.y + 260 }, { steps: 8, stepMs: 16 });
    await expect(sheet).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/de/day/${day.date}/$`));
    await expect(s).toBeVisible();
    await expect(s).toHaveAttribute('data-kind', 'story');
    await expect(s).toHaveAttribute('data-paused', 'user');
    await expect(page.getByTestId('player-frame')).toHaveAccessibleDescription(/nach unten zum Schließen/);
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

  test('a pull down still closes, without the stage following the finger', async ({ page, request }) => {
    const day = timerDay(await loadData(request));
    const s = await openDay(page, day.date);
    await expect(s).toHaveAttribute('data-status', 'ready');
    const mid = await framePoint(page, 0.5, 0.3); // above the "watch the day" button
    await page.mouse.move(mid.x, mid.y);
    await page.mouse.down();
    await page.mouse.move(mid.x, mid.y + 260, { steps: 6 });
    expect(await inlineStyle(page, 'player-frame', 'transform')).toBe('');
    await page.mouse.up();
    await expect(session(page)).toHaveCount(0);
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
