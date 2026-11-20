/** The hero collage never repeats a cover the first screen shows (L3-19). */
import type { ImageSet } from '@omw/contracts/site';
import { describe, expect, it } from 'vitest';
import { heroCovers } from '../src/components/site-header';
import { day, timeline, trip } from './timeline-fixture';

const img = (name: string): ImageSet => ({
  w: 800,
  h: 600,
  color: '#aabbcc',
  thumbhash: 'AAAA',
  sources: { avif: [{ w: 320, src: `media/${name}.avif` }], webp: [{ w: 320, src: `media/${name}.webp` }] },
});
const names = (covers: ImageSet[]) => covers.map((c) => c.sources.webp[0]?.src.slice(6, -5));

// Like the fixtures: a loose day, then a trip of four days whose cover is one of its days'.
const tl = timeline(
  [
    day('2026-11-12', { cover: img('berlin') }),
    day('2026-11-14', { trip: 'vn', cover: img('hanoi') }),
    day('2026-11-15', { trip: 'vn', cover: img('hoian') }),
    day('2026-11-16', { trip: 'vn', cover: img('saigon2') }),
    day('2026-11-17', { trip: 'vn', cover: img('saigon') }),
    day('2026-10-02', { cover: img('october') }),
  ],
  [{ ...trip('vn', '2026-11-14', '2026-11-17', ['VN']), cover: img('hoian') }],
);

describe('hero collage covers', () => {
  it('days level: not the two newest days nor their trip, older days instead', () => {
    expect(names(heroCovers(tl, 'days'))).toEqual(['hanoi', 'berlin', 'october']);
  });

  it('years level: not what the trip card and the "in between" card show', () => {
    // Trip card: hoian (trip cover), saigon, saigon2; then the loose run 12.11. + 02.10. (berlin, october).
    expect(names(heroCovers(tl, 'trips'))).toEqual(['hanoi']);
  });

  it('months level: not the tiles of the two newest months', () => {
    expect(heroCovers(tl, 'months')).toEqual([]);
  });

  it('degrades with few days (none, or fewer than three)', () => {
    expect(heroCovers(timeline([]), 'days')).toEqual([]);
    expect(heroCovers(timeline([day('2026-11-17', { cover: img('a') })]), 'days')).toEqual([]);
    expect(names(heroCovers(tl, 'days', 1))).toEqual(['hanoi']);
  });
});
