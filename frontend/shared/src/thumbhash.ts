/**
 * ThumbHash helpers. ImageSet.thumbhash is standard base64 of the raw ThumbHash bytes.
 */
import { thumbHashToApproximateAspectRatio, thumbHashToAverageRGBA, thumbHashToDataURL } from 'thumbhash';

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const cache = new Map<string, string>();

/** PNG data URL of the blurred placeholder (memoized; ~1 kB per image). Null for invalid input. */
export function thumbhashToDataUrl(b64: string): string | null {
  const hit = cache.get(b64);
  if (hit !== undefined) return hit;
  try {
    const url = thumbHashToDataURL(base64ToBytes(b64));
    if (cache.size > 500) cache.clear();
    cache.set(b64, url);
    return url;
  } catch {
    return null;
  }
}

/** Average colour of the placeholder as "#rrggbb" (null for invalid input). */
export function thumbhashAverageColor(b64: string): string | null {
  try {
    const { r, g, b } = thumbHashToAverageRGBA(base64ToBytes(b64));
    const hex = (v: number) =>
      Math.round(Math.min(1, Math.max(0, v)) * 255)
        .toString(16)
        .padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  } catch {
    return null;
  }
}

/** Approximate width/height ratio encoded in the hash. */
export function thumbhashAspectRatio(b64: string): number | null {
  try {
    return thumbHashToApproximateAspectRatio(base64ToBytes(b64));
  } catch {
    return null;
  }
}
