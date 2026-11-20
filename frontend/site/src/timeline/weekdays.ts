/** Weekday column labels of the month grids (pure; Intl only). */
import type { LocaleCode } from '@omw/contracts/i18n';
import { dateTimeFormat } from '@omw/ui/locale';

/** Below this tile width the full short names ("Mo.", "Tue") do not fit. */
export const NARROW_TILE = 56;

function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter !== 'function') return Array.from(text);
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (g) => g.segment);
}

function names(locale: LocaleCode, weekStart: number, weekday: 'short' | 'narrow'): string[] {
  // 2024-01-07 was a Sunday (weekday 0).
  const fmt = dateTimeFormat(locale, { weekday, timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(Date.UTC(2024, 0, 7 + ((weekStart + i) % 7)))));
}

/**
 * Seven labels starting at `weekStart` (0 = Sunday). Narrow tiles get two-letter short names
 * ("Mo", "Di") when these stay distinct; scripts where cutting would collapse them (Arabic
 * "ال…", Hebrew "יום …") get the locale's own narrow forms instead. Never cuts in the middle of a
 * grapheme cluster.
 */
export function weekdayLabels(locale: LocaleCode, weekStart: number, tile: number): string[] {
  const short = names(locale, weekStart, 'short');
  if (tile >= NARROW_TILE) return short;
  const cut = short.map((s) => graphemes(s.replace(/\.$/, '')).slice(0, 2).join(''));
  return new Set(cut).size === 7 ? cut : names(locale, weekStart, 'narrow');
}
