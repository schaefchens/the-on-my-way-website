import type { Entry } from '@omw/contracts/site';
import { describe, expect, it } from 'vitest';
import {
  charCount,
  DURATIONS,
  gifDurationMs,
  itemTiming,
  mediaDurationMs,
  noteDurationMs,
  photoDurationMs,
  textStatusDurationMs,
} from '../../src/player/durations';

const image = {
  w: 1600,
  h: 1200,
  color: '#aabbcc',
  thumbhash: 'AAAA',
  sources: { avif: [{ w: 320, src: 'media/a/a_w320.avif' }], webp: [{ w: 320, src: 'media/a/a_w320.webp' }] },
};
const base = { id: 'e_aaaaaaaaaaaa', at: '2026-11-15T02:12:00Z', tz: 'Asia/Ho_Chi_Minh' } as const;

describe('durations', () => {
  it('counts code points of trimmed, collapsed text', () => {
    expect(charCount('  Hội  An 🏮 ')).toBe(8);
    expect(charCount(undefined)).toBe(0);
  });

  it('photo: 5 s without text, +60 ms/char, capped at 12 s', () => {
    expect(photoDurationMs(0)).toBe(5_000);
    expect(photoDurationMs(50)).toBe(8_000);
    expect(photoDurationMs(500)).toBe(12_000);
    expect(photoDurationMs(-3)).toBe(5_000);
  });

  it('text status: 3 s + 45 ms/char, at most 10 s', () => {
    expect(textStatusDurationMs('')).toBe(3_000);
    expect(textStatusDurationMs('x'.repeat(100))).toBe(7_500);
    expect(textStatusDurationMs('x'.repeat(400))).toBe(10_000);
  });

  it('note: 6–10 s', () => {
    expect(noteDurationMs('Hi')).toBe(6_080);
    expect(noteDurationMs('')).toBe(6_000);
    expect(noteDurationMs('x'.repeat(280))).toBe(10_000);
  });

  it('gif: whole loops until 5 s, real length when longer', () => {
    expect(gifDurationMs(2)).toBe(6_000);
    expect(gifDurationMs(0.7)).toBeCloseTo(5_600);
    expect(gifDurationMs(5)).toBe(5_000);
    expect(gifDurationMs(14)).toBe(14_000);
    expect(gifDurationMs(0)).toBe(5_000);
    expect(gifDurationMs(Number.NaN)).toBe(5_000);
  });

  it('media: seconds to ms with a fallback', () => {
    expect(mediaDurationMs(3.02)).toBe(3_020);
    expect(mediaDurationMs(0)).toBe(DURATIONS.mediaFallbackMs);
    expect(mediaDurationMs(undefined)).toBe(DURATIONS.mediaFallbackMs);
  });

  it('itemTiming per kind', () => {
    const photo: Entry = {
      ...base,
      kind: 'photo',
      image,
      caption: 'Hội An',
      description: { de: 'Gelbe Häuser.', en: 'Yellow houses.' },
      descriptionOrig: 'de',
    };
    expect(itemTiming(photo, 'de')).toEqual({ timing: 'timer', durationMs: 5_000 + (6 + 13) * 60 });
    expect(itemTiming(photo, 'en')).toEqual({ timing: 'timer', durationMs: 5_000 + (6 + 14) * 60 });

    const video: Entry = {
      ...base,
      kind: 'video',
      video: { src: 'media/v.mp4', w: 720, h: 1280, duration: 4, hasAudio: true, poster: image },
    };
    expect(itemTiming(video, 'de')).toEqual({ timing: 'media', durationMs: 4_000 });
    // Data saver: no autoplay, the poster shows like a photo.
    expect(itemTiming(video, 'de', { dataSaver: true })).toEqual({ timing: 'timer', durationMs: 5_000 });

    const voice: Entry = { ...base, kind: 'voice', audio: { src: 'media/a.m4a', duration: 3, peaks: [0.1] } };
    expect(itemTiming(voice, 'de')).toEqual({ timing: 'media', durationMs: 3_000 });

    const story: Entry = {
      ...base,
      id: 'p_story0001',
      kind: 'story',
      story: { de: { title: 'T', body: 'B' } },
      orig: 'de',
    };
    expect(itemTiming(story, 'en')).toEqual({ timing: 'timer', durationMs: 6_000 });

    const note: Entry = { ...base, id: 'p_note00001', kind: 'note', note: { en: 'x'.repeat(50) }, orig: 'en' };
    expect(itemTiming(note, 'de').durationMs).toBe(8_000);

    const gif: Entry = {
      ...base,
      kind: 'gif',
      loop: true,
      video: { src: 'media/g.mp4', w: 480, h: 480, duration: 2, hasAudio: false, poster: image },
    };
    expect(itemTiming(gif, 'de')).toEqual({ timing: 'timer', durationMs: 6_000 });
  });
});
