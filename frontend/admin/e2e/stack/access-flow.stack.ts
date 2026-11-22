/**
 * The access gate across the WHOLE local stack (spec-wave5 §8.7), no mocks: the real PHP API, the
 * backend in fixture mode with ACCESS_MODE=gate, the generated gate tree and content tree served by
 * a local Apache with the generated .htaccess files, the session-file store on disk, the built
 * admin PWA and the built gate bundle. German UI, phone viewport.
 *
 * Two runs, each with its own stack (root .cache/e2e-stack-gate[-mac], ports API 8081, control
 * 8788, site 4174; override with OMW_GATE_API_PORT / OMW_GATE_CONTROL_PORT / OMW_GATE_SITE_PORT):
 *   - ACCESS_STORE_MODE=direct: the API writes the store itself; the full follower life cycle
 *     (invite → information screen + consent → first device → a second device waits → allow →
 *     remove a device, end a person's access → lock/unlock → changed notice → handoff replay →
 *     a revived session file is repaired by cron → "Your data" export → delete me) and the owner's
 *     password change ending her other sessions;
 *   - ACCESS_STORE_MODE=none: the backend's fallback writer applies the ops (the admin shows "not in
 *     effect yet" until it acknowledges); a backend pointed at the wrong store folder applies
 *     nothing and the admin never claims "in effect".
 * Skipped when no Apache binary is found. Needs `pnpm --filter @omw/admin build` and
 * `pnpm --filter @omw/site build` (SPA + gate bundle) first.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  devices,
  expect,
  type Page,
  request,
  test,
} from '@playwright/test';
import { findApache, REPO, Stack, waitFor } from './stack';

const SHOTS = join(REPO, '.cache/shots/stack-gate');
const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const PORTS = {
  apiPort: env('OMW_GATE_API_PORT', 8081),
  controlPort: env('OMW_GATE_CONTROL_PORT', 8788),
  sitePort: env('OMW_GATE_SITE_PORT', 4174),
};

const CONTEXT_OPTIONS = {
  viewport: { width: 390, height: 844 },
  locale: 'de-DE',
  timezoneId: 'Asia/Ho_Chi_Minh',
  serviceWorkers: 'block' as const,
};
/** The second device looks like an iPhone, so the admin can tell the devices apart. */
const IPHONE_UA = devices['iPhone 13'].userAgent;

interface AdminFollowerJson {
  id: string;
  name: string;
  state: string;
  devices: Array<{ id: string; state: string; label: string; first: boolean }>;
  consent: { version: number } | null;
}
interface AccessStatusJson {
  locked: boolean;
  pendingOps: number;
  writer: { mode: string; blocked: boolean; error: string | null };
  storeId: string | null;
  gateCheck: { result: string; by: string; detail: string | null } | null;
  noticeVersion: number | null;
  mismatch: boolean;
}

/** A follower's browser: its own cookie jar; every request URL is recorded (no secret may show). */
interface Device {
  context: BrowserContext;
  page: Page;
  urls: string[];
}

class Flow {
  readonly stack: Stack;
  api!: APIRequestContext;
  admin!: Page;
  private adminContext!: BrowserContext;
  readonly devices: Device[] = [];

  constructor(stack: Stack) {
    this.stack = stack;
  }

  get site(): string {
    return this.stack.siteUrl;
  }

  async start(browser: Browser): Promise<void> {
    this.stack.prepare();
    await this.stack.startApi();
    await this.stack.startStatic();
    this.api = await request.newContext({ baseURL: this.stack.apiUrl });
    await this.loginApi(this.stack.admin.password);
    this.adminContext = await browser.newContext({ ...CONTEXT_OPTIONS, baseURL: this.stack.apiUrl });
    this.admin = await this.adminContext.newPage();
    if (process.env.OMW_DEBUG_ADMIN) {
      this.admin.on('request', (r) => {
        if (r.url().includes('/api/')) console.log('ADMIN>', r.method(), r.url());
      });
      this.admin.on('response', (r) => {
        if (r.url().includes('/api/') && r.request().method() !== 'GET') console.log('ADMIN<', r.status(), r.url());
      });
      this.admin.on('console', (m) => console.log('ADMIN console', m.type(), m.text()));
    }
    await this.adminLogin(this.admin);
  }

  async loginApi(password: string): Promise<void> {
    const res = await this.api.post('/api/v1/admin/session', { data: { ...this.stack.admin, password } });
    expect(res.status()).toBe(200);
  }

  async stop(): Promise<void> {
    for (const d of this.devices) await d.context.close().catch(() => undefined);
    await this.adminContext?.close().catch(() => undefined);
    await this.api?.dispose();
    await this.stack.stopAll();
  }

  async adminLogin(page: Page, target = '/admin/'): Promise<void> {
    await page.goto(`${this.stack.apiUrl}${target}`);
    await expect(page).toHaveURL(/\/admin\/login/);
    await page.getByLabel('E-Mail').fill(this.stack.admin.email);
    await page.getByLabel('Passwort', { exact: true }).fill(this.stack.admin.password);
    await page.getByRole('button', { name: 'Anmelden' }).click();
    await expect(page).not.toHaveURL(/\/admin\/login/);
  }

  async adminGet<T>(path: string): Promise<T> {
    const res = await this.api.get(`/api/v1/admin${path}`);
    expect(res.status(), path).toBe(200);
    return (await res.json()) as T;
  }

  access(): Promise<AccessStatusJson> {
    return this.adminGet<AccessStatusJson>('/access');
  }

  async follower(name: string): Promise<AdminFollowerJson> {
    const list = await this.adminGet<{ items: AdminFollowerJson[] }>('/followers');
    const f = list.items.find((x) => x.name === name);
    if (!f) throw new Error(`no follower ${name}`);
    return f;
  }

  effect(): ReturnType<Page['getByTestId']> {
    return this.admin.getByTestId('effect-badge');
  }

  async device(browser: Browser, userAgent?: string): Promise<Device> {
    const context = await browser.newContext({ ...CONTEXT_OPTIONS, ...(userAgent ? { userAgent } : {}) });
    const page = await context.newPage();
    const d: Device = { context, page, urls: [] };
    context.on('request', (r) => d.urls.push(r.url()));
    this.devices.push(d);
    return d;
  }

  /** The device's gate cookie value <fid>.<did>.<sid> and its device key (http loopback: omw, omw_k). */
  async secrets(d: Device): Promise<{ session: string; key: string; fid: string; did: string; sid: string }> {
    const cookies = await d.context.cookies(this.site);
    const session = cookies.find((c) => c.name === 'omw')?.value ?? '';
    const key = cookies.find((c) => c.name === 'omw_k')?.value ?? '';
    const [fid = '', did = '', sid = ''] = session.split('.');
    return { session, key, fid, did, sid };
  }

  /** Admin: Menschen → "Website-Speicher einrichten". */
  async initStore(expectApplied: boolean): Promise<void> {
    await this.admin.goto(`${this.stack.apiUrl}/admin/people`);
    const banner = this.admin.getByTestId('banner-store-init');
    await expect(banner).toContainText('Website-Speicher einrichten');
    await banner.getByRole('button', { name: 'Einrichten' }).click();
    await expect(this.effect()).toContainText('Website-Speicher eingerichtet');
    if (expectApplied) await expect(this.effect()).toContainText('Wirksam ✓');
  }

  /** Admin: Datenschutzhinweise → name + e-mail (+ title) → save → publish version n. */
  async publishNotice(n: number, title: string): Promise<void> {
    await this.admin.goto(`${this.stack.apiUrl}/admin/settings/privacy`);
    await expect(this.admin.getByRole('heading', { level: 1, name: 'Datenschutzhinweise' })).toBeVisible();
    await this.admin.getByTestId('privacy-name').fill('Lena Beispiel');
    await this.admin.getByTestId('privacy-email').fill('lena@example.org');
    await this.admin.getByTestId('privacy-title').fill(title);
    await this.admin.getByRole('button', { name: 'Entwurf speichern' }).click();
    await expect(this.admin.getByText('Bereit zum Veröffentlichen')).toBeVisible();
    await this.admin.getByRole('button', { name: `Als Version ${n} veröffentlichen` }).click();
    await this.admin
      .getByRole('dialog', { name: `Version ${n} veröffentlichen?` })
      .getByRole('button', { name: 'Veröffentlichen', exact: true })
      .click();
    await expect(this.admin.getByRole('button', { name: `Als Version ${n + 1} veröffentlichen` })).toBeVisible();
    expect((await this.access()).noticeVersion).toBe(n);
  }

  /** Admin: Menschen → "Person einladen" → the personal link (shown once). */
  async invite(name: string): Promise<string> {
    await this.admin.goto(`${this.stack.apiUrl}/admin/people`);
    await this.admin.getByTestId('invite-open').click();
    const sheet = this.admin.getByRole('dialog', { name: 'Person einladen' });
    await sheet.getByTestId('invite-name').fill(name);
    await sheet.getByRole('button', { name: 'Link erstellen' }).click();
    const linkSheet = this.admin.getByRole('dialog', { name: `Persönlicher Link für ${name}` });
    const link = (await linkSheet.getByTestId('personal-link').textContent()) ?? '';
    expect(link).toMatch(new RegExp(`^${this.site.replace(/[.:/]/g, '\\$&')}/_/join/#t=[A-Za-z0-9_-]{43}$`));
    await linkSheet.getByRole('button', { name: 'Fertig' }).click();
    return link;
  }

  /** The content (the SPA) is on screen: its root rendered, at /<secret>/<locale>/…. */
  async expectContent(page: Page, timeout = 20_000): Promise<void> {
    await expect(page).toHaveURL(new RegExp(`/${this.stack.secret}/de/`), { timeout });
    await expect(page.locator('#omw-root [data-row-date]').first()).toBeVisible({ timeout });
  }

  async expectNeutral(page: Page): Promise<void> {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privat · Private');
  }

  /** Gate pages and the SPA: no request URL ever carries the session id or the device key. */
  async expectNoSecretInUrls(d: Device): Promise<void> {
    const { sid, key } = await this.secrets(d);
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const url of d.urls) {
      expect(url.includes(sid), url).toBe(false);
      expect(url.includes(key), url).toBe(false);
    }
    const log = this.stack.apacheAccessLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log.includes(sid)).toBe(false);
    expect(log.includes(key)).toBe(false);
  }

  /** Waits for the backend's first gate deploy and its anonymous-refused check. */
  async waitForGateDeploy(): Promise<void> {
    const content = join(this.stack.dirs.site, this.stack.secret);
    await waitFor(
      'the first gate deploy',
      async () =>
        existsSync(join(this.stack.dirs.site, '.htaccess')) &&
        existsSync(join(content, '.htaccess')) &&
        existsSync(join(content, 'data/manifest.json')),
      120_000,
    );
    await waitFor(
      'a passing gate check (#1–#5)',
      async () => (await this.access()).gateCheck?.result === 'ok',
      120_000,
    ).catch(async (err) => {
      throw new Error(`${String(err)}; last gate check: ${JSON.stringify((await this.access()).gateCheck)}`);
    });
  }

  storeFiles(rel: string): string[] {
    try {
      return readdirSync(join(this.stack.dirs.store, rel));
    } catch {
      return [];
    }
  }
}

function shot(page: Page, name: string): Promise<Buffer> {
  mkdirSync(SHOTS, { recursive: true });
  return page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

const apache = findApache();

// ---------------------------------------------------------------------------------------------
// ACCESS_STORE_MODE=direct

test.describe('gate stack: the API writes the store (direct)', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!apache, 'no Apache binary with mod_rewrite + mod_headers');

  const flow = new Flow(
    new Stack({ ...PORTS, root: join(REPO, '.cache/e2e-stack-gate'), gate: { storeMode: 'direct' } }),
  );
  const shared: { link?: string; a?: Device; b?: Device; bSession?: string; aSession?: string } = {};

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    await flow.start(browser);
  });
  test.afterAll(async () => {
    await flow.stop();
  });
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern for the fixtures.
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) {
      console.log(
        `--- backend ---\n${flow.stack.logTail('backend')}\n--- api ---\n${flow.stack.logTail('api', 20)}\n--- apache ---\n${flow.stack.logTail('apache-error', 20)}`,
      );
    }
  });

  test('(0)–(2) store set-up, notice v1, first gate deploy; anonymous visitors get nothing', async ({ browser }) => {
    test.setTimeout(240_000);
    await flow.initStore(true);
    const marker = JSON.parse(readFileSync(join(flow.stack.dirs.store, '.omw-store.json'), 'utf8')) as {
      storeId: string;
    };
    expect(marker.storeId).toBe((await flow.access()).storeId);
    await flow.publishNotice(1, 'Datenschutz bei On My Way');

    await flow.stack.startBackend();
    await flow.waitForGateDeploy();

    // Anonymous: every page path is the neutral page, every data/media/dot path the fixed 403,
    // byte-identical for existing and missing paths (no existence oracle).
    const s = flow.stack.secret;
    const days = readdirSync(join(flow.stack.dirs.site, s, 'data/days')).filter((f) => f.endsWith('.json'));
    const day = (days[0] ?? '').replace(/\.json$/, '');
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const neutral = await flow.stack.site('/_/n/');
    expect(neutral.status).toBe(200);
    for (const path of ['/', `/${s}/`, `/${s}/de/`, `/${s}/de/day/${day}/`, `/${s}/de/day/1999-01-01/`, '/nope/']) {
      const r = await flow.stack.site(path, { follow: false });
      expect(r.status, path).toBe(200);
      expect(r.text, path).toBe(neutral.text);
      expect(r.headers.get('set-cookie'), path).toBeNull();
    }
    const forbidden = await flow.stack.site(`/${s}/data/manifest.json`, { follow: false });
    expect(forbidden.status).toBe(403);
    expect(forbidden.text).toBe('Forbidden\n');
    for (const path of [
      `/${s}/data/days/${day}.json`,
      `/${s}/data/days/1999-01-01.json`,
      `/${s}/.omw-deploy.json.gz`,
      '/.omw-gate.json',
      '/.htaccess',
      `/${s}/media/00/0000000000000000_w640.avif`,
    ]) {
      const r = await flow.stack.site(path, { follow: false });
      expect(r.status, path).toBe(403);
      expect(r.text, path).toBe('Forbidden\n');
    }
    // The same in a browser (a link preview sees exactly this).
    const anon = await flow.device(browser);
    await anon.page.goto(`${flow.site}/${s}/de/day/${day}/`);
    await flow.expectNeutral(anon.page);
    await expect(anon.page).toHaveTitle('Privat · Private');
    await shot(anon.page, 'neutral');
  });

  test('(3)–(4) invite Oma; the first device reads the information screen, consents and is in', async ({ browser }) => {
    shared.link = await flow.invite('Oma');
    const a = await flow.device(browser);
    shared.a = a;
    await a.page.goto(shared.link);
    await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('Dieser Link ist für Oma.');
    expect(a.page.url()).toBe(`${flow.site}/_/join/`);
    await expect(a.page.getByText('Datenschutz bei On My Way')).toBeVisible();
    await expect(a.page.getByText('Was gespeichert wird')).toBeVisible();
    await expect(a.page.getByRole('checkbox')).toHaveCount(0);
    await shot(a.page, 'join-info');
    await a.page.getByRole('button', { name: 'Weiter' }).click();
    await flow.expectContent(a.page);
    await expect(a.page.getByRole('contentinfo').getByText('Persönlich geteilt mit Oma')).toBeVisible();

    const cookies = new Map((await a.context.cookies(flow.site)).map((c) => [c.name, c]));
    expect(cookies.get('omw')?.httpOnly).toBe(true);
    expect(cookies.get('omw')?.sameSite).toBe('Lax');
    expect(cookies.get('omw_k')?.sameSite).toBe('Strict');
    expect(cookies.has('omw_s')).toBe(false);
    await flow.expectNoSecretInUrls(a);
    const s = await flow.secrets(a);
    shared.aSession = s.session;
    expect(flow.storeFiles(`s/${s.fid}`)).toEqual([`${s.did}.${s.sid}`]);
    // The SPA's hello used the handoff marker up.
    await waitFor('the handoff marker to go', async () => !flow.storeFiles('h').includes(s.did), 10_000);
    const oma = await flow.follower('Oma');
    expect(oma.devices).toHaveLength(1);
    expect(oma.devices[0]).toMatchObject({ state: 'active', first: true });
    expect(oma.consent?.version).toBe(1);
  });

  test('(5) a second device waits; the owner allows it from Home', async ({ browser }) => {
    const b = await flow.device(browser, IPHONE_UA);
    shared.b = b;
    await b.page.goto(shared.link ?? '');
    await expect(b.page.getByText('Dieses Gerät muss noch bestätigt werden')).toBeVisible();
    await b.page.getByRole('button', { name: 'Weiter' }).click();
    await expect(b.page.getByRole('heading', { level: 1 })).toHaveText('Fast geschafft!');
    expect(b.page.url()).toBe(`${flow.site}/_/wait/`);
    await shot(b.page, 'wait');
    for (let i = 0; i < 3; i++) {
      await b.page.goto(shared.link ?? '');
      await expect(b.page.getByRole('heading', { level: 1 })).toHaveText('Fast geschafft!');
    }
    const oma = await flow.follower('Oma');
    expect(oma.devices.filter((d) => d.state === 'pending')).toHaveLength(1);

    // "Your data" of a waiting device: only itself, nothing about the person, no delete.
    await b.page.goto(`${flow.site}/_/me/`);
    await expect(b.page.getByText(/Dieses Gerät: .* · wartet · seit/)).toBeVisible();
    await expect(b.page.getByText('Oma')).toHaveCount(0);
    await expect(b.page.getByRole('button', { name: /löschen/ })).toHaveCount(0);
    await expect(b.page.getByRole('button', { name: 'Daten exportieren' })).toHaveCount(0);
    await b.page.goto(`${flow.site}/_/wait/`);
    await expect(b.page.getByRole('heading', { level: 1 })).toHaveText('Fast geschafft!');

    // Home shows the waiting device (the status the admin cached a moment ago is still fresh
    // for 5 s; a reload after that fetches it).
    const card = flow.admin.getByTestId('pending-devices');
    await expect(async () => {
      await flow.admin.goto(`${flow.stack.apiUrl}/admin/`);
      await expect(card).toContainText('Neues Gerät für Oma · iPhone', { timeout: 4_000 });
    }).toPass({ timeout: 30_000 });
    await shot(flow.admin, 'admin-pending-device');
    await card.getByRole('button', { name: 'Erlauben' }).click();
    await expect(flow.effect()).toContainText('Wirksam ✓');
    await flow.expectContent(b.page, 15_000);
    await flow.expectNoSecretInUrls(b);
    shared.bSession = (await flow.secrets(b)).session;
  });

  test('(6) removing a device ends it, the other keeps access; ending a person ends hers', async ({ browser }) => {
    const { a, b } = shared as Required<typeof shared>;
    const oma = await flow.follower('Oma');
    await flow.admin.goto(`${flow.stack.apiUrl}/admin/people/${oma.id}`);
    const phone = flow.admin.locator('li', { hasText: 'iPhone' });
    await phone.getByRole('button', { name: 'Entfernen' }).click();
    await flow.admin
      .getByRole('dialog', { name: 'Dieses Gerät entfernen?' })
      .getByRole('button', { name: 'Gerät entfernen' })
      .click();
    await expect(flow.effect()).toContainText('Gerät entfernt');
    await expect(flow.effect()).toContainText('Wirksam ✓');

    await b.page.goto(`${flow.site}/${flow.stack.secret}/de/`);
    await expect(b.page).toHaveURL(`${flow.site}/_/ended/`);
    await expect(b.page.getByText('Kein Zugang auf diesem Gerät.')).toBeVisible();
    await shot(b.page, 'ended');
    await a.page.goto(`${flow.site}/${flow.stack.secret}/de/`);
    await flow.expectContent(a.page);

    // End a whole person's access (Paul, first device in).
    const paulLink = await flow.invite('Paul');
    const p = await flow.device(browser);
    await p.page.goto(paulLink);
    await expect(p.page.getByRole('heading', { level: 1 })).toHaveText('Dieser Link ist für Paul.');
    await p.page.getByRole('button', { name: 'Weiter' }).click();
    await flow.expectContent(p.page);
    const paul = await flow.follower('Paul');
    await flow.admin.goto(`${flow.stack.apiUrl}/admin/people/${paul.id}`);
    await flow.admin.getByRole('button', { name: 'Zugang beenden' }).click();
    await flow.admin
      .getByRole('dialog', { name: 'Zugang für Paul beenden?' })
      .getByRole('button', { name: 'Zugang beenden' })
      .click();
    await expect(flow.effect()).toContainText('Zugang für Paul beendet');
    await expect(flow.effect()).toContainText('Wirksam ✓');
    expect(flow.storeFiles(`s/${paul.id}`)).toEqual([]);
    expect(JSON.parse(readFileSync(join(flow.stack.dirs.store, 't', paul.id), 'utf8'))).toMatchObject({ s: 'revoked' });
    await p.page.goto(`${flow.site}/${flow.stack.secret}/de/`);
    await expect(p.page).toHaveURL(`${flow.site}/_/ended/`);
    // The old link is dead too.
    await p.page.goto(paulLink);
    await expect(p.page.getByText(/nicht \(mehr\) gültig|Kein Zugang/)).toBeVisible();
  });

  test('(7) lock: everyone sees the neutral page (no Clear-Site-Data); unlock with the password', async () => {
    const { a } = shared as Required<typeof shared>;
    await flow.admin.goto(`${flow.stack.apiUrl}/admin/`);
    const shield = flow.admin.getByTestId('lock-card');
    await shield.getByRole('button', { name: 'Jetzt sperren' }).click();
    await flow.admin
      .getByRole('dialog', { name: 'Website jetzt sperren?' })
      .getByRole('button', { name: 'Jetzt sperren' })
      .click();
    await expect(flow.effect()).toContainText('Website gesperrt');
    await expect(flow.effect()).toContainText('Wirksam ✓');
    expect(existsSync(join(flow.stack.dirs.store, 'locked'))).toBe(true);

    const reload = await a.page.goto(`${flow.site}/${flow.stack.secret}/de/`);
    expect(reload?.status()).toBe(200);
    expect(await reload?.headerValue('clear-site-data')).toBeNull();
    const page = await flow.stack.site(`/${flow.stack.secret}/de/`, {
      cookie: `omw=${shared.aSession}`,
      follow: false,
    });
    expect(page.status).toBe(200);
    expect(page.text).toBe((await flow.stack.site('/_/n/')).text);
    expect(page.headers.get('clear-site-data')).toBeNull();
    // The neutral page's script tries to resume once; the API says "not available".
    await expect(a.page.getByText(/Privat · Private|Gerade nicht verfügbar/).first()).toBeVisible();
    const data = await flow.stack.site(`/${flow.stack.secret}/data/manifest.json`, {
      cookie: `omw=${shared.aSession}`,
      follow: false,
    });
    expect(data.status).toBe(403);
    expect(data.headers.get('clear-site-data')).toBeNull();

    await shield.getByRole('button', { name: 'Entsperren' }).click();
    const unlock = flow.admin.getByRole('dialog', { name: 'Website entsperren?' });
    await unlock.getByTestId('unlock-password').fill(flow.stack.admin.password);
    await unlock.getByRole('button', { name: 'Entsperren' }).click();
    await expect(unlock).toBeHidden();
    await expect(shield).toContainText('Nur eingeladene Personen sehen die Reise');
    expect(existsSync(join(flow.stack.dirs.store, 'locked'))).toBe(false);
    await a.page.goto(`${flow.site}/${flow.stack.secret}/de/`);
    await flow.expectContent(a.page);
  });

  test('(8) a new notice version is confirmed again on the next visit', async () => {
    const { a } = shared as Required<typeof shared>;
    await flow.publishNotice(2, 'Datenschutz bei On My Way (neu)');
    // A new tab (the hello throttle is per tab); nothing was cleared.
    const page = await a.context.newPage();
    await page.goto(`${flow.site}/${flow.stack.secret}/de/`);
    await expect(page).toHaveURL(/\/_\/info\//, { timeout: 20_000 });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Die Datenschutzhinweise haben sich geändert.');
    await expect(page.getByText('Datenschutz bei On My Way (neu)')).toBeVisible();
    await page.getByRole('button', { name: 'Weiter' }).click();
    await flow.expectContent(page);
    await page.close();
    expect((await flow.follower('Oma')).consent?.version).toBe(2);
  });

  test('(9) /_/h/ without the device key never completes a handoff', async ({ browser }) => {
    const c = await flow.device(browser);
    await c.page.goto(`${flow.site}/_/h/`);
    await flow.expectNeutral(c.page);
    // Only a copied transfer cookie (a cross-site navigation would drop the Strict key cookie).
    await c.context.addCookies([{ name: 'omw_s', value: shared.aSession ?? '', url: flow.site, sameSite: 'Strict' }]);
    await c.page.goto(`${flow.site}/_/h/`);
    await flow.expectNeutral(c.page);
    expect((await c.context.cookies(flow.site)).some((x) => x.name === 'omw')).toBe(false);
    const raw = await flow.stack.site('/_/h/', { cookie: `omw_s=${shared.aSession}`, follow: false });
    expect(raw.status).toBe(303);
    expect(raw.headers.get('location')).toMatch(/\/_\/join\/#handoff-failed$/);
    expect(raw.headers.get('set-cookie')).toBeNull();
  });

  test('(10) a revoked session file copied back into the store is removed by cron', async () => {
    const [fid = '', did = '', sid = ''] = (shared.bSession ?? '').split('.');
    const file = join(flow.stack.dirs.store, 's', fid, `${did}.${sid}`);
    writeFileSync(file, '');
    const cookie = `omw=${shared.bSession}`;
    const path = `/${flow.stack.secret}/data/manifest.json`;
    expect((await flow.stack.site(path, { cookie, follow: false })).status).toBe(200);
    flow.stack.cron(['access']);
    expect(existsSync(file)).toBe(false);
    expect((await flow.stack.site(path, { cookie, follow: false })).status).toBe(403);
  });

  test('(11) "Your data": export with both consents, then delete me; the owner sees a tombstone', async () => {
    const { a } = shared as Required<typeof shared>;
    const oma = await flow.follower('Oma');
    await a.page.goto(`${flow.site}/_/me/`);
    await expect(a.page.getByText('Persönlich geteilt mit Oma seit')).toBeVisible();
    await shot(a.page, 'your-data');
    const downloading = a.page.waitForEvent('download');
    await a.page.getByRole('button', { name: 'Daten exportieren' }).click();
    const download = await downloading;
    const data = JSON.parse(readFileSync((await download.path()) ?? '', 'utf8')) as {
      format: string;
      follower: { name: string };
      consents: Array<{ version: number }>;
    };
    expect(data.format).toBe('omw-follower-data/1');
    expect(data.follower.name).toBe('Oma');
    // Every successful join records a consent (§3.3): A v1, B v1 (its own join), A v2 (reconfirm).
    expect(data.consents.map((c) => c.version)).toEqual([1, 1, 2]);

    await a.page.getByRole('button', { name: /^Mich und alle meine Daten löschen/ }).click();
    const erase = a.page.getByRole('button', { name: 'Jetzt endgültig löschen' });
    await expect(erase).toBeDisabled();
    await a.page.getByLabel('Ich verstehe, dass alles endgültig gelöscht wird').check();
    await shot(a.page, 'delete-confirm');
    await erase.click();
    await expect(a.page).toHaveURL(`${flow.site}/_/ended/#deleted`);
    await expect(a.page.getByText('Deine Daten wurden gelöscht.')).toBeVisible();
    expect((await a.context.cookies(flow.site)).some((c) => c.name === 'omw_k')).toBe(false);
    expect(flow.storeFiles(`s/${oma.id}`)).toEqual([]);
    expect(JSON.parse(readFileSync(join(flow.stack.dirs.store, 't', oma.id), 'utf8'))).toMatchObject({ s: 'deleted' });
    const r = await flow.stack.site(`/${flow.stack.secret}/data/manifest.json`, {
      cookie: `omw=${shared.aSession}`,
      follow: false,
    });
    expect(r.status).toBe(403);

    const list = await flow.adminGet<{
      items: AdminFollowerJson[];
      tombstones: Array<{ id: string; deletedBy: string }>;
    }>('/followers');
    expect(list.items.some((f) => f.name === 'Oma')).toBe(false);
    expect(list.tombstones).toContainEqual(expect.objectContaining({ id: oma.id, deletedBy: 'follower' }));
    await flow.admin.goto(`${flow.stack.apiUrl}/admin/people`);
    const deleted = flow.admin.getByRole('region', { name: 'Gelöscht' });
    await expect(deleted.getByText(/Person · gelöscht am .* · von der Person selbst/)).toBeVisible();
    await expect(deleted).not.toContainText('Oma');
    const notices = await flow.adminGet<{ items: Array<{ kind: string; readAt: string | null }> }>('/notices');
    expect(notices.items).toContainEqual(expect.objectContaining({ kind: 'follower_deleted', readAt: null }));
    await expect(async () => {
      await flow.admin.goto(`${flow.stack.apiUrl}/admin/`);
      await expect(flow.admin.getByTestId('owner-notices')).toContainText('Eine Person hat ihre Daten gelöscht', {
        timeout: 4_000,
      });
    }).toPass({ timeout: 30_000 });
  });

  test('changing the password ends every other admin session', async () => {
    await flow.admin.goto(`${flow.stack.apiUrl}/admin/settings`);
    await flow.admin.getByRole('button', { name: 'Passwort ändern' }).click();
    const sheet = flow.admin.getByRole('dialog', { name: 'Passwort ändern' });
    const next = 'Laternen-Fest-im-Hafen-21';
    await sheet.getByTestId('password-current').fill(flow.stack.admin.password);
    await sheet.getByTestId('password-new').fill(next);
    await sheet.getByTestId('password-repeat').fill(next);
    await sheet.getByRole('button', { name: 'Passwort ändern' }).click();
    await expect(flow.admin.getByText('Passwort geändert. Andere Geräte wurden abgemeldet.')).toBeVisible();
    // The other session (the request context) is gone; this one stays.
    expect((await flow.api.get('/api/v1/admin/me')).status()).toBe(401);
    await flow.admin.reload();
    await expect(flow.admin).not.toHaveURL(/\/admin\/login/);
    // The old password no longer works, the new one does.
    const old = await flow.api.post('/api/v1/admin/session', { data: flow.stack.admin });
    expect(old.status()).toBe(401);
    await flow.loginApi(next);
  });
});

// ---------------------------------------------------------------------------------------------
// ACCESS_STORE_MODE=none: the backend (the Mac) writes the store

test.describe('gate stack: the backend writes the store (none)', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!apache, 'no Apache binary with mod_rewrite + mod_headers');

  const flow = new Flow(
    new Stack({ ...PORTS, root: join(REPO, '.cache/e2e-stack-gate-mac'), gate: { storeMode: 'none' } }),
  );
  const shared: { link?: string; a?: Device; b?: Device } = {};

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    await flow.start(browser);
  });
  test.afterAll(async () => {
    await flow.stop();
  });
  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructuring pattern for the fixtures.
  test.afterEach(async ({}, info) => {
    if (info.status !== info.expectedStatus) {
      console.log(`--- backend ---\n${flow.stack.logTail('backend')}\n--- api ---\n${flow.stack.logTail('api', 20)}`);
    }
  });

  test('store set-up waits for the backend; the first gate deploy passes the check', async () => {
    test.setTimeout(240_000);
    await flow.initStore(false);
    await expect(flow.effect()).toContainText('Noch nicht wirksam');
    expect(existsSync(join(flow.stack.dirs.store, '.omw-store.json'))).toBe(false);
    await flow.publishNotice(1, 'Datenschutz bei On My Way');
    await flow.stack.startBackend();
    await waitFor(
      'the backend to write the store marker',
      async () => existsSync(join(flow.stack.dirs.store, '.omw-store.json')),
      60_000,
    );
    await flow.waitForGateDeploy();
    expect((await flow.access()).writer.mode).toBe('none');
  });

  test('join waits in "activating" until the backend has applied the session', async ({ browser }) => {
    test.setTimeout(120_000);
    shared.link = await flow.invite('Oma');
    const a = await flow.device(browser);
    shared.a = a;
    await a.page.goto(shared.link);
    await expect(a.page.getByRole('heading', { level: 1 })).toHaveText('Dieser Link ist für Oma.');
    const joined = a.page.waitForResponse((r) => r.url().endsWith('/api/v1/public/join'));
    await a.page.getByRole('button', { name: 'Weiter' }).click();
    expect(((await (await joined).json()) as { status: string }).status).toBe('activating');
    await flow.expectContent(a.page, 60_000);
    await flow.expectNoSecretInUrls(a);
  });

  test('a removed device stays "not in effect yet" until the backend acknowledges, then it is refused', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const b = await flow.device(browser, IPHONE_UA);
    shared.b = b;
    await b.page.goto(shared.link ?? '');
    await b.page.getByRole('button', { name: 'Weiter' }).click();
    await expect(b.page.getByRole('heading', { level: 1 })).toHaveText('Fast geschafft!');
    const oma = await flow.follower('Oma');
    await flow.admin.goto(`${flow.stack.apiUrl}/admin/people/${oma.id}`);
    await flow.admin.locator('li', { hasText: 'iPhone' }).getByRole('button', { name: 'Erlauben' }).click();
    await flow.expectContent(b.page, 60_000);
    const bSession = (await flow.secrets(b)).session;

    await flow.admin.reload();
    await flow.admin.locator('li', { hasText: 'iPhone' }).getByRole('button', { name: 'Entfernen' }).click();
    await flow.admin
      .getByRole('dialog', { name: 'Dieses Gerät entfernen?' })
      .getByRole('button', { name: 'Gerät entfernen' })
      .click();
    await expect(flow.effect()).toContainText('Noch nicht wirksam');
    await expect(flow.effect()).toContainText('Wirksam ✓', { timeout: 60_000 });
    const r = await flow.stack.site(`/${flow.stack.secret}/data/manifest.json`, {
      cookie: `omw=${bSession}`,
      follow: false,
    });
    expect(r.status).toBe(403);
    await b.page.goto(`${flow.site}/${flow.stack.secret}/de/`);
    await expect(b.page).toHaveURL(`${flow.site}/_/ended/`);
  });

  test('a backend pointed at the wrong store folder applies nothing; the admin never says "in effect"', async () => {
    test.setTimeout(180_000);
    await flow.stack.stopBackend();
    const empty = join(flow.stack.root, 'store-elsewhere');
    mkdirSync(empty, { recursive: true });
    flow.stack.writeTargets(empty);
    await flow.stack.startBackend();

    await flow.admin.goto(`${flow.stack.apiUrl}/admin/`);
    const shield = flow.admin.getByTestId('lock-card');
    await shield.getByRole('button', { name: 'Jetzt sperren' }).click();
    await flow.admin
      .getByRole('dialog', { name: 'Website jetzt sperren?' })
      .getByRole('button', { name: 'Jetzt sperren' })
      .click();
    await expect(flow.effect()).toContainText('Noch nicht wirksam');
    // Two fallback intervals and more: still not applied, nothing written anywhere.
    await waitFor(
      'the backend to report the store mismatch',
      async () => /store_unverified/.test((await flow.access()).writer.error ?? ''),
      60_000,
    );
    flow.stack.cron(['alerts']);
    const alerts = (await flow.adminGet<{ alerts: Array<{ kind: string }> }>('/status')).alerts.map((x) => x.kind);
    expect(alerts).toContain('access_store_unverified');
    await expect(flow.effect()).not.toContainText('Wirksam ✓');
    expect(existsSync(join(flow.stack.dirs.store, 'locked'))).toBe(false);
    expect(readdirSync(empty)).toEqual([]);
    expect((await flow.access()).pendingOps).toBeGreaterThan(0);
    // The follower still gets in: the lock is not in effect, and the admin says so.
    const { a } = shared as Required<typeof shared>;
    await a.page.goto(`${flow.site}/${flow.stack.secret}/de/`);
    await flow.expectContent(a.page);
  });
});
