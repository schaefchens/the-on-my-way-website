/**
 * The owner's portrait (setting site.avatar) as its own small files: a round crop of one photo,
 * exactly the circle the site and the admin preview show (object-fit: cover in a square box at
 * the focus point, CSS object-position semantics), at AVATAR_SIZES px in AVIF and WebP with
 * transparent corners. The owner may pick a photo she hid from the timeline: these crops are all
 * of it that gets published, never its frame, its other variants or its OG image.
 *
 * - Source: the photo's own processed WebP variant (the smallest whose shorter side covers the
 *   largest crop, else the largest one). Variants are already oriented and carry no metadata.
 * - Names (paths.ts AvatarVariant): media/<sha[0:2]>/<sha[0:16]>_avatar_<key>_s<edge>.<ext>,
 *   key = 8 hex digits of sha256({ v, src, x, y }). Content-addressed like every variant: a new
 *   focus point makes new files, an unchanged one finds its files and does no image work.
 * - Colour (alpha-weighted average) and ThumbHash come from the smallest WebP crop, decoded also
 *   when it already existed, so every run (full or incremental) yields the same facts.
 * - Files are written atomically into MEDIA_DIR; the generator links them into OUT_DIR like any
 *   other variant and removes crops nothing references any more (removeStaleAvatarCrops).
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import { AVATAR_MAX_WIDTH, AVATAR_SIZES, type FocusPoint } from '@omw/contracts/site';
import sharp from 'sharp';
import { rgbaToThumbHash } from 'thumbhash';
import { type AvatarVariant, type MediaExt, mediaFilePath, mediaRelPath } from '../paths.js';
import type { ProcessedVariant } from '../store/index.js';
import { throwIfAborted } from './exec.js';
import { fsyncDir, writeFileDurable } from './files.js';
import { DEFAULT_IMAGE_OPTIONS, type ImageEncodeOptions, MAX_INPUT_PIXELS } from './image.js';

/** Bump when the crop or its encoding changes: every portrait gets new files (new names). */
export const AVATAR_CROP_VERSION = 1;

/** "_avatar_" files below MEDIA_DIR (and OUT_DIR/media). */
export const AVATAR_FILE_RE = /^media\/[0-9a-f]{2}\/[0-9a-f]{16}_avatar_[0-9a-f]{8}_s\d+\.(?:avif|webp)$/;

export interface AvatarCropRegion {
  left: number;
  top: number;
  /** Edge of the square (the shorter side of the image). */
  size: number;
}

/**
 * The square an `object-fit: cover` box shows of a `width` x `height` image at `focus`
 * (object-position x% y%: the point at x% of the image sits at x% of the box). No focus: centred.
 */
export function avatarCropRegion(width: number, height: number, focus?: FocusPoint): AvatarCropRegion {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`Invalid image size: ${width}x${height}`);
  }
  const clamp = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5);
  const size = Math.min(width, height);
  return {
    left: Math.round((width - size) * clamp(focus?.x ?? 0.5)),
    top: Math.round((height - size) * clamp(focus?.y ?? 0.5)),
    size,
  };
}

/** Edges of the files for a crop `size` px wide: AVATAR_SIZES without upscaling (at least one). */
export function avatarCropSizes(size: number): number[] {
  const fit = AVATAR_SIZES.filter((s) => s <= size);
  return fit.length > 0 ? fit : [Math.max(1, Math.min(size, AVATAR_MAX_WIDTH))];
}

/** Focus values in the key (and the crop) are rounded to 1/10,000. */
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

function normalFocus(focus: FocusPoint | undefined): FocusPoint {
  return { x: round4(focus?.x ?? 0.5), y: round4(focus?.y ?? 0.5) };
}

export function avatarCropKey(sourceRelPath: string, focus: FocusPoint | undefined): string {
  const f = normalFocus(focus);
  return createHash('sha256')
    .update(JSON.stringify({ v: AVATAR_CROP_VERSION, src: sourceRelPath, x: f.x, y: f.y }))
    .digest('hex')
    .slice(0, 8);
}

function knownSize(v: ProcessedVariant, aspect: number | null): { w: number; h: number } | null {
  const w = v.w ?? Number(/w(\d{2,4})$/.exec(v.variant)?.[1] ?? 0);
  if (!w) return null;
  const h = v.h ?? (aspect ? Math.max(1, Math.round(w / aspect)) : 0);
  return h ? { w, h } : null;
}

/**
 * The photo variant a portrait is cropped from: the smallest WebP "image" variant whose shorter
 * side reaches AVATAR_MAX_WIDTH, else the largest one; null when the photo has none.
 */
export function avatarSourceVariant(
  variants: readonly ProcessedVariant[],
  meta: { w?: number | undefined; h?: number | undefined } | null,
): ProcessedVariant | null {
  const aspect = meta?.w && meta.h ? meta.w / meta.h : null;
  const sized = variants
    .filter((v) => v.role === 'image' && v.format === 'webp')
    .map((v) => ({ v, size: knownSize(v, aspect) }))
    .filter((x): x is { v: ProcessedVariant; size: { w: number; h: number } } => x.size !== null)
    .sort((a, b) => a.size.w - b.size.w || (a.v.relPath < b.v.relPath ? -1 : 1));
  const enough = sized.find((x) => Math.min(x.size.w, x.size.h) >= AVATAR_MAX_WIDTH);
  return (enough ?? sized.at(-1))?.v ?? null;
}

export interface AvatarCropFile {
  /** Edge in px (the file is square). */
  w: number;
  src: string;
}

export interface AvatarCrop {
  /** Edge of the widest file. */
  size: number;
  sources: { avif: AvatarCropFile[]; webp: AvatarCropFile[] };
  /** "#rrggbb", the alpha-weighted average of the circle. */
  color: string;
  /** ThumbHash (base64) of the smallest crop, with its transparent corners. */
  thumbhash: string;
  /** Files written by this call (the rest already existed). */
  written: string[];
}

export interface AvatarCropOptions {
  /** sha256 hex of the photo's ORIGINAL (the D8 naming key). */
  sha256: string;
  mediaDir: string;
  /** The photo variant to crop from (avatarSourceVariant). */
  source: Pick<ProcessedVariant, 'relPath'>;
  focus?: FocusPoint | undefined;
  encode?: Partial<ImageEncodeOptions> | undefined;
  signal?: AbortSignal | undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

function circleMask(edge: number): Buffer {
  const r = edge / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${edge}" height="${edge}"><circle cx="${r}" cy="${r}" r="${r}"/></svg>`,
  );
}

const hex2 = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0');

/** Colour + ThumbHash of a (small, possibly transparent) image file. */
async function facts(file: string): Promise<{ color: string; thumbhash: string }> {
  const { data, info } = await sharp(file, { failOn: 'error' })
    .resize(100, 100, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = (data[i + 3] ?? 0) / 255;
    r += (data[i] ?? 0) * alpha;
    g += (data[i + 1] ?? 0) * alpha;
    b += (data[i + 2] ?? 0) * alpha;
    a += alpha;
  }
  const color = a > 0 ? `#${hex2(r / a)}${hex2(g / a)}${hex2(b / a)}` : '#000000';
  const thumbhash = Buffer.from(rgbaToThumbHash(info.width, info.height, data)).toString('base64');
  return { color, thumbhash };
}

/**
 * Makes (or finds) the round crops of one photo for the portrait. Throws when the source cannot
 * be read or decoded; the caller leaves the portrait out with a warning then.
 */
export async function makeAvatarCrop(options: AvatarCropOptions): Promise<AvatarCrop> {
  const enc: ImageEncodeOptions = { ...DEFAULT_IMAGE_OPTIONS, ...options.encode };
  const sourceFile = mediaFilePath(options.mediaDir, options.source.relPath);
  const input = await fsp.readFile(sourceFile);
  const meta = await sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  const width = meta.autoOrient?.width ?? meta.width;
  const height = meta.autoOrient?.height ?? meta.height;
  if (!width || !height) throw new Error(`cannot read the size of ${options.source.relPath}`);
  const focus = normalFocus(options.focus);
  const region = avatarCropRegion(width, height, focus);
  const sizes = avatarCropSizes(region.size);
  const key = avatarCropKey(options.source.relPath, options.focus);
  const plan = sizes.flatMap((edge) =>
    (['avif', 'webp'] as const).map((ext) => ({
      edge,
      ext,
      rel: mediaRelPath(options.sha256, `avatar_${key}_s${edge}` as AvatarVariant, ext as MediaExt),
    })),
  );
  const present = await Promise.all(plan.map((p) => exists(mediaFilePath(options.mediaDir, p.rel))));
  const written: string[] = [];
  if (present.some((p) => !p)) {
    const square = await sharp(input, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
      .autoOrient()
      .toColourspace('srgb')
      .extract({ left: region.left, top: region.top, width: region.size, height: region.size })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    throwIfAborted(options.signal);
    const raw = { width: square.info.width, height: square.info.height, channels: 4 as const };
    for (const [i, p] of plan.entries()) {
      if (present[i]) continue;
      const round = sharp(square.data, { raw })
        .resize(p.edge, p.edge, { kernel: 'lanczos3' })
        .composite([{ input: circleMask(p.edge), blend: 'dest-in' }]);
      const data =
        p.ext === 'avif'
          ? await round.avif({ quality: enc.avifQuality, effort: enc.avifEffort }).toBuffer()
          : await round.webp({ quality: enc.webpQuality, effort: enc.webpEffort }).toBuffer();
      throwIfAborted(options.signal);
      await writeFileDurable(mediaFilePath(options.mediaDir, p.rel), data, { syncDir: false });
      written.push(p.rel);
    }
    const first = plan[0];
    if (first) await fsyncDir(dirname(mediaFilePath(options.mediaDir, first.rel)));
  }
  const smallestWebp = plan.find((p) => p.ext === 'webp');
  if (!smallestWebp) throw new Error('no crop sizes');
  const { color, thumbhash } = await facts(mediaFilePath(options.mediaDir, smallestWebp.rel));
  const list = (ext: 'avif' | 'webp') => plan.filter((p) => p.ext === ext).map((p) => ({ w: p.edge, src: p.rel }));
  return {
    size: sizes.at(-1) ?? region.size,
    sources: { avif: list('avif'), webp: list('webp') },
    color,
    thumbhash,
    written,
  };
}

/**
 * Removes portrait crops below MEDIA_DIR that `keep` does not list (an older focus point, an
 * earlier portrait photo, a removed portrait). `present` is a scan of MEDIA_DIR (scanMediaRoot).
 * Returns the removed paths. Only "_avatar_" files are ever touched.
 */
export async function removeStaleAvatarCrops(
  mediaDir: string,
  present: Iterable<string>,
  keep: ReadonlySet<string>,
): Promise<string[]> {
  const removed: string[] = [];
  for (const rel of present) {
    if (!AVATAR_FILE_RE.test(rel) || keep.has(rel)) continue;
    await fsp.rm(mediaFilePath(mediaDir, rel), { force: true });
    removed.push(rel);
  }
  return removed.sort();
}
