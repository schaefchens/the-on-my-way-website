import type { DayDetail, Entry } from '@omw/contracts/site';
import { describe, expect, it } from 'vitest';
import {
  buildItems,
  firstImage,
  markdownExcerpt,
  readingMinutes,
  textStatusScale,
  wordCount,
} from '../../src/player/items';
import { createPrefsStore, parsePrefs } from '../../src/player/prefs';
import { pickStory, type StoryEntry, storyAlternative } from '../../src/player/story-content';

const image = {
  w: 1200,
  h: 1600,
  color: '#aabbcc',
  thumbhash: 'AAAA',
  sources: { avif: [{ w: 320, src: 'media/a/a_w320.avif' }], webp: [{ w: 320, src: 'media/a/a_w320.webp' }] },
};

function day(entries: Entry[]): DayDetail {
  return { contractVersion: 1, date: '2026-11-15', v: 'abcd1234', tz: 'Asia/Ho_Chi_Minh', entries };
}

const story: StoryEntry = {
  id: 'p_s01lantern',
  at: '2026-11-15T14:00:00Z',
  tz: 'Asia/Ho_Chi_Minh',
  kind: 'story',
  orig: 'de',
  story: {
    de: { title: 'Die Nacht der Laternen', body: '## Vollmond\n\nEinmal im Monat …' },
    en: { title: 'The night of lanterns', body: 'Once a month …' },
  },
};

describe('buildItems', () => {
  it('picks texts for the locale, alt from description then caption, time in the traveler zone', () => {
    const items = buildItems(
      day([
        {
          id: 'e_aaaaaaaaaaaa',
          at: '2026-11-15T02:12:00Z',
          tz: 'Asia/Ho_Chi_Minh',
          kind: 'photo',
          image,
          caption: ' Hội An ',
          description: { de: 'Gelbe Häuser' },
          descriptionOrig: 'de',
        },
        {
          id: 'e_bbbbbbbbbbbb',
          at: '2026-11-15T03:00:00Z',
          tz: 'Asia/Ho_Chi_Minh',
          kind: 'photo',
          image,
          caption: 'Kaffee',
        },
        { id: 'e_cccccccccccc', at: '2026-11-15T04:00:00Z', tz: 'Asia/Ho_Chi_Minh', kind: 'photo', image },
        story,
      ]),
      'en',
    );
    expect(items.map((i) => i.kind)).toEqual(['photo', 'photo', 'photo', 'story']);
    expect(items[0]?.time).toBe('09:12');
    expect(items[0]?.description).toEqual({ text: 'Gelbe Häuser', locale: 'de', fallback: true });
    expect(items[0]?.alt).toBe('Gelbe Häuser');
    expect(items[1]?.alt).toBe('Kaffee');
    expect(items[2]?.alt).toBe('');
    expect(items[3]?.description).toBeNull();
    expect(items[3]?.image).toBeNull();
    expect(firstImage(items)).toBe(image);
  });
});

describe('story language', () => {
  it('shows the visitor locale, else the original with fallback flag', () => {
    expect(pickStory(story, 'en')).toMatchObject({ locale: 'en', fallback: false });
    expect(pickStory(story, 'de')).toMatchObject({ locale: 'de', fallback: false });
    const deOnly: StoryEntry = { ...story, story: { de: story.story.de } };
    expect(pickStory(deOnly, 'en')).toMatchObject({ locale: 'de', fallback: true });
    expect(pickStory({ ...story, story: {} }, 'en')).toBeNull();
    // Blank translations do not count.
    expect(pickStory({ ...story, story: { ...story.story, en: { title: ' ', body: '' } } }, 'en')?.locale).toBe('de');
  });

  it('offers the original for a translation and the translation for the original', () => {
    expect(storyAlternative(story, 'en', 'en')).toBe('de');
    expect(storyAlternative(story, 'de', 'en')).toBe('en');
    expect(storyAlternative(story, 'de', 'de')).toBeNull();
    expect(storyAlternative({ ...story, story: { de: story.story.de } }, 'de', 'en')).toBeNull();
  });
});

describe('text helpers', () => {
  it('builds a plain excerpt from markdown', () => {
    const md =
      '## Vollmond über dem Thu Bồn\n\nEinmal im Monat wird in **Hội An** der [Strom](https://x.y) abgedreht.\n\n- eine Kerze';
    expect(markdownExcerpt(md)).toBe('Einmal im Monat wird in Hội An der Strom abgedreht. eine Kerze');
    const long = markdownExcerpt('word '.repeat(100), 40);
    expect(long.endsWith('…')).toBe(true);
    expect(Array.from(long).length).toBeLessThanOrEqual(41);
  });

  it('estimates reading time', () => {
    expect(wordCount('Hello **world**, this is *Hội An*!')).toBe(6);
    expect(readingMinutes('word '.repeat(450))).toBe(2);
    expect(readingMinutes('')).toBe(1);
  });

  it('scales text statuses by length', () => {
    expect(textStatusScale('Hi')).toBe('xl');
    expect(textStatusScale('x'.repeat(60))).toBe('lg');
    expect(textStatusScale('x'.repeat(150))).toBe('md');
    expect(textStatusScale('x'.repeat(300))).toBe('sm');
  });
});

describe('prefs', () => {
  it('parses stored prefs defensively', () => {
    const d = { muted: true, dataSaver: false };
    expect(parsePrefs(null, d)).toEqual(d);
    expect(parsePrefs('nope', d)).toEqual(d);
    expect(parsePrefs('{"muted":false}', d)).toEqual({ muted: false, dataSaver: false });
    expect(parsePrefs('{"muted":"no","dataSaver":true}', d)).toEqual({ muted: true, dataSaver: true });
  });

  it('remembers choices and survives a throwing storage', () => {
    const data = new Map<string, string>();
    const store = createPrefsStore({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) });
    let calls = 0;
    store.subscribe(() => calls++);
    expect(store.get().muted).toBe(true);
    store.set({ muted: false });
    expect(store.get()).toEqual({ muted: false, dataSaver: false });
    expect(JSON.parse(data.get('omw.player.v1') ?? '{}')).toEqual({ muted: false, dataSaver: false });
    store.set({ muted: false });
    expect(calls).toBe(1);

    const broken = createPrefsStore({
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(broken.get().muted).toBe(true);
    broken.set({ dataSaver: true });
    expect(broken.get().dataSaver).toBe(true);
  });
});
