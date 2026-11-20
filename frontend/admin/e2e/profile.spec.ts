/**
 * "About you" (owner decision "personal touch") against the mock API, German UI, 390x844:
 * name and greeting are cleaned and saved, the portrait is picked from the photo statuses (also a
 * hidden one, with a hint), removed with undo; a portrait the API refuses (deleted on WhatsApp
 * meanwhile) is reported at the field; the item sheet's "Use as portrait" with undo; the trips
 * list says when a trip is not on the site yet.
 */
import { type APIRequestContext, test as base, expect, type Locator, type Page } from '@playwright/test';

interface Mock {
  settings(): Promise<Record<string, unknown>>;
  revoke(sourceKey: string): Promise<void>;
  hide(sourceKey: string): Promise<void>;
  putTrip(body: Record<string, unknown>): Promise<void>;
}

function mockOf(request: APIRequestContext): Mock {
  let csrf: Promise<string> | null = null;
  const session = () => {
    csrf ??= request
      .post('/api/v1/admin/session', { data: { email: 'owner@example.org', password: 'reisetagebuch' } })
      .then(async (res) => ((await res.json()) as { csrfToken: string }).csrfToken);
    return csrf;
  };
  return {
    settings: async () =>
      ((await (await request.get('/__mock/state')).json()) as { settings: Record<string, unknown> }).settings,
    revoke: async (key) => {
      expect((await request.post(`/__mock/revoke/${encodeURIComponent(key)}`)).status()).toBe(200);
    },
    hide: async (key) => {
      const token = await session();
      const res = await request.patch(`/api/v1/admin/captures/${encodeURIComponent(key)}`, {
        data: { visibility: 'hidden' },
        headers: { 'x-csrf-token': token },
      });
      expect(res.status()).toBe(200);
    },
    putTrip: async (body) => {
      const token = await session();
      const res = await request.put(`/api/v1/admin/trips/${body.slug as string}`, {
        data: body,
        headers: { 'x-csrf-token': token },
      });
      expect(res.status()).toBeLessThan(300);
    },
  };
}

const test = base.extend<{ mock: Mock }>({
  mock: async ({ request }, use) => {
    await request.post('/__mock/reset');
    await use(mockOf(request));
  },
});

async function login(page: Page, target: string) {
  await page.goto(target);
  await expect(page).toHaveURL(/\/admin\/login/);
  await page.getByLabel('E-Mail').fill('owner@example.org');
  await page.getByLabel('Passwort', { exact: true }).fill('reisetagebuch');
  await page.getByRole('button', { name: 'Anmelden' }).click();
}

/** A picker tile: the radio is visually hidden, its photo (the label) is what one taps. */
async function pickTile(radio: Locator) {
  await radio.locator('xpath=..').click();
  await expect(radio).toBeChecked();
}

const HANOI = 'wa:3EB0CCAE0F9B4D04143F';
const HOIAN = 'wa:3EB0B028C9D92EFF4C5B';

test('about you: name and greeting are cleaned and saved; the preview shows them', async ({ page, mock }) => {
  await login(page, '/admin/settings');
  const about = page.locator('#about-you');
  await expect(about.getByRole('heading', { name: 'Über dich' })).toBeVisible();

  await about.getByLabel('Dein Name').fill('  Lea \n ');
  await about.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect.poll(async () => (await mock.settings())['site.author']).toBe('Lea');

  const greeting = about.getByTestId('profile-greeting');
  await greeting.fill('  Hallo ihr Lieben!\n\n\n\nSchön, dass ihr da seid.  ');
  await expect(about.getByText(/^noch \d+$/)).toHaveText(
    `noch ${160 - 'Hallo ihr Lieben!\n\nSchön, dass ihr da seid.'.length}`,
  );
  await about.getByRole('tab', { name: /English/ }).click();
  await greeting.fill('Hello, lovely people!');
  // The preview ("Auf deiner Seite") shows what visitors will see, in the handwritten face.
  await expect(about.locator('figure').getByText('Hello, lovely people!')).toBeVisible();
  await about.getByRole('button', { name: 'Begrüßung speichern' }).click();
  await expect
    .poll(async () => (await mock.settings())['site.intro'])
    .toEqual({ de: 'Hallo ihr Lieben!\n\nSchön, dass ihr da seid.', en: 'Hello, lovely people!' });

  // Too long: an inline note, nothing sent.
  await greeting.fill('x'.repeat(161));
  await expect(about.getByText('Höchstens 160 Zeichen')).toBeVisible();
  await expect(about.getByRole('button', { name: 'Begrüßung speichern' })).toBeDisabled();

  // Emptying the name removes it (null clears the setting).
  await about.getByLabel('Dein Name').fill('   ');
  await about.getByRole('button', { name: 'Entfernen', exact: true }).first().click();
  await expect.poll(async () => 'site.author' in (await mock.settings())).toBe(false);
});

test('about you: pick a portrait (also a hidden photo), remove it, undo', async ({ page, mock }) => {
  await mock.hide(HOIAN);
  await login(page, '/admin/settings');
  const about = page.locator('#about-you');
  await about.getByRole('button', { name: 'Foto auswählen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Dein Porträt auswählen' });
  await expect(sheet).toBeVisible();
  // Photos only, newest first; deleted ones are not offered.
  const choices = sheet.getByRole('radio');
  await expect(choices.first()).toBeVisible();
  await expect(sheet.getByRole('radio', { name: /Laternen \(verwackelt\)/ })).toHaveCount(0);
  await expect(sheet.getByText(/2 Fotos fehlen hier/)).toBeVisible();
  await pickTile(sheet.getByRole('radio', { name: /Hội An.*nicht zu sehen/ }));
  await sheet.getByRole('button', { name: 'Als Porträt verwenden' }).click();
  await expect(sheet).toBeHidden();
  await expect.poll(async () => (await mock.settings())['site.avatar']).toEqual({ sourceKey: HOIAN });
  await expect(page.getByText('Jetzt dein Porträt')).toBeVisible();
  // Hidden in the timeline: the hint says it is still the portrait.
  await expect(about.getByTestId('portrait-hidden-hint')).toBeVisible();
  await expect(about.getByTestId('portrait-preview').first()).toBeVisible();

  await about.getByRole('button', { name: 'Entfernen', exact: true }).last().click();
  await expect.poll(async () => 'site.avatar' in (await mock.settings())).toBe(false);
  const removed = page.getByRole('status').filter({ hasText: 'Porträt entfernt' });
  await expect(removed).toBeVisible();
  await removed.getByRole('button', { name: 'Rückgängig' }).click();
  await expect.poll(async () => (await mock.settings())['site.avatar']).toEqual({ sourceKey: HOIAN });
  await expect(about.getByRole('button', { name: 'Ändern' })).toBeVisible();
});

test('about you: a portrait the API refuses is reported at the field, not saved', async ({ page, mock }) => {
  await login(page, '/admin/settings');
  const about = page.locator('#about-you');
  await about.getByRole('button', { name: 'Foto auswählen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Dein Porträt auswählen' });
  await pickTile(sheet.getByRole('radio', { name: /Angekommen in Hà Nội/ }));
  // Deleted on WhatsApp while the sheet was open: the API answers 422.
  await mock.revoke(HANOI);
  await sheet.getByRole('button', { name: 'Als Porträt verwenden' }).click();
  const error = about.getByTestId('portrait-error');
  await expect(error).toContainText('deleted on WhatsApp');
  await expect(page.getByText(/Speichern fehlgeschlagen/)).toHaveCount(0);
  expect('site.avatar' in (await mock.settings())).toBe(false);
  // The optimistic portrait was rolled back.
  await expect(about.getByRole('button', { name: 'Foto auswählen' })).toBeVisible();
});

test('item sheet: "use as portrait" with undo; a hidden portrait gets a hint', async ({ page, mock }) => {
  await login(page, `/admin/inbox/${encodeURIComponent(HANOI)}`);
  const use = page.getByTestId('use-as-portrait');
  await use.scrollIntoViewIfNeeded();
  await expect(use).toHaveText('Als Porträt verwenden');
  await use.click();
  await expect.poll(async () => (await mock.settings())['site.avatar']).toEqual({ sourceKey: HANOI });
  await expect(use).toHaveText('Als Porträt entfernen');
  // A plain action button: its label says what a tap does, no contradicting "pressed" state.
  await expect(use).not.toHaveAttribute('aria-pressed');
  await expect(page.getByRole('button', { name: 'Als Porträt entfernen' })).toBeVisible();
  await page
    .getByRole('status')
    .filter({ hasText: 'Jetzt dein Porträt' })
    .getByRole('button', { name: 'Rückgängig' })
    .click();
  await expect.poll(async () => 'site.avatar' in (await mock.settings())).toBe(false);
  await expect(use).toHaveText('Als Porträt verwenden');

  await use.click();
  await expect.poll(async () => (await mock.settings())['site.avatar']).toEqual({ sourceKey: HANOI });
  // Hide it in the timeline: still the portrait, and the sheet says so.
  await page.getByRole('group', { name: 'Sichtbarkeit' }).getByText('Versteckt', { exact: true }).click();
  await expect(page.getByTestId('portrait-hidden-hint')).toBeVisible();
  expect((await mock.settings())['site.avatar']).toEqual({ sourceKey: HANOI });
});

test('trips: a trip without a public day says it is not on the site yet', async ({ page, mock }) => {
  await mock.putTrip({
    slug: 'japan-2027',
    title: { de: 'Japan im Frühling' },
    origLocale: 'de',
    startDate: '2027-03-01',
    endDate: '2027-03-20',
  });
  await login(page, '/admin/trips');
  const japan = page.getByRole('link', { name: /Japan im Frühling/ });
  await expect(japan.getByTestId('trip-not-on-site')).toHaveText(
    'Erscheint auf der Seite erst mit dem ersten öffentlichen Tag',
  );
  await expect(page.getByRole('link', { name: /Vietnam 2026/ }).getByTestId('trip-not-on-site')).toHaveCount(0);
});
