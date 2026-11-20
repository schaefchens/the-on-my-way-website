/**
 * Owner flows against the production build + mock API (German UI, phone viewport):
 * login, create a note, edit a day, hide a capture (with undo), the 409 conflict dialog, a note
 * written offline that survives a reload and is sent once the device is back online, two queued
 * edits of a fresh capture (no self-inflicted conflict), and a story the API rejects coming back
 * as a draft.
 */
import { type APIRequestContext, test as base, expect, type Page } from '@playwright/test';

interface MockState {
  seq: number;
  posts: Array<{ publicId: string; kind: string; origLocale: string; content: Record<string, { body: string }> }>;
  days: Array<{
    localDate: string;
    placeName?: string | null;
    countryCode?: string | null;
    title?: Record<string, string> | null;
  }>;
  annotations: Array<{ sourceKey: string; visibility?: string | null }>;
}

interface Mock {
  state(): Promise<MockState>;
  log(): Promise<Array<{ method: string; path: string; status: number }>>;
  editDayElsewhere(date: string, patch: Record<string, unknown>): Promise<void>;
}

function mockOf(request: APIRequestContext): Mock {
  return {
    state: async () => (await request.get('/__mock/state')).json(),
    log: async () => (await request.get('/__mock/log')).json(),
    editDayElsewhere: async (date, patch) => {
      await request.post(`/__mock/day/${date}`, { data: patch });
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
}

test('login: wrong password, then sign in and land where I wanted to go', async ({ page, mock }) => {
  await page.goto('/admin/settings');
  await expect(page).toHaveURL(/\/admin\/login\?redirect=/);
  await page.getByLabel('E-Mail').fill('owner@example.org');
  await page.getByLabel('Passwort', { exact: true }).fill('falsch');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('alert')).toHaveText('E-Mail oder Passwort stimmt nicht.');

  await page.getByLabel('Passwort', { exact: true }).fill('reisetagebuch');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page).toHaveURL(/\/admin\/settings$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Einstellungen' })).toBeVisible();

  await page.goto('/admin/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Lena');
  await expect(page.getByText('Alles ist live')).toBeVisible();
  expect((await mock.log()).some((r) => r.method === 'POST' && r.path.endsWith('/session') && r.status === 200)).toBe(
    true,
  );
});

test('create a note: it is sent once and lands on the site', async ({ page, mock }) => {
  await login(page);
  await page.getByRole('link', { name: 'Schreiben' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Neue Notiz' })).toBeVisible();
  await page.locator('#note-body').fill('Bánh mì am Fluss, die Laternen spiegeln sich im Wasser ✨');
  await expect(page.getByText(/^noch \d+$/)).toBeVisible();
  await page.getByRole('button', { name: 'Veröffentlichen' }).click();
  await expect(page.getByText('Veröffentlicht. Gleich ist es auf der Seite.')).toBeVisible();

  await expect
    .poll(async () => (await mock.state()).posts.find((p) => p.content.de?.body.startsWith('Bánh mì'))?.kind)
    .toBe('note');
  const posts = (await mock.log()).filter((r) => r.method === 'POST' && r.path.endsWith('/posts'));
  expect(posts.map((r) => r.status)).toEqual([201]);
});

test('edit a day: place and country are saved', async ({ page, mock }) => {
  await login(page);
  await page.goto('/admin/days/2026-11-16');
  await expect(page.getByRole('heading', { level: 1, name: 'Auf dem Thu Bồn' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Ort', exact: true }).fill('Hội An');
  await page.getByRole('combobox', { name: 'Land' }).selectOption({ label: 'Vietnam' });
  await page.getByRole('button', { name: 'Tag speichern' }).click();
  await expect(page.getByText('Tag gespeichert')).toBeVisible();

  await expect
    .poll(async () => (await mock.state()).days.find((d) => d.localDate === '2026-11-16'))
    .toMatchObject({ placeName: 'Hội An', countryCode: 'VN', title: { de: 'Auf dem Thu Bồn' } });
  await page.getByRole('link', { name: 'Tage' }).first().click();
  await expect(page.getByRole('link', { name: /Auf dem Thu Bồn/ })).toContainText('Hội An');
});

test('hide a capture from the inbox, then undo', async ({ page, mock }) => {
  await login(page);
  await page.getByRole('link', { name: 'Eingang' }).first().click();
  const card = page.getByRole('article').filter({ hasText: 'Mekong-Delta' });
  await card.getByRole('button', { name: 'Verstecken' }).click();
  await expect(card.getByText('Versteckt')).toBeVisible();
  const visibility = async () =>
    (await mock.state()).annotations.find((a) => a.sourceKey === 'wa:3EB0F1A2B3C4D5E6F701')?.visibility ?? null;
  await expect.poll(visibility).toBe('hidden');

  await page.getByRole('button', { name: 'Rückgängig' }).click();
  await expect.poll(visibility).toBe(null);
  await expect(card.getByRole('button', { name: 'Verstecken' })).toBeVisible();
});

test('conflict: the day was changed on another device, I keep my place', async ({ page, mock }) => {
  await login(page);
  await page.goto('/admin/days/2026-11-15');
  const place = page.getByRole('textbox', { name: 'Ort', exact: true });
  await expect(place).toHaveValue('Hội An');

  await mock.editDayElsewhere('2026-11-15', { placeName: 'Đà Nẵng' });
  await place.fill('Hội An, Altstadt');
  await page.getByRole('button', { name: 'Tag speichern' }).click();

  const dialog = page.getByRole('dialog', { name: 'Auf einem anderen Gerät geändert' });
  await expect(dialog).toBeVisible();
  // The sheet needs an answer: even a repeated Escape (which browsers enforce) does not drop it.
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Deine Änderung/ })).toBeChecked();
  await expect(dialog.getByText('Đà Nẵng')).toBeVisible();
  await dialog.getByRole('button', { name: 'Meine Auswahl speichern' }).click();
  await expect(dialog).toBeHidden();

  await expect
    .poll(async () => (await mock.state()).days.find((d) => d.localDate === '2026-11-15')?.placeName)
    .toBe('Hội An, Altstadt');
  await expect(place).toHaveValue('Hội An, Altstadt');
  const patches = (await mock.log()).filter((r) => r.method === 'PATCH' && r.path.endsWith('/days/2026-11-15'));
  expect(patches.map((r) => r.status)).toEqual([409, 200]);
});

test('offline: a note written without connection survives a reload and is sent when back online', async ({
  page,
  context,
  mock,
}) => {
  await login(page);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Lena');
  // The service worker controls the page (app shell precached), so a reload works offline.
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 15_000 })
    .toBe(true);

  await page.getByRole('link', { name: 'Schreiben' }).click();
  await context.setOffline(true);
  await page.locator('#note-body').fill('Offline im Bus nach Cần Thơ 🚌');
  await page.getByRole('button', { name: 'Veröffentlichen' }).click();
  await expect(page.getByText('Auf diesem Gerät gespeichert – wird gesendet, sobald du online bist')).toBeVisible();
  await expect(page.getByText('Du bist offline')).toBeVisible();
  await expect(
    page.getByText('1 Änderung ist auf diesem Gerät gespeichert und wird automatisch gesendet.'),
  ).toBeVisible();

  // Close and reopen the app while still offline: the queued write is restored from IndexedDB.
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Lena');
  await expect(
    page.getByText('1 Änderung ist auf diesem Gerät gespeichert und wird automatisch gesendet.'),
  ).toBeVisible();
  expect((await mock.log()).filter((r) => r.path.endsWith('/posts'))).toEqual([]);

  await context.setOffline(false);
  await expect
    .poll(
      async () =>
        (await mock.state()).posts.filter((p) => p.content.de?.body === 'Offline im Bus nach Cần Thơ 🚌').length,
      {
        timeout: 15_000,
      },
    )
    .toBe(1);
  await expect(page.getByText('Du bist offline')).toBeHidden();
  const creates = (await mock.log()).filter((r) => r.method === 'POST' && r.path.endsWith('/posts'));
  expect(creates.map((r) => r.status)).toEqual([201]);
});

test('offline: hide a fresh status and show it again, both edits are sent without a conflict', async ({
  page,
  context,
  mock,
}) => {
  await login(page);
  await page.getByRole('link', { name: 'Eingang' }).first().click();
  const card = page.getByRole('article').filter({ hasText: 'Mekong-Delta' });
  await expect(card.getByRole('button', { name: 'Verstecken' })).toBeVisible();
  await context.setOffline(true);
  await card.getByRole('button', { name: 'Verstecken' }).click();
  await card.getByRole('button', { name: 'Zeigen' }).click();
  await expect(card.getByRole('button', { name: 'Verstecken' })).toBeVisible();
  await context.setOffline(false);

  const patches = async () =>
    (await mock.log())
      .filter((r) => r.method === 'PATCH' && r.path.endsWith(encodeURIComponent('wa:3EB0F1A2B3C4D5E6F701')))
      .map((r) => r.status);
  // The second edit is based on the version the first one creates, not on a made-up one.
  await expect.poll(patches, { timeout: 15_000 }).toEqual([200, 200]);
  // "Show" returns the status to the publish setting (no override), it does not force it public.
  expect((await mock.state()).annotations.find((a) => a.sourceKey === 'wa:3EB0F1A2B3C4D5E6F701')?.visibility).toBe(
    null,
  );
});

test('a story the API rejects comes back as a draft, nothing is lost', async ({ page, mock }) => {
  await login(page);
  let reject = true;
  await page.route('**/api/v1/admin/posts', async (route) => {
    if (reject && route.request().method() === 'POST') {
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'validation_failed', message: 'Zu lang' } }),
      });
    } else {
      await route.fallback();
    }
  });
  await page.goto('/admin/compose?kind=story');
  await page.getByLabel('Titel (de)').fill('Ein Morgen am Mekong');
  await page.getByLabel('Text der Geschichte in Markdown (de)').fill('Um fünf Uhr klingelte der Wecker.');
  await page.getByRole('button', { name: 'Veröffentlichen' }).click();
  await expect(
    page.getByText(
      'Nicht gespeichert: Der Server hat das nicht angenommen. Dein Text liegt wieder bei deinen Entwürfen.',
    ),
  ).toBeVisible();

  reject = false;
  await page.getByRole('button', { name: 'Entwurf öffnen' }).click();
  await expect(page).toHaveURL(/\/admin\/compose\?kind=story&draft=/);
  await expect(page.locator('#story-title')).toHaveValue('Ein Morgen am Mekong');
  await page.getByRole('button', { name: 'Veröffentlichen' }).click();
  const story = async () =>
    (await mock.state()).posts.find(
      (p) => (p.content.de as { title?: string } | undefined)?.title === 'Ein Morgen am Mekong',
    );
  await expect.poll(async () => (await story())?.content.de?.body).toBe('Um fünf Uhr klingelte der Wecker.');
  const creates = (await mock.log()).filter((r) => r.method === 'POST' && r.path.endsWith('/posts'));
  expect(creates.map((r) => r.status)).toEqual([201]);
  await page.goto('/admin/');
  await expect(page.getByRole('heading', { name: /Entw(u|ü)rf/ })).toBeHidden();
});
