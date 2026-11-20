/**
 * The portrait's round crop (pipeline/avatar.ts): the circle the site shows at the focus point,
 * transparent corners, AVATAR_SIZES without upscaling, content-addressed names, reuse, clean-up.
 */
import { createHash } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import { AVATAR_MAX_WIDTH } from '@omw/contracts/site';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mediaFilePath, mediaRelPath } from '../../src/paths.js';
import {
  AVATAR_FILE_RE,
  avatarCropRegion,
  avatarCropSizes,
  makeAvatarCrop,
  removeStaleAvatarCrops,
} from '../../src/pipeline/avatar.js';
import { writeFileDurable } from '../../src/pipeline/files.js';
import { makeTempDir } from '../helpers.js';

vi.setConfig({ testTimeout: 60_000 });

const SHA = createHash('sha256').update('portrait-original').digest('hex');
let tmp: ReturnType<typeof makeTempDir> | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
});

const RED = { r: 230, g: 20, b: 20 };
const BLUE = { r: 20, g: 20, b: 230 };

/** A 400x800 "photo" variant: top half red, bottom half blue (like a processed w640 WebP). */
async function tallSource(mediaDir: string): Promise<string> {
  const top = await sharp({ create: { width: 400, height: 400, channels: 3, background: RED } })
    .png()
    .toBuffer();
  const data = await sharp({ create: { width: 400, height: 800, channels: 3, background: BLUE } })
    .composite([{ input: top, left: 0, top: 0 }])
    .webp({ quality: 90 })
    .toBuffer();
  const rel = mediaRelPath(SHA, 'w640', 'webp');
  await writeFileDurable(mediaFilePath(mediaDir, rel), data);
  return rel;
}

async function pixel(file: string, x: number, y: number) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return {
    r: data[i] ?? 0,
    g: data[i + 1] ?? 0,
    b: data[i + 2] ?? 0,
    a: data[i + 3] ?? 0,
    w: info.width,
    h: info.height,
  };
}

describe('avatarCropRegion: what object-fit: cover shows at object-position x% y%', () => {
  it('takes the largest square at the focus point (centred without one)', () => {
    expect(avatarCropRegion(400, 800)).toEqual({ left: 0, top: 200, size: 400 });
    expect(avatarCropRegion(400, 800, { x: 0.5, y: 0 })).toEqual({ left: 0, top: 0, size: 400 });
    expect(avatarCropRegion(400, 800, { x: 0.5, y: 1 })).toEqual({ left: 0, top: 400, size: 400 });
    expect(avatarCropRegion(400, 800, { x: 0.5, y: 0.4 })).toEqual({ left: 0, top: 160, size: 400 });
    expect(avatarCropRegion(1600, 1200, { x: 0.25, y: 0.9 })).toEqual({ left: 100, top: 0, size: 1200 });
    expect(avatarCropRegion(300, 300, { x: 1, y: 1 })).toEqual({ left: 0, top: 0, size: 300 });
    expect(() => avatarCropRegion(0, 10)).toThrow(RangeError);
  });

  it('sizes: 96/192/288 without upscaling, at least one', () => {
    expect(avatarCropSizes(1200)).toEqual([96, 192, 288]);
    expect(avatarCropSizes(240)).toEqual([96, 192]);
    expect(avatarCropSizes(60)).toEqual([60]);
  });
});

describe('makeAvatarCrop', () => {
  it('publishes only the circle at the focus point, with transparent corners', async () => {
    tmp = makeTempDir('avatar-');
    const source = await tallSource(tmp.dir);
    const top = await makeAvatarCrop({
      sha256: SHA,
      mediaDir: tmp.dir,
      source: { relPath: source },
      focus: { x: 0.5, y: 0 },
    });
    expect(top.size).toBe(288);
    expect(top.sources.webp.map((s) => s.w)).toEqual([96, 192, 288]);
    expect(top.sources.avif.map((s) => s.w)).toEqual([96, 192, 288]);
    expect(top.written).toHaveLength(6);
    for (const s of [...top.sources.avif, ...top.sources.webp]) {
      expect(s.src).toMatch(AVATAR_FILE_RE);
      expect(s.src.startsWith(`media/${SHA.slice(0, 2)}/${SHA.slice(0, 16)}_avatar_`)).toBe(true);
      expect(s.w).toBeLessThanOrEqual(AVATAR_MAX_WIDTH);
    }
    const largest = mediaFilePath(tmp.dir, top.sources.webp[2]?.src ?? '-');
    const middle = await pixel(largest, 144, 144);
    expect([middle.w, middle.h]).toEqual([288, 288]);
    expect(middle.a).toBe(255);
    expect(middle.r).toBeGreaterThan(180); // the red top half only
    expect(middle.b).toBeLessThan(80);
    expect((await pixel(largest, 144, 280)).r).toBeGreaterThan(180);
    for (const [x, y] of [
      [0, 0],
      [287, 0],
      [0, 287],
      [287, 287],
    ] as const) {
      expect((await pixel(largest, x, y)).a).toBe(0);
    }
    expect(top.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(Number.parseInt(top.color.slice(1, 3), 16)).toBeGreaterThan(180);
    const avif = await sharp(mediaFilePath(tmp.dir, top.sources.avif[2]?.src ?? '-')).metadata();
    expect([avif.width, avif.height, avif.hasAlpha]).toEqual([288, 288, true]);

    // Another focus point: other files, the blue bottom half.
    const bottom = await makeAvatarCrop({
      sha256: SHA,
      mediaDir: tmp.dir,
      source: { relPath: source },
      focus: { x: 0.5, y: 1 },
    });
    expect(bottom.sources.webp[0]?.src).not.toBe(top.sources.webp[0]?.src);
    const blue = await pixel(mediaFilePath(tmp.dir, bottom.sources.webp[2]?.src ?? '-'), 144, 144);
    expect(blue.b).toBeGreaterThan(180);
    expect(blue.r).toBeLessThan(80);
  });

  it('finds its files again (no image work) with the same colour and ThumbHash', async () => {
    tmp = makeTempDir('avatar-');
    const source = await tallSource(tmp.dir);
    const options = { sha256: SHA, mediaDir: tmp.dir, source: { relPath: source }, focus: { x: 0.5, y: 0.4 } };
    const first = await makeAvatarCrop(options);
    const again = await makeAvatarCrop(options);
    expect(again.written).toEqual([]);
    expect({ ...again, written: [] }).toEqual({ ...first, written: [] });
    // The key ignores noise below 1/10,000 of the focus point.
    const near = await makeAvatarCrop({ ...options, focus: { x: 0.500001, y: 0.400001 } });
    expect(near.written).toEqual([]);
  });

  it('fails on a source that is not an image', async () => {
    tmp = makeTempDir('avatar-');
    const rel = mediaRelPath(SHA, 'w640', 'webp');
    await writeFileDurable(mediaFilePath(tmp.dir, rel), 'dummy w640.webp\n');
    await expect(makeAvatarCrop({ sha256: SHA, mediaDir: tmp.dir, source: { relPath: rel } })).rejects.toThrow();
  });

  it('removeStaleAvatarCrops removes only crops that are not kept', async () => {
    tmp = makeTempDir('avatar-');
    const source = await tallSource(tmp.dir);
    const crop = await makeAvatarCrop({ sha256: SHA, mediaDir: tmp.dir, source: { relPath: source } });
    const files = [...crop.sources.avif, ...crop.sources.webp].map((s) => s.src);
    const keep = new Set(files.slice(0, 2));
    const removed = await removeStaleAvatarCrops(tmp.dir, [source, ...files], keep);
    expect(removed).toEqual(files.slice(2).sort());
    for (const f of files) expect(existsSync(mediaFilePath(tmp.dir, f))).toBe(keep.has(f));
    expect(existsSync(mediaFilePath(tmp.dir, source))).toBe(true);
    expect(await fsp.readdir(tmp.dir)).toEqual([SHA.slice(0, 2)]);
  });
});
