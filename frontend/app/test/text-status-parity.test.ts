/**
 * The app's text-status preview must match the site's TextSlide: the same thresholds
 * (textStatusScale in frontend/site/src/player/items.ts) and the same sizes (TEXT_SIZES in
 * slides.tsx, in cqi). Read from the site's sources, so a change there fails here.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TEXT_STATUS_PADDING_CQI, TEXT_STATUS_SIZES, textStatusScale } from '../src/core/text-status';

const site = (path: string) => readFileSync(new URL(`../../site/src/player/${path}`, import.meta.url), 'utf8');

describe('text status parity with the site', () => {
  it('uses the site’s length thresholds', () => {
    const src = site('items.ts');
    const fn = /export function textStatusScale[\s\S]*?\n}/.exec(src)?.[0] ?? '';
    const thresholds = [...fn.matchAll(/if \(n <= (\d+)\) return '(\w+)'/g)].map((m) => [Number(m[1]), m[2]] as const);
    expect(thresholds).toEqual([
      [24, 'xl'],
      [70, 'lg'],
      [160, 'md'],
    ]);
    for (const [n, scale] of thresholds) {
      expect(textStatusScale('x'.repeat(n))).toBe(scale);
      expect(textStatusScale('x'.repeat(n + 1))).not.toBe(scale);
    }
  });

  it('uses the site’s sizes, line heights and padding', () => {
    const src = site('slides.tsx');
    const block = /const TEXT_SIZES = \{([\s\S]*?)\} as const;/.exec(src)?.[1] ?? '';
    const sizes = Object.fromEntries(
      [...block.matchAll(/(\w+): 'text-\[([\d.]+)cqi\] leading-\[([\d.]+)\]'/g)].map((m) => [
        m[1],
        { cqi: Number(m[2]), lineHeight: Number(m[3]) },
      ]),
    );
    expect(sizes).toEqual(TEXT_STATUS_SIZES);
    expect(src).toContain(`px-[${TEXT_STATUS_PADDING_CQI}cqi]`);
  });
});
