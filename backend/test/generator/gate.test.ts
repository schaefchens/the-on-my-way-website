/**
 * Gate mode of the generator (spec-wave5 §5.4, §5.5, §8.4): the gate tree in GATE_OUT_DIR, the
 * neutral page and its CSP hashes, the public-surface leak test, the exact .htaccess texts and
 * verifyHtaccess(), and the gated content tree (Boot.access, CSP, no robots/sitemap).
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { GateBoot } from '@omw/contracts/access';
import { Boot } from '@omw/contracts/site';
import { afterEach, describe, expect, it } from 'vitest';
import { isGateMode } from '../../src/config.js';
import { fixturesPresent } from '../../src/generator/dev/fixtures.js';
import {
  contentHtaccess,
  GATE_BLOCK_END,
  GATE_BLOCK_START,
  type GateHtaccessConfig,
  gateBlock,
  rootCookieSection,
  rootHtaccess,
} from '../../src/generator/extras.js';
import { GATE_FIXED_FILES, gateHtaccessConfig } from '../../src/generator/gate.js';
import { NEUTRAL_CSS, neutralCsp, neutralPage, neutralScript } from '../../src/generator/gate-pages.js';
import { cspHash } from '../../src/generator/hash.js';
import { startGatePreviewServer } from '../../src/generator/serve.js';
import { SiteBuildError } from '../../src/generator/site-build.js';
import {
  contentLeakFacts,
  GATE_FORBIDDEN_WORDS,
  inspectHtml,
  verifyGateTree,
  verifyHtaccess,
  verifyOutDir,
} from '../../src/generator/verify.js';
import { createHarness, GATE_SECRET, type Harness, readJson, readOut, snapshot } from './harness.js';

const present = fixturesPresent();
let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

function cfgOf(hh: Harness): GateHtaccessConfig {
  if (!isGateMode(hh.config)) throw new Error('not gate mode');
  return gateHtaccessConfig(hh.config.access.site, hh.config.access.secret);
}

const gate = (hh: Harness, rel: string) => readFileSync(join(hh.gateOutDir, rel), 'utf8');

describe.skipIf(!present)('gate tree (spec-wave5 §5.4)', () => {
  it('writes exactly the files of §2.1 into GATE_OUT_DIR, nothing of the content', async () => {
    h = await createHarness({ gate: true });
    const r = await h.generator.generate();
    expect(files(h.gateOutDir)).toEqual(
      [...GATE_FIXED_FILES, '_/assets/gate-St1b.js', '_/assets/gate-St1c.css', '_/assets/gate-St1s.js'].sort(),
    );
    expect(r.gate?.changed).toEqual(files(h.gateOutDir));
    // The content folder is never part of the gate tree, and the source map is not copied.
    expect(files(h.gateOutDir).some((f) => f.includes(GATE_SECRET) || f.endsWith('.map'))).toBe(false);
    expect(gate(h, 'robots.txt')).toBe('User-agent: *\nDisallow: /\n');
    expect(gate(h, '_/403.txt')).toBe('Forbidden\n');
    expect(gate(h, 'favicon.svg')).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });

  it('the neutral page: one byte sequence at three paths and across runs, CSP hashes = its inline bytes', async () => {
    h = await createHarness({ gate: true });
    await h.generator.generate();
    const neutral = gate(h, '_/n/index.html');
    expect(gate(h, 'index.html')).toBe(neutral);
    expect(gate(h, '_/index.html')).toBe(neutral);
    const info = inspectHtml(neutral);
    expect(info.inlineScripts).toHaveLength(1);
    expect(info.styles).toEqual([NEUTRAL_CSS]);
    const cfg = cfgOf(h);
    expect(cfg.cspNeutral).toBe(
      `default-src 'none'; script-src ${cspHash(info.inlineScripts[0] ?? '')}; style-src ${cspHash(NEUTRAL_CSS)}; img-src data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
    );
    expect(gate(h, '.htaccess')).toContain(`Header always set Content-Security-Policy "${cfg.cspNeutral}"`);
    // The script uses the https cookie names and Secure; it never names the API.
    expect(info.inlineScripts[0]).toBe(neutralScript({ key: '__Host-omw_k', resume: '__Host-omw_r', secure: true }));
    expect(neutral).not.toContain('api.example.org');
    expect(neutral).toContain('<title>Privat · Private</title>');
    const before = snapshot(h.gateOutDir);
    h.clock.advance(60_000);
    const again = await h.generator.generate({ full: true });
    expect(again.gate).toEqual({ changed: [], removed: [] });
    expect(snapshot(h.gateOutDir)).toEqual(before);
  });

  it('language order follows site.default_locale; nothing else varies', () => {
    const cookies = { key: 'omw_k', resume: 'omw_r', secure: false };
    const de = neutralPage('de', cookies);
    const en = neutralPage('en', cookies);
    expect(de).toMatch(/^<!doctype html>\n<html lang="de">/);
    expect(en).toMatch(/^<!doctype html>\n<html lang="en">/);
    expect(en).toContain('<title>Private · Privat</title>');
    expect(de.replace(/lang="(?:de|en)"/g, '').length).toBe(en.replace(/lang="(?:de|en)"/g, '').length);
    // http dev: no Secure on the throttle cookie
    expect(neutralScript(cookies)).toContain("'omw_r=1; Path=/; Max-Age=300; SameSite=Strict'");
    expect(neutralCsp(cookies)).toContain(cspHash(neutralScript(cookies)));
  });

  it('gate pages: GateBoot with the API base, cookie names and the bundle; no content path', async () => {
    h = await createHarness({ gate: true });
    await h.generator.generate();
    for (const page of ['join', 'info', 'wait', 'ended', 'me', 'panic'] as const) {
      const html = gate(h, `_/${page}/index.html`);
      const boot = inspectHtml(html).dataScripts.find((d) => d.id === 'omw-gate');
      const parsed = GateBoot.parse(JSON.parse(boot?.body ?? 'null'));
      expect(parsed).toEqual({
        page,
        api: 'https://api.example.org/api/v1/public/',
        locales: ['de', 'en'],
        defaultLocale: 'de',
        cookies: {
          session: '__Host-omw',
          key: '__Host-omw_k',
          transfer: '__Host-omw_s',
          handoff: '__Host-omw_h',
          resume: '__Host-omw_r',
          secure: true,
        },
        cookieMode: 'headers',
        cookieDomain: null,
        build: expect.stringMatching(/^[0-9a-f]{16}$/),
      });
      expect(html).toContain('<script type="module" src="/_/assets/gate-St1b.js"></script>');
      expect(html).toContain('<link rel="stylesheet" href="/_/assets/gate-St1c.css">');
      expect(html).toContain('<link rel="modulepreload" href="/_/assets/gate-St1s.js">');
      expect(html).toContain('<main id="omw-gate-root"></main>');
      expect(html).toContain('<noscript><p>Bitte JavaScript aktivieren / Please enable JavaScript</p></noscript>');
      expect(html).not.toContain(GATE_SECRET);
    }
  });

  it('passes the public-surface leak test with the fixture profile and model; the test catches leaks', async () => {
    h = await createHarness({ gate: true });
    await h.generator.generate();
    const facts = await contentLeakFacts(h.outDir, GATE_SECRET);
    // The fixtures' author, places, dates and ids are among the facts.
    expect(facts).toEqual(expect.arrayContaining(['Lea', GATE_SECRET, '2026-11-15', 'vietnam-2026']));
    const cfg = cfgOf(h);
    expect((await verifyGateTree(h.gateOutDir, { cfg, facts })).problems).toEqual([]);
    // A leak in any file (the bundle included) is found.
    writeFileSync(join(h.gateOutDir, '_/assets/gate-St1s.js'), 'export const x = "Lea";\n');
    writeFileSync(join(h.gateOutDir, '_/assets/gate-St1c.css'), '/* bald auf Reisen */\n');
    writeFileSync(join(h.gateOutDir, '_/assets/extra.map'), '{}');
    writeFileSync(join(h.gateOutDir, '_/stray.html'), '<p>x</p>');
    const problems = (await verifyGateTree(h.gateOutDir, { cfg, facts })).problems;
    expect(problems).toEqual(
      expect.arrayContaining([
        '_/assets/gate-St1s.js: leaks "Lea"',
        '_/assets/gate-St1c.css: contains the word "Reisen"',
        '_/assets/extra.map: not an allowed gate tree file',
        '_/stray.html: not an allowed gate tree file',
      ]),
    );
  });

  it('the word list is whole-word and case-insensitive', async () => {
    h = await createHarness({ gate: true });
    await h.generator.generate();
    const cfg = cfgOf(h);
    const check = async (text: string) => {
      writeFileSync(join(h?.gateOutDir ?? '', '_/assets/gate-St1s.js'), text);
      return (await verifyGateTree(h?.gateOutDir ?? '', { cfg })).problems.filter((p) => p.includes('the word'));
    };
    for (const word of GATE_FORBIDDEN_WORDS) expect(await check(`a ${word.toUpperCase()} b`), word).toHaveLength(1);
    // Not whole words: other, there, tripod, Reisepass, journeyman, herb.
    expect(await check('other there tripod Reisepass journeyman herb hier')).toEqual([]);
  });

  it('strays in GATE_OUT_DIR are removed on full runs; a changed gate tree is a new release', async () => {
    h = await createHarness({ gate: true });
    const first = await h.generator.generate();
    writeFileSync(join(h.gateOutDir, 'old.html'), 'x');
    const incremental = await h.generator.generate();
    expect(incremental.gate?.removed).toEqual([]);
    expect(existsSync(join(h.gateOutDir, 'old.html'))).toBe(true);
    const full = await h.generator.generate({ full: true });
    expect(full.gate?.removed).toEqual(['old.html']);
    expect(full.version).toBeGreaterThan(first.version);
    // A damaged gate file is rewritten and makes a release (the publisher deploys it).
    writeFileSync(join(h.gateOutDir, '_/join/index.html'), 'broken');
    const repaired = await h.generator.generate();
    expect(repaired.gate?.changed).toEqual(['_/join/index.html']);
    expect(repaired.version).toBe(full.version + 1);
  });

  it('refuses gate mode without the gate bundle (SiteBuildError)', async () => {
    h = await createHarness({ gate: true });
    rmSync(join(h.siteDist, 'gate'), { recursive: true, force: true });
    await expect(h.generator.generate()).rejects.toBeInstanceOf(SiteBuildError);
  });
});

describe.skipIf(!present)('gate preview server (spec-wave5 §5.7)', () => {
  it('serves GATE_OUT_DIR at / and OUT_DIR at /<secret>/ without enforcing the gate', async () => {
    h = await createHarness({ gate: true });
    await h.generator.generate();
    const preview = await startGatePreviewServer({
      gateDir: h.gateOutDir,
      outDir: h.outDir,
      secret: GATE_SECRET,
      port: 0,
    });
    try {
      const neutral = await fetch(`${preview.url}_/n/`);
      expect(await neutral.text()).toContain('<title>Privat · Private</title>');
      expect((await fetch(`${preview.url}_/join/`)).status).toBe(200);
      const data = await fetch(`${preview.url}${GATE_SECRET}/data/manifest.json`);
      expect(data.status).toBe(200);
      expect(((await data.json()) as { site: { basePath: string } }).site.basePath).toBe(`/${GATE_SECRET}/`);
      expect((await fetch(`${preview.url}${GATE_SECRET}/de/`)).status).toBe(200);
      expect((await fetch(`${preview.url}.htaccess`)).status).toBe(404);
    } finally {
      await preview.close();
    }
  });
});

describe.skipIf(!present)('gated content tree (spec-wave5 §5.4)', () => {
  it('Boot.access, connect-src with the API origin, worker-src none, noindex, no robots/sitemap', async () => {
    h = await createHarness({ gate: true });
    h.store.owner.setSetting('site.indexable', true);
    await h.generator.generate();
    expect(existsSync(join(h.outDir, 'robots.txt'))).toBe(false);
    expect(existsSync(join(h.outDir, 'sitemap.xml'))).toBe(false);
    const manifest = readJson<{ site: { basePath: string; indexable: boolean } }>(h, 'data/manifest.json');
    expect(manifest.site).toMatchObject({ basePath: `/${GATE_SECRET}/`, indexable: false });
    for (const rel of ['de/index.html', 'de/day/2026-11-15/index.html', '404.html']) {
      const page = readOut(h, rel);
      const boot = Boot.parse(
        JSON.parse(/<script id="omw-boot" type="application\/json">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? 'null'),
      );
      expect(boot.access, rel).toEqual({
        api: 'https://api.example.org/api/v1/public/',
        cookies: { key: '__Host-omw_k', transfer: '__Host-omw_s', handoff: '__Host-omw_h' },
        cookieMode: 'headers',
        cookieDomain: null,
      });
      const csp = inspectHtml(page).csp ?? '';
      expect(csp, rel).toContain("connect-src 'self' https://api.example.org;");
      expect(csp, rel).toContain("worker-src 'none'");
      expect(page, rel).toContain('<meta name="robots" content="noindex, nofollow">');
    }
    expect(inspectHtml(readOut(h, 'index.html')).csp).toContain("worker-src 'none'");
    const cfg = cfgOf(h);
    expect((await verifyOutDir(h.outDir, { gate: cfg })).problems).toEqual([]);
  });

  it('the content .htaccess is contentHtaccess() exactly: gate block appended, private caching, no dot FilesMatch', async () => {
    h = await createHarness({ gate: true });
    await h.generator.generate();
    const cfg = cfgOf(h);
    const content = readOut(h, '.htaccess');
    const manifest = readJson<{ site: Parameters<typeof contentHtaccess>[0] }>(h, 'data/manifest.json');
    expect(content).toBe(contentHtaccess(manifest.site, cfg));
    expect(content).toContain(`ErrorDocument 404 /${GATE_SECRET}/404.html\nErrorDocument 403 /_/403.txt\n`);
    expect(content).toContain('Header set Cache-Control "private, no-cache"');
    expect(content).toContain('Header set Cache-Control "private, max-age=31536000, immutable"');
    expect(content).not.toContain('public, max-age');
    expect(content).toContain('Header always set Referrer-Policy "same-origin"');
    expect(content).not.toMatch(/FilesMatch "\^\\\.|Require/);
    expect(content.endsWith(`${gateBlock(cfg)}\n`)).toBe(true);
    // The same block, byte for byte, in the root file; the cookie section only there.
    const root = gate(h, '.htaccess');
    expect(root).toBe(rootHtaccess(cfg));
    expect(root).toContain(`${gateBlock(cfg)}\n${rootCookieSection(cfg)}\n`);
    expect(content).not.toContain('Set-Cookie');
    // The real outputs pass verifyHtaccess().
    expect(verifyHtaccess(content, 'content', cfg)).toEqual([]);
    expect(verifyHtaccess(root, 'root', cfg)).toEqual([]);
    expect((await verifyGateTree(h.gateOutDir, { cfg })).problems).toEqual([]);
  });

  it('open mode keeps today’s .htaccess, robots.txt and CSP', async () => {
    h = await createHarness();
    await h.generator.generate();
    const content = readOut(h, '.htaccess');
    expect(content).toContain('<FilesMatch "^\\.">');
    expect(content).not.toContain(GATE_BLOCK_START);
    expect(existsSync(join(h.outDir, 'robots.txt'))).toBe(true);
    expect(inspectHtml(readOut(h, 'de/index.html')).csp).toContain("connect-src 'self'; ");
    expect(inspectHtml(readOut(h, 'de/index.html')).csp).toContain("worker-src 'self'");
    expect(existsSync(h.gateOutDir)).toBe(false);
  });
});

describe('gate .htaccess texts (spec-wave5 §2.4)', () => {
  const base: GateHtaccessConfig = {
    storeDir: '/srv/omw-store/site1',
    secret: GATE_SECRET,
    host: 'site.example.org',
    cookieMode: 'headers',
    cookies: {
      session: '__Host-omw',
      key: '__Host-omw_k',
      transfer: '__Host-omw_s',
      handoff: '__Host-omw_h',
      resume: '__Host-omw_r',
      secure: true,
    },
    httpsRedirect: false,
    hsts: true,
    cspNeutral: "default-src 'none'",
    cspGate: "default-src 'none'; connect-src https://api.example.org",
  };
  const site = {
    title: 'T',
    locales: ['de' as const],
    defaultLocale: 'de' as const,
    basePath: `/${GATE_SECRET}/`,
    indexable: false,
  };

  it('the block starts and ends with its markers and carries the store, secret and cookie names', () => {
    const block = gateBlock(base);
    expect(
      block.startsWith(
        `${GATE_BLOCK_START}\nRewriteEngine On\nRewriteOptions InheritDownBefore AllowNoSlash\nDirectorySlash Off\n`,
      ),
    ).toBe(true);
    expect(block.endsWith(GATE_BLOCK_END)).toBe(true);
    expect(block).toContain('RewriteCond /srv/omw-store/site1/s/%1/%2.%3 -f');
    expect(block).toContain(`RewriteRule ^ /${GATE_SECRET}/ [R=303,L,E=OMW_SET:%1.%2.%3,E=OMW_KEY:%{ENV:OMW_HK}]`);
    expect(block).toContain(
      'RewriteCond %{HTTP_COOKIE} (?:^|;\\s*)__Host-omw_s=([a-z2-7]{12})\\.([a-z2-7]{8})\\.([A-Za-z0-9_-]{43})(?:;|$)',
    );
    expect(block).toContain('RewriteRule ^ /_/join/#handoff-failed [R=303,L,NE]');
    expect(block).toContain('RewriteRule ^ /_/n/index.html [END]');
  });

  it('[https] lines only with httpsRedirect; [hsts] only for https', () => {
    expect(gateBlock(base)).not.toContain('%{HTTPS}');
    const redirect = gateBlock({ ...base, httpsRedirect: true });
    expect(redirect).toContain(
      'RewriteRule ^ - [L]\nRewriteCond %{HTTPS} !=on\nRewriteRule ^ https://site.example.org%{REQUEST_URI} [R=301,L]\nRewriteCond %{REQUEST_URI} (?:^|/)\\.\n',
    );
    expect(rootCookieSection(base)).toContain('Header always set Strict-Transport-Security "max-age=31536000"');
    expect(rootCookieSection({ ...base, hsts: false })).not.toContain('Strict-Transport-Security');
  });

  it('headers mode: eight Set-Cookie lines with __Host- names and Secure; http dev names without Secure', () => {
    const lines = rootCookieSection(base)
      .split('\n')
      .filter((l) => l.includes('Set-Cookie'));
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe(
      'Header always add Set-Cookie "__Host-omw=%{OMW_SET}e; Path=/; Max-Age=34560000; Secure; HttpOnly; SameSite=Lax" env=OMW_SET',
    );
    const dev = rootCookieSection({
      ...base,
      cookies: { session: 'omw', key: 'omw_k', transfer: 'omw_s', handoff: 'omw_h', resume: 'omw_r', secure: false },
    });
    expect(dev).toContain('Header always add Set-Cookie "omw_s=; Path=/; Max-Age=0; SameSite=Strict" env=OMW_SET');
    expect(dev).not.toContain('Secure');
  });

  it('co mode (F1): CO flags on the handoff and refresh rules, no Set-Cookie lines', () => {
    const co: GateHtaccessConfig = {
      ...base,
      cookieMode: 'co',
      cookies: { session: 'omw', key: 'omw_k', transfer: 'omw_s', handoff: 'omw_h', resume: 'omw_r', secure: true },
    };
    const block = gateBlock(co);
    expect(block).toContain(
      `RewriteRule ^ /${GATE_SECRET}/ [R=303,L,CO=omw:%1.%2.%3:site.example.org:576000:/:secure:httponly:lax,CO=omw_k:%{ENV:OMW_HK}:site.example.org:576000:/:secure:false:strict,CO=omw_h:1:site.example.org:10:/:secure:false:strict,CO=omw_s:x:site.example.org:-1:/:secure:false:strict]`,
    );
    expect(block).toContain('RewriteRule ^ - [CO=omw:%{ENV:OMW_C}:site.example.org:576000:/:secure:httponly:lax]');
    expect(
      block.match(/RewriteRule \^ - \[CO=omw_k:%1:site\.example\.org:576000:\/:secure:false:strict\]/g),
    ).toHaveLength(2);
    expect(block).not.toContain('E=OMW_SET');
    expect(rootCookieSection(co)).not.toContain('Set-Cookie');
    expect(rootCookieSection({ ...co, cookieMode: 'parent' })).not.toContain('Set-Cookie');
    expect(verifyHtaccess(rootHtaccess(co), 'root', co)).toEqual([]);
  });

  it('verifyHtaccess accepts the real outputs and rejects every forbidden change', () => {
    const content = contentHtaccess(site, base);
    const root = rootHtaccess(base);
    expect(verifyHtaccess(content, 'content', base)).toEqual([]);
    expect(verifyHtaccess(root, 'root', base)).toEqual([]);
    const bad: [string, string, 'root' | 'content', RegExp][] = [
      ['RewriteEngine Off appended', `${content}RewriteEngine Off\n`, 'content', /RewriteEngine Off/],
      [
        'RewriteEngine Off in IfModule',
        `${content}<IfModule mod_rewrite.c>\nRewriteEngine  off\n</IfModule>\n`,
        'content',
        /RewriteEngine Off/,
      ],
      ['IgnoreInherit', `${content}RewriteOptions IgnoreInherit\n`, 'content', /IgnoreInherit/],
      [
        'Require',
        `Require all granted\n${content}`,
        'content',
        /forbidden outside the gate block: Require all granted/,
      ],
      ['Satisfy', `${content}Satisfy Any\n`, 'content', /Satisfy/],
      ['SetEnvIf', `${content}SetEnvIfNoCase Cookie x OMW_OK=1\n`, 'content', /SetEnvIfNoCase/],
      ['stray RewriteRule', `RewriteRule ^ - [L]\n${content}`, 'content', /forbidden outside/],
      ['AuthMerging', `${content}AuthMerging Or\n`, 'content', /AuthMerging/],
      ['Allow/Deny', `${content}Allow from all\n`, 'content', /Allow from all/],
      [
        'edited block',
        content.replace('RewriteRule ^ /_/n/index.html [END]', 'RewriteRule ^ - [L]'),
        'content',
        /gate block differs/,
      ],
      ['no block', content.split(GATE_BLOCK_START)[0] ?? '', 'content', /missing/],
      ['two blocks', `${content}${gateBlock(base)}\n`, 'content', /twice/],
      ['cookie section in content', `${content}${rootCookieSection(base)}\n`, 'content', /root file only/],
      ['edited cookie section', root.replace('Max-Age=600', 'Max-Age=6000'), 'root', /cookie section differs/],
      ['missing cookie section', root.replace(rootCookieSection(base), ''), 'root', /missing/],
    ];
    for (const [label, text, kind, why] of bad) {
      const problems = verifyHtaccess(text, kind, base);
      expect(problems.length, label).toBeGreaterThan(0);
      expect(problems.join('\n'), label).toMatch(why);
    }
  });
});
