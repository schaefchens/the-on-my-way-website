/**
 * The gate on a real Apache (spec-wave5 §8.2): the generated gate tree (renderGateTree) and a
 * fixture content tree with the real contentHtaccess() output, served by a local httpd on
 * 127.0.0.1 with the store on a case-sensitive volume. Cases A–P of apache-probe-w5r/run.sh and
 * review-probe/review.sh. Run with `pnpm --filter @omw/backend test:apache` (skipped when no
 * Apache binary is found; not part of the default `pnpm test`).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CookieMode, SiteAccessConfig } from '@omw/contracts/access';
import type { SiteInfo } from '@omw/contracts/site';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentHtaccess, type GateHtaccessConfig } from '../../src/generator/extras.js';
import { gateHtaccessConfig, renderGateTree } from '../../src/generator/gate.js';
import { FORBIDDEN_TXT } from '../../src/generator/gate-pages.js';
import { readGateBuild } from '../../src/generator/site-build.js';
import { verifyHtaccess, verifyOutDir } from '../../src/generator/verify.js';
import { writeFakeGateBuild } from '../generator/harness.js';
import { type ApacheRun, findApache, type HttpAnswer, http, startApache } from './apache-harness.js';

const apache = findApache();
const S = 'k3j9x0m2p7q4r8s1t5u6';
const OTHER = 'zzzzzzzzzzzzzzzzzzzz';
const F = 'abcdefghijkl';
const D = 'abcdefgh';
const SID = 'A'.repeat(43);
const KEY = 'K'.repeat(43);
const STALE_SID = 'B'.repeat(43);
const VALUE = `${F}.${D}.${SID}`;
const HOST = 'site.example.org';

const site: SiteInfo = { title: 'T', locales: ['de', 'en'], defaultLocale: 'de', basePath: `/${S}/`, indexable: false };

let run: ApacheRun;
let cfg: GateHtaccessConfig;
let neutral: Buffer;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 16);
const get = (path: string, cookie?: string) => http(run, path, cookie === undefined ? {} : { cookie });
const view = (a: HttpAnswer) => ({ status: a.status, lines: a.lines, body: sha(a.body) });

function write(rel: string, data: string | Buffer): void {
  const p = join(run.docroot, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
}
function storeFile(rel: string): void {
  const p = join(run.store, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '');
}
function storeRemove(rel: string): void {
  rmSync(join(run.store, rel), { recursive: true, force: true });
}

function accessConfig(over: Partial<SiteAccessConfig> = {}): SiteAccessConfig & { storeDir: string } {
  return {
    mode: 'gate',
    siteOrigin: `https://${HOST}`,
    contentPath: `/${S}/`,
    apiPublicBase: 'https://api.example.org/api/v1/public/',
    cookieMode: 'headers',
    storeDir: run.store,
    httpsRedirect: false,
    ...over,
  } as SiteAccessConfig & { storeDir: string };
}

/** Writes the gate tree and the content tree for an access configuration; returns its config. */
async function deploy(over: Partial<SiteAccessConfig> = {}): Promise<GateHtaccessConfig> {
  const access = accessConfig(over);
  const dist = join(run.dir, 'dist');
  writeFakeGateBuild(dist);
  const files = await renderGateTree({
    site: access,
    secret: S,
    locales: ['de', 'en'],
    defaultLocale: 'de',
    build: await readGateBuild(dist),
  });
  for (const [rel, bytes] of files) write(rel, bytes);
  const c = gateHtaccessConfig(access, S);
  write(`${S}/.htaccess`, contentHtaccess(site, c));
  return c;
}

function contentTree(): void {
  write(`${S}/index.html`, '<p>picker</p>\n');
  write(`${S}/404.html`, '<p>content 404</p>\n');
  write(`${S}/de/index.html`, '<p>home de</p>\n');
  write(`${S}/de/day/2026-11-18/index.html`, '<p>day 18</p>\n');
  write(`${S}/de/day/2026-11-18/story/p_bhhhs5v54ykcijn3/index.html`, '<p>story</p>\n');
  write(`${S}/de/trip/vietnam-2026/index.html`, '<p>trip</p>\n');
  write(`${S}/data/manifest.json`, '{"version":7}\n');
  write(`${S}/data/days/2026-11-18.json`, '{"date":"2026-11-18"}\n');
  write(`${S}/media/ab/0123456789abcdef_w640.avif`, Buffer.from([0, 1, 2, 3]));
  write(`${S}/assets/index-abc.js`, 'console.log(1);\n');
  write(`${S}/.omw-deploy.json.gz`, Buffer.from([0x1f, 0x8b]));
  write('.well-known/acme-challenge/tok123', 'tok123.x\n');
}

describe.skipIf(!apache)('the gate on Apache (spec-wave5 §8.2)', () => {
  beforeAll(async () => {
    if (!apache) return;
    run = await startApache(apache, 'gate');
    contentTree();
    cfg = await deploy();
    storeFile(`s/${F}/${D}.${SID}`);
    neutral = (await get('/_/n/')).body;
  }, 60_000);

  afterAll(async () => {
    await run?.stop();
  }, 30_000);

  const follower = `other=1; __Host-omw=${VALUE}; __Host-omw_k=${KEY}`;
  const handoff = `__Host-omw_k=${KEY}; __Host-omw_s=${VALUE}`;

  it('serves the generated files, which pass verifyHtaccess()', async () => {
    expect(verifyHtaccess(readFileSync(join(run.docroot, '.htaccess'), 'utf8'), 'root', cfg)).toEqual([]);
    expect(verifyHtaccess(readFileSync(join(run.docroot, S, '.htaccess'), 'utf8'), 'content', cfg)).toEqual([]);
    expect(neutral.toString('utf8')).toContain('<title>Privat · Private</title>');
  });

  it('A/H: anonymous pairs are byte-identical (status, headers, body), existing or not', async () => {
    const pairs: [string, string][] = [
      [`/${S}/de/day/2026-11-18/`, `/${S}/de/day/2026-11-19/`],
      [`/${S}/de/day/2026-11-18`, `/${S}/de/day/2026-11-19`],
      [`/${S}/de/trip/vietnam-2026/`, `/${S}/de/trip/japan-2027/`],
      [`/${S}/de/day/2026-11-18/story/p_bhhhs5v54ykcijn3/`, `/${S}/de/day/2026-11-18/story/p_aaaaaaaaaaaaaaaa/`],
      [`/${S}`, `/${OTHER}`],
      [`/${S}/`, `/${OTHER}/`],
      [`/${S}/data/manifest.json`, `/${S}/data/nope.json`],
      [`/${S}/data/manifest.json`, `/${OTHER}/data/manifest.json`],
      [`/${S}/media/ab/0123456789abcdef_w640.avif`, `/${S}/media/ab/ffffffffffffffff_w640.avif`],
      [`/${S}/media/ab/0123456789abcdef_w640.avif`, `/${OTHER}/media/ab/0123456789abcdef_w640.avif`],
      [`/${S}/assets/index-abc.js`, `/${S}/assets/index-nope.js`],
      [`/${S}/.omw-deploy.json.gz`, '/.nope'],
      [`/${S}/.htaccess`, '/.htaccess'],
      ['/x', `/${S}/de/`],
    ];
    for (const [a, b] of pairs) expect(view(await get(a)), `${a} vs ${b}`).toEqual(view(await get(b)));
    const page = await get(`/${S}/de/`);
    expect(page.status).toBe(200);
    expect(page.body.equals(neutral)).toBe(true);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['content-security-policy']).toBe(cfg.cspNeutral);
    expect(page.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
    expect(page.headers.vary).toBe('Cookie');
    expect(page.setCookies).toEqual([]);
    for (const p of [`/${S}/data/manifest.json`, `/${S}/media/ab/0123456789abcdef_w640.avif`, `/${S}/.nope`, '/.env']) {
      const r = await get(p);
      expect(r.status, p).toBe(403);
      expect(r.body.toString(), p).toBe(FORBIDDEN_TXT);
    }
    expect((await get('/')).body.equals(neutral)).toBe(true);
    expect((await get('/robots.txt')).body.toString()).toBe('User-agent: *\nDisallow: /\n');
    expect((await get('/.well-known/acme-challenge/tok123')).status).toBe(200);
  });

  it('B: the handoff sets exactly the four cookies; every other shape fails to one fixed target', async () => {
    storeFile(`h/${D}`);
    const ok = await get('/_/h/', handoff);
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe(`${run.base}/${S}/`);
    expect(ok.setCookies).toEqual([
      `__Host-omw=${VALUE}; Path=/; Max-Age=34560000; Secure; HttpOnly; SameSite=Lax`,
      `__Host-omw_k=${KEY}; Path=/; Max-Age=34560000; Secure; SameSite=Strict`,
      '__Host-omw_s=; Path=/; Max-Age=0; Secure; SameSite=Strict',
      '__Host-omw_h=1; Path=/; Max-Age=600; Secure; SameSite=Strict',
    ]);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.headers['referrer-policy']).toBe('no-referrer');
    const failed = async (label: string, path: string, cookie?: string) => {
      const r = await get(path, cookie);
      expect(r.status, label).toBe(303);
      expect(r.headers.location, label).toBe(`${run.base}/_/join/#handoff-failed`);
      expect(r.setCookies, label).toEqual([]);
    };
    await failed('transfer cookie only', '/_/h/', `__Host-omw_s=${VALUE}`);
    await failed('no cookies', '/_/h/');
    await failed('old 4-part URL', `/_/h/${VALUE}.${KEY}`, handoff);
    await failed('wrong sid', '/_/h/', `__Host-omw_k=${KEY}; __Host-omw_s=${F}.${D}.${STALE_SID}`);
    await failed('malformed transfer cookie', '/_/h/', `__Host-omw_k=${KEY}; __Host-omw_s=${VALUE}.x`);
    await failed('malformed key cookie', '/_/h/', `__Host-omw_k=short; __Host-omw_s=${VALUE}`);
    storeFile('locked');
    await failed('locked', '/_/h/', handoff);
    storeRemove('locked');
    storeRemove(`h/${D}`);
    await failed('marker gone', '/_/h/', handoff);
    await failed('/_/h without slash', '/_/h', handoff);
  });

  it('C/C′: followers get the content with refreshed cookies; gate pages refresh only the key', async () => {
    const page = await get(`/${S}/de/`, follower);
    expect(page.status).toBe(200);
    expect(page.body.toString()).toBe('<p>home de</p>\n');
    expect(page.setCookies).toEqual([
      `__Host-omw=${VALUE}; Path=/; Max-Age=34560000; Secure; HttpOnly; SameSite=Lax`,
      `__Host-omw_k=${KEY}; Path=/; Max-Age=34560000; Secure; SameSite=Strict`,
    ]);
    expect(page.headers['cache-control']).toBe('private, no-cache');
    expect(page.headers['referrer-policy']).toBe('same-origin');
    for (const p of [`/${S}/data/manifest.json`, `/${S}/media/ab/0123456789abcdef_w640.avif`]) {
      const r = await get(p, follower);
      expect(r.status, p).toBe(200);
      expect(r.setCookies, p).toEqual([]);
    }
    expect((await get(`/${S}/media/ab/0123456789abcdef_w640.avif`, follower)).headers['cache-control']).toBe(
      'private, max-age=31536000, immutable',
    );
    const root = await get('/', follower);
    expect([root.status, root.headers.location]).toEqual([302, `${run.base}/${S}/`]);
    const dir = await get(`/${S}/de`, follower);
    expect([dir.status, dir.headers.location]).toEqual([301, `${run.base}/${S}/de/`]);
    const missing = await get(`/${S}/de/day/2026-11-19/`, follower);
    expect([missing.status, missing.body.toString()]).toEqual([404, '<p>content 404</p>\n']);
    for (const p of ['/_/wait/', '/_/me/', '/_/join/', '/_/info/', '/_/ended/']) {
      const r = await get(p, `__Host-omw_k=${KEY}`);
      expect(r.setCookies, p).toEqual([`__Host-omw_k=${KEY}; Path=/; Max-Age=34560000; Secure; SameSite=Strict`]);
      expect((await get(p)).setCookies, `${p} without key`).toEqual([]);
    }
    for (const p of ['/_/n/', '/_/assets/gate-St1b.js', '/_/panic/']) {
      expect((await get(p, `__Host-omw_k=${KEY}`)).setCookies, p).toEqual([]);
    }
    expect((await get('/_/wait/', '__Host-omw_k=short')).setCookies).toEqual([]);
  });

  it('D: a stale gate cookie gets the refusal plus one Clear-Site-Data, never on /_/', async () => {
    const stale = `__Host-omw=${F}.${D}.${STALE_SID}`;
    for (const p of [`/${S}/de/`, `/${S}/data/manifest.json`]) {
      const r = await get(p, stale);
      expect(
        r.lines.filter((l) => l.startsWith('clear-site-data:')),
        p,
      ).toEqual(['clear-site-data: "cache", "storage"']);
    }
    expect((await get('/_/join/', stale)).headers['clear-site-data']).toBeUndefined();
    expect((await get(`/${S}/de/`)).headers['clear-site-data']).toBeUndefined();
  });

  it('E: lock refuses everyone without Clear-Site-Data; gate pages stay public', async () => {
    storeFile('locked');
    try {
      const page = await get(`/${S}/de/`, follower);
      expect(page.body.equals(neutral)).toBe(true);
      expect(page.headers['clear-site-data']).toBeUndefined();
      expect((await get(`/${S}/data/manifest.json`, follower)).status).toBe(403);
      expect((await get('/', follower)).status).toBe(200);
      expect((await get('/_/join/', follower)).status).toBe(200);
    } finally {
      storeRemove('locked');
    }
  });

  it('F/G: the content stays gated without either .htaccess and against sabotage, except RewriteEngine Off', async () => {
    const content = contentHtaccess(site, cfg);
    const gated = async (label: string) => {
      expect((await get(`/${S}/de/`)).body.equals(neutral), `${label} page`).toBe(true);
      expect((await get(`/${S}/data/manifest.json`)).status, `${label} data`).toBe(403);
    };
    try {
      for (const [label, text] of [
        ['prepended stray rules', `RewriteEngine On\nRewriteRule ^ - [L]\n${content}`],
        ['IgnoreInherit', `${content}RewriteOptions IgnoreInherit\n`],
        ['Require all granted', `${content}Require all granted\n`],
        ['Options +Indexes', `${content}Options +Indexes\n`],
      ] as const) {
        write(`${S}/.htaccess`, text);
        await gated(label);
      }
      rmSync(join(run.docroot, S, '.htaccess'));
      await gated('content .htaccess missing');
      // RewriteEngine Off fails open: verify and the publisher refuse such a file.
      write(`${S}/.htaccess`, `${content}RewriteEngine Off\n`);
      expect((await get(`/${S}/data/manifest.json`)).status).toBe(200);
      expect(verifyHtaccess(`${content}RewriteEngine Off\n`, 'content', cfg).join()).toMatch(/RewriteEngine Off/);
    } finally {
      write(`${S}/.htaccess`, content);
    }
    // Known residual (review R7): a stray subdirectory .htaccess with RewriteEngine Off opens
    // that subtree; verifyOutDir() rejects such a tree.
    write(`${S}/de/.htaccess`, 'RewriteEngine Off\n');
    try {
      expect((await get(`/${S}/de/`)).body.toString()).toBe('<p>home de</p>\n');
      const problems = (await verifyOutDir(join(run.docroot, S), { gate: cfg })).problems;
      expect(problems).toContain('de/.htaccess: no other .htaccess may exist in the content tree');
    } finally {
      rmSync(join(run.docroot, S, 'de', '.htaccess'));
    }
    const rootFile = join(run.docroot, '.htaccess');
    const rootText = readFileSync(rootFile);
    rmSync(rootFile);
    try {
      await gated('root .htaccess missing');
      expect((await get(`/${S}/de/`, follower)).body.toString()).toBe('<p>home de</p>\n');
    } finally {
      writeFileSync(rootFile, rootText);
    }
  });

  it('I: gate pages are public with {{CSP_G}}; the neutral page has {{CSP_N}} and no API origin', async () => {
    for (const p of ['/_/join/', '/_/info/', '/_/wait/', '/_/ended/', '/_/me/', '/_/panic/']) {
      const r = await get(p);
      expect(r.status, p).toBe(200);
      expect(r.headers['content-security-policy'], p).toBe(cfg.cspGate);
      expect(r.headers['cache-control'], p).toBe('no-store');
    }
    const n = await get('/_/n/');
    expect(n.headers['content-security-policy']).toBe(cfg.cspNeutral);
    expect(`${n.lines.join('\n')}\n${n.body.toString()}`).not.toContain('api.example.org');
    expect((await get('/_/join')).status).toBe(301);
    expect((await get('/_/assets/gate-St1b.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await get('/_/nope')).status).toBe(404);
  });

  it('N: duplicate cookies (first wins), look-alike names, quoted values and directories are refused', async () => {
    const stale = `__Host-omw=${F}.${D}.${STALE_SID}`;
    const data = `/${S}/data/manifest.json`;
    expect((await get(data, `${stale}; __Host-omw=${VALUE}`)).status).toBe(403);
    expect((await get(data, `__Host-omw=${VALUE}; ${stale}`)).status).toBe(200);
    expect((await get(data, `x__Host-omw=${VALUE}`)).status).toBe(403);
    expect((await get(data, `__Host-omw="${VALUE}"`)).status).toBe(403);
    const dirSid = 'C'.repeat(43);
    mkdirSync(join(run.store, 's', F, `${D}.${dirSid}`), { recursive: true });
    try {
      expect((await get(data, `__Host-omw=${F}.${D}.${dirSid}`)).status).toBe(403);
    } finally {
      storeRemove(`s/${F}/${D}.${dirSid}`);
    }
  });

  it('O: traversal and encoding tricks toward /_/ never reach content', async () => {
    for (const p of [
      `/_/../${S}/data/manifest.json`,
      `/_/%2e%2e/${S}/data/manifest.json`,
      `/_/%2E%2E/${S}/de/`,
      `//${S}/data/manifest.json`,
      `/${S}/%64ata/manifest.json`,
      `/robots.txt/../${S}/data/manifest.json`,
      `/.well-known/acme-challenge/../../${S}/data/manifest.json`,
      `/${S}/data/manifest.json?x=/_/`,
      `/_%2f..%2f${S}/data/manifest.json`,
      `/${S}/data%2fmanifest.json`,
    ]) {
      const r = await get(p);
      const body = r.body.toString();
      expect(body, p).not.toContain('"version":7');
      expect(body, p).not.toContain('home de');
      expect([200, 403, 404], p).toContain(r.status);
    }
  });

  it('P: a session id with flipped case is refused (case-sensitive store volume)', async () => {
    if (!run.caseSensitive) return; // no case-sensitive volume on this machine: nothing to prove
    const flipped = `${F}.${D}.${'a'.repeat(43)}`;
    expect((await get(`/${S}/data/manifest.json`, `__Host-omw=${flipped}`)).status).toBe(403);
  });

  it('L: in layout F3 the store inside the docroot is never served', async () => {
    write('.omw-store/.htaccess', 'Require all denied\nOptions -Indexes\n');
    write(`.omw-store/s/${F}/${D}.${SID}`, '');
    write('.omw-store/.omw-store.json', '{}');
    try {
      for (const p of [`/.omw-store/s/${F}/${D}.${SID}`, '/.omw-store/.omw-store.json', '/.omw-store/']) {
        expect((await get(p)).status, p).toBe(403);
        expect((await get(p, follower)).status, `${p} follower`).toBe(403);
      }
    } finally {
      rmSync(join(run.docroot, '.omw-store'), { recursive: true, force: true });
    }
  });

  it('M: the https redirect is uniform (301 to the configured host) and ACME stays on http', async () => {
    const redirect = await deploy({ httpsRedirect: true });
    try {
      for (const p of [
        '/',
        '/x?q=1',
        `/${S}/de/day/2026-11-18`,
        `/${S}/de/day/2026-11-19`,
        `/${S}/data/manifest.json`,
        '/.env',
        '/_/h/',
      ]) {
        const r = await get(p, follower);
        expect([r.status, r.headers.location], p).toEqual([301, `https://${HOST}${p}`]);
        expect(r.headers['strict-transport-security'], p).toBe('max-age=31536000');
      }
      expect((await get('/.well-known/acme-challenge/tok123')).status).toBe(200);
      expect(redirect.httpsRedirect).toBe(true);
    } finally {
      cfg = await deploy();
    }
  });

  it('J: http dev names (omw, omw_s, no Secure)', async () => {
    await deploy({ siteOrigin: 'http://127.0.0.1:4174', apiPublicBase: 'http://127.0.0.1:8081/api/v1/public/' });
    storeFile(`h/${D}`);
    try {
      const r = await get('/_/h/', `omw_k=${KEY}; omw_s=${VALUE}`);
      expect(r.setCookies).toEqual([
        `omw=${VALUE}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax`,
        `omw_k=${KEY}; Path=/; Max-Age=34560000; SameSite=Strict`,
        'omw_s=; Path=/; Max-Age=0; SameSite=Strict',
        'omw_h=1; Path=/; Max-Age=600; SameSite=Strict',
      ]);
      expect((await get(`/${S}/data/manifest.json`, `omw=${VALUE}`)).status).toBe(200);
    } finally {
      storeRemove(`h/${D}`);
      cfg = await deploy();
    }
  });

  it('K: cookie mode co (F1): CO cookies from the captures and OMW_HK, transfer cookie expired, CO refresh', async () => {
    await deploy({ cookieMode: 'co' as CookieMode, cookieDomain: HOST });
    storeFile(`h/${D}`);
    try {
      const r = await get('/_/h/', `omw_k=${KEY}; omw_s=${VALUE}`);
      expect(r.status).toBe(303);
      expect(r.setCookies.map((c) => c.replace(/expires=[^;]+; /, ''))).toEqual([
        `omw=${VALUE}; path=/; domain=${HOST}; secure; HttpOnly; SameSite=lax`,
        `omw_k=${KEY}; path=/; domain=${HOST}; secure; SameSite=strict`,
        `omw_h=1; path=/; domain=${HOST}; secure; SameSite=strict`,
        `omw_s=x; path=/; domain=${HOST}; secure; SameSite=strict`,
      ]);
      const expired = r.setCookies.find((c) => c.startsWith('omw_s='))?.match(/expires=([^;]+)/)?.[1] ?? '';
      expect(Date.parse(expired)).toBeLessThan(Date.now());
      expect((await get('/_/h/', `omw_s=${VALUE}`)).setCookies).toEqual([]);
      const refresh = await get(`/${S}/de/`, `omw=${VALUE}; omw_k=${KEY}`);
      expect(refresh.setCookies.map((c) => c.split(';')[0]).sort()).toEqual([`omw=${VALUE}`, `omw_k=${KEY}`]);
      expect(refresh.setCookies.every((c) => c.includes(`domain=${HOST}`))).toBe(true);
    } finally {
      storeRemove(`h/${D}`);
      cfg = await deploy();
    }
  });

  it('httpd logged no configuration errors for the generated files', () => {
    expect(run.errorLog()).not.toMatch(/Invalid command|RewriteRule: bad flag|syntax error|AH00526/);
  });
});
