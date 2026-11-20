/**
 * Regression tests for problems found in the independent verification of the generator:
 * - pages that depend on summary-only facts (the day cover from Day.coverSourceKey) were not
 *   re-rendered incrementally, so incremental output differed from a full run;
 * - user text starting with "media/" was taken for a media reference (a note crashed the whole
 *   run, a caption made its capture disappear as "missing media");
 * - one owner item that the API accepts but the site contract does not (a note > 20,000 chars)
 *   failed contract validation of the whole run;
 * - settings that only act through the model (timezone.current, publish.*) forced full runs;
 * - SITE_DIST_DIR (config.siteDistDir) was ignored unless the caller passed siteDistDir;
 * - meta descriptions could end in half an emoji; leftover asset temp files were never removed;
 * - a misconfigured OUT_DIR (= DATA_DIR, a parent of MEDIA_DIR, …) would have had every
 *   unplanned file in it deleted by the first full run (store.db, WhatsApp session, media);
 * - the day page showed the cover twice in a row when it was the day's first picture.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Post } from '@omw/contracts/api';
import { publicIdFromSha256Hex } from '@omw/contracts/ids';
import { afterEach, describe, expect, it } from 'vitest';
import { fixturesPresent, readFixtureIndex } from '../../src/generator/dev/fixtures.js';
import { createGenerator, UnsafeOutDirError } from '../../src/generator/index.js';
import { isGeneratorPath } from '../../src/generator/output.js';
import { truncate } from '../../src/generator/pages.js';
import { verifyOutDir } from '../../src/generator/verify.js';
import { createLogger } from '../../src/log.js';
import { bootOf, createHarness, type Harness, readJson, readOut, snapshot } from './harness.js';

const present = fixturesPresent();
const index = present ? readFixtureIndex() : [];
const key = (k: string) => {
  const s = index.find((e) => e.key === k);
  if (!s) throw new Error(`no fixture ${k}`);
  return s;
};

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

/** Full regeneration into an empty directory must equal the incremental output byte for byte. */
async function expectFullEqualsIncremental(hh: Harness, label: string): Promise<void> {
  const fresh = join(hh.dir, `fresh-${label}`);
  const before = hh.store.meta.siteVersion();
  const result = await hh.generatorFor(fresh).generate({ full: true, reason: `check ${label}` });
  expect(result.version, `${label}: full run must not bump the version`).toBe(before);
  expect(snapshot(fresh), `${label}: full output differs from incremental output`).toEqual(snapshot(hh.outDir));
  rmSync(fresh, { recursive: true, force: true });
}

function ogImage(page: string): string | undefined {
  return /<meta property="og:image" content="([^"]+)"/.exec(page)?.[1];
}

function heroSrc(page: string): string | undefined {
  return /<main>.*?<picture class="omw-fs-pic">.*?<img [^>]*src="([^"]+)"/s.exec(page)?.[1];
}

function note(publicId: string, body: string, date = '2026-11-15'): Post {
  return {
    publicId,
    kind: 'note',
    occurredAt: `${date}T03:00:00Z`,
    tz: 'Asia/Ho_Chi_Minh',
    localDate: date,
    origLocale: 'en',
    visibility: 'public',
    updatedAt: '2026-11-19T12:03:00Z',
    content: { en: { body } },
  };
}

describe.skipIf(!present)('generator regressions: incremental dependencies', () => {
  it('a Day.coverSourceKey change re-renders the day, story and trip pages (incremental == full)', async () => {
    h = await createHarness();
    await h.generator.generate();
    const before = readOut(h, 'en/day/2026-11-15/index.html');
    const day = h.store.owner.getDay('2026-11-15');
    h.store.owner.upsertDay({
      ...(day ?? { localDate: '2026-11-15' }),
      coverSourceKey: key('hoian-gif').sourceKey,
      updatedAt: '2026-11-19T12:10:00Z',
    });
    const r = await h.generator.generate();
    expect(r.full).toBe(false);
    expect(r.version).toBe(2);
    // The day file itself is unchanged (the cover is summary-only) ...
    expect(r.changed).not.toContain('data/days/2026-11-15.json');
    // ... but every page showing the cover follows: hero + og:image, story og:image, trip thumbs.
    expect(r.changed).toEqual(
      expect.arrayContaining([
        'data/timeline.json',
        'de/day/2026-11-15/index.html',
        'en/day/2026-11-15/index.html',
        'de/day/2026-11-15/story/p_s01lantern/index.html',
        'en/day/2026-11-15/story/p_s01lantern/index.html',
        'de/trip/vietnam-2026/index.html',
        'en/trip/vietnam-2026/index.html',
      ]),
    );
    const after = readOut(h, 'en/day/2026-11-15/index.html');
    expect(heroSrc(after)).not.toBe(heroSrc(before));
    expect(bootOf(after).manifestVersion).toBe(2);
    await expectFullEqualsIncremental(h, 'cover');
  });

  it('a Day.coverSourceKey placed on another day is ignored; moving the cover away re-renders (L2-07)', async () => {
    h = await createHarness();
    const morning = key('hoian-photo-morning'); // placed on 2026-11-15
    const sha = h.store.captures.get(morning.sourceKey)?.originalSha256?.slice(0, 16) ?? 'none';
    // 2026-11-12 is outside the trip, so no trip dependency re-renders it by accident.
    const day = h.store.owner.getDay('2026-11-12');
    h.store.owner.upsertDay({
      ...(day ?? { localDate: '2026-11-12' }),
      coverSourceKey: morning.sourceKey,
      updatedAt: '2026-11-19T12:10:00Z',
    });
    await h.generator.generate();
    // a cover from another day is not used: 2026-11-12 shows its own first image
    const d12 = readOut(h, 'de/day/2026-11-12/index.html');
    expect(d12).not.toContain(sha);
    const tl = readJson<{ days: { date: string; cover?: { fallback: string } }[] }>(h, 'data/timeline.json');
    expect(JSON.stringify(tl.days.find((d) => d.date === '2026-11-12'))).not.toContain(sha);
    // the owner picks it as the cover of its own day, then moves it to another day
    const d15 = h.store.owner.getDay('2026-11-15');
    h.store.owner.upsertDay({
      ...(d15 ?? { localDate: '2026-11-15' }),
      coverSourceKey: morning.sourceKey,
      updatedAt: '2026-11-19T12:11:00Z',
    });
    await h.generator.generate();
    expect(heroSrc(readOut(h, 'de/day/2026-11-15/index.html'))).toContain(sha);
    expect(ogImage(readOut(h, 'de/day/2026-11-15/index.html'))).toContain(sha);
    h.store.owner.upsertAnnotation({
      ...(h.store.owner.getAnnotation(morning.sourceKey) ?? { sourceKey: morning.sourceKey }),
      localDateOverride: '2026-11-16',
      updatedAt: '2026-11-19T12:12:00Z',
    });
    const r = await h.generator.generate();
    expect(r.full).toBe(false);
    expect(r.changed).toContain('de/day/2026-11-15/index.html');
    const after15 = readOut(h, 'de/day/2026-11-15/index.html');
    // hero, og:image and the timeline tile of 2026-11-15 come from an image still on that day
    expect(heroSrc(after15)).toBeDefined();
    expect(heroSrc(after15)).not.toContain(sha);
    expect(ogImage(after15)).not.toContain(sha);
    const tl2 = readJson<{ days: { date: string; cover?: unknown }[] }>(h, 'data/timeline.json');
    const cover15 = JSON.stringify(tl2.days.find((d) => d.date === '2026-11-15')?.cover);
    expect(cover15).toBeDefined();
    expect(cover15).not.toContain(sha);
    // the moved status is listed (and may be the cover) on its new day
    const day16 = readJson<{ entries: { id: string }[] }>(h, 'data/days/2026-11-16.json');
    expect(day16.entries.map((e) => e.id)).toContain(h.store.captures.get(morning.sourceKey)?.publicId);
    await expectFullEqualsIncremental(h, 'moved-cover');
  });
});

describe.skipIf(!present)('generator regressions: user text is never a media reference', () => {
  it('notes, captions and text statuses that start with "media/" are published as text', async () => {
    h = await createHarness({ captions: { 'berlin-photo': 'media/ab/notreal.avif' } });
    h.store.owner.upsertPost(note('p_medianote', 'media/ coverage was great'));
    const text = h.store.captures.get(key('berlin-text').sourceKey);
    expect(text?.text).toBeTruthy();
    const r = await h.generator.generate();
    expect(r.warnings).toEqual([]);
    expect(readJson<{ entries: { id: string }[] }>(h, 'data/days/2026-11-12.json').entries.map((e) => e.id)).toContain(
      key('berlin-photo').publicId,
    );
    expect(readOut(h, 'data/days/2026-11-15.json')).toContain('p_medianote');
    expect(readOut(h, 'en/day/2026-11-12/index.html')).toContain('>media/ab/notreal.avif</p>');
    expect((await verifyOutDir(h.outDir)).problems).toEqual([]);
  });
});

describe.skipIf(!present)('generator regressions: one bad owner item never blocks the site', () => {
  it('a note longer than the site contract allows is left out with a warning', async () => {
    h = await createHarness();
    // The API accepts note bodies up to 100,000 characters; I18nText allows 20,000.
    h.store.owner.upsertPost(note('p_hugenote', 'x'.repeat(20_001)));
    h.store.owner.upsertPost(note('p_finenote', 'still here'));
    const r = await h.generator.generate();
    expect(r.warnings).toEqual([
      expect.stringMatching(/^post p_hugenote \(note\) left out: violates the site contract/),
    ]);
    const day = readOut(h, 'data/days/2026-11-15.json');
    expect(day).not.toContain('p_hugenote');
    expect(day).toContain('p_finenote');
    expect((await verifyOutDir(h.outDir)).problems).toEqual([]);
  });
});

describe.skipIf(!present)('generator regressions: what forces a full run', () => {
  it('timezone.current and publish.* changes are incremental (and change nothing here)', async () => {
    h = await createHarness();
    await h.generator.generate();
    const before = snapshot(h.outDir);
    h.store.owner.setSetting('timezone.current', 'Asia/Bangkok');
    const r1 = await h.generator.generate();
    expect(r1).toMatchObject({ full: false, version: 1, changed: [], removed: [] });
    // Switching to review mode now never unpublishes the archive (mode_since).
    h.store.owner.setSetting('publish.mode', 'review');
    h.store.owner.setSetting('publish.mode_since', '2026-11-19T12:00:00.000Z');
    const r2 = await h.generator.generate();
    expect(r2).toMatchObject({ full: false, version: 1, changed: [], removed: [] });
    expect(snapshot(h.outDir)).toEqual(before);
    // site.* settings still force a full run.
    h.store.owner.setSetting('site.title', 'Unterwegs');
    const r3 = await h.generator.generate();
    expect(r3).toMatchObject({ full: true, fullReason: 'settings changed', version: 2 });
    await expectFullEqualsIncremental(h, 'settings');
  });
});

describe.skipIf(!present)('generator regressions: configuration and housekeeping', () => {
  it('uses SITE_DIST_DIR (config.siteDistDir) when no siteDistDir is passed', async () => {
    h = await createHarness();
    const out = join(h.dir, 'out-config-dist');
    const generator = createGenerator({
      config: { ...h.config, siteDistDir: h.siteDist, dirs: { ...h.config.dirs, out } },
      log: createLogger({ level: 'silent' }),
      store: h.store,
      now: h.clock,
    });
    await generator.generate();
    expect(existsSync(join(out, 'assets/index-a1x1.js'))).toBe(true);
  });

  it('full runs remove leftover temp files of a crashed run, also below assets/', async () => {
    h = await createHarness();
    await h.generator.generate();
    mkdirSync(join(h.outDir, 'assets'), { recursive: true });
    writeFileSync(join(h.outDir, 'assets/index-a1x1.js.tmp-123-4'), 'partial');
    writeFileSync(join(h.outDir, 'de/index.html.tmp-123-5'), 'partial');
    const r = await h.generator.generate({ full: true });
    expect(r.removed).toEqual(['assets/index-a1x1.js.tmp-123-4', 'de/index.html.tmp-123-5']);
    expect(r.version).toBe(1);
  });

  it('refuses an OUT_DIR that is or contains a directory it must never touch', async () => {
    h = await createHarness();
    const log = createLogger({ level: 'silent' });
    const media = snapshot(h.mediaDir);
    expect(Object.keys(media).length).toBeGreaterThan(0);
    const cases: [string, string][] = [
      ['DATA_DIR', h.config.dirs.data],
      ['MEDIA_DIR', join(h.mediaDir, '..')],
      ['the site build', join(h.siteDist, '..')],
      ['the repository', '/'],
    ];
    for (const [name, out] of cases) {
      const generator = createGenerator({
        config: { ...h.config, dirs: { ...h.config.dirs, out } },
        log,
        store: h.store,
        now: h.clock,
        siteDistDir: h.siteDist,
      });
      await expect(generator.generate(), name).rejects.toThrow(UnsafeOutDirError);
    }
    expect(snapshot(h.mediaDir)).toEqual(media);
  });

  it('full runs leave files outside the generator namespaces alone', async () => {
    h = await createHarness();
    mkdirSync(join(h.outDir, 'private'), { recursive: true });
    writeFileSync(join(h.outDir, 'private/notes.txt'), 'operator file');
    writeFileSync(join(h.outDir, 'google1234.html'), 'site verification');
    mkdirSync(join(h.outDir, 'de/day/2000-01-01'), { recursive: true });
    writeFileSync(join(h.outDir, 'de/day/2000-01-01/index.html'), 'stale page');
    const r = await h.generator.generate();
    expect(r.full).toBe(true);
    expect(r.removed).toEqual(['de/day/2000-01-01/index.html']);
    expect(readOut(h, 'private/notes.txt')).toBe('operator file');
    expect(readOut(h, 'google1234.html')).toBe('site verification');
    expect(isGeneratorPath('data/days/2026-11-15.json')).toBe(true);
    expect(isGeneratorPath('index.html.tmp-12-3')).toBe(true);
    expect(isGeneratorPath('store.db')).toBe(false);
    expect(isGeneratorPath('wa/session.db')).toBe(false);
  });

  it('the 404 page does not claim to be the home page in its language switcher', async () => {
    h = await createHarness();
    await h.generator.generate();
    expect(readOut(h, '404.html')).toContain('lang="de" aria-current="true">Deutsch</a>');
    expect(readOut(h, 'de/index.html')).toContain('lang="de" aria-current="page">Deutsch</a>');
  });

  it('a site with no public entries is valid and says so', async () => {
    h = await createHarness();
    for (const s of index) {
      h.store.owner.upsertAnnotation({
        sourceKey: s.sourceKey,
        visibility: 'hidden',
        updatedAt: '2026-11-19T12:00:00Z',
      });
    }
    for (const p of h.store.owner.listPosts()) h.store.owner.upsertPost({ ...p, visibility: 'hidden' });
    const r = await h.generator.generate();
    // Only the owner's portrait (site.avatar of the demo owner) stays: its round crop, 3 sizes x 2 formats.
    expect(r.stats).toMatchObject({ days: 0, entries: 0, media: 6 });
    expect(readOut(h, 'de/index.html')).toContain('Noch keine Momente.');
    const timeline = readJson<{ days: unknown[]; trips: unknown[]; profile?: { avatar?: unknown } }>(
      h,
      'data/timeline.json',
    );
    expect(timeline.days).toEqual([]);
    expect(timeline.trips).toEqual([]);
    expect(timeline.profile?.avatar).toBeDefined();
    expect((await verifyOutDir(h.outDir)).problems).toEqual([]);
  });
});

describe.skipIf(!present)('generator regressions: daylight saving time', () => {
  it('places and shows wall-clock times across the Berlin DST switches', async () => {
    h = await createHarness();
    const instants = [
      '2026-03-28T23:30:00Z', // 00:30 CET, 29 Mar
      '2026-03-29T01:30:00Z', // 03:30 CEST (02:00-03:00 does not exist that night)
      '2026-10-24T22:30:00Z', // 00:30 CEST, 25 Oct
      '2026-10-25T00:30:00Z', // 02:30 CEST (first 02:30)
      '2026-10-25T01:30:00Z', // 02:30 CET (second 02:30)
    ];
    instants.forEach((occurredAt, i) => {
      const sourceKey = `wa:DST${i}`;
      const publicId = publicIdFromSha256Hex(createHash('sha256').update(sourceKey).digest('hex'));
      h?.store.captures.insert({
        sourceKey,
        publicId,
        msgId: `DST${i}`,
        source: 'fixture',
        kind: 'text',
        occurredAt,
        tz: 'Europe/Berlin',
        text: { body: `dst ${i}`, bgArgb: null, textArgb: null, font: null },
      });
      h?.store.captures.markReady(sourceKey);
    });
    await h.generator.generate();
    const times = (date: string) =>
      [
        ...readOut(h as Harness, `de/day/${date}/index.html`).matchAll(
          /<time class="omw-fs-meta" datetime="[^"]+">([^<]+)</g,
        ),
      ].map((m) => m[1]);
    expect(times('2026-03-29')).toEqual(['00:30', '03:30']);
    expect(times('2026-10-25')).toEqual(['00:30', '02:30', '02:30']);
    const oct = readJson<{ tz: string; entries: { at: string }[] }>(h, 'data/days/2026-10-25.json');
    expect(oct.tz).toBe('Europe/Berlin');
    expect(oct.entries.map((e) => e.at)).toEqual(instants.slice(2).map((t) => t.replace('Z', '.000Z')));
  });
});

describe('truncate (meta descriptions, alt text)', () => {
  it('never splits a surrogate pair', () => {
    const text = `${'a'.repeat(158)}🇻🇳 tail`;
    const out = truncate(text, 160);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(truncate('short', 160)).toBe('short');
  });
});
