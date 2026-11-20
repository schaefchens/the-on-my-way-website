import type { Entry, ImageSet } from '@omw/contracts/site';
import { describe, expect, it } from 'vitest';
import {
  clip,
  entriesLayout,
  excerpt,
  MOSAIC_MIN_ITEMS,
  STRIP_ASPECT,
  stripItemWidth,
  stripLayout,
} from '../src/timeline/strip-layout';

const image = (w: number, h: number): ImageSet => ({
  w,
  h,
  color: '#aabbcc',
  thumbhash: 'AAAA',
  sources: { avif: [{ w: 320, src: 'media/a.avif' }], webp: [{ w: 320, src: 'media/a.webp' }] },
});
const base = { id: 'e_aaaaaaaaaaaa', at: '2026-11-18T10:00:00Z', tz: 'Asia/Ho_Chi_Minh' } as const;

describe('filmstrip item widths', () => {
  it('follow the photo aspect ratio within bounds', () => {
    const photo = (w: number, h: number): Entry => ({ ...base, kind: 'photo', image: image(w, h) });
    expect(stripItemWidth(photo(1200, 1600), 200)).toBe(150);
    expect(stripItemWidth(photo(4000, 1000), 200)).toBe(200 * STRIP_ASPECT.max);
    expect(stripItemWidth(photo(500, 4000), 200)).toBe(Math.round(200 * STRIP_ASPECT.min));
  });

  it('give text, voice, note and story cards fixed proportions', () => {
    const text: Entry = {
      ...base,
      kind: 'text',
      text: { body: 'hi', bg: '#000000ff', fg: '#ffffffff', font: 'SYSTEM' },
    };
    expect(stripItemWidth(text, 200)).toBe(156);
    const note: Entry = { ...base, id: 'p_note1', kind: 'note', note: { de: 'x' }, orig: 'de' };
    expect(stripItemWidth(note, 200)).toBe(164);
  });
});

describe('clip (filmstrip labels)', () => {
  it('keeps short text, cuts long text with an ellipsis, never splits a surrogate pair', () => {
    expect(clip('  Hội An  ', 80)).toBe('Hội An');
    expect(clip('abcdef', 4)).toBe('abc…');
    const emoji = '😀'.repeat(10);
    const out = clip(emoji, 5);
    expect(out).toBe(`${'😀'.repeat(4)}…`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });
});

describe('strip layout', () => {
  const photo = (i: number, w: number, h: number): Entry => ({
    ...base,
    id: `e_${String(i).padStart(12, '0')}`,
    kind: 'photo',
    image: image(w, h),
  });

  it('one row at full height for few moments (or without the mosaic)', () => {
    const entries = [photo(1, 1200, 1600), photo(2, 1600, 1200)];
    const layout = entriesLayout(entries, { height: 288, gap: 12, mosaic: true });
    expect(layout.mosaic).toBe(false);
    expect(layout.cells.map((c) => [c.x, c.y, c.w, c.h])).toEqual([
      [0, 0, 216, 288],
      [228, 0, 384, 288],
    ]);
    expect(layout.width).toBe(612);
    const many = Array.from({ length: 6 }, (_, i) => photo(i, 1200, 1600));
    expect(entriesLayout(many, { height: 240, gap: 12, mosaic: false }).mosaic).toBe(false);
  });

  it('wide screens: a large lead and half-height tiles in two balanced rows', () => {
    const entries = Array.from({ length: 7 }, (_, i) => photo(i, 1000, 1000));
    const layout = entriesLayout(entries, { height: 288, gap: 12, mosaic: true });
    expect(layout.mosaic).toBe(true);
    const [lead, ...tiles] = layout.cells;
    expect(lead).toMatchObject({ x: 0, y: 0, w: 288, h: 288, size: 'large' });
    // Rows: top at y 0, bottom aligned with the lead's bottom; tiles alternate.
    expect(tiles.map((c) => c.y)).toEqual([0, 150, 0, 150, 0, 150]);
    expect(tiles.every((c) => c.h === 138 && c.w === 138)).toBe(true);
    expect(tiles.map((c) => c.x)).toEqual([300, 300, 450, 450, 600, 600]);
    expect(layout.width).toBe(738);
    // Deterministic.
    expect(entriesLayout(entries, { height: 288, gap: 12, mosaic: true })).toEqual(layout);
  });

  it('shows eight or more moments in a 1440 px strip, even all landscape', () => {
    const entries = Array.from({ length: 16 }, (_, i) => photo(i, 1600, 900));
    const layout = entriesLayout(entries, { height: 288, gap: 12, mosaic: true });
    const visible = layout.cells.filter((c) => c.x + c.w <= 1000).length;
    expect(visible).toBeGreaterThanOrEqual(8);
  });

  it(`needs ${MOSAIC_MIN_ITEMS} moments for the mosaic`, () => {
    const aspect = () => 1;
    expect(stripLayout(MOSAIC_MIN_ITEMS - 1, aspect, { height: 288, gap: 12, mosaic: true }).mosaic).toBe(false);
    expect(stripLayout(MOSAIC_MIN_ITEMS, aspect, { height: 288, gap: 12, mosaic: true }).mosaic).toBe(true);
    expect(stripLayout(0, aspect, { height: 288, gap: 12, mosaic: true }).width).toBe(0);
  });
});

describe('excerpt (accessible names)', () => {
  it('collapses whitespace and line breaks, then clips', () => {
    expect(excerpt('  Erste Schale\n\n  Phở.  ', 120)).toBe('Erste Schale Phở.');
    expect(excerpt('a '.repeat(100), 120)).toHaveLength(120);
    expect(excerpt('a '.repeat(100), 120).endsWith('…')).toBe(true);
  });
});
