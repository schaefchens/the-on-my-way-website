/**
 * Generator integration tests on the shared fixtures (dummy media files, fake site build).
 * Skipped when the fixtures have not been generated (`pnpm fixtures`).
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Post, Trip } from '@omw/contracts/api';
import { routePath } from '@omw/contracts/site';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixturesPresent, readFixtureIndex } from '../../src/generator/dev/fixtures.js';
import { cspHash } from '../../src/generator/hash.js';
import { SiteBuildError } from '../../src/generator/index.js';
import { pickerScript, THEME_BOOT_SCRIPT } from '../../src/generator/pages.js';
import { DIRTY_KEY } from '../../src/generator/state.js';
import { inspectHtml, verifyOutDir } from '../../src/generator/verify.js';
import { mediaFilePath } from '../../src/paths.js';
import { bootOf, createHarness, type Harness, readJson, readOut, snapshot, writeFakeSiteBuild } from './harness.js';

const present = fixturesPresent();
const index = present ? readFixtureIndex() : [];
const key = (k: string) => {
  const s = index.find((e) => e.key === k);
  if (!s) throw new Error(`no fixture ${k}`);
  return s;
};
/** WhatsApp ids must never appear in static output (D4). */
const forbidden = () => index.flatMap((s) => [s.msgId, s.sourceKey]);

function nonMediaFiles(dir: string): string[] {
  return Object.keys(snapshot(dir)).filter((p) => !p.startsWith('media/') && !p.startsWith('assets/'));
}

function htmlFiles(h: Harness): string[] {
  return Object.keys(snapshot(h.outDir)).filter((p) => p.endsWith('.html'));
}

/** Full regeneration of the same store into an empty directory must equal the incremental output. */
async function expectFullEqualsIncremental(h: Harness, label: string): Promise<void> {
  const fresh = join(h.dir, `fresh-${label}`);
  const before = h.store.meta.siteVersion();
  const result = await h.generatorFor(fresh).generate({ full: true, reason: `check ${label}` });
  expect(result.version, `${label}: full run must not bump the version`).toBe(before);
  expect(snapshot(fresh), `${label}: full output differs from incremental output`).toEqual(snapshot(h.outDir));
  const again = await h.generator.generate({ full: true });
  expect([again.changed, again.removed], `${label}: full run in place changed files`).toEqual([[], []]);
  rmSync(fresh, { recursive: true, force: true });
}

describe.skipIf(!present)('generator: full run on the fixtures', () => {
  let h: Harness;
  let first: Awaited<ReturnType<Harness['generator']['generate']>>;
  beforeAll(async () => {
    h = await createHarness();
    first = await h.generator.generate({ reason: 'test' });
  });
  afterAll(() => h.cleanup());

  it('writes exactly the layout of plan A4', () => {
    expect(first).toMatchObject({ version: 1, full: true, fullReason: 'no previous state', removed: [] });
    const days = ['2026-11-12', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17'];
    const expected = [
      '.htaccess',
      '404.html',
      'data/manifest.json',
      'data/timeline.json',
      'data/trips/vietnam-2026.json',
      'index.html',
      'robots.txt',
      ...days.map((d) => `data/days/${d}.json`),
      ...['de', 'en'].flatMap((l) => [
        `${l}/index.html`,
        `${l}/trip/vietnam-2026/index.html`,
        `${l}/day/2026-11-15/story/p_s01lantern/index.html`,
        ...days.map((d) => `${l}/day/${d}/index.html`),
      ]),
    ].sort();
    expect(nonMediaFiles(h.outDir)).toEqual(expected);
    expect(first.changed).toEqual(Object.keys(snapshot(h.outDir)));
  });

  it('passes the output verifier: contracts, v hashes, references, pages, CSP, boot; no WhatsApp ids', async () => {
    const result = await verifyOutDir(h.outDir, { forbidden: forbidden() });
    expect(result.problems).toEqual([]);
    expect(result.pages).toBe(18); // 2 locales x (home + 5 days + 1 story + 1 trip) + index + 404
  });

  it('publishes exactly the public items (policy, placement, posts)', () => {
    const timeline = readJson<{ days: { date: string; counts: Record<string, number>; trip?: string }[] }>(
      h,
      'data/timeline.json',
    );
    expect(timeline.days.map((d) => [d.date, d.trip ?? null])).toEqual([
      ['2026-11-12', null],
      ['2026-11-14', 'vietnam-2026'],
      ['2026-11-15', 'vietnam-2026'],
      ['2026-11-16', 'vietnam-2026'],
      ['2026-11-17', 'vietnam-2026'],
    ]);
    const ids = (date: string) =>
      readJson<{ entries: { id: string }[] }>(h, `data/days/${date}.json`).entries.map((e) => e.id);
    // Revoked (on_revoke=hide) photo left out; the night photo is moved here by localDateOverride.
    expect(ids('2026-11-15')).not.toContain(key('hoian-photo-revoked').publicId);
    expect(ids('2026-11-15')).toContain(key('hoian-photo-night').publicId);
    expect(ids('2026-11-15')).toContain('p_s01lantern');
    // Hidden by the owner, unsupported kind.
    expect(ids('2026-11-16')).toEqual([key('hoian-video-hevc').publicId, 'p_n02hoian26']);
    // Download pending / media lost are not ready.
    expect(ids('2026-11-17')).toEqual([key('saigon-photo').publicId, key('saigon-text-plain').publicId]);
  });

  it('links exactly the referenced media into OUT_DIR (hard links), never hidden or revoked ones', () => {
    const outMedia = Object.keys(snapshot(h.outDir)).filter((p) => p.startsWith('media/'));
    const referenced = new Set<string>();
    // Day files reference the entries' media; timeline.json also the portrait's round crop.
    for (const f of [...readdirSync(join(h.outDir, 'data/days')).map((d) => `data/days/${d}`), 'data/timeline.json']) {
      const text = readOut(h, f);
      for (const m of text.matchAll(/"(media\/[^"]+)"/g)) if (m[1]) referenced.add(m[1]);
    }
    expect(outMedia).toEqual([...referenced].sort());
    const sample = outMedia[0] as string;
    expect(statSync(join(h.outDir, sample)).ino).toBe(statSync(mediaFilePath(h.mediaDir, sample)).ino);
    const revokedSha = h.store.captures.get(key('hoian-photo-revoked').sourceKey)?.originalSha256 ?? 'x';
    expect(outMedia.some((p) => p.includes(revokedSha.slice(0, 16)))).toBe(false);
    expect(readdirSync(join(h.mediaDir, revokedSha.slice(0, 2))).length).toBeGreaterThan(0);
  });

  it('renders real first screens with lang/dir, meta tags, canonical + hreflang and absolute asset URLs', () => {
    const page = readOut(h, 'en/day/2026-11-15/index.html');
    expect(page).toMatch(
      /^<!doctype html>\n<html lang="en" dir="ltr">\n<head>\n<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy"/,
    );
    expect(page).toContain('<title>Lanterns in Hội An · 15 Nov 2026 · On My Way</title>');
    expect(page).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(page).toContain('<link rel="canonical" href="https://example.org/en/day/2026-11-15/">');
    expect(page).toContain('<link rel="alternate" hreflang="de" href="https://example.org/de/day/2026-11-15/">');
    expect(page).toContain('<link rel="alternate" hreflang="x-default" href="https://example.org/de/day/2026-11-15/">');
    expect(page).toMatch(
      /<meta property="og:image" content="https:\/\/example\.org\/media\/[0-9a-f]{2}\/[0-9a-f]{16}_og\.jpg">/,
    );
    expect(page).toContain('<link rel="stylesheet" href="/assets/index-a1x3.css">');
    expect(page).toContain('<link rel="stylesheet" href="/assets/shared-a1x4.css">');
    expect(page).toContain('<link rel="modulepreload" href="/assets/shared-a1x2.js" crossorigin>');
    expect(page).toContain('<script type="module" src="/assets/index-a1x1.js" crossorigin></script>');
    expect(page).toContain(
      '<link rel="preload" href="/assets/nunito-latin-wght-normal-Zz9.woff2" as="font" type="font/woff2" crossorigin>',
    );
    // First screen: the player twin, then the readable article for no-JS readers (L3-02).
    expect(page).toContain('<div id="omw-root"><div class="omw-twin fixed inset-0 z-40');
    const article = noscriptOf(page);
    expect(article.startsWith('<div class="omw-fs">')).toBe(true);
    expect(article).toMatch(
      /<img class="omw-fs-img omw-c-[0-9a-f]{6}" src="\/media\/[^"]+_w640\.webp" width="\d+" height="\d+" alt="Yellow houses, bougainvillea and the first coffee of the day\." decoding="async" loading="eager" fetchpriority="high">/,
    );
    // The cover is the day's first photo here: the article shows it once (no separate hero), eagerly.
    const srcs = [...article.matchAll(/<img [^>]*src="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(srcs).size, 'no picture repeats in the article').toBe(srcs.length);
    expect(article.match(/fetchpriority="high"/g)?.length).toBe(1);
    // The twin's slide is the one high-priority image of the visible first screen.
    expect(twinOf(page).match(/fetchpriority="high"/g)?.length).toBe(1);
    expect(page).toContain('<a rel="prev" href="/en/day/2026-11-14/">');
    expect(page).toContain('<a rel="next" href="/en/day/2026-11-16/">');
    expect(page).toContain('href="/en/day/2026-11-15/story/p_s01lantern/">Read the story</a>');
    expect(page).toContain('Yellow houses, bougainvillea and the first coffee of the day.');
    const boot = bootOf(page);
    expect(boot).toMatchObject({ basePath: '/', locale: 'en', route: { name: 'day', params: { date: '2026-11-15' } } });
    expect(boot.manifestVersion).toBe(1);
    expect((boot.day as { date: string }).date).toBe('2026-11-15');
    // Story page renders markdown (raw HTML off).
    const story = readOut(h, 'de/day/2026-11-15/story/p_s01lantern/index.html');
    expect(story).toContain('<h2>Vollmond über dem Thu Bồn</h2>');
    expect(story).toContain('rel="nofollow noopener noreferrer"');
    expect(bootOf(story)).toMatchObject({
      route: { name: 'story', params: { date: '2026-11-15', id: 'p_s01lantern' } },
    });
    // Fallback labels: an English-only text on the German page says "Original: Englisch".
    const de16 = readOut(h, 'de/day/2026-11-16/index.html');
    expect(de16).toContain('Vormittags Regen');
    // 404 + picker.
    const notFound = readOut(h, '404.html');
    expect(bootOf(notFound)).toMatchObject({ route: { name: 'notFound', params: {} }, locale: 'de' });
    expect(notFound).not.toContain('rel="canonical"');
    const picker = readOut(h, 'index.html');
    expect(picker).toContain('<noscript><meta http-equiv="refresh" content="0; url=/de/"></noscript>');
    expect(picker).toContain('<a class="omw-fs-card" href="/en/" hreflang="en" lang="en">English</a>');
  });

  it('CSP: no unsafe-inline, the picker script, the theme boot script and every <style> are hashed', () => {
    const picker = readOut(h, 'index.html');
    const info = inspectHtml(picker);
    expect(info.inlineScripts).toEqual([
      pickerScript({
        site: { basePath: '/', locales: ['de', 'en'], defaultLocale: 'de', title: 'x', indexable: false },
      }),
    ]);
    expect(info.csp).toContain(`script-src 'self' ${cspHash(info.inlineScripts[0] ?? '')};`);
    for (const rel of htmlFiles(h)) {
      const i = inspectHtml(readOut(h, rel));
      expect(i.csp).not.toContain('unsafe-inline');
      expect(i.csp).toContain(`style-src 'self' ${cspHash(i.styles[0] ?? '')}`);
      for (const style of i.styles) expect(i.csp, rel).toContain(cspHash(style));
      if (rel !== 'index.html') {
        expect(i.inlineScripts).toEqual([THEME_BOOT_SCRIPT]);
        expect(i.csp).toContain(`script-src 'self' ${cspHash(THEME_BOOT_SCRIPT)};`);
      }
    }
  });

  it('writes public output world-readable whatever the umask (L1-09), durably (W2-1)', async () => {
    const umask = process.umask(0o077);
    try {
      const out = join(h.dir, 'out-modes');
      await h.generatorFor(out).generate({ full: true, reason: 'modes' });
      for (const rel of ['de/index.html', 'data/manifest.json', 'data/timeline.json', 'assets/index-a1x1.js']) {
        expect((statSync(join(out, rel)).mode & 0o777).toString(8), rel).toBe('644');
      }
      for (const rel of ['de', 'de/day', 'data', 'data/days']) {
        expect((statSync(join(out, rel)).mode & 0o777).toString(8), rel).toBe('755');
      }
      // no temp files left behind by the fsync + rename writes
      expect(Object.keys(snapshot(out)).filter((p) => p.includes('.tmp-'))).toEqual([]);
      rmSync(out, { recursive: true, force: true });
    } finally {
      process.umask(umask);
    }
  });

  it('copies the site build without source maps', () => {
    const assets = Object.keys(snapshot(h.outDir)).filter((p) => p.startsWith('assets/'));
    expect(assets).toEqual([
      'assets/index-a1x1.js',
      'assets/index-a1x3.css',
      'assets/nunito-latin-wght-normal-Zz9.woff2',
      'assets/rubik-hebrew-wght-normal-Yy8.woff2',
      'assets/shared-a1x2.js',
      'assets/shared-a1x4.css',
    ]);
    expect(readOut(h, '.htaccess')).toContain('ErrorDocument 404 /404.html');
    expect(readOut(h, 'robots.txt')).toBe('User-agent: *\nDisallow: /\n');
  });

  it('.htaccess: compression of text types (brotli, else gzip), private media caching (L3-04, L1-12)', () => {
    const ht = readOut(h, '.htaccess');
    const types =
      'text/html text/css text/javascript application/javascript application/json image/svg+xml application/manifest+json';
    expect(ht).toContain(
      `<IfModule mod_brotli.c>\n    <IfModule mod_filter.c>\n        AddOutputFilterByType BROTLI_COMPRESS ${types}\n    </IfModule>\n</IfModule>`,
    );
    expect(ht).toContain(
      `<IfModule mod_deflate.c>\n    <IfModule mod_filter.c>\n        AddOutputFilterByType DEFLATE ${types}\n    </IfModule>\n</IfModule>`,
    );
    // brotli first: mod_deflate leaves an already encoded response alone
    expect(ht.indexOf('BROTLI_COMPRESS')).toBeLessThan(ht.indexOf('DEFLATE'));
    // media is never compressed
    for (const line of ht.split('\n').filter((l) => l.includes('AddOutputFilterByType'))) {
      expect(line).not.toMatch(/image\/(?:avif|webp|jpeg)|video\/|audio\//);
    }
    // media: private (after the public rule, so it wins for media names); assets stay public
    const media = ht.indexOf('<FilesMatch "^[0-9a-f]{16}_[a-z0-9_]+\\.(?:avif|webp|jpg|mp4|m4a)$">');
    expect(media).toBeGreaterThan(ht.indexOf('Header set Cache-Control "public, max-age=31536000, immutable"'));
    expect(ht.slice(media)).toContain('Header set Cache-Control "private, max-age=31536000, immutable"');
    const re = /^[0-9a-f]{16}_[a-z0-9_]+\.(?:avif|webp|jpg|mp4|m4a)$/;
    expect(re.test('ab12cd34ef56ab78_w640.avif')).toBe(true);
    expect(re.test('ab12cd34ef56ab78_poster_w320.webp')).toBe(true);
    expect(re.test('index-a1x1.js')).toBe(false);
    expect(re.test('nunito-latin-wght-normal-Zz9.woff2')).toBe(false);
    // dotfiles (the publisher's deploy record, plain or gzipped) are denied
    expect(ht).toContain('<FilesMatch "^\\.">\n    Require all denied\n</FilesMatch>');
  });

  it('is idempotent: running again changes nothing and keeps the version', async () => {
    const before = snapshot(h.outDir);
    const again = await h.generator.generate();
    expect(again).toMatchObject({ version: 1, full: false, changed: [], removed: [] });
    expect(snapshot(h.outDir)).toEqual(before);
  });

  it('is deterministic: an independent run from the same input is byte-identical', async () => {
    const other = await createHarness();
    try {
      await other.generator.generate();
      expect(snapshot(other.outDir)).toEqual(snapshot(h.outDir));
    } finally {
      other.cleanup();
    }
  });
});

describe.skipIf(!present)('generator: incremental runs equal full runs', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
    await h.generator.generate();
  });
  afterAll(() => h.cleanup());

  it('a day title change touches that day, its neighbours (previews), the timeline, the manifest, home/trip/404', async () => {
    const day = h.store.owner.getDay('2026-11-12');
    h.store.owner.upsertDay({
      ...(day ?? { localDate: '2026-11-12' }),
      title: { de: 'Abflug', en: 'Departure' },
      updatedAt: '2026-11-19T12:01:00Z',
    });
    const r = await h.generator.generate({ reason: 'feed' });
    expect(r.full).toBe(false);
    expect(r.version).toBe(2);
    // 2026-11-14 is re-rendered too: its player twin previews the previous day (L3-02).
    expect(r.dates).toEqual(['2026-11-12', '2026-11-14']);
    expect(r.changed).toEqual([
      '404.html',
      'data/days/2026-11-12.json',
      'data/manifest.json',
      'data/timeline.json',
      'de/day/2026-11-12/index.html',
      'de/day/2026-11-14/index.html',
      'de/index.html',
      'de/trip/vietnam-2026/index.html',
      'en/day/2026-11-12/index.html',
      'en/day/2026-11-14/index.html',
      'en/index.html',
      'en/trip/vietnam-2026/index.html',
    ]);
    expect(r.removed).toEqual([]);
    expect(readOut(h, 'de/day/2026-11-14/index.html')).toContain('Abflug');
    // Untouched pages keep the release in which they last changed.
    expect(bootOf(readOut(h, 'de/day/2026-11-16/index.html')).manifestVersion).toBe(1);
    expect(bootOf(readOut(h, 'de/day/2026-11-12/index.html')).manifestVersion).toBe(2);
    expect(bootOf(readOut(h, 'de/index.html')).manifestVersion).toBe(2);
    await expectFullEqualsIncremental(h, 'day-title');
  });

  it('hiding a photo removes it and its media; covers fall back; trip pages follow', async () => {
    const morning = key('hoian-photo-morning');
    const sha = h.store.captures.get(morning.sourceKey)?.originalSha256 ?? '';
    const ann = h.store.owner.getAnnotation(morning.sourceKey);
    h.store.owner.upsertAnnotation({
      ...(ann ?? { sourceKey: morning.sourceKey }),
      visibility: 'hidden',
      updatedAt: '2026-11-19T12:02:00Z',
    });
    const r = await h.generator.generate({ dates: ['2026-11-15'] });
    expect(r.full).toBe(false);
    const goneMedia = r.removed.filter((p) => p.startsWith('media/'));
    expect(goneMedia.length).toBeGreaterThan(0);
    expect(goneMedia.every((p) => p.includes(sha.slice(0, 16)))).toBe(true);
    for (const p of goneMedia) expect(existsSync(join(h.outDir, p))).toBe(false);
    expect(readOut(h, 'data/days/2026-11-15.json')).not.toContain(morning.publicId);
    // The trip cover was this photo: trip JSON/pages and all trip day pages are re-rendered.
    expect(r.changed).toContain('data/trips/vietnam-2026.json');
    expect(r.changed).toContain('en/trip/vietnam-2026/index.html');
    const timeline = readOut(h, 'data/timeline.json');
    expect(timeline).not.toContain(sha.slice(0, 16));
    await expectFullEqualsIncremental(h, 'hide');
  });

  it('a new day re-links its neighbour (prev/next) and the trip when the range grows', async () => {
    const note: Post = {
      publicId: 'p_new18note',
      kind: 'note',
      occurredAt: '2026-11-18T03:00:00Z',
      tz: 'Asia/Ho_Chi_Minh',
      localDate: '2026-11-18',
      origLocale: 'en',
      visibility: 'public',
      updatedAt: '2026-11-19T12:03:00Z',
      content: { en: { body: 'Last day.' } },
    };
    h.store.owner.upsertPost(note);
    const r1 = await h.generator.generate();
    expect(r1.dates).toEqual(['2026-11-16', '2026-11-17', '2026-11-18']);
    expect(readJson<{ next?: string }>(h, 'data/days/2026-11-17.json').next).toBe('2026-11-18');
    await expectFullEqualsIncremental(h, 'new-day');

    const trip = h.store.owner.getTrip('vietnam-2026') as Trip;
    h.store.owner.upsertTrip({
      ...trip,
      endDate: '2026-11-18',
      title: { de: 'Vietnam!', en: 'Vietnam!' },
      updatedAt: '2026-11-19T12:04:00Z',
    });
    const r2 = await h.generator.generate();
    expect(r2.full).toBe(false);
    expect(readJson<{ trip?: string }>(h, 'data/days/2026-11-18.json').trip).toBe('vietnam-2026');
    // The trip title shows on every trip day page.
    expect(readOut(h, 'en/day/2026-11-14/index.html')).toContain('>Vietnam!</a>');
    await expectFullEqualsIncremental(h, 'trip');
  });

  it('a Day.tz fix moves items to the neighbouring day', async () => {
    h.store.owner.upsertDay({ localDate: '2026-11-17', tz: 'America/Los_Angeles', updatedAt: '2026-11-19T12:05:00Z' });
    const r = await h.generator.generate();
    expect(r.full).toBe(false);
    const d16 = readJson<{ entries: { id: string; tz: string }[] }>(h, 'data/days/2026-11-16.json');
    const moved = d16.entries.find((e) => e.id === key('saigon-photo').publicId);
    expect(moved?.tz).toBe('America/Los_Angeles');
    await expectFullEqualsIncremental(h, 'tz-fix');
  });

  it('deleting a story removes its pages; a revoke hides the capture', async () => {
    h.store.owner.deletePost('p_s01lantern');
    h.store.captures.setRevoked(key('hoian-gif').sourceKey, '2026-11-19T12:06:00Z');
    const r = await h.generator.generate();
    expect(r.full).toBe(false);
    expect(r.removed).toEqual(
      expect.arrayContaining([
        'de/day/2026-11-15/story/p_s01lantern/index.html',
        'en/day/2026-11-15/story/p_s01lantern/index.html',
      ]),
    );
    expect(existsSync(join(h.outDir, 'de/day/2026-11-15/story'))).toBe(false);
    expect(readOut(h, 'data/days/2026-11-15.json')).not.toContain(key('hoian-gif').publicId);
    await expectFullEqualsIncremental(h, 'delete');
  });

  it('a day losing its last public entry disappears with all its files', async () => {
    h.store.owner.upsertAnnotation({
      sourceKey: key('berlin-text').sourceKey,
      visibility: 'hidden',
      updatedAt: '2026-11-19T12:07:00Z',
    });
    h.store.owner.upsertAnnotation({
      sourceKey: key('berlin-photo').sourceKey,
      visibility: 'hidden',
      updatedAt: '2026-11-19T12:07:00Z',
    });
    const r = await h.generator.generate();
    expect(r.removed).toEqual(
      expect.arrayContaining([
        'data/days/2026-11-12.json',
        'de/day/2026-11-12/index.html',
        'en/day/2026-11-12/index.html',
      ]),
    );
    expect(existsSync(join(h.outDir, 'de/day/2026-11-12'))).toBe(false);
    expect(readJson<{ prev?: string }>(h, 'data/days/2026-11-14.json').prev).toBeUndefined();
    await expectFullEqualsIncremental(h, 'empty-day');
  });

  it('versions are monotonic and only move when something changed', async () => {
    const v = h.store.meta.siteVersion();
    const r = await h.generator.generate();
    expect(r).toMatchObject({ version: v, changed: [], removed: [] });
    expect(readJson<{ version: number }>(h, 'data/manifest.json').version).toBe(v);
  });
});

describe.skipIf(!present)('generator: publish modes over time', () => {
  it('delayed mode publishes items when their delay has passed, incrementally', async () => {
    const h = await createHarness();
    try {
      h.clock.set('2026-11-17T14:30:00.000Z');
      h.store.owner.setSetting('publish.mode', 'delayed');
      h.store.owner.setSetting('publish.delay_minutes', 60);
      h.store.owner.setSetting('publish.mode_since', '2026-11-01T00:00:00.000Z');
      const r1 = await h.generator.generate();
      const textId = key('saigon-text-plain').publicId;
      expect(readOut(h, 'data/days/2026-11-17.json')).not.toContain(textId);
      expect(r1.nextRunAt).toBe('2026-11-17T15:00:00.000Z');
      h.clock.set('2026-11-17T15:00:00.000Z');
      const r2 = await h.generator.generate({ reason: 'timer' });
      expect(r2.full).toBe(false);
      expect(r2.dates).toEqual(['2026-11-16', '2026-11-17']);
      expect(readOut(h, 'data/days/2026-11-17.json')).toContain(textId);
      expect(r2.nextRunAt).toBeNull();
      await expectFullEqualsIncremental(h, 'delayed');
    } finally {
      h.cleanup();
    }
  });

  it('review mode keeps new captures back but never unpublishes older ones', async () => {
    const h = await createHarness();
    try {
      h.store.owner.setSetting('publish.mode', 'review');
      h.store.owner.setSetting('publish.mode_since', '2026-11-16T00:00:00.000Z');
      await h.generator.generate();
      const timeline = readJson<{ days: { date: string }[] }>(h, 'data/timeline.json');
      // Captures from the 16th on wait for review; the 16th still has its public note.
      expect(timeline.days.map((d) => d.date)).toEqual(['2026-11-12', '2026-11-14', '2026-11-15', '2026-11-16']);
      expect(readOut(h, 'data/days/2026-11-16.json')).not.toContain(key('hoian-video-hevc').publicId);
    } finally {
      h.cleanup();
    }
  });
});

describe.skipIf(!present)('generator: escaping and XSS attempts', () => {
  let h: Harness;
  const evilCaption = '</script><script>alert("cap")</script>\u2028<!--';
  const evilAttr = '"><img src=x onerror=alert(1)>';
  beforeAll(async () => {
    h = await createHarness({ captions: { 'berlin-photo': evilCaption, 'hanoi-photo': evilAttr } });
    h.store.owner.upsertDay({
      localDate: '2026-11-12',
      title: { de: '</title><script>alert(2)</script>', en: 'a\u2029b' },
      summary: { de: '<b>fett</b> & "zitiert"' },
      origLocale: 'de',
      placeName: '<i>Berlin</i>',
      countryCode: 'DE',
      updatedAt: '2026-11-19T00:00:00Z',
    });
    h.store.owner.upsertPost({
      publicId: 'p_evilstory',
      kind: 'story',
      occurredAt: '2026-11-12T10:00:00Z',
      tz: 'Europe/Berlin',
      localDate: '2026-11-12',
      origLocale: 'de',
      visibility: 'public',
      updatedAt: '2026-11-19T00:00:00Z',
      content: {
        de: {
          title: '<img src=x onerror=alert(3)>',
          body: '<script>alert(4)</script>\n\n[x](javascript:alert(5)) <svg onload=alert(6)>',
        },
      },
    });
    const trip = h.store.owner.getTrip('vietnam-2026') as Trip;
    h.store.owner.upsertTrip({ ...trip, title: { de: '"><svg onload=alert(7)>', en: 'Trip' } });
    h.store.owner.upsertAnnotation({
      sourceKey: key('hanoi-video').sourceKey,
      description: { de: '<iframe src="javascript:alert(8)"></iframe>' },
      origLocale: 'de',
      updatedAt: '2026-11-19T00:00:00Z',
    });
    await h.generator.generate();
  });
  afterAll(() => h.cleanup());

  it('never emits injected markup or javascript: URLs', () => {
    for (const rel of htmlFiles(h)) {
      const page = readOut(h, rel);
      expect(page, rel).not.toMatch(/<script>alert|<img src=x|<svg onload|<iframe|<i>Berlin|<b>fett/);
      expect(page, rel).not.toMatch(/(?:href|src)="javascript:/i);
      // U+2028/9 are plain characters in HTML text; inside <script> they must be escaped.
      for (const m of page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))
        expect(m[1], rel).not.toMatch(/[\u2028\u2029]/);
    }
    const day = readOut(h, 'de/day/2026-11-12/index.html');
    expect(day).toContain(
      '<title>&lt;/title&gt;&lt;script&gt;alert(2)&lt;/script&gt; · 12. Nov. 2026 · On My Way</title>',
    );
    expect(day).toContain('&lt;b&gt;fett&lt;/b&gt; &amp; &quot;zitiert&quot;');
    const story = readOut(h, 'de/day/2026-11-12/story/p_evilstory/index.html');
    expect(story).toContain('&lt;script&gt;alert(4)&lt;/script&gt;');
    expect(story).toContain('[x](javascript:alert(5))');
  });

  it('round-trips the exact strings through the escaped boot JSON and data files', async () => {
    const boot = bootOf(readOut(h, 'de/day/2026-11-12/index.html'));
    const entries = (boot.day as { entries: { caption?: string }[] }).entries;
    expect(entries.map((e) => e.caption)).toContain(evilCaption);
    const data = readJson<{ title: Record<string, string> }>(h, 'data/days/2026-11-12.json');
    expect(data.title).toEqual({ de: '</title><script>alert(2)</script>', en: 'a\u2029b' });
    expect((await verifyOutDir(h.outDir, { forbidden: forbidden() })).problems).toEqual([]);
  });
});

describe.skipIf(!present)('generator: locales, base path, indexing', () => {
  it('generates exactly the configured locales (incl. RTL pseudo-locale) and removes dropped ones', async () => {
    const h = await createHarness();
    try {
      h.store.owner.setSetting('site.locales', ['de', 'en', 'ar']);
      const r1 = await h.generator.generate();
      expect(r1.fullReason).toBe('no previous state');
      const ar = readOut(h, 'ar/day/2026-11-15/index.html');
      expect(ar).toMatch(/<html lang="ar" dir="rtl">/);
      expect(ar).not.toContain('nunito-latin-wght-normal'); // no Latin font preload for RTL pages
      expect(readOut(h, 'de/index.html')).toContain('hreflang="ar"');
      h.store.owner.setSetting('site.locales', ['de']);
      const r2 = await h.generator.generate();
      expect(r2.fullReason).toBe('settings changed');
      expect(r2.removed.filter((p) => p.startsWith('en/') || p.startsWith('ar/')).length).toBe(16);
      expect(existsSync(join(h.outDir, 'en'))).toBe(false);
      expect(readOut(h, 'de/index.html')).not.toContain('class="omw-fs-langs"');
      expect((await verifyOutDir(h.outDir)).problems).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it('prefixes every URL with the basePath and writes a sitemap only when indexable', async () => {
    const h = await createHarness({ publicUrl: 'https://example.org/travel/' });
    try {
      h.store.owner.setSetting('site.indexable', true);
      await h.generator.generate();
      const page = readOut(h, 'de/trip/vietnam-2026/index.html');
      expect(bootOf(page).basePath).toBe('/travel/');
      for (const m of page.matchAll(/(?:href|src|srcset)="(\/[^"]*)"/g)) expect(m[1]).toMatch(/^\/travel\//);
      expect(page).not.toContain('name="robots"');
      expect(readOut(h, '.htaccess')).toContain('ErrorDocument 404 /travel/404.html');
      expect(readOut(h, 'robots.txt')).toBe(
        'User-agent: *\nAllow: /\nSitemap: https://example.org/travel/sitemap.xml\n',
      );
      const sitemap = readOut(h, 'sitemap.xml');
      expect(sitemap).toContain('<loc>https://example.org/travel/en/day/2026-11-15/story/p_s01lantern/</loc>');
      expect(sitemap).toContain('<xhtml:link rel="alternate" hreflang="de" href="https://example.org/travel/de/"/>');
      expect(readOut(h, 'index.html')).toContain(
        '<link rel="alternate" hreflang="x-default" href="https://example.org/travel/">',
      );
      expect((await verifyOutDir(h.outDir)).problems).toEqual([]);
      h.store.owner.setSetting('site.indexable', false);
      const r = await h.generator.generate();
      expect(r.removed).toContain('sitemap.xml');
      expect(readOut(h, '404.html')).toContain('<meta name="robots" content="noindex, nofollow">');
    } finally {
      h.cleanup();
    }
  });

  it('omits absolute URLs (canonical, hreflang, og:image) without SITE_PUBLIC_URL', async () => {
    const h = await createHarness({ publicUrl: null, htaccess: false });
    try {
      await h.generator.generate();
      const page = readOut(h, 'de/day/2026-11-15/index.html');
      expect(page).not.toMatch(/rel="canonical"|rel="alternate"|og:image|og:url/);
      expect(page).toContain('<meta property="og:title"');
      expect(existsSync(join(h.outDir, '.htaccess'))).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});

describe.skipIf(!present)('generator: robustness', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(() => h.cleanup());

  it('serialises concurrent calls', async () => {
    const [a, b] = await Promise.all([h.generator.generate(), h.generator.generate()]);
    expect(a.version).toBe(1);
    expect(b).toMatchObject({ version: 1, changed: [], removed: [] });
  });

  it('a new site build triggers a full run and replaces the assets', async () => {
    rmSync(join(h.siteDist, 'assets'), { recursive: true });
    writeFakeSiteBuild(h.siteDist, { version: 'b2' });
    const r = await h.generator.generate();
    expect(r).toMatchObject({ full: true, fullReason: 'new site build', version: 2 });
    expect(r.removed).toEqual(expect.arrayContaining(['assets/index-a1x1.js', 'assets/shared-a1x2.js']));
    expect(existsSync(join(h.outDir, 'assets/index-b2x1.js'))).toBe(true);
    for (const rel of htmlFiles(h)) {
      if (rel !== 'index.html') expect(readOut(h, rel)).toContain('/assets/index-b2x1.js');
    }
  });

  it('an interrupted run makes the next run full; stray files are removed', async () => {
    mkdirSync(join(h.outDir, 'de/day/2000-01-01'), { recursive: true });
    writeFileSync(join(h.outDir, 'de/day/2000-01-01/index.html'), 'stale');
    mkdirSync(join(h.outDir, 'media/ab'), { recursive: true });
    writeFileSync(join(h.outDir, 'media/ab/ffffffffffffffff_w320.avif'), 'stale');
    writeFileSync(join(h.outDir, 'data/days/2000-01-01.json'), '{}');
    h.store.meta.set(DIRTY_KEY, '1');
    const r = await h.generator.generate();
    expect(r.fullReason).toBe('previous run was interrupted');
    expect(r.removed).toEqual([
      'data/days/2000-01-01.json',
      'de/day/2000-01-01/index.html',
      'media/ab/ffffffffffffffff_w320.avif',
    ]);
    expect(r.version).toBe(2);
  });

  it('repairs deleted output files without a new release', async () => {
    rmSync(join(h.outDir, 'en/day/2026-11-14/index.html'));
    rmSync(join(h.outDir, 'data/days/2026-11-14.json'));
    const before = snapshot(h.outDir);
    const r = await h.generator.generate({ full: true });
    expect(r.version).toBe(2);
    expect(r.changed).toEqual(['data/days/2026-11-14.json', 'en/day/2026-11-14/index.html']);
    expect(Object.keys(snapshot(h.outDir)).length).toBe(Object.keys(before).length + 2);
  });

  it('a wiped OUT_DIR is regenerated byte-identically (release stamps survive in the store)', async () => {
    const before = snapshot(h.outDir);
    rmSync(h.outDir, { recursive: true });
    const r = await h.generator.generate({ full: true });
    expect(r.version).toBe(2);
    expect(snapshot(h.outDir)).toEqual(before);
  });

  it('fails clearly without a site build and rejects invalid dates', async () => {
    const g = createHarness({ siteDist: join(h.dir, 'no-such-dist') });
    const other = await g;
    try {
      await expect(other.generator.generate()).rejects.toBeInstanceOf(SiteBuildError);
    } finally {
      other.cleanup();
    }
    await expect(h.generator.generate({ dates: ['2026-02-30'] })).rejects.toThrow(RangeError);
  });

  it('route files match routePath() of the contracts', () => {
    expect(existsSync(join(h.outDir, `${routePath('de', { name: 'trip', slug: 'vietnam-2026' })}index.html`))).toBe(
      true,
    );
  });
});

/** The visible first screen (the twin) of a generated page. */
function twinOf(page: string): string {
  const start = page.indexOf('<div id="omw-root">');
  const end = page.indexOf('<noscript>', start);
  return page.slice(start, end);
}

/** The no-JS article (inside <noscript> in #omw-root). */
function noscriptOf(page: string): string {
  const start = page.indexOf('<noscript>', page.indexOf('<div id="omw-root">'));
  return page.slice(start + '<noscript>'.length, page.indexOf('</noscript>', start));
}
