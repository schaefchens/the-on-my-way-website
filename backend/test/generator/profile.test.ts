/**
 * The profile (site.author / site.intro / site.avatar) and published trips, end to end through
 * the generator on the shared fixtures (whose demo owner has a profile: "Lea", a greeting, the
 * Hà Nội photo as portrait), the local publisher and the output verifier.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Post, Trip } from '@omw/contracts/api';
import { AVATAR_MAX_WIDTH, type Manifest, type TimelineIndex } from '@omw/contracts/site';
import pino from 'pino';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { fixturesPresent, readFixtureIndex } from '../../src/generator/dev/fixtures.js';
import { contentHash } from '../../src/generator/hash.js';
import { createGenerator } from '../../src/generator/index.js';
import { verifyOutDir } from '../../src/generator/verify.js';
import { createPublisher } from '../../src/publisher/index.js';
import { Store } from '../../src/store/index.js';
import { localTarget, silentLog, staticTargets } from '../publisher/helpers.js';
import { createHarness, type Harness, readJson, readOut, snapshot } from './harness.js';

const present = fixturesPresent();
const index = present ? readFixtureIndex() : [];
const key = (k: string) => {
  const s = index.find((e) => e.key === k);
  if (!s) throw new Error(`no fixture ${k}`);
  return s;
};
/** WhatsApp ids must never appear in static output (D4). */
const forbidden = () => index.flatMap((s) => [s.msgId, s.sourceKey]);

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

function shaOf(harness: Harness, fixtureKey: string): string {
  const sha = harness.store.captures.get(key(fixtureKey).sourceKey)?.originalSha256;
  if (!sha) throw new Error(`no media for ${fixtureKey}`);
  return sha.slice(0, 16);
}

/** Files below `dir` (relative, "/"-separated). */
function filesBelow(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

const variantsOf = (files: readonly string[], sha: string) =>
  files
    .filter((p) => p.startsWith('media/') && p.includes(`${sha}_`))
    .map((p) => p.slice(p.indexOf('_') + 1))
    .sort();

/** The portrait's own files: its round crop at 96/192/288 px (pipeline/avatar.ts). */
const CROP_RE = /^avatar_[0-9a-f]{8}_s(?:96|192|288)\.(?:avif|webp)$/;
const crops = (names: readonly string[]) => names.filter((n) => n.startsWith('avatar_'));
const PHOTO = ['og.jpg', 'w1080.avif', 'w1080.webp', 'w320.avif', 'w320.webp', 'w640.avif', 'w640.webp'];

function localPublisher(harness: Harness, siteDir: string) {
  return createPublisher({
    config: harness.config,
    log: silentLog,
    store: harness.store,
    targets: staticTargets([localTarget('local', siteDir)]),
    hashCacheFile: null,
    httpCheck: false,
  });
}

/** Full regeneration of the same store into an empty directory must equal the incremental output. */
async function expectFullEqualsIncremental(harness: Harness, label: string): Promise<void> {
  const fresh = join(harness.dir, `fresh-${label}`);
  await harness.generatorFor(fresh).generate({ full: true, reason: `check ${label}` });
  expect(snapshot(fresh), `${label}: full output differs from incremental output`).toEqual(snapshot(harness.outDir));
}

// Several generator runs (some full) plus local deploys per test: more than the 5 s default when
// other suites share the machine.
const SLOW = { timeout: 60_000 };

describe.skipIf(!present)('profile: timeline.json carries who travels', SLOW, () => {
  it('publishes the demo owner’s author, greeting and portrait (its round crop only)', async () => {
    h = await createHarness();
    await h.generator.generate();
    const timeline = readJson<TimelineIndex>(h, 'data/timeline.json');
    expect(timeline.profile?.author).toBe('Lea');
    expect(Object.keys(timeline.profile?.intro ?? {}).sort()).toEqual(['de', 'en']);
    const avatar = timeline.profile?.avatar;
    // Already framed at the owner's focus point: square, no object-position needed.
    expect(avatar).toMatchObject({ w: 288, h: 288 });
    expect(avatar).not.toHaveProperty('focus');
    expect(avatar).not.toHaveProperty('og');
    const sources = [...(avatar?.sources.avif ?? []), ...(avatar?.sources.webp ?? [])];
    expect(sources.map((s) => s.w).sort((a, b) => a - b)).toEqual([96, 96, 192, 192, 288, 288]);
    const sha = shaOf(h, 'hanoi-photo');
    for (const s of sources) {
      expect(s.w).toBeLessThanOrEqual(AVATAR_MAX_WIDTH);
      expect(s.src.startsWith(`media/${sha.slice(0, 2)}/${sha}_`)).toBe(true);
      expect(s.src.slice(s.src.indexOf('_') + 1)).toMatch(CROP_RE);
    }
    // Round: transparent corners, opaque middle, the advertised size.
    const largest = avatar?.sources.webp.at(-1)?.src ?? '-';
    const { data, info } = await sharp(join(h.outDir, largest))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([288, 288]);
    const alpha = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
    expect([alpha(0, 0), alpha(287, 0), alpha(0, 287), alpha(287, 287)]).toEqual([0, 0, 0, 0]);
    expect(alpha(144, 144)).toBe(255);
    // The timeline hash covers the profile; the verifier agrees; no WhatsApp id leaks.
    const manifest = readJson<Manifest>(h, 'data/manifest.json');
    const { trips, days, profile } = timeline;
    expect(manifest.timeline.v).toBe(contentHash({ trips, days, profile }));
    expect((await verifyOutDir(h.outDir, { forbidden: forbidden() })).problems).toEqual([]);
  });

  it('without profile settings timeline.json has no profile and the same hash as before', async () => {
    h = await createHarness();
    for (const k of ['site.author', 'site.intro', 'site.avatar'] as const) h.store.owner.deleteSetting(k);
    await h.generator.generate();
    const timeline = readJson<TimelineIndex>(h, 'data/timeline.json');
    expect(timeline).not.toHaveProperty('profile');
    expect(readOut(h, 'data/timeline.json')).not.toContain('"profile"');
    expect(readJson<Manifest>(h, 'data/manifest.json').timeline.v).toBe(
      contentHash({ trips: timeline.trips, days: timeline.days }),
    );
  });

  it('a hidden photo stays the portrait with its round crop only; clearing it deletes the crop from the host', async () => {
    h = await createHarness();
    const site = join(h.dir, 'site');
    const publisher = localPublisher(h, site);
    await h.generator.generate();
    expect((await publisher.deploy({ outDir: h.outDir }))[0]?.ok).toBe(true);
    const hanoi = key('hanoi-photo');
    const sha = shaOf(h, 'hanoi-photo');
    const published = variantsOf(filesBelow(site), sha);
    expect(published.filter((n) => !n.startsWith('avatar_'))).toEqual(PHOTO);
    const crop = crops(published);
    expect(crop).toHaveLength(6);
    for (const n of crop) expect(n).toMatch(CROP_RE);

    // Hidden from the timeline: the entry and every variant of the photo go (also the small
    // ones and the OG image); the portrait stays as its round crop.
    h.store.owner.upsertAnnotation({
      sourceKey: hanoi.sourceKey,
      visibility: 'hidden',
      updatedAt: '2026-11-19T12:01:00Z',
    });
    const hidden = await h.generator.generate();
    expect(hidden.full).toBe(false);
    expect(variantsOf(hidden.removed, sha)).toEqual(PHOTO);
    expect(variantsOf(filesBelow(h.outDir), sha)).toEqual(crop);
    expect(readJson<TimelineIndex>(h, 'data/timeline.json').profile?.avatar).toBeDefined();
    for (const rel of filesBelow(h.outDir).filter((p) => !p.startsWith('media/') && !p.startsWith('assets/'))) {
      const text = readFileSync(join(h.outDir, rel), 'utf8');
      expect(text, rel).not.toContain(hanoi.publicId);
      expect(text, rel).not.toContain('Angekommen in Hà Nội'); // its caption
    }
    await expectFullEqualsIncremental(h, 'hidden-portrait');
    const deployHidden = (await publisher.deploy({ outDir: h.outDir }))[0];
    expect(deployHidden?.ok).toBe(true);
    expect(variantsOf(filesBelow(site), sha)).toEqual(crop);

    // Clearing site.avatar: full run (the profile is on every page), the files go, then off the
    // host; the crop is removed from MEDIA_DIR too.
    h.store.owner.deleteSetting('site.avatar');
    const cleared = await h.generator.generate();
    expect(cleared.fullReason).toBe('settings changed');
    expect(variantsOf(cleared.removed, sha)).toEqual(crop);
    expect(
      crops(
        variantsOf(
          filesBelow(h.mediaDir).map((p) => `media/${p}`),
          sha,
        ),
      ),
    ).toEqual([]);
    const profile = readJson<TimelineIndex>(h, 'data/timeline.json').profile;
    expect(profile).toEqual({ author: 'Lea', intro: expect.any(Object) });
    const deployCleared = (await publisher.deploy({ outDir: h.outDir }))[0];
    expect(deployCleared?.ok).toBe(true);
    expect(deployCleared?.deleted).toBeGreaterThanOrEqual(6);
    expect(variantsOf(filesBelow(site), sha)).toEqual([]);
    expect((await verifyOutDir(site, { forbidden: forbidden() })).problems).toEqual([]);
  });

  it('changing the portrait re-renders everything; files another entry still uses stay', async () => {
    h = await createHarness();
    await h.generator.generate();
    const before = readJson<TimelineIndex>(h, 'data/timeline.json').profile?.avatar;
    h.store.owner.setSetting('site.avatar', { sourceKey: key('saigon-photo').sourceKey });
    const r = await h.generator.generate();
    expect(r.fullReason).toBe('settings changed');
    const after = readJson<TimelineIndex>(h, 'data/timeline.json').profile?.avatar;
    expect(after?.sources.webp[0]?.src).toContain(shaOf(h, 'saigon-photo'));
    expect(after).not.toEqual(before);
    // The Hà Nội photo is public itself: its own files stay, only its round crop goes.
    const hanoi = shaOf(h, 'hanoi-photo');
    expect(variantsOf(r.removed, hanoi).every((n) => CROP_RE.test(n))).toBe(true);
    expect(variantsOf(r.removed, hanoi)).toHaveLength(6);
    expect(variantsOf(filesBelow(h.outDir), hanoi)).toEqual(PHOTO);
  });

  it('a new focus point makes a new crop; the old one goes from OUT_DIR and MEDIA_DIR', async () => {
    h = await createHarness();
    await h.generator.generate();
    const sha = shaOf(h, 'hanoi-photo');
    const before = crops(variantsOf(filesBelow(h.outDir), sha));
    const avatar = h.store.owner.settings()['site.avatar'];
    if (!avatar) throw new Error('the demo owner has a portrait');
    h.store.owner.setSetting('site.avatar', { ...avatar, focus: { x: 0.5, y: 0.1 } });
    const r = await h.generator.generate();
    expect(r.fullReason).toBe('settings changed');
    const after = crops(variantsOf(filesBelow(h.outDir), sha));
    expect(after).toHaveLength(6);
    expect(after.some((n) => before.includes(n))).toBe(false);
    expect(variantsOf(r.removed, sha)).toEqual(before);
    expect(
      crops(
        variantsOf(
          filesBelow(h.mediaDir).map((p) => `media/${p}`),
          sha,
        ),
      ),
    ).toEqual(after);
    // An unchanged setting finds its crop: nothing is written again.
    const again = await h.generator.generate({ full: true });
    expect(again.changed).toEqual([]);
    await expectFullEqualsIncremental(h, 'new-focus');
  });

  it('no portrait for a revoked photo (on_revoke = hide): one warning, logged once; the files go', async () => {
    h = await createHarness();
    const lines: string[] = [];
    const log = pino({ level: 'warn' }, { write: (line: string) => lines.push(line) });
    const generator = createGenerator({
      config: h.config,
      log,
      store: h.store,
      now: h.clock,
      siteDistDir: h.siteDist,
      validate: true,
    });
    await generator.generate();
    const warned = () => lines.filter((l) => l.includes('site.avatar')).length;
    expect(warned()).toBe(0);
    const sha = shaOf(h, 'hanoi-photo');
    h.store.captures.setRevoked(key('hanoi-photo').sourceKey, '2026-11-19T12:05:00Z');
    const r = await generator.generate();
    expect(r.fullReason).toBe('settings changed'); // the resolved profile changed
    expect(r.warnings.filter((w) => w.startsWith('site.avatar'))).toEqual([
      `site.avatar ${key('hanoi-photo').sourceKey}: no portrait published: deleted on WhatsApp (ingest.on_revoke = hide)`,
    ]);
    expect(readJson<TimelineIndex>(h, 'data/timeline.json').profile).not.toHaveProperty('avatar');
    expect(variantsOf(filesBelow(h.outDir), sha)).toEqual([]);
    expect(warned()).toBe(1);
    await generator.generate({ full: true });
    await generator.generate();
    expect(warned()).toBe(1); // unchanged warnings are not logged again
    // The warning (local log only) names the capture; the published files never do.
    expect((await verifyOutDir(h.outDir, { forbidden: forbidden() })).problems).toEqual([]);
  });

  it('escapes author and greeting: exact round trip through timeline.json, never raw markup in pages', async () => {
    h = await createHarness();
    const author = '</script><script>alert("a")</script>';
    const intro = { de: '"><img src=x onerror=alert(1)>\u2028<!--', en: 'Line one\nline two & <b>bold</b>' };
    h.store.owner.setSetting('site.author', author);
    h.store.owner.setSetting('site.intro', intro);
    await h.generator.generate();
    const raw = readOut(h, 'data/timeline.json');
    const timeline = JSON.parse(raw) as TimelineIndex;
    expect(timeline.profile?.author).toBe(author);
    expect(timeline.profile?.intro).toEqual(intro);
    for (const rel of filesBelow(h.outDir).filter((p) => p.endsWith('.html'))) {
      const page = readOut(h, rel);
      expect(page, rel).not.toMatch(/<script>alert|<img src=x|<b>bold/);
      for (const m of page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))
        expect(m[1], rel).not.toMatch(/[\u2028\u2029]/);
    }
    expect((await verifyOutDir(h.outDir, { forbidden: forbidden() })).problems).toEqual([]);
  });
});

describe.skipIf(!present)('planned trips: nothing public until their first public day', SLOW, () => {
  const japan: Trip = {
    slug: 'japan-2027',
    title: { de: 'Japan im Frühling', en: 'Japan in spring' },
    description: { de: 'Kirschblüten!' },
    origLocale: 'de',
    startDate: '2027-03-01',
    endDate: '2027-03-20',
    updatedAt: '2026-11-19T12:00:00Z',
  };
  const note = (visibility: Post['visibility']): Post => ({
    publicId: 'p_japan0001',
    kind: 'note',
    occurredAt: '2027-03-02T03:00:00Z',
    tz: 'Asia/Tokyo',
    localDate: '2027-03-02',
    origLocale: 'de',
    visibility,
    content: { de: { body: 'Angekommen in Tōkyō' } },
    updatedAt: '2026-11-19T12:00:00Z',
  });
  const tripFiles = (harness: Harness) =>
    filesBelow(harness.outDir).filter((p) => p.includes('japan-2027') || p.includes('2027-03-02'));
  const mentions = (harness: Harness) =>
    filesBelow(harness.outDir)
      .filter((p) => !p.startsWith('media/') && !p.startsWith('assets/'))
      .filter((p) => /japan-2027|Japan im Frühling|Japan in spring/.test(readOut(harness, p)));

  it('appears with its first public day and disappears with its last one, files included', async () => {
    h = await createHarness({ publicUrl: 'https://example.org/' });
    h.store.owner.setSetting('site.indexable', true);
    h.store.owner.upsertTrip(japan);
    // A planned trip, and a pending note on its first day: still nothing anywhere.
    h.store.owner.upsertPost(note('pending'));
    await h.generator.generate();
    expect(readJson<TimelineIndex>(h, 'data/timeline.json').trips.map((t) => t.slug)).toEqual(['vietnam-2026']);
    expect(tripFiles(h)).toEqual([]);
    expect(mentions(h)).toEqual([]); // no card, chip, sitemap entry, title anywhere
    expect((await verifyOutDir(h.outDir, { forbidden: forbidden() })).problems).toEqual([]);

    // First public day: the trip, its data file, pages and sitemap entries appear.
    h.store.owner.upsertPost(note('public'));
    const shown = await h.generator.generate();
    expect(shown.full).toBe(false);
    expect(shown.changed).toEqual(
      expect.arrayContaining([
        'data/trips/japan-2027.json',
        'de/trip/japan-2027/index.html',
        'en/trip/japan-2027/index.html',
        'data/days/2027-03-02.json',
      ]),
    );
    const trips = readJson<TimelineIndex>(h, 'data/timeline.json').trips;
    expect(trips.map((t) => [t.slug, t.dayCount])).toEqual([
      ['vietnam-2026', 4],
      ['japan-2027', 1],
    ]);
    expect(readOut(h, 'sitemap.xml')).toContain('<loc>https://example.org/de/trip/japan-2027/</loc>');
    await expectFullEqualsIncremental(h, 'trip-shown');

    // Everything hidden again: the trip and all its files disappear on the next run.
    h.store.owner.upsertPost(note('hidden'));
    const gone = await h.generator.generate();
    expect(gone.removed).toEqual(
      expect.arrayContaining([
        'data/trips/japan-2027.json',
        'de/trip/japan-2027/index.html',
        'en/trip/japan-2027/index.html',
        'data/days/2027-03-02.json',
      ]),
    );
    expect(tripFiles(h)).toEqual([]);
    expect(mentions(h)).toEqual([]);
    expect((await verifyOutDir(h.outDir, { forbidden: forbidden() })).problems).toEqual([]);
    await expectFullEqualsIncremental(h, 'trip-gone');
  });
});

describe('owner mirror: the profile settings apply like every other setting', () => {
  it('upserts and tombstones from the change feed', () => {
    const store = Store.memory();
    try {
      const avatar = { sourceKey: 'wa:3EB0ABCDEF', focus: { x: 0.5, y: 0.25 } };
      const intro = { de: 'Hallo!', en: 'Hello!' };
      const page = (items: unknown[], nextSeq: number) => ({ feedId: 'feed00000001', items, nextSeq, hasMore: false });
      const set = (seq: number, k: string, value: unknown) => ({
        seq,
        entity: 'setting',
        key: k,
        op: 'upsert',
        data: { value },
      });
      const r = store.owner.applyChanges(
        page([set(1, 'site.author', 'Lea'), set(2, 'site.intro', intro), set(3, 'site.avatar', avatar)], 3),
      );
      expect(r).toMatchObject({ applied: 3, ignored: 0, quarantined: 0, settingsChanged: true });
      expect(store.owner.settings()).toMatchObject({
        'site.author': 'Lea',
        'site.intro': intro,
        'site.avatar': avatar,
      });
      // Invalid values are quarantined; the last good value stays.
      const bad = store.owner.applyChanges(page([set(4, 'site.author', ' Lea ')], 4));
      expect(bad.quarantined).toBe(1);
      expect(store.owner.settings()['site.author']).toBe('Lea');
      const del = (seq: number, k: string) => ({ seq, entity: 'setting', key: k, op: 'delete' });
      store.owner.applyChanges(page([del(5, 'site.author'), del(6, 'site.intro'), del(7, 'site.avatar')], 7));
      const after = store.owner.settings();
      for (const k of ['site.author', 'site.intro', 'site.avatar']) expect(after).not.toHaveProperty(k);
    } finally {
      store.close();
    }
  });
});
