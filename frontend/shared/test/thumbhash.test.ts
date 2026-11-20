import { rgbaToThumbHash } from 'thumbhash';
import { describe, expect, it } from 'vitest';
import { base64ToBytes, thumbhashAspectRatio, thumbhashAverageColor, thumbhashToDataUrl } from '../src/thumbhash';

function solid(w: number, h: number, [r, g, b]: [number, number, number]): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([r, g, b, 255], i * 4);
  return rgba;
}

describe('thumbhash helpers', () => {
  const hash = rgbaToThumbHash(40, 20, solid(40, 20, [190, 74, 116]));
  const b64 = btoa(String.fromCharCode(...hash));

  it('round-trips base64', () => {
    expect([...base64ToBytes(b64)]).toEqual([...hash]);
  });

  it('renders a PNG data URL and memoizes it', () => {
    const url = thumbhashToDataUrl(b64);
    expect(url).toMatch(/^data:image\/png;base64,/);
    expect(thumbhashToDataUrl(b64)).toBe(url);
  });

  it('decodes average colour and aspect ratio', () => {
    expect(thumbhashAverageColor(b64)).toMatch(/^#[0-9a-f]{6}$/);
    const [r, g, b] = (thumbhashAverageColor(b64) ?? '#000000')
      .slice(1)
      .match(/../g)
      ?.map((h) => Number.parseInt(h, 16)) ?? [0, 0, 0];
    expect(Math.abs((r ?? 0) - 190)).toBeLessThan(12);
    expect(Math.abs((g ?? 0) - 74)).toBeLessThan(12);
    expect(Math.abs((b ?? 0) - 116)).toBeLessThan(12);
    expect(thumbhashAspectRatio(b64)).toBeGreaterThan(1.5);
  });

  it('returns null for garbage', () => {
    expect(thumbhashToDataUrl('!!!')).toBeNull();
  });
});
