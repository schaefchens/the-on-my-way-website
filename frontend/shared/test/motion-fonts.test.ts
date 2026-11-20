import { readFileSync } from 'node:fs';
import { FONT_NAMES } from '@omw/contracts/wa';
import { describe, expect, it } from 'vitest';
import { WA_FONTS, waFontStyle } from '../src/fonts';
import { SPRINGS } from '../src/motion';

const theme = readFileSync(new URL('../src/styles/theme.css', import.meta.url), 'utf8');
const fonts = readFileSync(new URL('../src/styles/fonts.css', import.meta.url), 'utf8');

describe('motion presets', () => {
  it('match the plan', () => {
    expect(SPRINGS.soft).toEqual({ type: 'spring', visualDuration: 0.35, bounce: 0.15 });
    expect(SPRINGS.snappy.visualDuration).toBe(0.2);
    expect(SPRINGS.float.visualDuration).toBe(0.8);
  });
});

describe('WhatsApp font map', () => {
  it('covers every FontName and points at variables defined in theme.css', () => {
    for (const name of FONT_NAMES) {
      const spec = WA_FONTS[name];
      expect(theme).toContain(`${spec.cssVar}:`);
      expect(waFontStyle(name).fontFamily).toBe(`var(${spec.cssVar})`);
      if (spec.hosted) expect(fonts).toContain(`font-family: '${spec.hosted}'`);
    }
  });

  it('ships no emoji/cyrillic/greek/math subsets', () => {
    expect(fonts).not.toMatch(/-\[\d+\]-/);
    expect(fonts).not.toMatch(/cyrillic|greek|math/);
  });
});
