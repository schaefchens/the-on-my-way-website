import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEV_CONTROL_TOKEN, loadConfig, redactConfig } from '../src/config.js';
import { BACKEND_ROOT, REPO_ROOT } from '../src/paths.js';

describe('loadConfig', () => {
  it('uses dev defaults (D7, D12) with an empty environment', () => {
    const c = loadConfig({});
    expect(c.env).toBe('development');
    expect(c.wa.mode).toBe('fixture');
    expect(c.wa.travelerPhone).toBeNull();
    expect(c.wa.sendReadReceipt).toBe(false);
    expect(c.wa.fixturesDir).toBe(join(REPO_ROOT, 'fixtures', 'generated'));
    expect(c.api).toBeNull();
    expect(c.control).toEqual({ host: '127.0.0.1', port: 8787, token: DEV_CONTROL_TOKEN, tokenIsDefault: true });
    expect(c.defaultTimezone).toBe('Europe/Berlin');
    expect(c.dirs).toEqual({
      data: join(BACKEND_ROOT, 'data', 'state'),
      archive: join(BACKEND_ROOT, 'data', 'archive'),
      out: join(BACKEND_ROOT, 'data', 'out'),
      config: join(BACKEND_ROOT, 'data', 'config'),
      media: join(BACKEND_ROOT, 'data', 'media'),
    });
    expect(c.site).toEqual({ publicUrl: null, basePath: '/' });
    expect(c.wa.travelerLid).toBeNull();
    expect(c.wa.mediaGiveUpHours).toBe(48);
  });

  it('keeps MEDIA_DIR next to OUT_DIR in production (hard links need one filesystem)', () => {
    const c = loadConfig({ NODE_ENV: 'production', TRAVELER_PHONE: '4915100000001', CONTROL_TOKEN: 'x'.repeat(16) });
    expect(c.dirs.data).toBe('/data');
    expect(c.dirs.media).toBe(join(BACKEND_ROOT, 'data', 'media'));
    expect(c.dirs.out).toBe(join(BACKEND_ROOT, 'data', 'out'));
  });

  it('derives the basePath from SITE_PUBLIC_URL', () => {
    expect(loadConfig({ SITE_PUBLIC_URL: 'https://example.org/travel' }).site).toEqual({
      publicUrl: 'https://example.org/travel',
      basePath: '/travel/',
    });
    expect(loadConfig({ SITE_PUBLIC_URL: 'https://example.org/' }).site.basePath).toBe('/');
  });

  it('parses a full production environment', () => {
    const c = loadConfig({
      NODE_ENV: 'production',
      WA_MODE: 'observer',
      TRAVELER_PHONE: '+49 151 0000 0001',
      SEND_READ_RECEIPT: 'true',
      API_BASE_URL: 'https://api.example.org/',
      API_TOKEN: 'omw_backend_token',
      CONTROL_TOKEN: 'a-very-long-control-token',
      CONTROL_PORT: '9000',
      NTFY_URL: 'https://ntfy.sh/omw-test',
      DEFAULT_TIMEZONE: 'Asia/Ho_Chi_Minh',
      ARCHIVE_DIR: '/srv/archive',
      TRAVELER_LID: '100000000000001',
      MEDIA_DIR: '/srv/media',
      LOG_LEVEL: 'warn',
    });
    expect(c.env).toBe('production');
    expect(c.logLevel).toBe('warn');
    expect(c.wa.travelerPhone).toBe('4915100000001');
    expect(c.wa.sendReadReceipt).toBe(true);
    expect(c.api).toEqual({ baseUrl: 'https://api.example.org', token: 'omw_backend_token' });
    expect(c.control.port).toBe(9000);
    expect(c.control.tokenIsDefault).toBe(false);
    expect(c.ntfyUrl).toBe('https://ntfy.sh/omw-test');
    expect(c.defaultTimezone).toBe('Asia/Ho_Chi_Minh');
    expect(c.dirs.data).toBe('/data');
    expect(c.dirs.archive).toBe('/srv/archive');
    expect(c.dirs.media).toBe('/srv/media');
    expect(c.wa.travelerLid).toBe('100000000000001');
  });

  it('refuses the public development token on a non-loopback control address', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.20', 'omw.local']) {
      expect(() => loadConfig({ CONTROL_HOST: host }), host).toThrow(/CONTROL_TOKEN is required when CONTROL_HOST/);
      expect(loadConfig({ CONTROL_HOST: host, CONTROL_TOKEN: 'my-own-token' }).control.tokenIsDefault).toBe(false);
    }
    for (const host of ['127.0.0.1', 'localhost', '::1', '127.0.0.2']) {
      expect(loadConfig({ CONTROL_HOST: host }).control.tokenIsDefault, host).toBe(true);
    }
  });

  it('requires an https API_BASE_URL in production unless the host is loopback (L1-08)', () => {
    const prod = {
      NODE_ENV: 'production',
      TRAVELER_PHONE: '4915100000001',
      CONTROL_TOKEN: 'a-very-long-control-token',
      API_TOKEN: 'omw_backend_token',
    };
    expect(() => loadConfig({ ...prod, API_BASE_URL: 'http://api.example.org/' })).toThrow(
      /API_BASE_URL must use https:\/\/ in production/,
    );
    expect(() => loadConfig({ ...prod, API_BASE_URL: 'http://10.0.0.5:8080' })).toThrow(/https/);
    expect(loadConfig({ ...prod, API_BASE_URL: 'https://api.example.org/' }).api?.baseUrl).toBe(
      'https://api.example.org',
    );
    for (const url of ['http://127.0.0.1:8080', 'http://127.0.0.2', 'http://localhost:8080/', 'http://[::1]:8080']) {
      expect(loadConfig({ ...prod, API_BASE_URL: url }).api, url).not.toBeNull();
    }
    // development and test keep accepting plain http (local API, e2e stacks)
    expect(loadConfig({ API_BASE_URL: 'http://api.example.org', API_TOKEN: 't' }).api?.baseUrl).toBe(
      'http://api.example.org',
    );
    expect(loadConfig({ NODE_ENV: 'test', API_BASE_URL: 'http://api.example.org', API_TOKEN: 't' }).api?.baseUrl).toBe(
      'http://api.example.org',
    );
  });

  it('parses API_BACKUP_KEEP (default 7)', () => {
    expect(loadConfig({}).apiBackupKeep).toBe(7);
    expect(loadConfig({ API_BACKUP_KEEP: '3' }).apiBackupKeep).toBe(3);
    expect(() => loadConfig({ API_BACKUP_KEEP: '0' })).toThrow(/API_BACKUP_KEEP/);
  });

  it('treats empty strings as unset', () => {
    const c = loadConfig({ API_BASE_URL: '', API_TOKEN: '', WA_MODE: '', LOG_LEVEL: '' });
    expect(c.api).toBeNull();
    expect(c.wa.mode).toBe('fixture');
  });

  it.each([
    [{ WA_MODE: 'observer' }, /TRAVELER_PHONE is required/],
    [{ API_BASE_URL: 'https://api.example.org' }, /must be set together/],
    [{ NODE_ENV: 'production', TRAVELER_PHONE: '4915100000001' }, /CONTROL_TOKEN is required/],
    [{ NODE_ENV: 'production', TRAVELER_PHONE: '4915100000001', CONTROL_TOKEN: 'short' }, /at least 16/],
    [{ WA_MODE: 'carrier-pigeon' }, /WA_MODE/],
    [{ TRAVELER_PHONE: '0151 12345' }, /TRAVELER_PHONE/],
    [{ CONTROL_PORT: '70000' }, /CONTROL_PORT/],
    [{ DEFAULT_TIMEZONE: 'Mars/Olympus' }, /DEFAULT_TIMEZONE/],
    [{ API_BASE_URL: 'ftp://x', API_TOKEN: 't' }, /API_BASE_URL/],
    [{ TRAVELER_LID: '12ab' }, /TRAVELER_LID/],
    [{ SITE_PUBLIC_URL: 'https://example.org/a b/' }, /SITE_PUBLIC_URL/],
    [{ SITE_PUBLIC_URL: 'https://example.org/?x=1' }, /SITE_PUBLIC_URL/],
  ])('rejects %o', (env, message) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(message);
  });

  it('redacts secrets', () => {
    const c = loadConfig({ API_BASE_URL: 'https://api.example.org', API_TOKEN: 'secret-token', CONTROL_TOKEN: 'x' });
    const text = JSON.stringify(redactConfig(c));
    expect(text).not.toContain('secret-token');
    expect(text).toContain('***');
  });
});

describe('access gate config (spec-wave5 §5.1)', () => {
  const SECRET = 'k3j9x0m2p7q4r8s1t5u6';
  const gate = {
    ACCESS_MODE: 'gate',
    SITE_PUBLIC_URL: `https://site.example.org/${SECRET}/`,
    API_PUBLIC_URL: 'https://api.example.org/',
    ACCESS_STORE_DIR: '/usr/home/omw/omw-store/site1',
  };

  it('defaults to open mode; the site description only when the URLs are known', () => {
    const open = loadConfig({});
    expect(open.access).toMatchObject({ mode: 'open', site: null, secret: null });
    expect(open.access?.gateOutDir).toBe(join(BACKEND_ROOT, 'data', 'out-gate'));
    const described = loadConfig({
      SITE_PUBLIC_URL: 'http://127.0.0.1:4173/',
      API_BASE_URL: 'http://127.0.0.1:8081',
      API_TOKEN: 't',
    });
    expect(described.access?.site).toEqual({
      mode: 'open',
      siteOrigin: 'http://127.0.0.1:4173',
      contentPath: '/',
      apiPublicBase: 'http://127.0.0.1:8081/api/v1/public/',
      cookieMode: 'headers',
      httpsRedirect: false,
    });
  });

  it('builds the gate configuration: origin, content folder, public API base, store', () => {
    const c = loadConfig(gate);
    expect(c.access).toEqual({
      mode: 'gate',
      secret: SECRET,
      gateOutDir: join(BACKEND_ROOT, 'data', 'out-gate'),
      site: {
        mode: 'gate',
        siteOrigin: 'https://site.example.org',
        contentPath: `/${SECRET}/`,
        apiPublicBase: 'https://api.example.org/api/v1/public/',
        cookieMode: 'headers',
        storeDir: '/usr/home/omw/omw-store/site1',
        httpsRedirect: false,
      },
    });
    // API_PUBLIC_URL defaults to API_BASE_URL (with its path).
    const viaBase = loadConfig({
      ...gate,
      API_PUBLIC_URL: '',
      API_BASE_URL: 'https://example.org/omw',
      API_TOKEN: 't',
    });
    expect(viaBase.access?.site?.apiPublicBase).toBe('https://example.org/omw/api/v1/public/');
    expect(
      loadConfig({ ...gate, ACCESS_COOKIE_MODE: 'co', ACCESS_COOKIE_DOMAIN: 'site.example.org' }).access?.site,
    ).toMatchObject({ cookieMode: 'co', cookieDomain: 'site.example.org' });
    expect(loadConfig({ ...gate, ACCESS_HTTPS_REDIRECT: 'true' }).access?.site?.httpsRedirect).toBe(true);
  });

  it.each([
    [{ ...gate, SITE_PUBLIC_URL: '' }, /needs SITE_PUBLIC_URL/],
    [{ ...gate, API_PUBLIC_URL: '' }, /needs API_PUBLIC_URL/],
    [{ ...gate, ACCESS_STORE_DIR: '' }, /storeDir/],
    [{ ...gate, ACCESS_STORE_DIR: '/srv/../etc' }, /storeDir/],
    [{ ...gate, ACCESS_STORE_DIR: '/srv//store' }, /storeDir/],
    [{ ...gate, ACCESS_STORE_DIR: '/srv/a b' }, /storeDir/],
    [{ ...gate, ACCESS_STORE_DIR: '/srv/$x' }, /storeDir/],
    [{ ...gate, SITE_PUBLIC_URL: 'https://site.example.org/travel/' }, /contentPath/],
    [{ ...gate, SITE_PUBLIC_URL: `https://site.example.org/${SECRET}/de/` }, /contentPath/],
    [{ ...gate, SITE_PUBLIC_URL: `http://site.example.org/${SECRET}/` }, /must be https/],
    [{ ...gate, API_PUBLIC_URL: 'http://api.example.org/' }, /apiPublicBase must be https/],
    [{ ...gate, ACCESS_COOKIE_DOMAIN: 'example.org' }, /must not be set with cookieMode "headers"/],
    [{ ...gate, ACCESS_COOKIE_MODE: 'co', ACCESS_COOKIE_DOMAIN: 'example.org' }, /cookieDomain = the site host/],
    [{ ...gate, ACCESS_COOKIE_MODE: 'parent', ACCESS_COOKIE_DOMAIN: 'other.org' }, /parent domain/],
    [{ ...gate, ACCESS_COOKIE_MODE: 'cookie-jar' }, /ACCESS_COOKIE_MODE/],
    [{ ...gate, OUT_DIR: '/srv/site', GATE_OUT_DIR: '/srv/site/gate' }, /GATE_OUT_DIR/],
  ])('rejects %o', (env, message) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(message);
  });

  it('accepts http only for a loopback site (local Apache tests)', () => {
    const c = loadConfig({
      ACCESS_MODE: 'gate',
      SITE_PUBLIC_URL: `http://127.0.0.1:4174/${SECRET}/`,
      API_PUBLIC_URL: 'http://127.0.0.1:8081/',
      ACCESS_STORE_DIR: '/tmp/omw-store',
    });
    expect(c.access?.site?.siteOrigin).toBe('http://127.0.0.1:4174');
  });
});

describe('no hostname literals (Q9)', () => {
  /** Every origin comes from config: no source file names the live hosts. */
  it('backend, API, frontends and contracts never hard-code the live host names', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const roots = ['backend/src', 'api/src', 'packages/contracts/src'];
    for (const app of readdirSync(join(REPO_ROOT, 'frontend'))) {
      const src = join('frontend', app, 'src');
      try {
        if (statSync(join(REPO_ROOT, src)).isDirectory()) roots.push(src);
      } catch {
        // not an app with sources
      }
    }
    const hits: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(REPO_ROOT, rel), { withFileTypes: true })) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name !== 'node_modules' && e.name !== 'vendor') walk(child);
          continue;
        }
        if (!/\.(?:ts|tsx|js|mjs|php|json|css|html)$/.test(e.name)) continue;
        const text = readFileSync(join(REPO_ROOT, child), 'utf8');
        if (/schaefchens/i.test(text)) hits.push(`${child}: schaefchens`);
        if (/your-server\.de/i.test(text) && child !== 'backend/src/publisher/hostkeys.ts') {
          hits.push(`${child}: your-server.de`);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(hits).toEqual([]);
  });
});
