/**
 * Gate pages end to end (spec-wave5 §8.5) in a real browser, against the production gate bundle
 * and the mock site host + API of gate-mock.ts (no Apache: the gate rules themselves are tested
 * with Apache in backend/test/gate). Every test checks that no request left for another origin
 * and that no request URL contained a session value or a device key.
 */
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { GateMock, LINK, PANIC_KEY, SECRET, SITE } from './gate-mock.ts';

const DIST = process.env.OMW_GATE_E2E_DIST as string;

let mock: GateMock;
/** Console errors about the Content-Security-Policy (the gate pages run under {{CSP_G}}). */
let cspErrors: string[];

test.beforeEach(() => {
  mock = new GateMock(DIST);
  cspErrors = [];
});

test.afterEach(() => {
  expect(cspErrors).toEqual([]);
  expect(mock.foreign).toEqual([]);
  for (const { url } of mock.requests) {
    for (const secret of mock.secrets()) expect(url.includes(secret), url).toBe(false);
    expect(/[A-Za-z0-9_-]{43}/.test(new URL(url).pathname + new URL(url).search), url).toBe(false);
  }
});

async function device(context: BrowserContext): Promise<Page> {
  await mock.install(context);
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) cspErrors.push(msg.text());
  });
  return page;
}

async function joinFirst(page: Page): Promise<void> {
  await page.goto(`${SITE}/_/join/#t=${LINK}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dieser Link ist für Oma.');
  await page.getByRole('button', { name: 'Weiter' }).click();
  await expect(page.locator('#content')).toBeVisible();
}

test('anonymous: neutral page for pages, 403 for data', async ({ page }) => {
  await mock.install(page.context());
  await page.goto(`${SITE}/${SECRET}/de/`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privat · Private');
  // (The neutral page itself may not connect anywhere: its CSP has no connect-src.)
  const data = await page.goto(`${SITE}/${SECRET}/data/manifest.json`);
  expect(data?.status()).toBe(403);
  expect(await data?.text()).toBe('Forbidden\n');
});

test('first device: information screen, consent, handoff into the content', async ({ context }) => {
  const page = await device(context);
  await page.goto(`${SITE}/_/join/#t=${LINK}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dieser Link ist für Oma.');
  // The secret left the address bar before anything else happened.
  expect(page.url()).toBe(`${SITE}/_/join/`);
  await expect(page.getByText('Was gespeichert wird')).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Weiter' }).click();
  await expect(page.locator('#content')).toBeVisible();
  expect(page.url()).toBe(`${SITE}/${SECRET}/`);
  const cookies = await context.cookies(SITE);
  const byName = new Map(cookies.map((c) => [c.name, c]));
  expect(byName.get('__Host-omw')?.httpOnly).toBe(true);
  expect(byName.get('__Host-omw_k')?.sameSite).toBe('Strict');
  expect(byName.has('__Host-omw_s')).toBe(false);
  expect(mock.devices).toHaveLength(1);
  // Reopening the link on this device goes straight in.
  await page.goto(`${SITE}/_/join/#t=${LINK}`);
  await expect(page.locator('#content')).toBeVisible();
  expect(mock.devices).toHaveLength(1);
});

test('a further device waits, sees only itself under "Your data", and gets in once approved', async ({ browser }) => {
  const first = await device(await browser.newContext());
  await joinFirst(first);

  const context = await browser.newContext();
  const page = await device(context);
  await page.goto(`${SITE}/_/join/#t=${LINK}`);
  await expect(page.getByText('Dieses Gerät muss noch bestätigt werden')).toBeVisible();
  await page.getByRole('button', { name: 'Weiter' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Fast geschafft!');
  expect(page.url()).toBe(`${SITE}/_/wait/`);

  // Reopening the link while waiting creates no second device.
  await page.goto(`${SITE}/_/join/#t=${LINK}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Fast geschafft!');
  expect(mock.devices.filter((d: { state: string }) => d.state === 'pending')).toHaveLength(1);

  // "Your data" of a waiting device: no follower data, no export, no delete.
  await page.goto(`${SITE}/_/me/`);
  await expect(page.getByText(/Dieses Gerät: .* · wartet · seit/)).toBeVisible();
  await expect(page.getByText('Oma')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /löschen/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Daten exportieren' })).toHaveCount(0);

  await page.goto(`${SITE}/_/wait/`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Fast geschafft!');
  mock.approve(0);
  await expect(page.locator('#content')).toBeVisible({ timeout: 15_000 });
});

test('a removed device ends on /_/ended/ (neutral page → resume by key → ended)', async ({ context }) => {
  const page = await device(context);
  await joinFirst(page);
  mock.revoke(mock.devices[0] as (typeof mock.devices)[number]);
  await page.goto(`${SITE}/${SECRET}/de/`);
  await expect(page).toHaveURL(`${SITE}/_/ended/`);
  await expect(page.getByText('Kein Zugang auf diesem Gerät.')).toBeVisible();
});

test('your data: export, then delete me with the deliberate confirmation', async ({ context }) => {
  const page = await device(context);
  await joinFirst(page);
  await page.goto(`${SITE}/_/me/`);
  await expect(page.getByText('Persönlich geteilt mit Oma seit')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Daten exportieren' }).click();
  expect((await download).suggestedFilename()).toBe('on-my-way-data-2026-11-21.json');

  await page.getByRole('button', { name: /^Mich und alle meine Daten löschen/ }).click();
  const erase = page.getByRole('button', { name: 'Jetzt endgültig löschen' });
  await expect(erase).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Abbrechen' })).toBeFocused();
  await page.getByLabel('Ich verstehe, dass alles endgültig gelöscht wird').check();
  await erase.click();
  await expect(page).toHaveURL(`${SITE}/_/ended/#deleted`);
  await expect(page.getByText('Deine Daten wurden gelöscht.')).toBeVisible();
  expect(mock.deleted).toBe(true);
  expect((await context.cookies(SITE)).some((c) => c.name === '__Host-omw_k')).toBe(false);
});

test('a changed notice: reconfirm, then back where the visitor was', async ({ context }) => {
  const page = await device(context);
  await joinFirst(page);
  mock.noticeVersion = 2;
  await page.goto(`${SITE}/_/info/#reconfirm&return=%2F${SECRET}%2Fde%2F`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Die Datenschutzhinweise haben sich geändert.');
  await expect(page.getByText('Datenschutzhinweise (Version 2)')).toBeVisible();
  await page.getByRole('button', { name: 'Weiter' }).click();
  await expect(page).toHaveURL(`${SITE}/${SECRET}/de/`);
  expect(mock.devices[0]?.consented).toContain(2);
});

test('panic link: locks with one tap, the key leaves the address bar', async ({ context }) => {
  const page = await device(context);
  await page.goto(`${SITE}/_/panic/#k=${PANIC_KEY}`);
  expect(page.url()).toBe(`${SITE}/_/panic/`);
  await page.getByRole('button', { name: 'Website jetzt sperren' }).click();
  await expect(page.getByText('Gesperrt (wenn der Link gültig war).')).toBeVisible();
  expect(mock.locked).toBe(true);
});

test('English and the language switch', async ({ context }) => {
  const page = await device(context);
  await page.goto(`${SITE}/_/join/#t=${LINK}`);
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('This link is for Oma.');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
