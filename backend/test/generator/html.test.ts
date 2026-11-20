import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PageStyles } from '../../src/generator/css.js';
import { fixturesPresent } from '../../src/generator/dev/fixtures.js';
import { canonicalJson, contentHash, cspHash } from '../../src/generator/hash.js';
import {
  escapeHtml,
  Html,
  html,
  inlineCode,
  joinHtml,
  jsonForScript,
  safeHref,
  trustedHtml,
} from '../../src/generator/html.js';
import { renderMarkdown } from '../../src/generator/markdown.js';
import { NOSCRIPT_CSS, needsVietnamese, THEME_BOOT_SCRIPT } from '../../src/generator/pages.js';
import { inspectHtml } from '../../src/generator/verify.js';
import { REPO_ROOT } from '../../src/paths.js';
import { makeTempDir } from '../helpers.js';
import { bootOf, createHarness, type Harness, readOut, writeFakeSiteBuild } from './harness.js';

describe('html`` (escaping by construction)', () => {
  it('escapes every interpolated string, in text and attributes', () => {
    const evil = `"><img src=x onerror=alert(1)>&'`;
    const out = html`<p title="${evil}">${evil}</p>`.value;
    expect(out).toBe(
      '<p title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&amp;&#39;">&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&amp;&#39;</p>',
    );
    expect(out).not.toContain('<img');
  });

  it('passes nested Html through, flattens arrays and drops null/false', () => {
    const items = ['a<b', 'c'];
    const out = html`<ul>${items.map((i) => html`<li>${i}</li>`)}${null}${false}${undefined}${0}</ul>`.value;
    expect(out).toBe('<ul><li>a&lt;b</li><li>c</li>0</ul>');
    expect(joinHtml(['x', html`<br>`, 'y'], ', ').value).toBe('x, <br>, y');
  });

  it('cannot be forged: Html instances only come from the module', () => {
    expect(() => new (Html as unknown as new (v: string, t: symbol) => Html)('<x>', Symbol('omw.html'))).toThrow();
    const fake = { value: '<script>alert(1)</script>' };
    expect(html`${fake as unknown as string}`.value).toBe('[object Object]');
    expect(html`${trustedHtml('<b>ok</b>')}`.value).toBe('<b>ok</b>');
  });

  it('rejects non-finite numbers', () => {
    expect(() => html`${Number.NaN}`).toThrow(RangeError);
  });

  it('escapeHtml covers the five special characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

describe('jsonForScript', () => {
  it('can never close the script element and survives U+2028/9', () => {
    const value = { a: '</script><script>alert(1)</script>', b: '<!-- x -->', c: 'line\u2028sep\u2029', d: 'a&b' };
    const out = jsonForScript(value).value;
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(out)).toEqual(value);
  });
});

describe('inlineCode / safeHref', () => {
  it('refuses inline code that could break out of its element', () => {
    expect(() => inlineCode('a</script>b')).toThrow();
    expect(() => inlineCode('a</STYLE>b')).toThrow();
    expect(() => inlineCode('<!-- x')).toThrow();
    expect(inlineCode('body{color:red}').value).toBe('body{color:red}');
  });

  it('only allows http(s) and root-relative URLs', () => {
    expect(safeHref('/de/day/2026-11-15/')).toBe('/de/day/2026-11-15/');
    expect(safeHref('https://example.org/x?y=1')).toBe('https://example.org/x?y=1');
    for (const bad of ['javascript:alert(1)', '//evil.example/', 'data:text/html,x', '/a"b', 'de/x']) {
      expect(() => safeHref(bad)).toThrow(RangeError);
    }
  });
});

describe('markdown (stories)', () => {
  it('shows raw HTML as text and drops dangerous links', () => {
    const out = renderMarkdown(
      '<script>alert(1)</script>\n\n[x](javascript:alert(1)) [y](vbscript:x) [z](data:text/html;base64,PHNjcmlwdD4=) [ok](https://example.org/a)\n\n![img](https://evil.example/i.png)',
    ).value;
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toMatch(/href="(?:javascript|vbscript|data):/i);
    expect(out).toContain('<a href="https://example.org/a" rel="nofollow noopener noreferrer">ok</a>');
    expect(out).not.toContain('<img');
  });

  it('renders the usual formatting', () => {
    const out = renderMarkdown('## Title\n\n**bold** *it*\n\n- a\n- b\n\n> quote').value;
    expect(out).toContain('<h2>Title</h2>');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<li>a</li>');
    expect(out).toContain('<blockquote>');
  });
});

describe('hashes and page styles', () => {
  it('canonical JSON ignores key order and undefined members', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe('{"a":[1,{"d":2}],"b":1}');
    expect(contentHash({ x: 1, y: 2 })).toBe(contentHash({ y: 2, x: 1 }));
    expect(contentHash({ x: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });

  it('cspHash is the base64 sha256 of the exact text', () => {
    expect(cspHash('')).toBe("'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='");
  });

  it('PageStyles only accepts validated colours and fonts', () => {
    const s = new PageStyles();
    expect(s.imageColor('#a1b2c3')).toBe('omw-c-a1b2c3');
    expect(s.textColors('#3b2341ff', '#ffffffff')).toBe('omw-t-3b2341ff-ffffffff');
    expect(s.waFont('CALISTOGA_REGULAR')).toBe('omw-wa-calistoga-regular');
    expect(() => s.imageColor('red;}</style><script>')).toThrow(RangeError);
    expect(() => s.textColors('#fff', '#000')).toThrow(RangeError);
    expect(s.css()).toContain('.omw-c-a1b2c3{background-color:#a1b2c3}');
    expect(s.css()).not.toContain('<');
  });
});

// ---------------------------------------------------------------------------------------------
// Generated pages: first-screen twin, preloads, theme boot script, no-JS article (L3-01/02/03/13/16/17)

describe.skipIf(!fixturesPresent())('generated pages: head, twin and article', () => {
  let h: Harness | null = null;
  const page = (rel: string) => readOut(h as Harness, rel);
  const twinOf = (p: string) =>
    p.slice(p.indexOf('<div id="omw-root">'), p.indexOf('<noscript>', p.indexOf('<div id="omw-root">')));
  const articleOf = (p: string) => {
    const start = p.indexOf('<noscript>', p.indexOf('<div id="omw-root">')) + '<noscript>'.length;
    return p.slice(start, p.indexOf('</noscript>', start));
  };
  const headOf = (p: string) => p.slice(0, p.indexOf('</head>'));
  const preloads = (p: string) => [...headOf(p).matchAll(/<link rel="preload"[^>]*>/g)].map((m) => m[0]);
  const modulepreloads = (p: string) =>
    [...headOf(p).matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]);

  beforeAll(async () => {
    const tmp = makeTempDir('html-twin-');
    writeFakeSiteBuild(join(tmp.dir, 'dist'), { lazy: true });
    h = await createHarness({ siteDist: join(tmp.dir, 'dist') });
    const cleanup = h.cleanup;
    h.cleanup = () => {
      cleanup();
      tmp.cleanup();
    };
    await h.generator.generate();
  });
  afterAll(() => h?.cleanup());

  it('the theme boot script is a verbatim copy of @omw/ui THEME_BOOT_SCRIPT, inlined before the stylesheet', () => {
    const source = readFileSync(join(REPO_ROOT, 'frontend', 'shared', 'src', 'theme.ts'), 'utf8');
    const m = /export const THEME_BOOT_SCRIPT =\s*"((?:[^"\\]|\\.)*)";/.exec(source);
    expect(m, 'THEME_BOOT_SCRIPT in frontend/shared/src/theme.ts').not.toBeNull();
    expect(JSON.parse(`"${m?.[1]}"`)).toBe(THEME_BOOT_SCRIPT);
    for (const rel of ['de/index.html', 'en/day/2026-11-15/index.html', '404.html']) {
      const p = page(rel);
      const at = p.indexOf(`<script>${THEME_BOOT_SCRIPT}</script>`);
      expect(at, rel).toBeGreaterThan(p.indexOf('Content-Security-Policy'));
      expect(at, rel).toBeLessThan(p.indexOf('<link rel="stylesheet"'));
      expect(inspectHtml(p).csp, rel).toContain(cspHash(THEME_BOOT_SCRIPT));
    }
  });

  it('every page with a twin hides it for no-JS readers (hashed <noscript><style>) and keeps the article', () => {
    for (const rel of [
      'de/index.html',
      'de/day/2026-11-15/index.html',
      'de/day/2026-11-15/story/p_s01lantern/index.html',
      'en/trip/vietnam-2026/index.html',
    ]) {
      const p = page(rel);
      expect(p, rel).toContain(`<noscript><style>${NOSCRIPT_CSS}</style></noscript>`);
      expect(inspectHtml(p).csp, rel).toContain(cspHash(NOSCRIPT_CSS));
      expect(twinOf(p).startsWith('<div id="omw-root"><div class="omw-twin '), rel).toBe(true);
      expect(articleOf(p).startsWith('<div class="omw-fs">'), rel).toBe(true);
      // exactly one h1 in what JS readers see (the twin) and in what no-JS readers see (the article)
      expect(twinOf(p).match(/<h1[ >]/g)?.length, `${rel} twin`).toBe(1);
      expect(articleOf(p).match(/<h1[ >]/g)?.length, `${rel} article`).toBe(1);
    }
    // home: the site title is the h1 (brand), the article has no second brand line
    const home = page('de/index.html');
    expect(twinOf(home)).toMatch(/<h1 class="min-w-0"><a href="\/de\/" class="group flex/);
    expect(articleOf(home)).not.toContain('omw-fs-brand');
    // trip: the trip title is the h1, the brand a plain line
    const trip = page('en/trip/vietnam-2026/index.html');
    expect(twinOf(trip)).toMatch(/<h1 class="sr-only">Vietnam 2026<\/h1>/);
    expect(twinOf(trip)).toContain('<p class="min-w-0"><a href="/en/"');
  });

  it('home: locale catalog, timeline.json of the release and the first strip image are preloaded (L3-01)', () => {
    const p = page('de/index.html');
    const boot = bootOf(p) as { timelineV: string };
    expect(modulepreloads(p)).toEqual(['/assets/shared-a1x2.js', '/assets/messages-de1.js']);
    expect(p).toContain(`<link rel="preload" href="/data/timeline.json?v=${boot.timelineV}" as="fetch" crossorigin>`);
    // the image preload repeats the twin's first strip <picture> AVIF source exactly
    const first =
      /<ol aria-label="Momente dieses Tages"[^>]*><li[^>]*><a[^>]*><picture class="block h-full"><source type="image\/avif" srcset="([^"]+)" sizes="([^"]+)">/.exec(
        twinOf(p),
      );
    expect(first).not.toBeNull();
    expect(p).toContain(
      `<link rel="preload" as="image" type="image/avif" imagesrcset="${first?.[1]}" imagesizes="${first?.[2]}" fetchpriority="high">`,
    );
    expect(first?.[2]).toBe('(min-width: 1024px) 384px, (min-width: 704px) 320px, 256px');
    // that image is the twin's one eager, high-priority image
    expect(twinOf(p).match(/fetchpriority="high"/g)?.length).toBe(1);
    // fonts: Latin (LTR) and, for "Sài Gòn" / "Hội An", the Vietnamese subsets; never Playpen
    const fonts = preloads(p).filter((l) => l.includes('as="font"'));
    expect(fonts.map((l) => /href="([^"]+)"/.exec(l)?.[1]).sort()).toEqual([
      '/assets/fraunces-latin-soft-normal-Fl1.woff2',
      '/assets/fraunces-vietnamese-soft-normal-Vf1.woff2',
      '/assets/nunito-latin-wght-normal-Zz9.woff2',
      '/assets/nunito-vietnamese-wght-normal-Vn1.woff2',
    ]);
    expect(headOf(p)).not.toContain('playpen');
    expect(preloads(p).length).toBeLessThanOrEqual(6);
  });

  it('day and story pages: player chunks, the slide image at player sizes (L3-01)', () => {
    const day = page('en/day/2026-11-15/index.html');
    expect(modulepreloads(day)).toEqual([
      '/assets/shared-a1x2.js',
      '/assets/messages-en1.js',
      '/assets/player-p1.js',
      '/assets/motion-m1.js',
    ]);
    const slide =
      /<section aria-roledescription[^>]*>[\s\S]*?<source type="image\/avif" srcset="([^"]+)" sizes="([^"]+)">/.exec(
        twinOf(day),
      );
    expect(slide?.[2]).toBe('(min-width: 40rem) 36rem, 100vw');
    expect(day).toContain(
      `<link rel="preload" as="image" type="image/avif" imagesrcset="${slide?.[1]}" imagesizes="(min-width: 40rem) 36rem, 100vw" fetchpriority="high">`,
    );
    expect(day).toContain(`data/timeline.json?v=${(bootOf(day) as { timelineV: string }).timelineV}`);
    expect(preloads(day).length).toBeLessThanOrEqual(6);
    const story = page('de/day/2026-11-15/story/p_s01lantern/index.html');
    expect(modulepreloads(story)).toEqual([
      '/assets/shared-a1x2.js',
      '/assets/messages-de1.js',
      '/assets/player-p1.js',
      '/assets/motion-m1.js',
      '/assets/story-sheet-s1.js',
    ]);
    // trip pages need no player
    expect(modulepreloads(page('en/trip/vietnam-2026/index.html'))).toEqual([
      '/assets/shared-a1x2.js',
      '/assets/messages-en1.js',
    ]);
  });

  it('Vietnamese subsets only for Vietnamese text', () => {
    expect(needsVietnamese('<p>Hội An</p>')).toBe(true); // U+1ED9
    // à and ò are Latin-1: the Latin subset covers "Sài Gòn"
    expect(needsVietnamese('<p>Sài Gòn</p>')).toBe(false);
    expect(needsVietnamese('<p>Đà Lạt</p>')).toBe(true); // U+0110, U+1EA1
    expect(needsVietnamese('<p>Phở</p>')).toBe(true); // U+01A1
    expect(needsVietnamese('<p>Berlin, Köln, Straße, café</p>')).toBe(false);
    expect(needsVietnamese('<p title="Hội An">Berlin</p>')).toBe(false); // attributes are not visible text
  });

  it('no-JS article: RTL alignment of user text, story list markers, alt text per kind (L3-13, L3-17)', () => {
    const css = new PageStyles().css();
    expect(css).toContain(
      '.omw-fs [dir=auto]{text-align:-webkit-match-parent;text-align:match-parent;unicode-bidi:plaintext}',
    );
    expect(css).toContain('.omw-fs-story ul{list-style:disc}.omw-fs-story ol{list-style:decimal}');
    expect(css).toContain('.omw-fs-story li::marker{color:var(--fs-accent)}');
    const de15 = articleOf(page('de/day/2026-11-15/index.html'));
    const gif = [...de15.matchAll(/<img [^>]*_poster_w\d+\.webp"[^>]*alt="([^"]*)"/g)].map((m) => m[1]);
    expect(
      gif.some((alt) => /^GIF \d{2}:\d{2}$/.test(alt ?? '')),
      JSON.stringify(gif),
    ).toBe(true);
    expect(de15).not.toMatch(/alt="Foto \d{2}:\d{2}"[^>]*_poster_/);
  });
});
