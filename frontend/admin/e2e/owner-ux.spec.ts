/**
 * Owner UX regressions (review L4/L2): save bars in reach on a phone, edits that survive leaving
 * the screen, un-hiding that keeps delayed publishing, the mode_since rule, honest home states,
 * a fast "live" confirmation, the time-zone nudge, entry points that focus the field, calm toasts
 * and a story preview without remote images. German UI, 390x844, against the mock API.
 */
import { type APIRequestContext, test as base, expect, type Locator, type Page } from '@playwright/test';

interface MockState {
  days: Array<{ localDate: string; placeName?: string | null; title?: Record<string, string> | null }>;
  annotations: Array<{ sourceKey: string; visibility?: string | null; description?: Record<string, string> | null }>;
  settings: Record<string, unknown>;
}

interface Mock {
  state(): Promise<MockState>;
  log(): Promise<Array<{ method: string; path: string; status: number }>>;
  addCapture(minutesAgo: number, caption: string): Promise<string>;
  settings(patch: Record<string, unknown>): Promise<void>;
}

function mockOf(request: APIRequestContext): Mock {
  return {
    state: async () => (await request.get('/__mock/state')).json(),
    log: async () => (await request.get('/__mock/log')).json(),
    addCapture: async (minutesAgo, caption) =>
      (
        (await (await request.post('/__mock/capture', { data: { minutesAgo, caption } })).json()) as {
          sourceKey: string;
        }
      ).sourceKey,
    settings: async (patch) => {
      await request.post('/__mock/settings', { data: patch });
    },
  };
}

const test = base.extend<{ mock: Mock }>({
  mock: async ({ request }, use) => {
    await request.post('/__mock/reset');
    await use(mockOf(request));
  },
});

async function login(page: Page, target = '/admin/') {
  await page.goto(target);
  await expect(page).toHaveURL(/\/admin\/login/);
  await page.getByLabel('E-Mail').fill('owner@example.org');
  await page.getByLabel('Passwort', { exact: true }).fill('reisetagebuch');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).not.toHaveURL(/\/admin\/login/);
}

/** The control is completely inside the viewport and above the floating tab bar. */
async function expectInReachAboveTabBar(page: Page, control: Locator) {
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  const viewport = page.viewportSize();
  const tabBar = await page.getByRole('navigation', { name: 'Hauptnavigation' }).last().boundingBox();
  expect(box && viewport && tabBar).toBeTruthy();
  if (!box || !viewport || !tabBar) return;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(box.y + box.height).toBeLessThanOrEqual(tabBar.y);
}

const toasts = (page: Page) => page.getByRole('list', { name: 'Benachrichtigungen' }).getByRole('listitem');

test('phone: Publish and "Tag speichern" stay in reach while typing (no scrolling)', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Schreiben' }).click();
  // "Schreiben" is a deliberate intent: the note field has the cursor right away.
  await expect(page.locator('#note-body')).toBeFocused();
  await page.keyboard.type('Pho zum Frühstück, die Brühe kocht seit gestern Nacht.');
  await expectInReachAboveTabBar(page, page.getByRole('button', { name: 'Veröffentlichen' }).last());

  await page.goto('/admin/days/2026-11-15');
  await page.getByRole('textbox', { name: 'Titel', exact: true }).fill('Laternen über dem Fluss');
  await expectInReachAboveTabBar(page, page.getByRole('button', { name: 'Tag speichern' }));
  await page.evaluate(() => window.scrollTo(0, 0));
  await expectInReachAboveTabBar(page, page.getByRole('button', { name: 'Tag speichern' }));
  await page.screenshot({ path: '../../.cache/shots/fix-admin-control/e2e-day-sticky-390.png' });
});

test('day editor: leaving asks first, and a reload brings the unsaved edit back', async ({ page, mock }) => {
  await login(page);
  await page.goto('/admin/days/2026-11-20');
  await page.getByRole('textbox', { name: 'Titel', exact: true }).fill('Ankunft in Bangkok');
  await page.getByRole('textbox', { name: 'Ort', exact: true }).fill('Bangkok');

  await page.getByRole('link', { name: 'Start' }).click();
  const sheet = page.getByRole('dialog', { name: 'Änderungen speichern?' });
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/days\/2026-11-20$/);
  await sheet.getByRole('button', { name: 'Weiter bearbeiten' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Ort', exact: true })).toHaveValue('Bangkok');

  // The browser asks before a reload; the draft is restored afterwards.
  page.on('dialog', (d) => void d.accept());
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Ort', exact: true })).toHaveValue('Bangkok');
  await expect(page.getByRole('textbox', { name: 'Titel', exact: true })).toHaveValue('Ankunft in Bangkok');
  await expect(page.getByText('Noch nicht gespeichert')).toBeVisible();
  await page.screenshot({ path: '../../.cache/shots/fix-admin-control/e2e-day-draft-restored-390.png' });

  // Save from the leave sheet: it lands, and the draft is gone.
  await page.getByRole('link', { name: 'Start' }).click();
  await page.getByRole('dialog', { name: 'Änderungen speichern?' }).getByRole('button', { name: 'Speichern' }).click();
  await expect(page).toHaveURL(/\/admin\/$/);
  await expect
    .poll(async () => (await mock.state()).days.find((d) => d.localDate === '2026-11-20'))
    .toMatchObject({ placeName: 'Bangkok', title: { de: 'Ankunft in Bangkok' } });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('omw.admin.fieldDrafts'))).toBeNull();
});

test('description: the pencil focuses the field, a typed description survives leaving and reload', async ({
  page,
  mock,
}) => {
  await login(page);
  await page.getByRole('link', { name: 'Eingang' }).first().click();
  const card = page.getByRole('article').filter({ hasText: 'Sài Gòn' });
  await card.getByRole('link', { name: 'Beschreiben' }).click();
  const field = page.getByRole('textbox', { name: 'Beschreibung (de)' });
  await expect(field).toBeFocused();
  await expect(field).toBeInViewport({ ratio: 1 });
  await page.keyboard.type('Der Markt am Morgen');

  await page.getByRole('link', { name: 'Eingang' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Änderungen speichern?' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Weiter bearbeiten' }).click();
  page.on('dialog', (d) => void d.accept());
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Beschreibung (de)' })).toHaveValue('Der Markt am Morgen');
  await expect(page.getByText('Noch nicht gespeichert')).toBeVisible();
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect
    .poll(async () => (await mock.state()).annotations.find((a) => a.sourceKey === 'wa:3EB0A95100B25384B95E'))
    .toMatchObject({ description: { de: 'Der Markt am Morgen' } });
});

test('delayed mode: hiding and showing a fresh status returns it to the delay (no explicit public)', async ({
  page,
  mock,
}) => {
  await mock.settings({
    'publish.mode': 'delayed',
    'publish.delay_minutes': 2880,
    'publish.mode_since': '2026-01-01T00:00:00.000Z',
  });
  await mock.addCapture(10, 'Frisch vom Nachtmarkt');
  const bodies: Array<string | null> = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/captures/')) bodies.push(r.postData());
  });
  await login(page);
  await page.getByRole('link', { name: 'Eingang' }).first().click();
  const card = page.getByRole('article').filter({ hasText: 'Frisch vom Nachtmarkt' });
  await expect(card.getByText('Wartet', { exact: true })).toBeVisible();
  // Waiting statuses offer "publish now" (explicit), not a vague "release".
  await expect(card.getByRole('button', { name: 'Jetzt veröffentlichen' })).toBeVisible();
  await card.getByRole('button', { name: 'Jetzt veröffentlichen' }).click();
  await expect(card.getByRole('button', { name: 'Verstecken' })).toBeVisible();
  await card.getByRole('button', { name: 'Verstecken' }).click();
  await expect(card.getByRole('button', { name: 'Zeigen' })).toBeVisible();
  await card.getByRole('button', { name: 'Zeigen' }).click();
  await expect(page.getByText(/^Erscheint nach der Verzögerung/)).toBeVisible();
  await expect(card.getByText('Wartet', { exact: true })).toBeVisible();
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies.map((b) => JSON.parse(b ?? '{}').visibility)).toEqual(['public', 'hidden', null]);
});

test('settings: delayed -> review keeps a fresh waiting status waiting and an older public one public', async ({
  page,
  mock,
}) => {
  const now = Date.now();
  await mock.settings({
    'publish.mode': 'delayed',
    'publish.delay_minutes': 60,
    'publish.mode_since': new Date(now - 5 * 3600_000).toISOString(),
  });
  const older = await mock.addCapture(180, 'Schon öffentlich');
  const fresh = await mock.addCapture(10, 'Noch geheim');
  const visibility = async (key: string) =>
    (await (await page.request.get(`/api/v1/admin/captures/${encodeURIComponent(key)}`)).json())
      .effectiveVisibility as string;
  await login(page, '/admin/settings');
  expect(await visibility(older)).toBe('public');
  expect(await visibility(fresh)).toBe('pending');

  const mode = page.getByRole('group', { name: 'Veröffentlichungsmodus' });
  await mode.getByText('Nach Freigabe', { exact: true }).click();
  await expect(mode.getByRole('radio', { name: 'Nach Freigabe' })).toBeChecked();
  await expect.poll(async () => (await mock.state()).settings['publish.mode']).toBe('review');
  expect(await visibility(fresh)).toBe('pending');
  expect(await visibility(older)).toBe('public');
  // The optimistic copy used the same rule as the server.
  const since = (await mock.state()).settings['publish.mode_since'] as string;
  expect(Date.parse(since)).toBeGreaterThanOrEqual(now - 3600_000 - 60_000);
  expect(Date.parse(since)).toBeLessThanOrEqual(Date.now() - 3600_000 + 60_000);

  // review -> delayed would publish what waited longer than the delay: ask first (the waiting
  // list is loaded for the count, whatever this device has seen).
  await mock.settings({ 'publish.mode_since': new Date(Date.now() - 5 * 3600_000).toISOString() });
  await mock.addCapture(120, 'Wartet schon lange');
  await page.reload();
  await page.getByRole('group', { name: 'Veröffentlichungsmodus' }).getByText('Verzögert', { exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Ältere wartende Status veröffentlichen?' });
  await expect(sheet).toBeVisible();
  // Both statuses wait for review now (mode_since moved back) and are older than the delay.
  await expect(sheet).toContainText('2 wartende Status sind älter als die Verzögerung');
  await page.screenshot({ path: '../../.cache/shots/fix-admin-control/e2e-mode-confirm-390.png' });
  await sheet.getByRole('button', { name: 'Modus nicht ändern' }).click();
  await expect(sheet).toBeHidden();
  expect((await mock.state()).settings['publish.mode']).toBe('review');
});

test('home: a failing status request says "unknown", never "not published yet"', async ({ page }) => {
  await login(page);
  await page.route('**/api/v1/admin/**', async (route) => {
    if (route.request().url().endsWith('/me')) return route.fallback();
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal', message: 'Database is locked' } }),
    });
  });
  // A fresh start without any cached data (the persisted cache is dropped).
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('keyval-store');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Status gerade unbekannt' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Noch nicht veröffentlicht')).toBeHidden();
  const main = page.locator('main');
  await expect(main).toContainText('Der Server hat gerade ein Problem');
  // The technical text stays folded away under "Details" (rendered text, not the DOM's).
  // biome-ignore lint/performance/useDomNodeTextContent: what is visible is the point here
  const visible = await main.innerText();
  expect(visible).not.toContain('API unreachable');
  expect(visible).not.toContain('HTTP 50');
  expect(visible).not.toContain('Database is locked');
  await page.screenshot({ path: '../../.cache/shots/fix-admin-control/e2e-error-home-390.png', fullPage: true });
});

test('home: "Alles ist live" follows the publish within seconds, not a minute', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Schreiben' }).click();
  await page.locator('#note-body').fill('Kaffee mit Kondensmilch am Straßenrand');
  await page.getByRole('button', { name: 'Veröffentlichen' }).last().click();
  await page.getByRole('link', { name: 'Start' }).click();
  await expect(page.getByRole('heading', { name: 'Wird veröffentlicht…' })).toBeVisible();
  const started = Date.now();
  // The mock publishes 1.5 s after the last write; the status is polled every 10 s meanwhile.
  await expect(page.getByRole('heading', { name: 'Alles ist live' })).toBeVisible({ timeout: 16_000 });
  expect(Date.now() - started).toBeLessThan(16_000);
});

test.describe('device in Bangkok, setting Ho Chi Minh', () => {
  test.use({ timezoneId: 'Asia/Bangkok' });

  test('home offers the time zone of the device, one tap switches it', async ({ page, mock }) => {
    await login(page);
    const banner = page.getByRole('region', { name: /Du bist jetzt in Bangkok \(\+07:00\)/ });
    await expect(banner).toBeVisible();
    await page.screenshot({ path: '../../.cache/shots/fix-admin-control/e2e-tz-nudge-390.png' });
    await banner.getByRole('button', { name: 'Bangkok übernehmen' }).click();
    await expect(banner).toBeHidden();
    await expect.poll(async () => (await mock.state()).settings['timezone.current']).toBe('Asia/Bangkok');
  });
});

test('toasts: hide, describe, save a day and change the zone leave at most two toasts', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Eingang' }).first().click();
  await page
    .getByRole('article')
    .filter({ hasText: 'Mekong-Delta' })
    .getByRole('button', { name: 'Verstecken' })
    .click();
  await page.getByRole('article').filter({ hasText: 'Sài Gòn' }).getByRole('link', { name: 'Beschreiben' }).click();
  await page.getByRole('textbox', { name: 'Beschreibung (de)' }).fill('Roller, Roller, Roller');
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await page.goto('/admin/days/2026-11-16');
  await page.getByRole('textbox', { name: 'Ort', exact: true }).fill('Hội An');
  await page.getByRole('button', { name: 'Tag speichern' }).click();
  await page.getByRole('button', { name: 'Mehr' }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Einstellungen' }).click();
  await page.getByText('Andere Zeitzone wählen').click();
  await page.getByRole('combobox', { name: 'Zeitzone' }).selectOption('Asia/Bangkok');
  await expect(page.getByText('Zeitzone aktualisiert')).toBeVisible();
  expect(await toasts(page).count()).toBeLessThanOrEqual(2);
  await page.screenshot({ path: '../../.cache/shots/fix-admin-control/e2e-toasts-390.png' });
});

test('phone: "Mehr" reaches every area (trips, people, safety, privacy, settings, log out)', async ({ page }) => {
  await login(page);
  const tabBar = page.getByRole('navigation', { name: 'Hauptnavigation' }).last();
  await expect(tabBar.getByRole('link', { name: 'Tage' })).toBeVisible();
  await tabBar.getByRole('button', { name: 'Mehr' }).click();
  const sheet = page.getByRole('dialog', { name: 'Alle Bereiche' });
  for (const name of ['Tage', 'Reisen', 'Menschen', 'Sicherheit', 'Datenschutzhinweise', 'Einstellungen']) {
    await expect(sheet.getByRole('link', { name, exact: true })).toBeVisible();
  }
  await expect(sheet.getByRole('button', { name: 'Abmelden' })).toBeVisible();
  await page.waitForTimeout(450); // let the sheet finish sliding in before the screenshot
  await page.screenshot({ path: '../../.cache/shots/admin-more/more-sheet-390-de.png' });
  await sheet.getByRole('link', { name: 'Reisen', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/trips$/);
  await expect(page.getByRole('dialog', { name: 'Alle Bereiche' })).toBeHidden();
  // "Tage" stays highlighted on Trips (they share the Days screen's switch).
  await expect(tabBar.getByRole('link', { name: 'Tage' })).toHaveAttribute('aria-current', 'page');
  await tabBar.getByRole('button', { name: 'Mehr' }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Menschen', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/people$/);
  await expect(tabBar.getByRole('button', { name: 'Mehr' })).toHaveAttribute('aria-current', 'page');
});

test('story preview renders no remote image', async ({ page }) => {
  const remote: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('evil.example')) remote.push(r.url());
  });
  await login(page, '/admin/compose?kind=story');
  await page.getByLabel('Titel (de)').fill('Bilder?');
  await page.getByLabel('Text der Geschichte in Markdown (de)').fill('Hier: ![pixel](https://evil.example/p.gif)');
  await page.getByText('Vorschau', { exact: true }).click();
  const preview = page.locator('.prose-journal');
  await expect(preview).toContainText('pixel');
  await expect(preview.locator('img')).toHaveCount(0);
  expect(remote).toEqual([]);
});
