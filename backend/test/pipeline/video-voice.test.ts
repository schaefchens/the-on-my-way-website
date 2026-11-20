/**
 * Video/GIF/voice treatment with the real fixtures and the local ffmpeg/ffprobe: H.264 remux,
 * HEVC transcode, muted GIF loops, posters, AAC voice + waveform peaks; tool error handling.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mediaFilePath } from '../../src/paths.js';
import { runTool, ToolError } from '../../src/pipeline/exec.js';
import {
  canRemux,
  PEAK_COUNT,
  peaksFromPcm,
  peaksFromWhatsAppWaveform,
  probe,
  processOriginal,
  processVideo,
  processVoice,
  sha256File,
  toolPathsFromEnv,
} from '../../src/pipeline/index.js';
import { parseProbe } from '../../src/pipeline/probe.js';
import { resamplePeaks } from '../../src/pipeline/voice.js';
import { FIXTURE_INBOX, fixtureByKey, fixturesPresent } from '../capture/env.js';
import { makeTempDir } from '../helpers.js';

// Media encoding is CPU-bound: generous per-test timeouts for parallel runs.
vi.setConfig({ testTimeout: 60_000 });

const tools = toolPathsFromEnv();

function originalOf(key: string): string {
  const f = fixtureByKey(key);
  return join(FIXTURE_INBOX, f.msgId, f.file ?? 'missing');
}

function moovBeforeMdat(file: string): boolean {
  const buf = readFileSync(file);
  return buf.indexOf('moov') !== -1 && buf.indexOf('moov') < buf.indexOf('mdat');
}

describe.skipIf(!fixturesPresent)('processVideo', () => {
  let tmp: ReturnType<typeof makeTempDir>;
  beforeAll(() => {
    tmp = makeTempDir('pipeline-video-');
  });
  afterAll(() => tmp.cleanup());

  it('remuxes H.264/AAC with +faststart and builds the poster set', async () => {
    const file = originalOf('hanoi-video');
    const { sha256 } = await sha256File(file);
    const mediaDir = join(tmp.dir, 'h264');
    const r = await processVideo(file, { sha256, mediaDir, tools, gif: false });
    expect(r.mode).toBe('remux');
    expect([r.w, r.h, r.duration, r.hasAudio]).toEqual([720, 1280, 4, true]);
    const video = r.variants.find((v) => v.role === 'video');
    expect(video?.relPath).toBe(`media/${sha256.slice(0, 2)}/${sha256.slice(0, 16)}_video.mp4`);
    const out = mediaFilePath(mediaDir, video?.relPath ?? '');
    const info = await probe(out, tools);
    expect(info.video?.codec).toBe('h264');
    expect(info.audio?.codec).toBe('aac');
    expect(moovBeforeMdat(out)).toBe(true);
    expect(r.variants.filter((v) => v.role === 'poster').map((v) => `${v.variant}:${v.w}x${v.h}`)).toEqual([
      'poster_w320:320x569',
      'poster_w320:320x569',
      'poster_w640:640x1138',
      'poster_w640:640x1138',
      'poster_w1080:720x1280',
      'poster_w1080:720x1280',
    ]);
    expect(r.variants.some((v) => v.role === 'og')).toBe(true);
    expect(r.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('transcodes HEVC to H.264/AAC', async () => {
    const file = originalOf('hoian-video-hevc');
    const source = await probe(file, tools);
    expect(source.video?.codec).toBe('hevc');
    expect(canRemux(source, false)).toBe(false);
    const { sha256 } = await sha256File(file);
    const mediaDir = join(tmp.dir, 'hevc');
    const r = await processVideo(file, { sha256, mediaDir, tools, gif: false });
    expect(r.mode).toBe('transcode');
    const out = mediaFilePath(mediaDir, r.variants[0]?.relPath ?? '');
    const info = await probe(out, tools);
    expect(info.video).toMatchObject({ codec: 'h264', pixFmt: 'yuv420p', width: 720, height: 1280 });
    expect(info.audio?.codec).toBe('aac');
    expect(r.duration).toBeGreaterThan(2.9);
    expect(r.duration).toBeLessThan(3.2);
    expect(moovBeforeMdat(out)).toBe(true);
  });

  it('turns a GIF into a muted loop with a poster', async () => {
    const file = originalOf('hoian-gif');
    const { sha256 } = await sha256File(file);
    const mediaDir = join(tmp.dir, 'gif');
    const r = await processOriginal({ kind: 'gif', file, sha256, media: null }, { mediaDir, tools });
    expect(r.meta).toMatchObject({ w: 480, h: 480, duration: 2, hasAudio: false });
    const video = r.variants.find((v) => v.role === 'video');
    const info = await probe(mediaFilePath(mediaDir, video?.relPath ?? ''), tools);
    expect(info.audio).toBeNull();
    expect(info.video?.codec).toBe('h264');
  });

  it('decides remux vs. transcode from the probe', () => {
    const h264 = parseProbe({
      streams: [
        { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 720, height: 1280 },
        { codec_type: 'audio', codec_name: 'opus' },
      ],
      format: { duration: '3.5' },
    });
    expect(canRemux(h264, false)).toBe(false); // Opus audio
    expect(canRemux(h264, true)).toBe(true); // GIF drops the audio
    const tenBit = parseProbe({
      streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p10le', width: 10, height: 10 }],
    });
    expect(canRemux(tenBit, true)).toBe(false);
    const rotated = parseProbe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          pix_fmt: 'yuv420p',
          width: 1280,
          height: 720,
          side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
        },
      ],
    });
    expect(rotated.video).toMatchObject({ rotation: -90, displayWidth: 720, displayHeight: 1280 });
    expect(rotated.duration).toBeNull();
  });
});

describe.skipIf(!fixturesPresent)('processVoice', () => {
  let tmp: ReturnType<typeof makeTempDir>;
  beforeAll(() => {
    tmp = makeTempDir('pipeline-voice-');
  });
  afterAll(() => tmp.cleanup());

  const meta = () =>
    JSON.parse(readFileSync(join(FIXTURE_INBOX, fixtureByKey('hoian-voice').msgId, 'meta.json'), 'utf8')) as {
      media: { waveformB64: string };
    };

  it('encodes AAC m4a mono 64k and prefers the WhatsApp waveform', async () => {
    const file = originalOf('hoian-voice');
    const { sha256 } = await sha256File(file);
    const mediaDir = join(tmp.dir, 'wa');
    const waveformB64 = meta().media.waveformB64;
    const r = await processVoice(file, { sha256, mediaDir, tools, waveformB64 });
    expect(r.peaksSource).toBe('whatsapp');
    expect(r.peaks).toHaveLength(PEAK_COUNT);
    expect(r.peaks).toEqual(peaksFromWhatsAppWaveform(waveformB64));
    expect(Math.max(...r.peaks)).toBeLessThanOrEqual(1);
    expect(r.variants[0]).toMatchObject({ role: 'audio', variant: 'voice', format: 'm4a' });
    const info = await probe(mediaFilePath(mediaDir, r.variants[0]?.relPath ?? ''), tools);
    expect(info.audio).toMatchObject({ codec: 'aac', channels: 1 });
    expect(info.video).toBeNull();
    expect(r.duration).toBeGreaterThan(2.9);
  });

  it('computes peaks from the audio without a WhatsApp waveform', async () => {
    const file = originalOf('hoian-voice');
    const { sha256 } = await sha256File(file);
    const r = await processVoice(file, { sha256, mediaDir: join(tmp.dir, 'computed'), tools });
    expect(r.peaksSource).toBe('computed');
    expect(r.peaks).toHaveLength(PEAK_COUNT);
    expect(Math.max(...r.peaks)).toBe(1);
    expect(r.peaks.every((p) => p >= 0 && p <= 1)).toBe(true);
  });

  it('peak helpers', () => {
    expect(resamplePeaks([1, 2, 3, 4], 2)).toEqual([2, 4]);
    expect(resamplePeaks([0.5], 3)).toEqual([0.5, 0.5, 0.5]);
    expect(resamplePeaks([], 2)).toEqual([0, 0]);
    expect(peaksFromWhatsAppWaveform(undefined)).toBeNull();
    expect(peaksFromWhatsAppWaveform(Buffer.from([0, 50, 100, 200]).toString('base64'))?.slice(0, 1)).toEqual([0]);
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(1000, 0);
    pcm.writeInt16LE(-2000, 2);
    expect(peaksFromPcm(pcm, 2)).toEqual([1, 0]);
    expect(peaksFromPcm(Buffer.alloc(0), 2)).toEqual([0, 0]);
  });
});

describe('runTool', () => {
  it('reports a missing binary, a non-zero exit and a timeout as ToolError', async () => {
    await expect(runTool('/nonexistent/ffmpeg-omw', [], { timeoutMs: 5000 })).rejects.toThrow(/not found/);
    const failing = runTool(process.execPath, ['-e', 'process.stderr.write("boom\\n"); process.exit(3)'], {
      timeoutMs: 5000,
    });
    await expect(failing).rejects.toBeInstanceOf(ToolError);
    await expect(failing).rejects.toThrow(/exited with 3: boom/);
    await expect(runTool(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 })).rejects.toThrow(
      /timed out/,
    );
    const ac = new AbortController();
    const aborted = runTool(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      timeoutMs: 5000,
      signal: ac.signal,
    });
    ac.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    const ok = await runTool(process.execPath, ['-e', 'process.stdout.write("hi")'], { timeoutMs: 5000 });
    expect(ok.stdout.toString()).toBe('hi');
  });
});
