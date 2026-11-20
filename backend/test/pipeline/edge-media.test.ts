/**
 * Pipeline robustness with synthetic inputs generated on the fly (ffmpeg / sharp): an H.264 video
 * with a 90° display matrix (remuxed, orientation kept), 10-bit H.264 with odd dimensions
 * (transcoded to even yuv420p), a video without audio, an "video" without a video stream, videos
 * with location/creation-time/title tags (stripped on remux and transcode), and stills in 16-bit
 * RGB, CMYK, greyscale and with alpha.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mediaFilePath } from '../../src/paths.js';
import { runTool } from '../../src/pipeline/exec.js';
import { probe, processOriginal, sha256File, toolPathsFromEnv } from '../../src/pipeline/index.js';
import { makeTempDir } from '../helpers.js';

vi.setConfig({ testTimeout: 120_000 });

const tools = toolPathsFromEnv();
const GEO = '+52.5200+013.4050/';
const ff = (args: string[]) => runTool(tools.ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args], { timeoutMs: 60_000 });

/** Major version of the ffmpeg in use ("ffmpeg version 5.1.6-0+deb12u1", "… n8.1.2"); null if unknown (git builds). */
async function ffmpegMajor(): Promise<number | null> {
  const { stdout } = await runTool(tools.ffmpeg, ['-version'], { timeoutMs: 10_000 });
  const m = /ffmpeg version n?(\d+)\./.exec(stdout.toString('utf8'));
  return m?.[1] ? Number(m[1]) : null;
}

/** Set when this ffmpeg cannot produce the rotated input (the rotation case is skipped, loudly). */
let rotationSkip: string | null = null;

describe('pipeline edge media', () => {
  let tmp: ReturnType<typeof makeTempDir>;
  const src = (name: string) => join(tmp.dir, name);
  const mediaDir = () => join(tmp.dir, 'media');

  beforeAll(async () => {
    tmp = makeTempDir('pipeline-edge-');
    const testsrc = (size: string, seconds: number) => [
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${size}:rate=25`,
      '-t',
      `${seconds}`,
    ];
    await ff([
      ...testsrc('640x360', 2),
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      src('plain.mp4'),
    ]);
    // A 90° display matrix: `-display_rotation` exists since ffmpeg 6; ffmpeg 5.1 (Debian
    // bookworm, the Docker image) only knows the legacy "rotate" stream tag (degrees clockwise,
    // which ffmpeg >= 6 no longer writes). Either way the result is verified below.
    const major = await ffmpegMajor();
    await ff(
      major !== null && major < 6
        ? ['-i', src('plain.mp4'), '-c', 'copy', '-metadata:s:v:0', 'rotate=270', src('rot90.mp4')]
        : ['-display_rotation', '90', '-i', src('plain.mp4'), '-c', 'copy', src('rot90.mp4')],
    );
    const rotated = await probe(src('rot90.mp4'), tools);
    if (Math.abs(rotated.video?.rotation ?? 0) !== 90) {
      rotationSkip = `ffmpeg ${major ?? '?'} could not create a rotated test input (rotation ${rotated.video?.rotation})`;
      console.warn(`[edge-media] skipping the rotation case: ${rotationSkip}`);
    }
    await ff([
      ...testsrc('641x361', 1),
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p10le',
      src('odd10.mp4'),
    ]);
    await ff(['-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '1', '-c:a', 'aac', src('audioonly.mp4')]);
    // Phone videos carry the recording place and time in the container (public site: must go).
    const privateTags = [
      '-metadata',
      `location=${GEO}`,
      '-metadata',
      `location-eng=${GEO}`,
      '-metadata',
      'creation_time=2026-11-01T10:00:00Z',
      '-metadata',
      'title=PRIVATE-TITLE',
      '-metadata:s:v',
      'handler_name=PRIVATE-HANDLER',
      '-movflags',
      '+use_metadata_tags',
    ];
    await ff(['-i', src('plain.mp4'), '-c', 'copy', ...privateTags, src('geo-h264.mp4')]);
    await ff(['-i', src('plain.mp4'), '-c:v', 'mpeg4', '-c:a', 'copy', ...privateTags, src('geo-mpeg4.mp4')]);
    const base = sharp({ create: { width: 700, height: 500, channels: 3, background: '#336699' } });
    await base.clone().png().toColourspace('rgb16').toFile(src('p16.png'));
    await base.clone().toColourspace('cmyk').jpeg().toFile(src('cmyk.jpg'));
    await base.clone().greyscale().jpeg().toFile(src('grey.jpg'));
    await sharp({ create: { width: 50, height: 30, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
      .png()
      .toFile(src('alpha.png'));
  });
  afterAll(() => tmp.cleanup());

  async function run(kind: 'photo' | 'video', name: string) {
    const file = src(name);
    const { sha256 } = await sha256File(file);
    const media = { mimetype: kind === 'photo' ? 'image/jpeg' : 'video/mp4', fileSha256B64: 'AAAA', fileLength: 1 };
    return processOriginal({ kind, file, sha256, media }, { mediaDir: mediaDir(), tools, x264Preset: 'ultrafast' });
  }

  it('remuxes an H.264 video with a 90° display matrix and reports its portrait display size', async (ctx) => {
    if (rotationSkip) ctx.skip(rotationSkip);
    const r = await run('video', 'rot90.mp4');
    expect(r.summary).toMatch(/^video remux 360x640 /);
    expect(r.meta).toMatchObject({ w: 360, h: 640, hasAudio: true });
    const video = r.variants.find((v) => v.role === 'video');
    const out = await probe(mediaFilePath(mediaDir(), video?.relPath ?? ''), tools);
    expect(out.video).toMatchObject({ displayWidth: 360, displayHeight: 640 });
    expect(Math.abs(out.video?.rotation ?? 0)).toBe(90);
    const poster = r.variants.find((v) => v.variant === 'poster_w320' && v.format === 'webp');
    expect(poster?.w).toBe(320);
    expect(poster?.h).toBeGreaterThan(poster?.w ?? 0); // the poster is upright (portrait)
  });

  it('transcodes 10-bit H.264 with odd dimensions to even yuv420p without audio', async () => {
    const r = await run('video', 'odd10.mp4');
    expect(r.summary).toMatch(/^video transcode 640x360 /);
    expect(r.meta.hasAudio).toBe(false);
    const video = r.variants.find((v) => v.role === 'video');
    const out = await probe(mediaFilePath(mediaDir(), video?.relPath ?? ''), tools);
    expect(out.video).toMatchObject({ codec: 'h264', pixFmt: 'yuv420p', width: 640, height: 360 });
    expect(out.audio).toBeNull();
  });

  it.each([
    ['geo-h264.mp4', 'remux'],
    ['geo-mpeg4.mp4', 'transcode'],
  ])('strips location, creation time and titles from %s (%s)', async (name, mode) => {
    const before = await readFile(src(name), 'latin1');
    expect(before).toContain(GEO); // the input really carries them
    const r = await run('video', name);
    expect(r.summary).toMatch(new RegExp(`^video ${mode} `));
    const video = r.variants.find((v) => v.role === 'video');
    const bytes = await readFile(mediaFilePath(mediaDir(), video?.relPath ?? ''), 'latin1');
    for (const secret of [GEO, 'PRIVATE-TITLE', 'PRIVATE-HANDLER', '2026-11-01']) expect(bytes).not.toContain(secret);
  });

  it('rejects a "video" without a video stream (recorded as a pipeline failure)', async () => {
    await expect(run('video', 'audioonly.mp4')).rejects.toThrow(/no video stream/);
  });

  it('refuses playlist inputs that would open further files or URLs (W2-5)', async () => {
    // Content decides the demuxer, not the name: an archived "video" could be any of these.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(src('concat.mp4'), "ffconcat version 1.0\nfile 'plain.mp4'\n");
    await writeFile(
      src('hls.mp4'),
      '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:19207/seg.ts\n#EXTINF:1,\nplain.mp4\n#EXT-X-ENDLIST\n',
    );
    for (const name of ['concat.mp4', 'hls.mp4']) {
      await expect(probe(src(name), tools), name).rejects.toThrow();
      await expect(run('video', name), name).rejects.toThrow();
    }
    // without the whitelist ffprobe really would follow the concat playlist (the test is meaningful)
    const { stdout } = await runTool(tools.ffprobe, ['-v', 'error', '-show_format', '-of', 'json', src('concat.mp4')], {
      timeoutMs: 30_000,
    });
    expect(stdout.toString('utf8')).toContain('"format_name": "concat"');
  });

  it.each([
    ['p16.png', 700, 500, 7],
    ['cmyk.jpg', 700, 500, 7],
    ['grey.jpg', 700, 500, 7],
    ['alpha.png', 50, 30, 3],
  ])('decodes %s (16-bit, CMYK, grey, alpha) into sRGB variants', async (name, w, h, count) => {
    const r = await run('photo', name);
    expect(r.meta).toMatchObject({ w, h });
    expect(r.meta.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(r.variants).toHaveLength(count);
    const webp = r.variants.filter((v) => v.format === 'webp').sort((a, b) => (b.w ?? 0) - (a.w ?? 0))[0];
    const info = await sharp(mediaFilePath(mediaDir(), webp?.relPath ?? '')).metadata();
    expect(info).toMatchObject({ format: 'webp', space: 'srgb', width: w, height: h });
    expect(info.exif).toBeUndefined();
  });
});
