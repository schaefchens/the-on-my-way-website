import { describe, expect, it } from 'vitest';
import { NARROW_TILE, weekdayLabels } from '../src/timeline/weekdays';

describe('weekdayLabels', () => {
  it('wide tiles: the short names, Monday first', () => {
    const de = weekdayLabels('de', 1, NARROW_TILE);
    expect(de).toHaveLength(7);
    expect(de[0]).toMatch(/^Mo/);
    expect(de[6]).toMatch(/^So/);
    expect(weekdayLabels('en', 0, 80)[0]).toMatch(/^Sun/);
  });

  it('narrow tiles: two letters where they stay distinct (de, en)', () => {
    expect(weekdayLabels('de', 1, 40)).toEqual(['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']);
    expect(weekdayLabels('en', 1, 40)).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
  });

  it('narrow tiles in Arabic: never seven identical cut-offs ("ال"), the narrow forms instead', () => {
    const ar = weekdayLabels('ar', 1, 40);
    expect(ar).toHaveLength(7);
    expect(ar.every((l) => l.length > 0)).toBe(true);
    expect(ar).not.toContain('ال');
    expect(new Set(ar).size).toBe(7);
  });
});
