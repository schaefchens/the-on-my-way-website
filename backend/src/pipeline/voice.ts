/**
 * Voice treatment (plan A2): AAC-LC 64 kbps mono in an M4A container (+faststart) and 64 waveform
 * peaks in 0..1. The WhatsApp waveform (InboxMedia.waveformB64, bytes 0–100) is preferred; without
 * it the peaks are computed from the decoded audio (8 kHz mono PCM, max |sample| per bucket,
 * normalised to the loudest bucket).
 */
import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import { mediaFilePath, mediaRelPath } from '../paths.js';
import type { ProcessedVariant } from '../store/index.js';
import { localInputArgs, runTool, type ToolPaths, throwIfAborted } from './exec.js';
import { commitTemp, mkdirWithMode, PUBLIC_DIR_MODE, sha256File, tempPathFor } from './files.js';
import { probe } from './probe.js';

export const PEAK_COUNT = 64;

export interface VoiceResult {
  variants: ProcessedVariant[];
  duration: number;
  peaks: number[];
  /** Where the peaks came from. */
  peaksSource: 'whatsapp' | 'computed';
}

export interface ProcessVoiceOptions {
  sha256: string;
  mediaDir: string;
  tools: ToolPaths;
  /** InboxMedia.waveformB64 (preferred source of the peaks). */
  waveformB64?: string | undefined;
  signal?: AbortSignal | undefined;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Resamples `values` to `count` buckets (max per bucket; linear stretch when shorter). */
export function resamplePeaks(values: readonly number[], count = PEAK_COUNT): number[] {
  if (values.length === 0) return new Array<number>(count).fill(0);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * values.length) / count);
    const end = Math.max(start + 1, Math.floor(((i + 1) * values.length) / count));
    let max = 0;
    for (let j = start; j < end && j < values.length; j++) max = Math.max(max, values[j] ?? 0);
    out.push(max);
  }
  return out;
}

/** WhatsApp waveform (base64 bytes 0–100) -> 64 peaks 0..1; null when absent/empty. */
export function peaksFromWhatsAppWaveform(waveformB64: string | undefined): number[] | null {
  if (!waveformB64) return null;
  const bytes = Buffer.from(waveformB64, 'base64');
  if (bytes.length === 0) return null;
  const values = Array.from(bytes, (b) => Math.min(1, Math.max(0, b / 100)));
  return resamplePeaks(values).map(round3);
}

/** Peaks from signed 16-bit little-endian mono PCM. */
export function peaksFromPcm(pcm: Buffer, count = PEAK_COUNT): number[] {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return new Array<number>(count).fill(0);
  const buckets: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * samples) / count);
    const end = Math.max(start + 1, Math.floor(((i + 1) * samples) / count));
    let max = 0;
    for (let s = start; s < end && s < samples; s++) max = Math.max(max, Math.abs(pcm.readInt16LE(s * 2)));
    buckets.push(max);
  }
  const loudest = Math.max(...buckets);
  return buckets.map((b) => (loudest > 0 ? round3(b / loudest) : 0));
}

export async function processVoice(input: string, options: ProcessVoiceOptions): Promise<VoiceResult> {
  const { tools, signal } = options;
  const source = await probe(input, tools, { signal });
  if (!source.audio) throw new Error('no audio stream');
  throwIfAborted(signal);

  const relPath = mediaRelPath(options.sha256, 'voice', 'm4a');
  const target = mediaFilePath(options.mediaDir, relPath);
  await mkdirWithMode(dirname(target), PUBLIC_DIR_MODE);
  const tmp = tempPathFor(target);
  const timeoutMs = Math.min(10 * 60_000, Math.max(60_000, (source.duration ?? 60) * 5_000));
  try {
    await runTool(
      tools.ffmpeg,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        ...localInputArgs(input),
        '-map',
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-ac',
        '1',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '-flags:a',
        '+bitexact',
        '-fflags',
        '+bitexact',
        '-map_metadata',
        '-1',
        '-map_chapters',
        '-1',
        '-movflags',
        '+faststart',
        '-f',
        'ipod',
        tmp,
      ],
      { timeoutMs, signal, maxStdoutBytes: 1024 * 1024 },
    );
    await commitTemp(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }

  const out = await probe(target, tools, { signal });
  const duration = round3(out.duration ?? source.duration ?? 0);
  let peaks = peaksFromWhatsAppWaveform(options.waveformB64);
  let peaksSource: VoiceResult['peaksSource'] = 'whatsapp';
  if (!peaks) {
    const { stdout } = await runTool(
      tools.ffmpeg,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        ...localInputArgs(input),
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        's16le',
        '-',
      ],
      { timeoutMs, signal, maxStdoutBytes: 64 * 1024 * 1024 },
    );
    peaks = peaksFromPcm(stdout);
    peaksSource = 'computed';
  }
  const { sha256, bytes } = await sha256File(target);
  return {
    variants: [{ role: 'audio', variant: 'voice', format: 'm4a', relPath, bytes, sha256 }],
    duration,
    peaks,
    peaksSource,
  };
}
