import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WA_FONTS } from '../src/fonts';

/** The handwriting font: static, feature-trimmed subsets (scripts/fonts/subset-playpen.sh). */
const FAMILY = 'Playpen Sans Variable';
const stylesDir = new URL('../src/styles/', import.meta.url);
const fontsDir = new URL('../fonts/playpen-sans/', import.meta.url);
const css = readFileSync(new URL('fonts.css', stylesDir), 'utf8');

interface Face {
  weight: number;
  url: string;
  ranges: [number, number][];
}

function parseRanges(value: string): [number, number][] {
  return value.split(',').map((part) => {
    const [from = '', to] = part.trim().replace(/^U\+/, '').split('-');
    return [Number.parseInt(from, 16), Number.parseInt(to ?? from, 16)];
  });
}

const faces: Face[] = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)]
  .map(([, block = '']) => block)
  .filter((block) => block.includes(`font-family: '${FAMILY}';`))
  .map((block) => ({
    weight: Number(/font-weight:\s*([^;]+);/.exec(block)?.[1]),
    url: /src:\s*url\(([^)]+)\)/.exec(block)?.[1] ?? '',
    ranges: parseRanges(/unicode-range:\s*([^;]+);/.exec(block)?.[1] ?? ''),
  }));

const covers = (face: Face, cp: number) => face.ranges.some(([a, b]) => cp >= a && cp <= b);

/** The files a browser downloads to draw `text` at `weight` (unicode-range matching). */
function filesFor(text: string, weight: number): string[] {
  const files = new Set<string>();
  // Later @font-face rules win for overlapping ranges (CSS Fonts: tried in reverse order).
  const candidates = faces.filter((f) => f.weight === weight).reverse();
  for (const ch of new Set(text.replace(/\s/g, ''))) {
    const face = candidates.find((f) => covers(f, ch.codePointAt(0) ?? 0));
    if (face) files.add(face.url.split('/').pop() ?? '');
  }
  return [...files].sort();
}

const bytes = (file: string) => statSync(new URL(file, fontsDir)).size;

describe('hand font subsets', () => {
  it('comes only from the committed static subsets, one face per weight and subset', () => {
    expect(faces).toHaveLength(6);
    for (const face of faces) {
      expect(face.url).toMatch(
        /^\.\.\/\.\.\/fonts\/playpen-sans\/playpen-sans-(latin|latin-ext|vietnamese)-(400|500)\.woff2$/,
      );
      expect(existsSync(new URL(face.url, stylesDir))).toBe(true);
    }
    expect(css).not.toContain('@fontsource-variable/playpen-sans/files');
    // The Arabic and Hebrew cuts stay the upstream variable files.
    expect(css).toContain("font-family: 'Playpen Sans Arabic Variable'");
    expect(css).toContain("font-family: 'Playpen Sans Hebrew Variable'");
  });

  it('ships the weights the UI renders: 400 everywhere, 500 for FB_SCRIPT text statuses', () => {
    expect([...new Set(faces.map((f) => f.weight))].sort()).toEqual([400, 500]);
    expect(WA_FONTS.FB_SCRIPT).toMatchObject({ hosted: FAMILY, weight: 500 });
  });

  it('keeps German and English pages on the Latin file and within the byte budget', () => {
    const de = 'Momente von unterwegs · Größte Straßenküche, äußerst süß – „Grüße“ aus Köln… 12. November 2026';
    const en = 'Moments from the road · That’s all for now — “quotes”, ‘apostrophes’, bullets • and 10 €';
    expect(filesFor(de + en, 400)).toEqual(['playpen-sans-latin-400.woff2']);
    expect(filesFor(de + en, 500)).toEqual(['playpen-sans-latin-500.woff2']);
    // Goal of the subsetting: ≤ 40 kB of handwriting on a first visit to the home page.
    expect(bytes('playpen-sans-latin-400.woff2')).toBeLessThanOrEqual(30_000);
  });

  it('adds only the small Vietnamese file for Vietnamese place names', () => {
    const vi = 'Hội An · Đà Nẵng · Sài Gòn · Hà Nội · Huế · Phú Quốc · Cần Thơ · Buôn Ma Thuột · ₫';
    const files = filesFor(vi, 400);
    expect(files).toEqual(['playpen-sans-latin-400.woff2', 'playpen-sans-vietnamese-400.woff2']);
    expect(files.reduce((sum, f) => sum + bytes(f), 0)).toBeLessThanOrEqual(40_000);
    // Every Vietnamese letter (Ă … ư and U+1EA0–U+1EF9) is drawn by those files, at both weights.
    const letters = [...'ĂăĐđĨĩŨũƠơƯư', ...Array.from({ length: 0x5a }, (_, i) => String.fromCodePoint(0x1ea0 + i))];
    for (const weight of [400, 500]) {
      const missing = letters.filter(
        (ch) => !faces.some((f) => f.weight === weight && covers(f, ch.codePointAt(0) ?? 0)),
      );
      expect(missing, `weight ${weight}`).toEqual([]);
    }
  });

  it('serves other European names from the Latin Extended file', () => {
    expect(filesFor('Kraków Łódź Plzeň Český İstanbul Eskişehir Timișoara Győr Liepāja Šiauliai', 400)).toEqual([
      'playpen-sans-latin-400.woff2',
      'playpen-sans-latin-ext-400.woff2',
    ]);
    // Worst case (all three subsets in one weight) stays under 60 kB.
    const all = ['latin', 'latin-ext', 'vietnamese'].map((s) => bytes(`playpen-sans-${s}-400.woff2`));
    expect(all.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000);
  });

  it('ships the OFL next to the files; the font declares no Reserved Font Name', () => {
    const ofl = readFileSync(new URL('OFL.txt', fontsDir), 'utf8');
    expect(ofl).toContain('Copyright 2023 The Playpen Sans Project Authors');
    expect(ofl).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(ofl.split('This Font Software is licensed under')[0]).not.toMatch(/Reserved Font Name/i);
  });
});
