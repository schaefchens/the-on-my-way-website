/**
 * Publish mode review -> delayed (owner decision): waiting statuses older than the delay are
 * published, after a confirmation that shows how many. The dialog appears only when there is
 * something to publish, confirming saves the mode and publishes exactly those statuses,
 * cancelling changes nothing. A slow or failing waiting list never switches silently: the
 * question comes with an "unclear" count. German UI, 390x844, against the mock API.
 */
import { type APIRequestContext, test as base, expect, type Page } from '@playwright/test';

interface Mock {
  settings(patch: Record<string, unknown>): Promise<void>;
  storedSettings(): Promise<Record<string, unknown>>;
  addCapture(minutesAgo: number, caption: string): Promise<string>;
  /** Effective visibility as the API reports it (own API session, not the page's). */
  visibility(sourceKey: string): Promise<string>;
  /** Owner override through the API (as if set on another device). */
  hide(sourceKey: string): Promise<void>;
}

function mockOf(request: APIRequestContext): Mock {
  let csrf: Promise<string> | null = null;
  const session = () => {
    csrf ??= request
      .post('/api/v1/admin/session', { data: { email: 'owner@example.org', password: 'reisetagebuch' } })
      .then(async (res) => ((await res.json()) as { csrfToken: string }).csrfToken);
    return csrf;
  };
  const capturePath = (key: string) => `/api/v1/admin/captures/${encodeURIComponent(key)}`;
  return {
    settings: async (patch) => {
      await request.post('/__mock/settings', { data: patch });
    },
    storedSettings: async () =>
      ((await (await request.get('/__mock/state')).json()) as { settings: Record<string, unknown> }).settings,
    addCapture: async (minutesAgo, caption) =>
      (
        (await (await request.post('/__mock/capture', { data: { minutesAgo, caption } })).json()) as {
          sourceKey: string;
        }
      ).sourceKey,
    visibility: async (key) => {
      await session();
      const res = await request.get(capturePath(key));
      expect(res.status()).toBe(200);
      return ((await res.json()) as { effectiveVisibility: string }).effectiveVisibility;
    },
    hide: async (key) => {
      const token = await session();
      const res = await request.patch(capturePath(key), {
        data: { visibility: 'hidden' },
        headers: { 'x-csrf-token': token },
      });
      expect(res.status()).toBe(200);
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

const modeGroup = (page: Page) => page.getByRole('group', { name: 'Veröffentlichungsmodus' });
const confirmSheet = (page: Page) => page.getByRole('dialog', { name: 'Ältere wartende Status veröffentlichen?' });

/** Review mode for the last 5 hours, delay 1 h. */
async function reviewSince5h(mock: Mock) {
  await mock.settings({
    'publish.mode': 'review',
    'publish.delay_minutes': 60,
    'publish.mode_since': new Date(Date.now() - 5 * 3600_000).toISOString(),
  });
}

test('review -> delayed: confirming publishes exactly the waiting statuses older than the delay', async ({
  page,
  mock,
}) => {
  await reviewSince5h(mock);
  const old = [await mock.addCapture(180, 'Seit drei Stunden'), await mock.addCapture(90, 'Seit anderthalb Stunden')];
  const fresh = [await mock.addCapture(30, 'Eben erst'), await mock.addCapture(5, 'Gerade eben')];
  const hidden = await mock.addCapture(120, 'Versteckt');
  await mock.hide(hidden);
  for (const key of [...old, ...fresh]) expect(await mock.visibility(key)).toBe('pending');
  expect(await mock.visibility(hidden)).toBe('hidden');

  await login(page, '/admin/settings');
  await expect(modeGroup(page).getByRole('radio', { name: 'Nach Freigabe' })).toBeChecked();
  await modeGroup(page).getByText('Verzögert', { exact: true }).click();
  const sheet = confirmSheet(page);
  await expect(sheet).toBeVisible();
  // The hidden one stays hidden and is not counted; the fresh ones keep waiting.
  await expect(sheet).toContainText(
    '2 wartende Status sind älter als die Verzögerung und werden jetzt veröffentlicht.',
  );
  // Nothing changed while the question is open.
  expect((await mock.storedSettings())['publish.mode']).toBe('review');

  await sheet.getByRole('button', { name: 'Umstellen und veröffentlichen' }).click();
  await expect(sheet).toBeHidden();
  await expect(modeGroup(page).getByRole('radio', { name: 'Verzögert' })).toBeChecked();
  await expect.poll(async () => (await mock.storedSettings())['publish.mode']).toBe('delayed');
  for (const key of old) expect(await mock.visibility(key), key).toBe('public');
  for (const key of fresh) expect(await mock.visibility(key), key).toBe('pending');
  expect(await mock.visibility(hidden)).toBe('hidden');
});

test('review -> delayed: cancelling keeps review and publishes nothing', async ({ page, mock }) => {
  await reviewSince5h(mock);
  const old = await mock.addCapture(150, 'Wartet schon lange');
  await login(page, '/admin/settings');
  await modeGroup(page).getByText('Verzögert', { exact: true }).click();
  const sheet = confirmSheet(page);
  await expect(sheet).toContainText('1 wartender Status ist älter als die Verzögerung');
  await sheet.getByRole('button', { name: 'Modus nicht ändern' }).click();
  await expect(sheet).toBeHidden();
  await expect(modeGroup(page).getByRole('radio', { name: 'Nach Freigabe' })).toBeChecked();
  // Escape (closing the sheet) is a "no" too.
  await modeGroup(page).getByText('Verzögert', { exact: true }).click();
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await page.waitForTimeout(500);
  const stored = await mock.storedSettings();
  expect(stored['publish.mode']).toBe('review');
  expect(await mock.visibility(old)).toBe('pending');
  await expect(modeGroup(page).getByRole('radio', { name: 'Nach Freigabe' })).toBeChecked();
});

test('review -> delayed: nothing older than the delay waits, so it switches without asking', async ({ page, mock }) => {
  await reviewSince5h(mock);
  const fresh = await mock.addCapture(20, 'Noch ganz frisch');
  await login(page, '/admin/settings');
  await modeGroup(page).getByText('Verzögert', { exact: true }).click();
  await expect(modeGroup(page).getByRole('radio', { name: 'Verzögert' })).toBeChecked();
  await expect.poll(async () => (await mock.storedSettings())['publish.mode']).toBe('delayed');
  await expect(confirmSheet(page)).toHaveCount(0);
  expect(await mock.visibility(fresh)).toBe('pending');
});

test('review -> delayed: the count covers a backlog longer than one page of the waiting list', async ({
  page,
  mock,
}) => {
  await reviewSince5h(mock);
  // The waiting list comes newest first, 40 per page: the old ones are only on the second page.
  const old = [await mock.addCapture(240, 'Ganz alt'), await mock.addCapture(200, 'Auch alt')];
  const fresh: string[] = [];
  for (let i = 0; i < 45; i++) fresh.push(await mock.addCapture(1 + i, `Frisch ${i + 1}`));
  await login(page, '/admin/settings');
  await modeGroup(page).getByText('Verzögert', { exact: true }).click();
  const sheet = confirmSheet(page);
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('2 wartende Status sind älter als die Verzögerung');
  expect((await mock.storedSettings())['publish.mode']).toBe('review');
  await sheet.getByRole('button', { name: 'Umstellen und veröffentlichen' }).click();
  await expect.poll(async () => (await mock.storedSettings())['publish.mode']).toBe('delayed');
  for (const key of old) expect(await mock.visibility(key)).toBe('public');
  expect(await mock.visibility(fresh[0] as string)).toBe('pending');
});

/** Review mode, delay 1 h: 2 statuses older than the delay behind 45 fresh ones (page 2 of the list). */
async function backlogOnPageTwo(mock: Mock): Promise<{ old: string[]; fresh: string[] }> {
  await reviewSince5h(mock);
  const old = [await mock.addCapture(240, 'Ganz alt'), await mock.addCapture(200, 'Auch alt')];
  const fresh: string[] = [];
  for (let i = 0; i < 45; i++) fresh.push(await mock.addCapture(1 + i, `Frisch ${i + 1}`));
  return { old, fresh };
}

/** The waiting list (pending captures) on this page: slow after its first page, or unreachable. */
async function waitingList(page: Page, how: 'slow' | 'failing'): Promise<void> {
  await page.route('**/api/v1/admin/captures?**', async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('visibility') === 'pending') {
      if (how === 'failing') return route.abort('internetdisconnected');
      // Page 1 arrives at once, the next ones only after the switch stopped waiting (3 s).
      if (url.searchParams.get('cursor')) await new Promise((resolve) => setTimeout(resolve, 3500));
    }
    return route.continue();
  });
}

const UNCLEAR = 'Deine wartenden Status konnten gerade nicht geladen werden';

test('review -> delayed on a slow connection: asks anyway, and counts once the list has arrived', async ({
  page,
  mock,
}) => {
  const { old, fresh } = await backlogOnPageTwo(mock);
  await waitingList(page, 'slow');
  await login(page, '/admin/settings');
  await modeGroup(page).getByText('Verzögert', { exact: true }).click();
  const sheet = confirmSheet(page);
  await expect(sheet).toBeVisible();
  // Never switched as if nothing waited: the old ones are only on the late second page.
  expect((await mock.storedSettings())['publish.mode']).toBe('review');
  await expect(sheet.getByTestId('mode-switch-count')).toHaveText(
    '2 wartende Status sind älter als die Verzögerung und werden jetzt veröffentlicht.',
    { timeout: 15_000 },
  );
  await expect(sheet.getByRole('button', { name: 'Nochmal zählen' })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Umstellen und veröffentlichen' }).click();
  await expect.poll(async () => (await mock.storedSettings())['publish.mode']).toBe('delayed');
  for (const key of old) expect(await mock.visibility(key), key).toBe('public');
  expect(await mock.visibility(fresh[0] as string)).toBe('pending');
});

test('review -> delayed offline: asks with an unclear count, publishes nothing until confirmed', async ({
  page,
  mock,
}) => {
  const { old } = await backlogOnPageTwo(mock);
  await waitingList(page, 'failing');
  await login(page, '/admin/settings');
  await modeGroup(page).getByText('Verzögert', { exact: true }).click();
  const sheet = confirmSheet(page);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('mode-switch-count')).toContainText(UNCLEAR);
  await expect(sheet.getByTestId('mode-switch-count')).toContainText('älter als die Verzögerung');
  await page.waitForTimeout(500);
  expect((await mock.storedSettings())['publish.mode']).toBe('review');
  for (const key of old) expect(await mock.visibility(key), key).toBe('pending');

  // Back online: "count again" loads the whole list and shows the real count.
  await page.unroute('**/api/v1/admin/captures?**');
  await sheet.getByRole('button', { name: 'Nochmal zählen' }).click();
  await expect(sheet.getByTestId('mode-switch-count')).toHaveText(
    '2 wartende Status sind älter als die Verzögerung und werden jetzt veröffentlicht.',
  );
  // "No" keeps everything as it was.
  await sheet.getByRole('button', { name: 'Modus nicht ändern' }).click();
  await expect(sheet).toBeHidden();
  await page.waitForTimeout(500);
  expect((await mock.storedSettings())['publish.mode']).toBe('review');
  for (const key of old) expect(await mock.visibility(key), key).toBe('pending');
});

test('-> instant offline: asks with an unclear count too', async ({ page, mock }) => {
  const { old } = await backlogOnPageTwo(mock);
  await waitingList(page, 'failing');
  await login(page, '/admin/settings');
  await modeGroup(page).getByText('Sofort', { exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Alles Wartende veröffentlichen?' });
  await expect(sheet).toBeVisible();
  // What this device already has (the newest ones, from the start screen) is a lower bound.
  await expect(sheet.getByTestId('mode-switch-count')).toContainText(/^Mindestens \d+ wartende Status werden jetzt/);
  await expect(sheet.getByTestId('mode-switch-count')).toContainText(
    'Nicht alle wartenden Status konnten geladen werden',
  );
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await page.waitForTimeout(500);
  expect((await mock.storedSettings())['publish.mode']).toBe('review');
  for (const key of old) expect(await mock.visibility(key), key).toBe('pending');
});
