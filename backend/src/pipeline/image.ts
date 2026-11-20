/**
 * Photo treatment (plan A2), also used for video posters:
 *
 * - decode once with sharp, apply the EXIF orientation, convert to sRGB; the outputs carry no
 *   metadata (sharp strips EXIF/XMP/ICC unless asked to keep it);
 * - AVIF (q≈50) + WebP (q≈75) at the width buckets 320/640/1080/1600 (paths.ts IMAGE_WIDTHS) without
 *   upscaling: buckets up to the image width are filled at their exact width, and the first bucket
 *   above it gets the native width, so full resolution stays available and every image has at least
 *   one source. ProcessedVariant.w/h always hold the real pixel size;
 * - ThumbHash (from a ≤100 px thumbnail) and the dominant colour (#rrggbb);
 * - optional OG JPEG 1200x630 (smart crop, ≤ 300 KB by lowering the quality).
 *
 * Variants are named per D8 (media/<sha[0:2]>/<sha[0:16]>_<variant>.<ext>, sha = sha256 of the
 * ORIGINAL file) and written atomically into MEDIA_DIR. Output is deterministic for a given input
 * and sharp/libvips version.
 */
import { dirname } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { rgbaToThumbHash } from 'thumbhash';
import { IMAGE_WIDTHS, type MediaExt, type MediaVariant, mediaFilePath, mediaRelPath } from '../paths.js';
import type { ProcessedVariant } from '../store/index.js';
import { throwIfAborted } from './exec.js';
import { fsyncDir, sha256Buffer, writeFileDurable } from './files.js';

export interface ImageEncodeOptions {
  avifQuality: number;
  /** 0 (fastest) – 9 (slowest). */
  avifEffort: number;
  webpQuality: number;
  /** 0 (fastest) – 6 (slowest). */
  webpEffort: number;
  ogWidth: number;
  ogHeight: number;
  ogMaxBytes: number;
}

export const DEFAULT_IMAGE_OPTIONS: Readonly<ImageEncodeOptions> = Object.freeze({
  avifQuality: 50,
  avifEffort: 4,
  webpQuality: 75,
  webpEffort: 4,
  ogWidth: 1200,
  ogHeight: 630,
  ogMaxBytes: 300 * 1024,
});

/** Larger inputs are rejected (decompression-bomb guard; WhatsApp photos are far below). */
export const MAX_INPUT_PIXELS = 100_000_000;

export interface ImageResult {
  variants: ProcessedVariant[];
  /** Oriented size of the source image. */
  w: number;
  h: number;
  /** Dominant colour "#rrggbb". */
  color: string;
  /** ThumbHash, base64. */
  thumbhash: string;
}

export interface ProcessImageOptions {
  /** sha256 hex of the ORIGINAL media file (the D8 naming key). */
  sha256: string;
  mediaDir: string;
  /** "image" for photos (w320…), "poster" for video posters (poster_w320…). */
  role: 'image' | 'poster';
  /** Also write the 1200x630 OG JPEG (variant "og"). */
  og: boolean;
  encode?: Partial<ImageEncodeOptions> | undefined;
  signal?: AbortSignal | undefined;
}

export interface WidthTarget {
  /** Bucket of the variant name (w320 …). */
  bucket: (typeof IMAGE_WIDTHS)[number];
  /** Real output width (≤ bucket). */
  width: number;
}

/** Width buckets for an image `width` px wide (see the header: no upscaling, native width kept). */
export function widthTargets(width: number): WidthTarget[] {
  if (!Number.isInteger(width) || width < 1) throw new RangeError(`Invalid image width: ${width}`);
  const out: WidthTarget[] = [];
  for (const bucket of IMAGE_WIDTHS) {
    if (width >= bucket) {
      out.push({ bucket, width: bucket });
      continue;
    }
    if (width > (out.at(-1)?.width ?? 0)) out.push({ bucket, width });
    break;
  }
  return out;
}

const hex2 = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0');

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

function fromRaw(img: RawImage) {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: img.channels } });
}

async function toRaw(pipeline: Sharp): Promise<RawImage> {
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels as RawImage['channels'] };
}

/** Decodes, orients and converts an image to sRGB pixels. */
export async function decodeImage(input: Buffer | string): Promise<RawImage> {
  return toRaw(
    sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).autoOrient().toColourspace('srgb'),
  );
}

export async function processImage(input: Buffer | string, options: ProcessImageOptions): Promise<ImageResult> {
  const enc: ImageEncodeOptions = { ...DEFAULT_IMAGE_OPTIONS, ...options.encode };
  const decoded = await decodeImage(input);
  throwIfAborted(options.signal);
  const variants: ProcessedVariant[] = [];

  const write = async (
    variant: MediaVariant,
    ext: MediaExt,
    role: ProcessedVariant['role'],
    data: Buffer,
    w: number,
    h: number,
  ) => {
    const relPath = mediaRelPath(options.sha256, variant, ext);
    await writeFileDurable(mediaFilePath(options.mediaDir, relPath), data, { syncDir: false });
    variants.push({
      role,
      variant,
      format: ext as ProcessedVariant['format'],
      w,
      h,
      relPath,
      bytes: data.length,
      sha256: sha256Buffer(data),
    });
  };

  for (const target of widthTargets(decoded.width)) {
    const resized =
      target.width === decoded.width ? decoded : await toRaw(fromRaw(decoded).resize({ width: target.width }));
    const variant = `${options.role === 'poster' ? 'poster_' : ''}w${target.bucket}` as MediaVariant;
    const avif = await fromRaw(resized).avif({ quality: enc.avifQuality, effort: enc.avifEffort }).toBuffer();
    throwIfAborted(options.signal);
    const webp = await fromRaw(resized).webp({ quality: enc.webpQuality, effort: enc.webpEffort }).toBuffer();
    throwIfAborted(options.signal);
    await write(variant, 'avif', options.role, avif, resized.width, resized.height);
    await write(variant, 'webp', options.role, webp, resized.width, resized.height);
  }

  // Thumbnail for ThumbHash (max 100x100 per the ThumbHash spec) and the dominant colour.
  const thumb = await toRaw(fromRaw(decoded).resize(100, 100, { fit: 'inside' }).removeAlpha());
  const stats = await fromRaw(thumb).stats();
  const color = `#${hex2(stats.dominant.r)}${hex2(stats.dominant.g)}${hex2(stats.dominant.b)}`;
  const rgba = await toRaw(fromRaw(thumb).ensureAlpha());
  const thumbhash = Buffer.from(rgbaToThumbHash(rgba.width, rgba.height, rgba.data)).toString('base64');

  if (options.og) {
    let quality = 82;
    let jpeg: Buffer;
    for (;;) {
      jpeg = await fromRaw(decoded)
        .resize(enc.ogWidth, enc.ogHeight, { fit: 'cover', position: sharp.strategy.attention })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (jpeg.length <= enc.ogMaxBytes || quality <= 30) break;
      quality -= 8;
    }
    throwIfAborted(options.signal);
    await write('og', 'jpg', 'og', jpeg, enc.ogWidth, enc.ogHeight);
  }

  // One directory fsync for all renames (all variants of one original share a directory).
  const first = variants[0];
  if (first) await fsyncDir(dirname(mediaFilePath(options.mediaDir, first.relPath)));

  return { variants, w: decoded.width, h: decoded.height, color, thumbhash };
}
