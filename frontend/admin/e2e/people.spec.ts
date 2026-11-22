/**
 * People and access (spec-wave5 §7, §8.6) against the mock API, German UI, 390x844: the store
 * set-up banner, inviting a person (link sheet with share/copy, shown once), allowing and
 * declining devices (Home cards and the person screen), the device limit, removing a device,
 * ending access, the data export, deleting a person into a nameless tombstone, lock/unlock with
 * the password, "not in effect yet" while the Mac writes, the privacy draft → publish, the safety
 * options, the access status texts and the password change with and without the app-token box.
 */
import { type APIRequestContext, test as base, expect, type Page } from '@playwright/test';

interface AccessSnapshot {
  state: { locked: boolean; storeId: string | null; panicLink: boolean };
  followers: Array<{
    id: string;
    state: string;
    name: string | null;
    createdAt: string;
    deletedAt: string | null;
    deletedBy: string | null;
    devices: Array<{ id: string; state: string }>;
  }>;
  versions: Array<{ version: number }>;
}

interface Mock {
  access(): Promise<AccessSnapshot>;
  settings(): Promise<Record<string, unknown>>;
  tokens(): Promise<Array<{ kind: string; revokedAt: string | null }>>;
  password(): Promise<string>;
  setAccess(patch: Record<string, unknown>): Promise<void>;
  ack(): Promise<void>;
  addDevice(fid: string, opts?: { label?: string; minutesAgo?: number; state?: 'pending' | 'active' }): Promise<string>;
  addNotice(kind: string): Promise<void>;
  appToken(password: string): Promise<void>;
}

interface MockState {
  access: AccessSnapshot;
  settings: Record<string, unknown>;
  tokens: Array<{ kind: string; revokedAt: string | null }>;
  ownerPassword: string;
}

function mockOf(request: APIRequestContext): Mock {
  const state = async () => (await (await request.get('/__mock/state')).json()) as MockState;
  return {
    access: async () => (await state()).access,
    settings: async () => (await state()).settings,
    tokens: async () => (await state()).tokens,
    password: async () => (await state()).ownerPassword,
    setAccess: async (patch) => {
      expect((await request.post('/__mock/access', { data: patch })).status()).toBe(200);
    },
    ack: async () => {
      expect((await request.post('/__mock/access/ack')).status()).toBe(200);
    },
    addDevice: async (fid, opts = {}) =>
      ((await (await request.post('/__mock/device', { data: { fid, ...opts } })).json()) as { did: string }).did,
    addNotice: async (kind) => {
      expect((await request.post('/__mock/notice', { data: { kind } })).status()).toBe(200);
    },
    appToken: async (password) => {
      const login = await request.post('/api/v1/admin/session', {
        data: { email: 'owner@example.org', password },
      });
      const { csrfToken } = (await login.json()) as { csrfToken: string };
      const res = await request.post('/api/v1/admin/tokens', {
        data: { kind: 'app', name: 'Kurzbefehl' },
        headers: { 'x-csrf-token': csrfToken },
      });
      expect(res.status()).toBe(201);
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
  await expect(page).not.toHaveURL(/\/admin\/login/);
}

const effect = (page: Page) => page.getByTestId('effect-badge');

test('store set-up banner, then invite a person: the link is shown once, shared and copied', async ({
  page,
  context,
  mock,
}) => {
  await mock.setAccess({ storeId: null });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    (window as unknown as { __shared: unknown[] }).__shared = [];
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: unknown) => {
        (window as unknown as { __shared: unknown[] }).__shared.push(data);
      },
    });
  });
  await login(page, '/admin/settings');
  await page.getByRole('link', { name: /Menschen & Zugang/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Menschen' })).toBeVisible();

  const banner = page.getByTestId('banner-store-init');
  await expect(banner).toContainText('Website-Speicher einrichten');
  await banner.getByRole('button', { name: 'Einrichten' }).click();
  await expect(effect(page)).toContainText('Website-Speicher eingerichtet');
  await expect(effect(page)).toContainText('Wirksam ✓');
  await expect(banner).toBeHidden();
  expect((await mock.access()).state.storeId).toMatch(/^[0-9a-f]{16}$/);

  await page.getByTestId('invite-open').click();
  const sheet = page.getByRole('dialog', { name: 'Person einladen' });
  await sheet.getByTestId('invite-name').fill('  Lisa  ');
  await sheet.getByTestId('invite-note').fill('Nachbarin, gießt die Blumen');
  await expect(sheet.getByText('So sieht die Person es: „Dieser Link ist für Lisa.“')).toBeVisible();
  await sheet.getByRole('button', { name: 'Link erstellen' }).click();

  const linkSheet = page.getByRole('dialog', { name: 'Persönlicher Link für Lisa' });
  await expect(linkSheet).toBeVisible();
  const url = await linkSheet.getByTestId('personal-link').textContent();
  expect(url).toMatch(/^https:\/\/site\.example\.org\/_\/join\/#t=[A-Za-z0-9_-]{43}$/);
  await expect(linkSheet.getByText(/Der Link wird nur jetzt angezeigt/)).toBeVisible();
  await linkSheet.getByRole('button', { name: 'Teilen' }).click();
  const shared = await page.evaluate(() => (window as unknown as { __shared: Array<{ text: string }> }).__shared);
  expect(shared[0]?.text).toBe(
    `Hallo Lisa! Hier ist dein persönlicher Link zu meiner Reise. Bitte gib ihn nicht weiter: ${url}`,
  );
  await linkSheet.getByText('English', { exact: true }).click();
  await linkSheet.getByRole('button', { name: 'Teilen' }).click();
  const sharedEn = await page.evaluate(() => (window as unknown as { __shared: Array<{ text: string }> }).__shared);
  expect(sharedEn[1]?.text).toContain('Hi Lisa! Here is your personal link');
  await linkSheet.getByRole('button', { name: 'Link kopieren' }).click();
  await expect(linkSheet.getByRole('button', { name: 'Kopiert' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  await linkSheet.getByRole('button', { name: 'Fertig' }).click();
  await expect(linkSheet).toBeHidden();

  // Shown once: the person's screen never shows the link again.
  await page.getByRole('link', { name: /Lisa/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Lisa' })).toBeVisible();
  await expect(page.getByText('Nachbarin, gießt die Blumen')).toBeVisible();
  await expect(page.getByTestId('personal-link')).toHaveCount(0);
  expect(await page.content()).not.toContain(url ?? 'none');
  const lisa = (await mock.access()).followers.find((f) => f.name === 'Lisa');
  expect(lisa?.state).toBe('active');
});

test('new devices: allow from Home, decline on the person screen, the device limit', async ({ page, mock }) => {
  await mock.addDevice('omaomaomaoma', { label: 'Android · Chrome', minutesAgo: 4, state: 'pending' });
  await mock.addDevice('omaomaomaoma', { label: 'iPad · Safari', minutesAgo: 2, state: 'pending' });
  await login(page, '/admin/');
  const card = page.getByTestId('pending-devices');
  await expect(card).toContainText('2 neue Geräte warten');
  await expect(card).toContainText('Neues Gerät für Oma · Android · Chrome · vor 4 Minuten');
  // The phone tab bar marks Settings while devices wait.
  await expect(page.getByTestId('settings-pending-dot')).toBeVisible();

  await card
    .getByRole('listitem')
    .filter({ hasText: 'Android · Chrome' })
    .getByRole('button', { name: 'Erlauben' })
    .click();
  await expect(effect(page)).toContainText('Gerät für Oma erlaubt');
  await expect(effect(page)).toContainText('Wirksam ✓');
  await expect(card).toContainText('Ein neues Gerät wartet');

  await card.getByRole('link', { name: 'Details' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Oma' })).toBeVisible();
  const waiting = page.locator('li', { hasText: 'Wartet' }).filter({ hasText: 'iPad · Safari' });
  await expect(waiting.getByText(/Erlaube nur Geräte, die du dieser Person zuordnen kannst/)).toBeVisible();
  await waiting.getByRole('button', { name: 'Ablehnen' }).click();
  await expect(effect(page)).toContainText('Gerät abgelehnt');
  await expect(page.locator('li', { hasText: 'Abgelehnt' }).filter({ hasText: 'iPad · Safari' })).toBeVisible();
  const oma = (await mock.access()).followers.find((f) => f.id === 'omaomaomaoma');
  expect(oma?.devices.map((d) => d.state).sort()).toEqual(['active', 'active', 'active', 'declined']);

  // Paul already has the most devices allowed (5): a sixth waits and cannot be allowed.
  for (let i = 0; i < 4; i++) await mock.addDevice('paulpaulpaul', { state: 'active' });
  await mock.addDevice('paulpaulpaul', { label: 'Windows · Edge', state: 'pending' });
  await page.goto('/admin/people/paulpaulpaul');
  const sixth = page.locator('li', { hasText: 'Windows · Edge' });
  await sixth.getByRole('button', { name: 'Erlauben' }).click();
  await expect(sixth.getByRole('alert')).toHaveText('Paul hat schon 5 Geräte. Entferne zuerst eines.');
});

test('remove a device, end access, export, delete a person into a nameless tombstone', async ({ page, mock }) => {
  await login(page, '/admin/people/omaomaomaoma');
  await expect(page.getByText('Hinweise v1 bestätigt am', { exact: false })).toBeVisible();

  // Remove one device (confirm first).
  const phone = page.locator('li', { hasText: 'iPhone · WhatsApp' });
  await phone.getByRole('button', { name: 'Entfernen' }).click();
  const removeSheet = page.getByRole('dialog', { name: 'Dieses Gerät entfernen?' });
  await removeSheet.getByRole('button', { name: 'Gerät entfernen' }).click();
  await expect(effect(page)).toContainText('Gerät entfernt');
  await expect(phone.getByText('Entfernt', { exact: true })).toBeVisible();

  // Export: a JSON download in the contract's format.
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Daten exportieren' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^on-my-way-data-oma-\d{4}-\d{2}-\d{2}\.json$/);
  const path = await download.path();
  const { readFile } = await import('node:fs/promises');
  const data = JSON.parse(await readFile(path, 'utf8')) as { format: string; follower: { name: string } };
  expect(data.format).toBe('omw-follower-data/1');
  expect(data.follower.name).toBe('Oma');

  // End access: the confirmation explains what stays and the WhatsApp step.
  await page.getByRole('button', { name: 'Zugang beenden' }).click();
  const endSheet = page.getByRole('dialog', { name: 'Zugang für Oma beenden?' });
  await expect(endSheet).toContainText('Oma sieht ab sofort nur noch die neutrale Seite.');
  await expect(endSheet).toContainText('Nimm Oma auch in WhatsApp aus deinem Status-Publikum.');
  await endSheet.getByRole('button', { name: 'Zugang beenden' }).click();
  await expect(effect(page)).toContainText('Zugang für Oma beendet');
  await expect(page.getByText('Zugang beendet am', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Neuen Link erstellen' })).toHaveCount(0);

  // Delete everything: the red button works only after ticking the box.
  await page.getByRole('button', { name: 'Löschen …' }).click();
  const del = page.getByRole('dialog', { name: 'Alle Daten von Oma löschen?' });
  const red = del.getByRole('button', { name: 'Jetzt endgültig löschen' });
  await expect(red).toBeDisabled();
  await del.getByRole('checkbox', { name: 'Ich verstehe, dass alles endgültig gelöscht wird' }).check();
  await red.click();
  await expect(page).toHaveURL(/\/admin\/people$/);
  const deleted = page.getByRole('region', { name: 'Gelöscht' });
  await expect(deleted.getByText(/Person · gelöscht am .* · von dir/)).toBeVisible();
  await expect(deleted).not.toContainText('Oma');
  const oma = (await mock.access()).followers.find((f) => f.id === 'omaomaomaoma');
  expect(oma).toMatchObject({ state: 'deleted', name: null, deletedBy: 'owner' });
  // No invitation date kept: created = deleted.
  expect(oma?.createdAt).toBe(oma?.deletedAt);
});

test('a new link replaces the old one; the owner notice about a self-deletion', async ({ page, mock }) => {
  await mock.addNotice('follower_deleted');
  await login(page, '/admin/');
  const notices = page.getByTestId('owner-notices');
  await expect(notices).toContainText('Eine Person hat ihre Daten gelöscht');
  await notices.getByRole('button', { name: 'OK' }).click();
  await expect(notices).toBeHidden();

  await page.goto('/admin/people/paulpaulpaul');
  await page.getByRole('button', { name: 'Neuen Link erstellen' }).click();
  const confirm = page.getByRole('dialog', { name: 'Neuen Link erstellen?' });
  await expect(confirm).toContainText('Der alte Link funktioniert dann nicht mehr.');
  await confirm.getByRole('button', { name: 'Neuen Link erstellen' }).click();
  const linkSheet = page.getByRole('dialog', { name: 'Persönlicher Link für Paul' });
  await expect(linkSheet.getByTestId('personal-link')).toHaveText(/#t=[A-Za-z0-9_-]{43}$/);
  await linkSheet.getByRole('button', { name: 'Schließen' }).click();
  await expect(page.getByTestId('personal-link')).toHaveCount(0);
});

test('lock and unlock with the password; while the Mac writes, changes wait until it applies them', async ({
  page,
  mock,
}) => {
  await login(page, '/admin/');
  const shield = page.getByTestId('lock-card');
  await expect(shield).toContainText('Nur eingeladene Personen sehen die Reise');
  await shield.getByRole('button', { name: 'Jetzt sperren' }).click();
  const confirm = page.getByRole('dialog', { name: 'Website jetzt sperren?' });
  await expect(confirm).toContainText('Alle sehen sofort nur die neutrale Seite, auch eingeladene Personen.');
  await confirm.getByRole('button', { name: 'Jetzt sperren' }).click();
  await expect(effect(page)).toContainText('Website gesperrt');
  await expect(shield).toContainText('Gesperrt seit');
  expect((await mock.access()).state.locked).toBe(true);

  await shield.getByRole('button', { name: 'Entsperren' }).click();
  const unlock = page.getByRole('dialog', { name: 'Website entsperren?' });
  await unlock.getByTestId('unlock-password').fill('falsch');
  await unlock.getByRole('button', { name: 'Entsperren' }).click();
  await expect(unlock.getByText('Das Passwort stimmt nicht.')).toBeVisible();
  expect((await mock.access()).state.locked).toBe(true);
  await unlock.getByTestId('unlock-password').fill('reisetagebuch');
  await unlock.getByRole('button', { name: 'Entsperren' }).click();
  await expect(unlock).toBeHidden();
  await expect(shield).toContainText('Nur eingeladene Personen sehen die Reise');

  // The Mac is the writer: "not in effect yet" until it acknowledges.
  await mock.setAccess({ writerMode: 'none' });
  await shield.getByRole('button', { name: 'Jetzt sperren' }).click();
  await page
    .getByRole('dialog', { name: 'Website jetzt sperren?' })
    .getByRole('button', { name: 'Jetzt sperren' })
    .click();
  await expect(effect(page)).toContainText('Noch nicht wirksam ⏳ – dein Computer zu Hause überträgt es');
  await expect(effect(page)).not.toContainText('Wirksam ✓');
  await expect(shield.getByTestId('access-behind')).toContainText('Änderungen noch nicht wirksam');
  await mock.ack();
  await expect(effect(page)).toContainText('Wirksam ✓', { timeout: 10_000 });
});

test('an action without a connection says "not sent", never a success', async ({ page }) => {
  await login(page, '/admin/people/paulpaulpaul');
  await expect(page.getByRole('heading', { level: 1, name: 'Paul' })).toBeVisible();
  await page.route('**/api/v1/admin/followers/paulpaulpaul/revoke', (route) => route.abort('internetdisconnected'));
  await page.getByRole('button', { name: 'Zugang beenden' }).click();
  await page
    .getByRole('dialog', { name: 'Zugang für Paul beenden?' })
    .getByRole('button', { name: 'Zugang beenden' })
    .click();
  await expect(effect(page)).toContainText('Nicht gesendet – keine Verbindung');
  await expect(effect(page)).not.toContainText('Wirksam');
});

test('privacy notice: edit the draft, save it, publish version 1', async ({ page, mock }) => {
  await mock.setAccess({ noticeVersions: 0 });
  await login(page, '/admin/people');
  const banner = page.getByTestId('banner-notice-missing');
  await expect(banner).toContainText('Bevor jemand beitreten kann, veröffentliche die Datenschutzhinweise.');
  await banner.getByRole('link', { name: 'Datenschutzhinweise öffnen' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Datenschutzhinweise' })).toBeVisible();
  await expect(page.getByTestId('privacy-template-banner')).toContainText('Vorlage – keine Rechtsberatung.');
  await expect(page.getByTestId('privacy-problems')).toContainText('Verantwortlich: Name');
  const publish = page.getByRole('button', { name: 'Als Version 1 veröffentlichen' });
  await expect(publish).toBeDisabled();

  await page.getByTestId('privacy-name').fill('Lena Beispiel');
  await page.getByTestId('privacy-email').fill('lena@example.org');
  await page.getByTestId('privacy-title').fill('Datenschutz bei On My Way');
  await expect(page.getByRole('article').getByRole('heading', { name: 'Datenschutz bei On My Way' })).toBeVisible();
  await expect(publish).toBeDisabled(); // unsaved edits are not published
  await page.getByRole('button', { name: 'Entwurf speichern' }).click();
  await expect(page.getByText('Bereit zum Veröffentlichen')).toBeVisible();
  await publish.click();
  const confirm = page.getByRole('dialog', { name: 'Version 1 veröffentlichen?' });
  await expect(confirm).toContainText('Alle Personen sehen den neuen Text beim nächsten Besuch und bestätigen ihn.');
  await confirm.getByRole('button', { name: 'Veröffentlichen', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Version 1/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Als Version 2 veröffentlichen' })).toBeVisible();
  expect((await mock.access()).versions.map((v) => v.version)).toEqual([1]);
  // The unchanged text is not published again (everyone would have to confirm it once more).
  await expect(page.getByTestId('privacy-unchanged')).toHaveText(
    'Gleich wie Version 1. Ändere den Text, um eine neue Version zu veröffentlichen.',
  );
  await expect(page.getByRole('button', { name: 'Als Version 2 veröffentlichen' })).toBeDisabled();
});

test('safety options are saved; access status texts; the panic link is shown once', async ({ page, mock }) => {
  await mock.setAccess({ gateCheck: null, storeProofAt: null });
  await login(page, '/admin/settings/safety');
  await expect(page.getByRole('heading', { level: 1, name: 'Sicherheit' })).toBeVisible();

  // Controlled by the (optimistically updated) settings: click, then wait for the new state.
  const slots = page.getByRole('switch', { name: 'Nur zu festen Uhrzeiten' });
  await slots.click();
  await expect(slots).toBeChecked();
  await page.getByLabel('Uhrzeit hinzufügen').fill('13:30');
  await page.getByRole('button', { name: 'Hinzufügen', exact: true }).click();
  await expect
    .poll(async () => (await mock.settings())['publish.release_slots'])
    .toEqual({ enabled: true, times: ['08:00', '13:30', '20:00'] });
  await page.getByRole('button', { name: '08:00 entfernen' }).click();
  await expect
    .poll(async () => (await mock.settings())['publish.release_slots'])
    .toEqual({ enabled: true, times: ['13:30', '20:00'] });

  const hold = page.getByRole('switch', { name: 'Warten aufs Weiterreisen' });
  await hold.click();
  await expect(hold).toBeChecked();
  await page.getByRole('group', { name: 'Höchstzahl an Tagen' }).getByText('3', { exact: true }).click();
  await expect
    .poll(async () => (await mock.settings())['publish.departure_hold'])
    .toEqual({ enabled: true, maxDays: 3 });
  await page.getByRole('button', { name: 'Sie ist weitergereist' }).click();
  await expect.poll(async () => typeof (await mock.settings())['publish.moved_on_at']).toBe('string');

  await page.getByText('Nur das Land', { exact: true }).click();
  await expect.poll(async () => (await mock.settings())['site.here_now']).toBe('country');
  await page.getByText('Nur Tageszeit', { exact: true }).click();
  await expect.poll(async () => (await mock.settings())['site.time_precision']).toBe('part_of_day');

  await expect(page.getByTestId('access-proven')).toContainText('Zugang noch nicht geprüft');
  await expect(page.getByTestId('access-gate-check')).toContainText('nicht geprüft');
  await mock.setAccess({
    gateCheck: { at: new Date().toISOString(), by: 'mac', result: 'error', detail: 'blocked' },
  });
  await page.reload();
  await expect(page.getByTestId('access-gate-check')).toContainText('Gate-Prüfung nicht möglich (seit');

  await page.getByRole('button', { name: 'Panik-Link erstellen' }).click();
  const sheet = page.getByRole('dialog', { name: 'Dein Panik-Link' });
  await expect(sheet.getByTestId('personal-link')).toHaveText(/\/_\/panic\/#k=[A-Za-z0-9_-]{43}$/);
  await sheet.getByRole('button', { name: 'Fertig' }).click();
  await expect(page.getByTestId('panic-state')).toHaveText('Es gibt einen Panik-Link.');
  await page.getByRole('button', { name: 'Deaktivieren' }).click();
  await page
    .getByRole('dialog', { name: 'Panik-Link deaktivieren?' })
    .getByRole('button', { name: 'Deaktivieren' })
    .click();
  await expect(page.getByTestId('panic-state')).toHaveText('Noch kein Panik-Link.');
  expect((await mock.access()).state.panicLink).toBe(false);
});

test('departure hold on Home: days wait until she has moved on, one tap releases them', async ({
  page,
  request,
  mock,
}) => {
  await request.post('/__mock/settings', { data: { 'publish.departure_hold': { enabled: true, maxDays: 7 } } });
  await request.post('/__mock/capture', { data: { minutesAgo: 30, caption: 'Laternen am Fluss' } });
  await login(page, '/admin/');
  const card = page.getByTestId('hold-card');
  // Today's status has no place yet; older seed days may still wait too (depends on the date).
  await expect(card).toContainText(/Ohne Ort: \d+ Tage? warte[nt], bis sie weitergereist ist \(spätestens /);
  await card.getByRole('button', { name: 'Sie ist weitergereist' }).click();
  await expect.poll(async () => typeof (await mock.settings())['publish.moved_on_at']).toBe('string');
  await expect(card).toBeHidden();
});

test('change password: without app tokens no box; with app tokens the box ends them too', async ({ page, mock }) => {
  await login(page, '/admin/settings');
  await page.getByRole('button', { name: 'Passwort ändern' }).click();
  let sheet = page.getByRole('dialog', { name: 'Passwort ändern' });
  await expect(sheet.getByTestId('password-revoke-apps')).toHaveCount(0);
  await sheet.getByTestId('password-current').fill('reisetagebuch');
  await sheet.getByTestId('password-new').fill('kurz');
  await expect(sheet.getByTestId('password-strength')).toContainText('Zu kurz: mindestens 12 Zeichen');
  await sheet.getByTestId('password-new').fill('Passwort1234');
  await expect(sheet.getByTestId('password-strength')).toHaveAttribute('data-strength', 'weak');
  await sheet.getByTestId('password-new').fill('Laternen-Fest-im-Hafen-21');
  await expect(sheet.getByTestId('password-strength')).toContainText('Stark');
  await sheet.getByTestId('password-repeat').fill('Laternen-Fest-im-Hafen-2');
  await expect(sheet.getByText('Die beiden neuen Passwörter sind nicht gleich.')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Passwort ändern' })).toBeDisabled();
  await sheet.getByTestId('password-repeat').fill('Laternen-Fest-im-Hafen-21');
  await sheet.getByTestId('password-current').fill('falsch');
  await sheet.getByRole('button', { name: 'Passwort ändern' }).click();
  await expect(sheet.getByRole('alert')).toContainText('Das aktuelle Passwort stimmt nicht.');
  await sheet.getByTestId('password-current').fill('reisetagebuch');
  await sheet.getByRole('button', { name: 'Passwort ändern' }).click();
  await expect(page.getByText('Passwort geändert. Andere Geräte wurden abgemeldet.')).toBeVisible();
  await expect(sheet).toBeHidden();
  expect(await mock.password()).toBe('Laternen-Fest-im-Hafen-21');

  // With an app token the (pre-ticked) box appears and ends it too; the Mac's token stays.
  await mock.appToken('Laternen-Fest-im-Hafen-21');
  await page.reload();
  await page.getByRole('button', { name: 'Passwort ändern' }).click();
  sheet = page.getByRole('dialog', { name: 'Passwort ändern' });
  await expect(sheet.getByTestId('password-revoke-apps')).toBeChecked();
  await expect(sheet.getByText('Auch alle App-Zugänge beenden (1 Token)')).toBeVisible();
  await sheet.getByTestId('password-current').fill('Laternen-Fest-im-Hafen-21');
  await sheet.getByTestId('password-new').fill('drei kleine boote im nebel');
  await sheet.getByTestId('password-repeat').fill('drei kleine boote im nebel');
  await sheet.getByRole('button', { name: 'Passwort ändern' }).click();
  await expect(sheet).toBeHidden();
  const tokens = await mock.tokens();
  expect(tokens.filter((t) => t.kind === 'app').every((t) => t.revokedAt !== null)).toBe(true);
  expect(tokens.filter((t) => t.kind === 'backend').every((t) => t.revokedAt === null)).toBe(true);
});
