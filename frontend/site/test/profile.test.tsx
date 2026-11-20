/**
 * The owner's profile on the site: where it comes from (timeline, else Boot JSON), the greeting
 * pick, the portrait crop, the home hero block, the player's avatar ring and the day-end
 * sign-off. Nothing set: every part renders as before.
 */
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { AvatarImage, ImageSet, SiteProfile } from '@omw/contracts/site';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseBootJson, parseBootProfile } from '../src/boot';
import { heroCovers, ProfileIntro } from '../src/components/site-header';
import { activateLocale } from '../src/i18n';
import { PlayerHeader } from '../src/player/chrome';
import { DayEndCard } from '../src/player/day-end';
import { focusPosition, greetingFor, HERO_PORTRAIT_SIZES, ProfileValueProvider, profileFrom } from '../src/profile';
import { day, timeline } from './timeline-fixture';

/** Like the generator's: the round crop of a photo (its own small square files). */
const avatar = (focus?: { x: number; y: number }): AvatarImage => ({
  w: 288,
  h: 288,
  color: '#e88868',
  thumbhash: '55kGHgR2afh1eFiIh5Z4h4d4j52oCIs=',
  sources: {
    avif: [
      { w: 96, src: 'media/b9/b9ccb4af0cbdee5b_avatar_7098c834_s96.avif' },
      { w: 192, src: 'media/b9/b9ccb4af0cbdee5b_avatar_7098c834_s192.avif' },
      { w: 288, src: 'media/b9/b9ccb4af0cbdee5b_avatar_7098c834_s288.avif' },
    ],
    webp: [
      { w: 96, src: 'media/b9/b9ccb4af0cbdee5b_avatar_7098c834_s96.webp' },
      { w: 192, src: 'media/b9/b9ccb4af0cbdee5b_avatar_7098c834_s192.webp' },
      { w: 288, src: 'media/b9/b9ccb4af0cbdee5b_avatar_7098c834_s288.webp' },
    ],
  },
  ...(focus ? { focus } : {}),
});

const LEA: SiteProfile = {
  author: 'Lea',
  intro: { de: 'Hallo ihr Lieben!', en: 'Hello, lovely people!' },
  avatar: avatar({ x: 0.5, y: 0.4 }),
};

const cover: ImageSet = {
  w: 800,
  h: 600,
  color: '#aabbcc',
  thumbhash: 'AAAA',
  sources: { avif: [{ w: 320, src: 'media/cc/day.avif' }], webp: [{ w: 320, src: 'media/cc/day.webp' }] },
};

function render(node: ReactNode, profile: SiteProfile | null = null): string {
  return renderToStaticMarkup(
    <I18nProvider i18n={i18n}>
      <ProfileValueProvider profile={profile}>{node}</ProfileValueProvider>
    </I18nProvider>,
  );
}

beforeAll(async () => {
  await activateLocale('de');
});

describe('profile data', () => {
  it('comes from the timeline once loaded, from the Boot JSON until then', () => {
    const boot: SiteProfile = { author: 'Boot' };
    expect(profileFrom(undefined, boot)).toEqual(boot);
    expect(profileFrom(undefined, null)).toBeNull();
    expect(profileFrom({ profile: LEA }, boot)).toEqual(LEA);
    // A loaded timeline without a profile means: nothing set (the boot's may be older).
    expect(profileFrom({}, boot)).toBeNull();
    expect(profileFrom({ profile: {} }, null)).toBeNull();
  });

  it('picks the greeting in the visitor’s language, else in the one it exists in', () => {
    expect(greetingFor(LEA, 'en')).toEqual({ text: 'Hello, lovely people!', locale: 'en', fallback: false });
    expect(greetingFor({ intro: { en: 'Hi!' } }, 'de')).toEqual({ text: 'Hi!', locale: 'en', fallback: true });
    expect(greetingFor({ intro: { de: 'Hallo!' } }, 'ar')?.locale).toBe('de');
    expect(greetingFor({ author: 'Lea' }, 'de')).toBeNull();
    expect(greetingFor(null, 'de')).toBeNull();
  });

  it('turns the focus point into object-position (physical, clamped, 0.1 % steps)', () => {
    expect(focusPosition({ x: 0.5, y: 0.4 })).toBe('50% 40%');
    expect(focusPosition({ x: 0.3333, y: 1 })).toBe('33.3% 100%');
    expect(focusPosition({ x: -1, y: 2 })).toBe('0% 100%');
    expect(focusPosition(undefined)).toBeUndefined();
  });
});

describe('Boot JSON profile', () => {
  const base = {
    basePath: '/',
    locale: 'de',
    route: { name: 'day', params: { date: '2026-11-15' } },
    manifestVersion: 3,
    timelineV: 'de6ce259c71ad5ca',
  };

  it('is read from day pages, absent elsewhere', () => {
    expect(parseBootJson(JSON.stringify({ ...base, profile: LEA }))?.profile).toEqual(LEA);
    expect(parseBootJson(JSON.stringify(base))?.profile).toBeNull();
  });

  it('drops malformed parts instead of showing them', () => {
    expect(parseBootProfile({ author: '  ', intro: { fr: 'Salut', de: '' } })).toBeNull();
    expect(parseBootProfile({ author: 'Lea', intro: { fr: 'Salut', en: 'Hi' } })).toEqual({
      author: 'Lea',
      intro: { en: 'Hi' },
    });
    const bad = (patch: Record<string, unknown>) => parseBootProfile({ avatar: { ...avatar(), ...patch } });
    expect(bad({ color: 'red' })).toBeNull();
    expect(bad({ sources: { avif: [], webp: avatar().sources.webp } })).toBeNull();
    expect(
      bad({ sources: { avif: [{ w: 320, src: 'javascript:alert(1)' }], webp: avatar().sources.webp } }),
    ).toBeNull();
    expect(bad({ sources: { avif: [{ w: 320, src: 'media/../x.avif' }], webp: avatar().sources.webp } })).toBeNull();
    // A focus outside the image is ignored (centred crop), the portrait stays.
    expect(bad({ focus: { x: 2, y: 0.5 } })?.avatar?.focus).toBeUndefined();
    expect(parseBootProfile('Lea')).toBeNull();
  });

  it('counts the name in characters like the contract (an emoji is one, not two UTF-16 units)', () => {
    const emoji = `Lea ${'🌸'.repeat(30)}`; // 34 code points, 64 UTF-16 units
    expect(parseBootProfile({ author: emoji })?.author).toBe(emoji);
    expect(parseBootProfile({ author: '🌸'.repeat(60) })?.author).toBe('🌸'.repeat(60));
    expect(parseBootProfile({ author: 'a'.repeat(61) })).toBeNull();
  });
});

describe('home hero', () => {
  it('shows the portrait in its ring, the name and the greeting', () => {
    const html = render(<ProfileIntro profile={LEA} locale="de" />);
    expect(html).toContain('data-testid="hero-portrait"');
    expect(html).toContain(`sizes="${HERO_PORTRAIT_SIZES}"`);
    expect(html).toContain('object-position:50% 40%');
    expect(html).toContain('loading="eager"');
    expect(html).toMatch(/<p dir="auto" data-user-text="true" class="[^"]*font-display[^"]*">Lea<\/p>/);
    expect(html).toMatch(
      /<p lang="de" dir="auto" data-user-text="true" class="[^"]*font-hand[^"]*">Hallo ihr Lieben!<\/p>/,
    );
    expect(html).not.toContain('✈︎');
  });

  it('a greeting in another language keeps its lang; without one the tagline stays', () => {
    const fallback = render(<ProfileIntro profile={{ author: 'Lea', intro: { en: 'Hi!' } }} locale="de" />);
    expect(fallback).toContain('lang="en"');
    expect(fallback).not.toContain('hero-portrait');
    const nameOnly = render(<ProfileIntro profile={{ author: 'Lea' }} locale="de" />);
    expect(nameOnly).toContain('Momente von unterwegs');
    expect(nameOnly).toContain('✈︎');
  });

  it('escapes what the owner wrote', () => {
    const html = render(<ProfileIntro profile={{ author: '<b>Lea</b>', intro: { de: '<img src=x>' } }} locale="de" />);
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<img src=x');
  });

  it('the collage never repeats the portrait’s photo', () => {
    const img = (name: string): ImageSet => ({ ...cover, sources: { avif: [], webp: [{ w: 320, src: name }] } });
    const tl = {
      ...timeline([
        day('2026-11-10', { cover: img('media/a.webp') }),
        day('2026-11-11', { cover: img('media/b9/b9ccb4af0cbdee5b_w320.webp') }),
        day('2026-11-12', { cover: img('media/c.webp') }),
        day('2026-11-13', { cover: img('media/d.webp') }),
        day('2026-11-14', { cover: img('media/e.webp') }),
      ]),
      profile: LEA,
    };
    const shown = heroCovers(tl, 'days').map((c) => c.sources.webp[0]?.src);
    expect(shown).toEqual(['media/c.webp', 'media/a.webp']);
  });
});

describe('player', () => {
  const header = (profile: SiteProfile | null) =>
    render(
      <PlayerHeader title="Hội An" meta={['09:12']} avatar={cover}>
        <span />
      </PlayerHeader>,
      profile,
    );

  it('the avatar ring shows the portrait; without one, the day’s picture as before', () => {
    const withPortrait = header(LEA);
    expect(withPortrait).toContain('b9ccb4af0cbdee5b_avatar_7098c834_s96.webp');
    expect(withPortrait).toContain('object-position:50% 40%');
    expect(withPortrait).not.toContain('media/cc/day.webp');
    const without = header(null);
    expect(without).toContain('media/cc/day.webp');
    expect(without).not.toContain('b9ccb4af0cbdee5b');
    expect(header({ author: 'Lea' })).toContain('media/cc/day.webp');
  });

  const dayEnd = (profile: SiteProfile | null) =>
    render(
      <DayEndCard
        locale="de"
        title="Laternen in Hội An"
        momentCount={6}
        next={null}
        canCountDown={false}
        imageSizes="640px"
        onNextDay={() => undefined}
        onReplay={() => undefined}
        onClose={() => undefined}
      />,
      profile,
    );

  it('the day-end card signs off with the name, only when one is set', () => {
    const signed = dayEnd(LEA);
    expect(signed).toContain('data-testid="day-end-signoff"');
    expect(signed).toContain('Schön, dass du mitreist!');
    expect(signed).toMatch(/— <bdi dir="auto" data-user-text="true">Lea<\/bdi>/);
    expect(dayEnd({ avatar: avatar() })).not.toContain('day-end-signoff');
    expect(dayEnd(null)).not.toContain('day-end-signoff');
  });
});
