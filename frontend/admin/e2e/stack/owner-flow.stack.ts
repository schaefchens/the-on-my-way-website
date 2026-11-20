/**
 * The owner flow of plan "End-to-end verification" 3 + 4 on the real local stack (see
 * ../playwright.stack.config.ts): fixture statuses are captured by the backend and mirrored to
 * the PHP API; the owner edits in the admin PWA (German UI, phone viewport); the edits travel
 * through the change feed into the generated site; the admin reports "live"; with the API down a
 * new status is still published, and the sync catches up once the API is back.
 *
 * The tests run in order and share the stack (serial mode).
 */

import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, request, test } from '@playwright/test';
import { REPO, Stack, waitFor } from './stack';

/** Screenshots for a human look (not compared): .cache/shots/stack/. */
const SHOTS = join(REPO, '.cache/shots/stack');

const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const stack = new Stack({
  apiPort: env('OMW_STACK_API_PORT', 8080),
  controlPort: env('OMW_STACK_CONTROL_PORT', 8787),
  sitePort: env('OMW_STACK_SITE_PORT', 4173),
  // A run of its own (another run may use the default .cache/e2e-stack at the same time).
  ...(process.env.OMW_STACK_ROOT ? { root: process.env.OMW_STACK_ROOT } : {}),
});

// Fixture statuses (fixtures/generated/inbox) the flow works with.
const DESCRIBED = 'wa:3EB0A95100B25384B95E'; // photo "Sài Gòn", 2026-11-17
const HIDDEN = 'wa:3EB0B028C9D92EFF4C5B'; // photo "Hội An", 2026-11-15
const DAY = '2026-11-16';
const TRIP_SLUG = 'vietnam-2026';

// Unique texts of this run.
const run = Date.now().toString(36);
const T = {
  descDe: `Markt am Morgen, alle rufen durcheinander (${run})`,
  descEn: `Morning market, everyone shouting at once (${run})`,
  dayTitleDe: `Auf dem Thu Bồn ${run}`,
  dayTitleEn: `On the Thu Bồn ${run}`,
  place: 'Hội An',
  noteDe: `Bánh mì am Fluss, die Laternen spiegeln sich im Wasser ${run}`,
  noteEn: `Bánh mì by the river, lanterns mirrored in the water ${run}`,
  storyTitle: `Ein Morgen am Thu Bồn ${run}`,
  storyBody: `Um fünf Uhr klingelte der Wecker.\n\n## Auf dem Boot\n\nDer Fluss war **still** (${run}).`,
  tripDe: `Vietnam 2026 ${run}`,
  tripEn: `Vietnam 2026 (en) ${run}`,
  offline: `Status ohne API ${run}`,
};

interface CaptureItem {
  sourceKey: string;
  previewUrl?: string | null;
  posterUrl?: string | null;
  publicId: string;
  occurredAt: string;
  effectiveLocalDate: string;
  annotation: { visibility?: string | null; description?: Record<string, string> | null } | null;
}
interface DayJson {
  entries: Array<Record<string, unknown> & { id: string; kind: string }>;
}

let api: APIRequestContext;
const shared: { hiddenPublicId?: string; hiddenMedia?: string[]; storyId?: string } = {};

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  stack.prepare();
  await stack.startApi();
  await stack.startStatic();
  await stack.startBackend();
  api = await request.newContext({ baseURL: stack.apiUrl });
  const login = await api.post('/api/v1/admin/session', { data: stack.admin });
  expect(login.status()).toBe(200);
});

test.afterAll(async () => {
  await api?.dispose();
  await stack.stopAll();
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern for the fixtures.
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) {
    console.log(
      `--- backend log tail ---\n${stack.logTail('backend')}\n--- api log tail ---\n${stack.logTail('api', 15)}`,
    );
  }
});

async function admin<T>(path: string): Promise<T> {
  const res = await api.get(`/api/v1/admin${path}`);
  expect(res.status(), path).toBe(200);
  return (await res.json()) as T;
}

async function login(page: Page, target = '/admin/') {
  await page.goto(`${stack.apiUrl}${target}`);
  await expect(page).toHaveURL(/\/admin\/login/);
  await page.getByLabel('E-Mail').fill(stack.admin.email);
  await page.getByLabel('Passwort', { exact: true }).fill(stack.admin.password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Lena');
}

function mediaPaths(value: unknown): string[] {
  return [...new Set(JSON.stringify(value).match(/media\/[0-9a-f]{2}\/[0-9a-f]{16}_[A-Za-z0-9_]+\.[a-z0-9]+/g) ?? [])];
}

test('the backend mirrors the fixture statuses and their previews to the API', async () => {
  // 18 fixture statuses; the capture mirror and previews are pushed by the backend's sync.
  await waitFor(
    'the capture mirror',
    async () => (await admin<{ items: CaptureItem[] }>('/captures?limit=100')).items.length === 18,
    90_000,
  );
  await waitFor(
    'an empty sync queue',
    async () => (await stack.control<{ sync: { queue: { pending: number } } }>('/api/status')).sync.queue.pending === 0,
    90_000,
  );
  // The hidden photo's public media, as published before the owner hides it.
  const hidden = await admin<CaptureItem>(`/captures/${encodeURIComponent(HIDDEN)}`);
  shared.hiddenPublicId = hidden.publicId;
  await waitFor(
    'the first deploy',
    async () => (await stack.site('/data/days/2026-11-15.json')).status === 200,
    60_000,
  );
  const day = (await stack.siteJson<DayJson>('/data/days/2026-11-15.json')) as DayJson;
  const entry = day.entries.find((e) => e.id === hidden.publicId);
  expect(entry, 'hidden photo published before it is hidden').toBeDefined();
  shared.hiddenMedia = mediaPaths(entry);
  expect(shared.hiddenMedia.length).toBeGreaterThanOrEqual(5);
  for (const rel of shared.hiddenMedia) expect(stack.publishedFileExists(rel), rel).toBe(true);
});

test('owner edits in the admin PWA against the real API', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    // The one expected 401: the session probe (/me) before logging in.
    if (m.type() === 'error' && !/status of 401/.test(m.text())) consoleErrors.push(m.text());
  });
  const failed: string[] = [];
  page.on('requestfailed', (r) => {
    // ERR_ABORTED = a fetch cancelled by our own page.goto() or by TanStack Query on unmount.
    if (r.failure()?.errorText !== 'net::ERR_ABORTED')
      failed.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`);
  });
  const httpErrors: string[] = [];
  page.on('response', (r) => {
    // 401 on /me before logging in is the session probe.
    if (r.status() >= 400 && !(r.status() === 401 && r.url().endsWith('/api/v1/admin/me'))) {
      httpErrors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
    }
  });

  await test.step('log in (http dev session cookie) and see the backend heartbeat', async () => {
    await login(page);
    const cookies = await page.context().cookies();
    expect(cookies.map((c) => c.name)).toContain('omw_dev_session');
    expect(cookies.find((c) => c.name === 'omw_dev_session')?.httpOnly).toBe(true);
    await expect(page.getByText('Rechner zu Hause')).toBeVisible();
    await expect(page.getByText('Läuft', { exact: true })).toBeVisible();
    await expect(page.getByText('Verbunden', { exact: true })).toBeVisible();
  });

  await test.step('inbox: every mirrored photo, video and GIF shows its private preview', async () => {
    await page.getByRole('link', { name: 'Eingang' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Eingang' })).toBeVisible();
    await expect(page.getByRole('article')).toHaveCount(18);
    const previews = page.locator('article img[src*="/api/v1/admin/captures/"]');
    // Every capture the API has a preview/poster for: 5 photos + 2 videos + 1 GIF of the fixtures.
    // Lost/pending media have none, and the photo deleted on WhatsApp has none either while
    // ingest.on_revoke = hide (the API drops a revoked status' private previews).
    const withPreview = (await admin<{ items: CaptureItem[] }>('/captures?limit=100')).items.filter(
      (c) => c.previewUrl || c.posterUrl,
    ).length;
    expect(withPreview).toBeGreaterThanOrEqual(8);
    await expect(previews)
      .toHaveCount(withPreview)
      .catch(async (err) => {
        // Which cards lack a preview (and why) makes a failure here diagnosable.
        const cards = await page
          .locator('article')
          .evaluateAll((els) =>
            els.map(
              (a) =>
                `${a.getAttribute('aria-label')}: ${a.querySelector('img')?.getAttribute('src') ? 'img' : 'NO IMG'} ${(a.textContent ?? '').replace(/\s+/g, ' ').slice(0, 60)}`,
            ),
          );
        console.log(`--- inbox cards ---\n${cards.join('\n')}`);
        throw err;
      });
    for (const img of await previews.all()) {
      await img.scrollIntoViewIfNeeded();
      await expect
        .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { timeout: 10_000 })
        .toBe(true);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(SHOTS, 'inbox.png'), fullPage: true });
  });

  await test.step('describe a capture in German and English', async () => {
    await page.goto(`${stack.apiUrl}/admin/inbox/${encodeURIComponent(DESCRIBED)}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Sài Gòn' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Beschreibung (de)' }).fill(T.descDe);
    await page.getByRole('combobox', { name: 'Geschrieben auf' }).selectOption({ label: 'Deutsch' });
    await page.getByRole('tab', { name: /English/ }).click();
    await page.getByRole('textbox', { name: 'Beschreibung (en)' }).fill(T.descEn);
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect
      .poll(
        async () => (await admin<CaptureItem>(`/captures/${encodeURIComponent(DESCRIBED)}`)).annotation?.description,
      )
      .toEqual({ de: T.descDe, en: T.descEn });
  });

  await test.step('hide a capture', async () => {
    await page.getByRole('link', { name: 'Eingang' }).first().click();
    const card = page.getByRole('article').filter({ hasText: 'Hội An' }).filter({ hasText: '09:12' });
    await card.getByRole('button', { name: 'Verstecken' }).click();
    await expect(card.getByText('Versteckt')).toBeVisible();
    await expect
      .poll(async () => (await admin<CaptureItem>(`/captures/${encodeURIComponent(HIDDEN)}`)).annotation?.visibility)
      .toBe('hidden');
  });

  await test.step('edit a day: title per language, place and country', async () => {
    await page.goto(`${stack.apiUrl}/admin/days/${DAY}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Tag ohne Titel' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Titel', exact: true }).fill(T.dayTitleDe);
    await page.getByRole('tab', { name: /English/ }).click();
    await page.getByRole('textbox', { name: 'Titel', exact: true }).fill(T.dayTitleEn);
    await page.getByRole('textbox', { name: 'Ort', exact: true }).fill(T.place);
    await page.getByRole('combobox', { name: 'Land' }).selectOption({ label: 'Vietnam' });
    await page.getByRole('button', { name: 'Tag speichern' }).click();
    await expect(page.getByText('Tag gespeichert')).toBeVisible();
    await expect
      .poll(async () => admin<{ day: Record<string, unknown> | null }>(`/days/${DAY}`).then((d) => d.day))
      .toMatchObject({ title: { de: T.dayTitleDe, en: T.dayTitleEn }, placeName: T.place, countryCode: 'VN' });
  });

  await test.step('write a note for that day in German and English', async () => {
    await page.goto(`${stack.apiUrl}/admin/compose?kind=note&date=${DAY}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Neue Notiz' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Notiz (de)' }).fill(T.noteDe);
    await page.getByRole('tab', { name: /English/ }).click();
    await page.getByRole('textbox', { name: 'Notiz (en)' }).fill(T.noteEn);
    await page.getByRole('button', { name: 'Veröffentlichen' }).click();
    await expect(page.getByText('Veröffentlicht. Gleich ist es auf der Seite.')).toBeVisible();
    await expect
      .poll(async () => {
        const posts = await admin<{
          items: Array<{ kind: string; localDate: string; content: Record<string, { body: string }> }>;
        }>('/posts');
        return posts.items.find((p) => p.content.de?.body === T.noteDe);
      })
      .toMatchObject({ kind: 'note', localDate: DAY, content: { en: { body: T.noteEn } } });
  });

  await test.step('write a story for that day', async () => {
    await page.goto(`${stack.apiUrl}/admin/compose?kind=story&date=${DAY}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Neue Geschichte' })).toBeVisible();
    await page.getByLabel('Titel (de)').fill(T.storyTitle);
    await page.getByLabel('Text der Geschichte in Markdown (de)').fill(T.storyBody);
    await page.getByRole('button', { name: 'Veröffentlichen' }).click();
    await expect(page.getByText('Veröffentlicht. Gleich ist es auf der Seite.')).toBeVisible();
    await expect
      .poll(async () => {
        const posts = await admin<{
          items: Array<{
            publicId: string;
            kind: string;
            localDate: string;
            content: Record<string, { title?: string }>;
          }>;
        }>('/posts');
        const story = posts.items.find((p) => p.content.de?.title === T.storyTitle);
        shared.storyId = story?.publicId;
        return story && { kind: story.kind, localDate: story.localDate };
      })
      .toEqual({ kind: 'story', localDate: DAY });
  });

  await test.step('create a trip over the fixture days', async () => {
    await page.goto(`${stack.apiUrl}/admin/trips/new`);
    await expect(page.getByRole('heading', { level: 1, name: 'Neue Reise' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Titel', exact: true }).fill(T.tripDe);
    await page.getByRole('tab', { name: /English/ }).click();
    await page.getByRole('textbox', { name: 'Titel', exact: true }).fill(T.tripEn);
    await page.getByRole('textbox', { name: 'Webadresse' }).fill(TRIP_SLUG);
    await page.getByRole('textbox', { name: 'Erster Tag' }).fill('2026-11-12');
    await page.getByRole('textbox', { name: 'Letzter Tag' }).fill('2026-11-17');
    await page.getByRole('button', { name: 'Reise anlegen' }).click();
    await expect.poll(async () => (await api.get(`/api/v1/admin/trips/${TRIP_SLUG}`)).status()).toBe(200);
    expect(await admin<Record<string, unknown>>(`/trips/${TRIP_SLUG}`)).toMatchObject({
      slug: TRIP_SLUG,
      startDate: '2026-11-12',
      endDate: '2026-11-17',
      title: { de: T.tripDe, en: T.tripEn },
    });
  });

  await test.step('settings: time zone from this device, publish mode', async () => {
    await page.goto(`${stack.apiUrl}/admin/settings`);
    await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();
    await page.getByRole('button', { name: /Zeitzone dieses Geräts nehmen/ }).click();
    await expect
      .poll(async () => (await admin<Record<string, unknown>>('/settings'))['timezone.current'])
      .toBe('Asia/Ho_Chi_Minh');

    const mode = page.getByRole('group', { name: 'Veröffentlichungsmodus' });
    // Native radios sit under the pill labels: click the label like a finger would.
    await mode.getByText('Verzögert', { exact: true }).click();
    await expect(mode.getByRole('radio', { name: 'Verzögert' })).toBeChecked();
    await expect.poll(async () => (await admin<Record<string, unknown>>('/settings'))['publish.mode']).toBe('delayed');
    // Back to instant, so the rest of the flow publishes new statuses right away.
    await mode.getByText('Sofort', { exact: true }).click();
    await expect.poll(async () => (await admin<Record<string, unknown>>('/settings'))['publish.mode']).toBe('instant');
  });

  expect(failed, 'failed requests').toEqual([]);
  expect(httpErrors, 'HTTP errors').toEqual([]);
  expect(consoleErrors, 'console errors').toEqual([]);
});

test('the owner edits reach the generated site through the change feed', async () => {
  const html = async (path: string) => {
    const r = await stack.site(path);
    return r.status === 200 ? r.text : '';
  };
  await test.step('the note shows on its day, in German and in English', async () => {
    await expect.poll(() => html(`/de/day/${DAY}/`), { timeout: 120_000 }).toContain(T.noteDe);
    await expect.poll(() => html(`/en/day/${DAY}/`), { timeout: 30_000 }).toContain(T.noteEn);
  });
  await test.step('the day title shows (per language) with its place', async () => {
    await expect.poll(() => html(`/de/day/${DAY}/`), { timeout: 60_000 }).toContain(T.dayTitleDe);
    await expect.poll(() => html(`/en/day/${DAY}/`), { timeout: 30_000 }).toContain(T.dayTitleEn);
    expect(await html(`/de/day/${DAY}/`)).toContain(T.place);
  });
  await test.step('the story has its page', async () => {
    expect(shared.storyId).toMatch(/^p_/);
    await expect
      .poll(() => html(`/de/day/${DAY}/story/${shared.storyId}/`), { timeout: 60_000 })
      .toContain(T.storyTitle);
  });
  await test.step('the trip page exists', async () => {
    await expect.poll(() => html(`/de/trip/${TRIP_SLUG}/`), { timeout: 60_000 }).toContain(T.tripDe);
    await expect.poll(() => html(`/en/trip/${TRIP_SLUG}/`), { timeout: 30_000 }).toContain(T.tripEn);
  });
  await test.step('the description is in the day data', async () => {
    await expect
      .poll(async () => JSON.stringify(await stack.siteJson('/data/days/2026-11-17.json')), { timeout: 60_000 })
      .toContain(T.descEn);
    expect(JSON.stringify(await stack.siteJson('/data/days/2026-11-17.json'))).toContain(T.descDe);
  });
  await test.step('the hidden capture and all of its media are gone from the static host', async () => {
    const id = shared.hiddenPublicId as string;
    await expect
      .poll(async () => JSON.stringify(await stack.siteJson('/data/days/2026-11-15.json')), { timeout: 60_000 })
      .not.toContain(id);
    for (const rel of shared.hiddenMedia ?? []) {
      await expect.poll(() => stack.publishedFileExists(rel), { message: rel, timeout: 30_000 }).toBe(false);
      expect((await stack.site(`/${rel}`)).status, rel).toBe(404);
    }
    expect(await html('/de/day/2026-11-15/')).not.toContain(id);
  });
});

test('the admin reports the site as live', async ({ page }) => {
  await login(page);
  await expect(page.getByRole('heading', { level: 2, name: 'Alles ist live' })).toBeVisible({ timeout: 120_000 });
  await page.screenshot({ path: join(SHOTS, 'home-live.png'), fullPage: true });
  await page.goto(`${stack.apiUrl}/admin/days/${DAY}`);
  const note = page.getByRole('link').filter({ hasText: T.noteDe.slice(0, 20) });
  await expect(note.getByText('Live', { exact: true })).toBeVisible({ timeout: 60_000 });
  await page.screenshot({ path: join(SHOTS, 'day-live.png'), fullPage: true });
});

test('API down: a new status is still published; API back: the sync catches up', async ({ page }) => {
  const msgId = `3EB0E2E${run.toUpperCase().padStart(13, '0')}`.slice(0, 20);
  const sourceKey = `wa:${msgId}`;
  const at = new Date(Date.now() - 60_000);
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(at);

  await stack.stopApi();
  stack.injectTextStatus(msgId, T.offline, at);

  await test.step('published without the API (time zone from the mirrored settings)', async () => {
    await expect
      .poll(async () => JSON.stringify(await stack.siteJson(`/data/days/${localDate}.json`)), { timeout: 120_000 })
      .toContain(T.offline);
    const day = (await stack.siteJson<DayJson>(`/data/days/${localDate}.json`)) as DayJson;
    expect(day.entries.find((e) => JSON.stringify(e).includes(T.offline))).toMatchObject({ tz: 'Asia/Ho_Chi_Minh' });
    const status = await stack.control<{ sync: { queue: { pending: number }; lastHeartbeatError: string | null } }>(
      '/api/status',
    );
    expect(status.sync.queue.pending).toBeGreaterThan(0); // capture mirror + publish report wait
  });

  await test.step('API back: the queued capture and publish report arrive', async () => {
    await stack.startApi();
    await expect
      .poll(async () => (await api.get(`/api/v1/admin/captures/${encodeURIComponent(sourceKey)}`)).status(), {
        timeout: 60_000,
      })
      .toBe(200);
    await expect
      .poll(
        async () => (await stack.control<{ sync: { queue: { pending: number } } }>('/api/status')).sync.queue.pending,
        { timeout: 60_000 },
      )
      .toBe(0);
    const status = await admin<{ publish: Array<{ ok: boolean; capturesThrough: string | null }> }>('/status');
    expect(status.publish).toHaveLength(1);
    expect(Date.parse(status.publish[0]?.capturesThrough ?? '')).toBeGreaterThanOrEqual(at.getTime() - 1000);
  });

  await test.step('the admin shows it, live', async () => {
    await login(page);
    await expect(page.getByRole('heading', { level: 2, name: 'Alles ist live' })).toBeVisible({ timeout: 90_000 });
    await page.goto(`${stack.apiUrl}/admin/inbox`);
    const card = page.getByRole('article').filter({ hasText: T.offline });
    await expect(card.getByText('Live', { exact: true })).toBeVisible({ timeout: 60_000 });
  });
});
