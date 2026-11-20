/**
 * Video and GIF treatment (plan A2):
 *
 * - ffprobe the original;
 * - H.264 (yuv420p/yuvj420p) with AAC or no audio: remux with +faststart (no re-encode);
 *   anything else (HEVC, VP9, 10-bit, Opus audio, …): x264 crf 23 (preset medium, yuv420p, High,
 *   long side ≤ 1920, even dimensions) + AAC 128k;
 * - GIF (gifPlayback): always muted (no audio stream), same codec rules;
 * - poster frame (PNG via pipe, at min(1 s, duration/3), already rotated by ffmpeg) -> the photo
 *   treatment with poster_* variants plus the OG JPEG;
 * - facts: display width/height (rotation applied), duration and hasAudio of the OUTPUT file.
 *
 * Outputs are written to a temp name and renamed into place; metadata and encoder tags are
 * stripped (-map_metadata -1, bitexact) so the result is deterministic for a given ffmpeg build.
 */
import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import { mediaFilePath, mediaRelPath } from '../paths.js';
import type { ProcessedVariant } from '../store/index.js';
import { localInputArgs, runTool, type ToolPaths, throwIfAborted } from './exec.js';
import { commitTemp, mkdirWithMode, PUBLIC_DIR_MODE, sha256File, tempPathFor } from './files.js';
import { type ImageEncodeOptions, processImage } from './image.js';
import { type ProbeResult, probe } from './probe.js';

export interface VideoResult {
  variants: ProcessedVariant[];
  w: number;
  h: number;
  duration: number;
  hasAudio: boolean;
  /** Poster facts (the poster has the video's display size). */
  color: string;
  thumbhash: string;
  /** "remux" or "transcode" (for logs/tests). */
  mode: 'remux' | 'transcode';
}

export interface ProcessVideoOptions {
  sha256: string;
  mediaDir: string;
  tools: ToolPaths;
  /** GIF playback: muted loop. */
  gif: boolean;
  encode?: Partial<ImageEncodeOptions> | undefined;
  signal?: AbortSignal | undefined;
  /** x264 preset (default "medium"); tests may pass "ultrafast". */
  x264Preset?: string;
}

const REMUX_PIX_FMTS = new Set(['yuv420p', 'yuvj420p']);
export const MAX_VIDEO_LONG_SIDE = 1920;

/** True when the original can be served as-is after a +faststart remux. */
export function canRemux(info: ProbeResult, gif: boolean): boolean {
  const v = info.video;
  if (v?.codec !== 'h264' || !v.pixFmt || !REMUX_PIX_FMTS.has(v.pixFmt)) return false;
  if (gif || !info.audio) return true;
  return info.audio.codec === 'aac';
}

function timeoutFor(duration: number | null): number {
  const d = duration ?? 60;
  return Math.min(15 * 60_000, Math.max(120_000, 60_000 + d * 20_000));
}

const BITEXACT = ['-fflags', '+bitexact', '-map_metadata', '-1', '-map_chapters', '-1'];

export function remuxArgs(input: string, output: string, info: ProbeResult, gif: boolean): string[] {
  const audio = !gif && info.audio ? ['-map', '0:a:0', '-c:a', 'copy'] : ['-an'];
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...localInputArgs(input),
    '-map',
    '0:v:0',
    '-c:v',
    'copy',
    ...audio,
    '-sn',
    '-dn',
    ...BITEXACT,
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    output,
  ];
}

export function transcodeArgs(
  input: string,
  output: string,
  info: ProbeResult,
  gif: boolean,
  preset = 'medium',
): string[] {
  const downmix = (info.audio?.channels ?? 0) > 2 ? ['-ac', '2'] : [];
  const audio =
    !gif && info.audio
      ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', ...downmix, '-flags:a', '+bitexact']
      : ['-an'];
  const max = MAX_VIDEO_LONG_SIDE;
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...localInputArgs(input),
    '-map',
    '0:v:0',
    '-vf',
    `scale=w='min(iw,${max})':h='min(ih,${max})':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`,
    '-c:v',
    'libx264',
    '-preset',
    preset,
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-profile:v',
    'high',
    '-flags:v',
    '+bitexact',
    ...audio,
    '-sn',
    '-dn',
    ...BITEXACT,
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    output,
  ];
}

/** Grabs one frame as PNG (ffmpeg applies the display rotation). */
export async function extractPosterFrame(
  file: string,
  duration: number | null,
  tools: ToolPaths,
  signal?: AbortSignal,
): Promise<Buffer> {
  const at = duration && duration > 0 ? Math.min(1, duration / 3) : 0;
  const grab = async (seconds: number) =>
    (
      await runTool(
        tools.ffmpeg,
        [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'error',
          '-ss',
          seconds.toFixed(3),
          ...localInputArgs(file),
          '-map',
          '0:v:0',
          '-frames:v',
          '1',
          '-f',
          'image2pipe',
          '-c:v',
          'png',
          '-',
        ],
        { timeoutMs: 60_000, signal, maxStdoutBytes: 128 * 1024 * 1024 },
      )
    ).stdout;
  let png = await grab(at);
  if (png.length === 0 && at > 0) png = await grab(0);
  if (png.length === 0) throw new Error('ffmpeg produced no poster frame');
  return png;
}

export async function processVideo(input: string, options: ProcessVideoOptions): Promise<VideoResult> {
  const { tools, signal, gif } = options;
  const source = await probe(input, tools, { signal });
  if (!source.video) throw new Error('no video stream');
  throwIfAborted(signal);

  const relPath = mediaRelPath(options.sha256, 'video', 'mp4');
  const target = mediaFilePath(options.mediaDir, relPath);
  await mkdirWithMode(dirname(target), PUBLIC_DIR_MODE);
  const tmp = tempPathFor(target);
  const mode: VideoResult['mode'] = canRemux(source, gif) ? 'remux' : 'transcode';
  const args =
    mode === 'remux'
      ? remuxArgs(input, tmp, source, gif)
      : transcodeArgs(input, tmp, source, gif, options.x264Preset ?? 'medium');
  try {
    await runTool(tools.ffmpeg, args, { timeoutMs: timeoutFor(source.duration), signal, maxStdoutBytes: 1024 * 1024 });
    await commitTemp(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }

  const out = await probe(target, tools, { signal });
  if (!out.video) throw new Error('processed video has no video stream');
  const duration = out.duration ?? source.duration ?? 0;
  const { sha256, bytes } = await sha256File(target);
  const videoVariant: ProcessedVariant = {
    role: 'video',
    variant: 'video',
    format: 'mp4',
    w: out.video.displayWidth,
    h: out.video.displayHeight,
    relPath,
    bytes,
    sha256,
  };

  const png = await extractPosterFrame(target, duration, tools, signal);
  throwIfAborted(signal);
  const poster = await processImage(png, {
    sha256: options.sha256,
    mediaDir: options.mediaDir,
    role: 'poster',
    og: true,
    encode: options.encode,
    signal,
  });

  return {
    variants: [videoVariant, ...poster.variants],
    w: out.video.displayWidth,
    h: out.video.displayHeight,
    duration: Math.round(duration * 1000) / 1000,
    hasAudio: out.audio !== null,
    color: poster.color,
    thumbhash: poster.thumbhash,
    mode,
  };
}
