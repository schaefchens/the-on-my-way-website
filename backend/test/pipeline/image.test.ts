/**
 * Photo treatment with the real fixtures: EXIF orientation, width buckets without upscaling,
 * metadata stripping, AVIF/WebP, ThumbHash, dominant colour, OG JPEG, determinism.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { thumbHashToApproximateAspectRatio } from 'thumbhash';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mediaFilePath } from '../../src/paths.js';
import { processImage, sha256File, widthTargets } from '../../src/pipeline/index.js';
import { FIXTURE_INBOX, fixtureByKey, fixturesPresent } from '../capture/env.js';
import { makeTempDir } from '../helpers.js';

// Media encoding is CPU-bound: generous per-test timeouts for parallel runs.
vi.setConfig({ testTimeout: 60_000 });

describe('widthTargets', () => {
  it('fills buckets up to the width and keeps the native width in the next bucket', () => {
    expect(widthTargets(1600)).toEqual([
      { bucket: 320, width: 320 },
      { bucket: 640, width: 640 },
      { bucket: 1080, width: 1080 },
      { bucket: 1600, width: 1600 },
    ]);
    expect(widthTargets(4000).map((t) => t.width)).toEqual([320, 640, 1080, 1600]);
    expect(widthTargets(1080).map((t) => t.width)).toEqual([320, 640, 1080]);
    expect(widthTargets(1200)).toEqual([
      { bucket: 320, width: 320 },
      { bucket: 640, width: 640 },
      { bucket: 1080, width: 1080 },
      { bucket: 1600, width: 1200 },
    ]);
    expect(widthTargets(200)).toEqual([{ bucket: 320, width: 200 }]);
    expect(widthTargets(320)).toEqual([{ bucket: 320, width: 320 }]);
    expect(() => widthTargets(0)).toThrow(RangeError);
  });
});

describe.skipIf(!fixturesPresent)('processImage', () => {
  let tmp: ReturnType<typeof makeTempDir>;
  beforeAll(() => {
    tmp = makeTempDir('pipeline-image-');
  });
  afterAll(() => tmp.cleanup());

  const original = (key: string) => {
    const f = fixtureByKey(key);
    return join(FIXTURE_INBOX, f.msgId, f.file ?? 'missing');
  };

  it('applies the EXIF orientation, never upscales and strips metadata', async () => {
    const file = original('hoian-photo-night'); // stored 1350x1080, orientation 6
    const input = await sharp(file).metadata();
    expect(input.orientation).toBe(6);
    expect([input.width, input.height]).toEqual([1350, 1080]);
    const { sha256 } = await sha256File(file);
    const mediaDir = join(tmp.dir, 'media');
    const r = await processImage(file, { sha256, mediaDir, role: 'image', og: true });

    expect([r.w, r.h]).toEqual([1080, 1350]);
    expect(r.color).toMatch(/^#[0-9a-f]{6}$/);
    // ThumbHash encodes the aspect ratio coarsely: portrait, roughly 4:5.
    const ratio = thumbHashToApproximateAspectRatio(Buffer.from(r.thumbhash, 'base64'));
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1);
    const names = r.variants.map((v) => `${v.variant}.${v.format}`).sort();
    expect(names).toEqual(['og.jpg', 'w1080.avif', 'w1080.webp', 'w320.avif', 'w320.webp', 'w640.avif', 'w640.webp']);
    for (const v of r.variants) {
      expect(v.relPath).toBe(`media/${sha256.slice(0, 2)}/${sha256.slice(0, 16)}_${v.variant}.${v.format}`);
      const path = mediaFilePath(mediaDir, v.relPath);
      const buf = readFileSync(path);
      expect(buf.length).toBe(v.bytes);
      const meta = await sharp(buf).metadata();
      expect([meta.width, meta.height]).toEqual([v.w, v.h]);
      expect(meta.orientation).toBeUndefined();
      expect(meta.exif).toBeUndefined();
      if (v.role === 'image') expect((v.w ?? 0) / (v.h ?? 1)).toBeCloseTo(1080 / 1350, 2);
    }
    const w1080 = r.variants.find((v) => v.variant === 'w1080' && v.format === 'avif');
    expect((await sharp(mediaFilePath(mediaDir, w1080?.relPath ?? '')).metadata()).format).toBe('heif');
    const og = r.variants.find((v) => v.role === 'og');
    expect(og).toMatchObject({ w: 1200, h: 630, format: 'jpg' });
    expect(og?.bytes).toBeLessThanOrEqual(300 * 1024);
  });

  it('keeps all four buckets for a 1600 px landscape photo and is deterministic', async () => {
    const file = original('berlin-photo');
    const { sha256 } = await sha256File(file);
    const a = await processImage(file, { sha256, mediaDir: join(tmp.dir, 'a'), role: 'image', og: false });
    const b = await processImage(file, { sha256, mediaDir: join(tmp.dir, 'b'), role: 'image', og: false });
    expect(a.variants.filter((v) => v.format === 'webp').map((v) => [v.variant, v.w, v.h])).toEqual([
      ['w320', 320, 240],
      ['w640', 640, 480],
      ['w1080', 1080, 810],
      ['w1600', 1600, 1200],
    ]);
    expect(a.variants.some((v) => v.role === 'og')).toBe(false);
    expect(b.variants.map((v) => v.sha256)).toEqual(a.variants.map((v) => v.sha256));
    expect(b.thumbhash).toBe(a.thumbhash);
    expect(b.color).toBe(a.color);
  });

  it('names poster variants poster_w… and rejects undecodable input', async () => {
    const png = await sharp({ create: { width: 500, height: 300, channels: 3, background: '#336699' } })
      .png()
      .toBuffer();
    const sha = 'ab'.repeat(32);
    const r = await processImage(png, { sha256: sha, mediaDir: join(tmp.dir, 'p'), role: 'poster', og: true });
    expect(r.variants.map((v) => v.variant)).toEqual([
      'poster_w320',
      'poster_w320',
      'poster_w640',
      'poster_w640',
      'og',
    ]);
    expect(r.variants.find((v) => v.variant === 'poster_w640')?.w).toBe(500);
    expect(r.color).toBe('#386898'); // dominant colour (4096-bin histogram)
    await expect(
      processImage(Buffer.from('not an image'), {
        sha256: sha,
        mediaDir: join(tmp.dir, 'x'),
        role: 'image',
        og: false,
      }),
    ).rejects.toThrow();
  });
});
