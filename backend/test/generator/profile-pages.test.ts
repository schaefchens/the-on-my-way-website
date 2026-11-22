/**
 * The profile on the pre-rendered first screen (pages.ts, twin.ts): the home hero (portrait,
 * name, greeting), the player's avatar ring, no <meta name="author"> (neutral previews), the Boot JSON of day/story
 * pages and the no-JS article. The shared fixtures' demo owner has a profile ("Lea", a de and an
 * en greeting, the Hà Nội photo as portrait with focus {0.5, 0.4}).
 */
import type { Boot, TimelineIndex } from '@omw/contracts/site';
import { afterEach, describe, expect, it } from 'vitest';
import { PageStyles } from '../../src/generator/css.js';
import { fixturesPresent } from '../../src/generator/dev/fixtures.js';
import { HERO_PORTRAIT_SIZES } from '../../src/generator/twin.js';
import { bootOf, createHarness, type Harness, readJson, readOut } from './harness.js';

const present = fixturesPresent();
const SLOW = { timeout: 60_000 };

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

/** The first-screen twin of a page (the part React replaces), without the <noscript> article. */
function twinOf(page: string): string {
  const start = page.indexOf('<div class="omw-twin');
  const end = page.indexOf('<noscript>', start);
  expect(start, 'twin').toBeGreaterThan(0);
  return page.slice(start, end);
}

function articleOf(page: string): string {
  const m = /<noscript><div class="omw-fs">([\s\S]*?)<\/noscript>/.exec(page);
  if (!m?.[1]) throw new Error('no article');
  return m[1];
}

function heroOf(twin: string): string {
  const m = /<div data-testid="profile-intro"[\s\S]*?<\/div><\/div>/.exec(twin);
  if (!m) throw new Error('no profile intro');
  return m[0];
}

describe('PageStyles.objectPosition', () => {
  it('turns a focus point into a validated object-position rule (never mirrored)', () => {
    const s = new PageStyles();
    expect(s.objectPosition({ x: 0.5, y: 0.4 })).toBe('omw-fp-50-40');
    expect(s.objectPosition({ x: 0.333, y: 1 })).toBe('omw-fp-33_3-100');
    expect(s.css()).toContain('.omw-fp-50-40{object-position:50% 40%}');
    expect(s.css()).toContain('.omw-fp-33_3-100{object-position:33.3% 100%}');
    for (const bad of [
      { x: -0.1, y: 0 },
      { x: 0, y: 1.2 },
      { x: Number.NaN, y: 0 },
    ]) {
      expect(() => s.objectPosition(bad)).toThrow(RangeError);
    }
  });
});

describe.skipIf(!present)('profile on the first screen', SLOW, () => {
  it('home: portrait, name and greeting in the twin; no author meta; article lead', async () => {
    h = await createHarness();
    await h.generator.generate();
    const timeline = readJson<TimelineIndex>(h, 'data/timeline.json');
    const avatar = timeline.profile?.avatar;
    expect(avatar).toBeDefined();
    const de = readOut(h, 'de/index.html');
    // Neutral link previews (spec-wave5 §5.2): the name is never in a meta tag.
    expect(de).not.toContain('name="author"');
    const hero = heroOf(twinOf(de));
    expect(hero).toContain('>Lea</p>');
    expect(hero).toMatch(/<p lang="de" dir="auto" data-user-text class="[^"]*font-hand[^"]*">Hallo ihr Lieben!/);
    // The portrait: a fixed-size ring, eager, its round crop only (already framed at the focus
    // point, so no object-position), with the placeholder.
    expect(hero).toContain('data-testid="hero-portrait"');
    expect(hero).toContain(`sizes="${HERO_PORTRAIT_SIZES}"`);
    const img = /<img [^>]*>/.exec(hero)?.[0] ?? '';
    expect(img).toContain('loading="eager"');
    expect(img).toContain('alt=""');
    expect(img).toContain('width="288" height="288"');
    expect(img).toMatch(/class="size-full rounded-full object-cover omw-bg-[a-z0-9]+ omw-c-[0-9a-f]{6}"/);
    expect(de).not.toContain('omw-fp-');
    const srcsets = [...hero.matchAll(/srcset="([^"]*)"/g)].map((m) => m[1] ?? '');
    for (const candidate of srcsets.join(', ').split(', ')) {
      expect(candidate).toMatch(/_avatar_[0-9a-f]{8}_s(96|192|288)\.(avif|webp) (96|192|288)w$/);
    }
    for (const s of avatar?.sources.webp ?? []) expect(hero).toContain(s.src);
    // The tagline gives way to the greeting; the collage never repeats the portrait's photo.
    expect(hero).not.toContain('✈︎');
    const collage = /<div aria-hidden="true" class="pointer-events-none absolute end-gutter-wide[\s\S]*?<\/div>/.exec(
      twinOf(de),
    )?.[0];
    const photo = avatar?.sources.webp[0]?.src.split('_')[0];
    if (collage && photo) expect(collage).not.toContain(`${photo}_`);
    // No-JS readers get the name and the greeting too.
    const article = articleOf(de);
    expect(article).toContain('<p class="omw-fs-kicker" dir="auto">Lea</p>');
    expect(article).toContain('<p class="omw-fs-lead omw-fs-user" dir="auto" lang="de">Hallo ihr Lieben!');

    const en = heroOf(twinOf(readOut(h, 'en/index.html')));
    expect(en).toMatch(/<p lang="en" dir="auto"[^>]*>Hello, lovely people!/);
  });

  it('a greeting written in one language only is shown everywhere, marked with its language', async () => {
    h = await createHarness();
    h.store.owner.setSetting('site.intro', { en: 'Hello from the road!' });
    h.store.owner.deleteSetting('site.avatar');
    await h.generator.generate();
    const hero = heroOf(twinOf(readOut(h, 'de/index.html')));
    expect(hero).toContain('<p lang="en" dir="auto" data-user-text');
    expect(hero).toContain('Hello from the road!');
    expect(hero).not.toContain('hero-portrait');
  });

  it('day and story pages: the player avatar is the portrait; the Boot JSON carries the profile', async () => {
    h = await createHarness();
    await h.generator.generate();
    const timeline = readJson<TimelineIndex>(h, 'data/timeline.json');
    const day = timeline.days.find((d) => d.counts.story > 0) ?? timeline.days[0];
    if (!day) throw new Error('no day');
    const page = readOut(h, `de/day/${day.date}/index.html`);
    const boot = bootOf(page) as Boot;
    expect(boot.profile).toEqual(timeline.profile);
    expect(page).not.toContain('name="author"');
    const header =
      /<span class="grid size-10 shrink-0 place-items-center rounded-pill bg-linear-to-br[\s\S]*?<\/span><\/span>/.exec(
        twinOf(page),
      )?.[0];
    expect(header).toBeDefined();
    expect(header).toContain('sizes="40px"');
    expect(header).toContain(timeline.profile?.avatar?.sources.webp[0]?.src ?? '-');
    expect(header).not.toContain('omw-fp-');
  });

  it('nothing set: the first screen is exactly as before (tagline, day picture as avatar, no author)', async () => {
    h = await createHarness();
    for (const k of ['site.author', 'site.intro', 'site.avatar'] as const) h.store.owner.deleteSetting(k);
    await h.generator.generate();
    const home = readOut(h, 'de/index.html');
    expect(home).not.toContain('profile-intro');
    expect(home).not.toContain('name="author"');
    expect(twinOf(home)).toContain('<p class="font-hand text-lg text-accent sm:text-2xl">Momente von unterwegs ✈︎</p>');
    expect(articleOf(home)).toContain('<p class="omw-fs-lead">Reisetagebuch</p>');
    const timeline = readJson<TimelineIndex>(h, 'data/timeline.json');
    const date = timeline.days[0]?.date;
    const page = readOut(h, `de/day/${date}/index.html`);
    expect(bootOf(page)).not.toHaveProperty('profile');
    expect(page).not.toContain('omw-fp-');
    expect(page).not.toContain('name="author"');
  });
});
