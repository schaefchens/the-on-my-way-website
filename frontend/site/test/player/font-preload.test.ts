import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Entry } from '@omw/contracts/site';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { preloadFonts } from '../../src/player/media';

const base = { id: 'e_aaaaaaaaaaaa', at: '2026-11-15T02:12:00Z', tz: 'Asia/Ho_Chi_Minh' } as const;

/** Weights of the hand font's @font-face rules (one static file per weight). */
function handWeights(): Set<number> {
  const css = readFileSync(createRequire(import.meta.url).resolve('@omw/ui/fonts.css'), 'utf8');
  const weights = new Set<number>();
  for (const [, block = ''] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    if (!block.includes("font-family: 'Playpen Sans Variable'")) continue;
    weights.add(Number(/font-weight:\s*(\d+);/.exec(block)?.[1]));
  }
  return weights;
}

function stubFonts() {
  const load = vi.fn(async (_font: string, _text?: string) => [] as FontFace[]);
  vi.stubGlobal('document', { fonts: { load } });
  return load;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('preloadFonts (player)', () => {
  it('loads the weight a note slide renders at, with its text (unicode-range subsets)', async () => {
    const load = stubFonts();
    const note: Entry = { ...base, id: 'p_note00001', kind: 'note', note: { de: 'Erste Schale Phở' }, orig: 'de' };
    await preloadFonts(note, 'de');
    expect(load).toHaveBeenCalledWith('400 1em "Playpen Sans Variable"', 'Erste Schale Phở');
  });

  it('only asks for hand-font weights that fonts.css ships, so no unused file is fetched', async () => {
    const load = stubFonts();
    const note: Entry = { ...base, id: 'p_note00001', kind: 'note', note: { en: 'Hi' }, orig: 'en' };
    const script: Entry = {
      ...base,
      kind: 'text',
      text: { body: 'Xin chào', bg: '#be4a74ff', fg: '#ffffffff', font: 'FB_SCRIPT' },
    };
    await preloadFonts(note, 'en');
    await preloadFonts(script, 'en');
    const shipped = handWeights();
    expect([...shipped].sort()).toEqual([400, 500]);
    const requested = load.mock.calls
      .map(([font]) => /^(\d+) 1em "Playpen Sans Variable"$/.exec(font)?.[1])
      .filter((w) => w !== undefined)
      .map(Number);
    expect(requested).toEqual([400, 500]);
    for (const w of requested) expect(shipped.has(w)).toBe(true);
  });
});
