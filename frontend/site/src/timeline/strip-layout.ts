/**
 * Geometry of a day's filmstrip (pure; the strip height is fixed by the row model, so nothing
 * here can change a row's height).
 *
 * - One row: every moment at the full height, its width from its aspect ratio (phones, tablets,
 *   and days with few moments).
 * - Two-row mosaic (wide screens, L3-19): the first moment large (full height), the others as
 *   half-height tiles, each placed in whichever of the two rows ends first. A day with many
 *   moments then shows eight or more of them at 1440 px instead of three.
 * Positions are logical (x from the inline start), so the mosaic mirrors in RTL.
 */
import type { Entry, ImageSet } from '@omw/contracts/site';

/** Photos and posters keep their aspect ratio within these bounds (portrait … landscape). */
export const STRIP_ASPECT = { min: 0.62, max: 1.5 } as const;
/**
 * In the mosaic, pictures are cropped closer to square (a wide lead or wide tiles would leave
 * room for too few moments): the lead and the tiles stay within these bounds.
 */
export const MOSAIC_ASPECT = { lead: { min: 0.62, max: 1.25 }, small: { min: 0.75, max: 1 } } as const;

/** large: a one-row item; lead: the mosaic's first item; small: a mosaic tile. */
export type StripItemSize = 'large' | 'lead' | 'small';

type CardKind = 'text' | 'voice' | 'note' | 'story';

/** Card proportions at full height (tall cards) and as small mosaic tiles (wider, for text). */
const CARD_ASPECT: Record<'large' | 'small', Record<CardKind, number>> = {
  large: { text: 0.78, voice: 0.86, note: 0.82, story: 0.86 },
  small: { text: 1.2, voice: 1.1, note: 1.2, story: 1.2 },
};

/** A day needs at least this many moments for the mosaic (fewer are shown large). */
export const MOSAIC_MIN_ITEMS = 4;

function imageAspect(image: Pick<ImageSet, 'w' | 'h'>, size: StripItemSize): number {
  const bounds = size === 'large' ? STRIP_ASPECT : MOSAIC_ASPECT[size];
  if (image.w <= 0 || image.h <= 0) return Math.max(bounds.min, Math.min(bounds.max, 0.75));
  return Math.min(bounds.max, Math.max(bounds.min, image.w / image.h));
}

/** Width / height of an entry's strip item. */
export function stripAspect(entry: Entry, size: StripItemSize = 'large'): number {
  switch (entry.kind) {
    case 'photo':
      return imageAspect(entry.image, size);
    case 'video':
    case 'gif':
      return imageAspect(entry.video, size);
    default:
      return CARD_ASPECT[size === 'small' ? 'small' : 'large'][entry.kind];
  }
}

export function stripItemWidth(entry: Entry, height: number): number {
  return Math.round(height * stripAspect(entry));
}

export interface StripCell {
  /** Logical offsets inside the strip content (x from the inline start). */
  x: number;
  y: number;
  w: number;
  h: number;
  size: 'large' | 'small';
}

export interface StripLayout {
  mosaic: boolean;
  /** Width of the content (without the trailing gutter). */
  width: number;
  height: number;
  cells: StripCell[];
}

export interface StripLayoutOptions {
  /** Item area height (the strip minus its vertical padding). */
  height: number;
  gap: number;
  /** The metrics allow the mosaic (wide screens). */
  mosaic: boolean;
}

/**
 * Lays out `count` items whose aspect ratio (width / height) is given per size. Deterministic:
 * the same aspects always give the same geometry.
 */
export function stripLayout(
  count: number,
  aspectOf: (index: number, size: StripItemSize) => number,
  { height, gap, mosaic: allowMosaic }: StripLayoutOptions,
): StripLayout {
  const cells: StripCell[] = [];
  const mosaic = allowMosaic && count >= MOSAIC_MIN_ITEMS;
  if (!mosaic) {
    let x = 0;
    for (let i = 0; i < count; i++) {
      const w = Math.round(height * aspectOf(i, 'large'));
      cells.push({ x, y: 0, w, h: height, size: 'large' });
      x += w + gap;
    }
    return { mosaic, width: Math.max(0, x - gap), height, cells };
  }
  const small = Math.floor((height - gap) / 2);
  const leadW = Math.round(height * aspectOf(0, 'lead'));
  cells.push({ x: 0, y: 0, w: leadW, h: height, size: 'large' });
  const ends: [number, number] = [leadW + gap, leadW + gap];
  for (let i = 1; i < count; i++) {
    const row = ends[0] <= ends[1] ? 0 : 1;
    const w = Math.round(small * aspectOf(i, 'small'));
    cells.push({ x: ends[row], y: row === 0 ? 0 : height - small, w, h: small, size: 'small' });
    ends[row] += w + gap;
  }
  return { mosaic, width: Math.max(ends[0], ends[1]) - gap, height, cells };
}

/** Layout of a day's entries. */
export function entriesLayout(entries: readonly Entry[], opts: StripLayoutOptions): StripLayout {
  return stripLayout(entries.length, (i, size) => stripAspect(entries[i] as Entry, size), opts);
}

/** At most `max` code points (never half an emoji's surrogate pair), with an ellipsis if cut. */
export function clip(text: string, max: number): string {
  const chars = Array.from(text.trim());
  if (chars.length <= max) return chars.join('');
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}

/** Whitespace collapsed to single spaces (line breaks too), then clipped (accessible names). */
export function excerpt(text: string, max: number): string {
  return clip(text.replace(/\s+/g, ' '), max);
}
