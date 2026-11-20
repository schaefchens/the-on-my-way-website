/** ffprobe wrapper: the few stream facts the pipeline decides on. */
import { z } from 'zod';
import { localInputArgs, runTool, type ToolPaths } from './exec.js';

const ProbeStream = z
  .object({
    index: z.number().optional(),
    codec_type: z.string().optional(),
    codec_name: z.string().optional(),
    profile: z.string().optional(),
    pix_fmt: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    duration: z.string().optional(),
    channels: z.number().optional(),
    sample_rate: z.string().optional(),
    tags: z.record(z.string(), z.unknown()).optional(),
    side_data_list: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .loose();

const ProbeOutput = z.object({
  streams: z.array(ProbeStream).default([]),
  format: z.object({ duration: z.string().optional(), format_name: z.string().optional() }).loose().optional(),
});

export interface VideoStreamInfo {
  codec: string;
  pixFmt: string | null;
  /** Coded size. */
  width: number;
  height: number;
  /** Display rotation in degrees (from the display matrix or the legacy "rotate" tag). */
  rotation: number;
  /** Display size (coded size with a ±90° rotation applied). */
  displayWidth: number;
  displayHeight: number;
}

export interface AudioStreamInfo {
  codec: string;
  channels: number | null;
  sampleRate: number | null;
}

export interface ProbeResult {
  formatName: string | null;
  /** Seconds (format duration, else the longest stream). */
  duration: number | null;
  video: VideoStreamInfo | null;
  audio: AudioStreamInfo | null;
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function rotationOf(stream: z.infer<typeof ProbeStream>): number {
  for (const side of stream.side_data_list ?? []) {
    const r = num(side.rotation);
    if (r !== null) return r;
  }
  return num(stream.tags?.rotate) ?? 0;
}

export function parseProbe(json: unknown): ProbeResult {
  const out = ProbeOutput.parse(json);
  const v = out.streams.find((s) => s.codec_type === 'video' && s.codec_name && s.width && s.height);
  const a = out.streams.find((s) => s.codec_type === 'audio' && s.codec_name);
  let video: VideoStreamInfo | null = null;
  if (v?.codec_name && v.width && v.height) {
    const rotation = rotationOf(v);
    const quarter = Math.abs(Math.round(rotation / 90)) % 2 === 1;
    video = {
      codec: v.codec_name,
      pixFmt: v.pix_fmt ?? null,
      width: v.width,
      height: v.height,
      rotation,
      displayWidth: quarter ? v.height : v.width,
      displayHeight: quarter ? v.width : v.height,
    };
  }
  const audio: AudioStreamInfo | null = a?.codec_name
    ? { codec: a.codec_name, channels: a.channels ?? null, sampleRate: num(a.sample_rate) }
    : null;
  let duration = num(out.format?.duration);
  if (duration === null) {
    const durations = out.streams.map((s) => num(s.duration)).filter((d): d is number => d !== null);
    duration = durations.length > 0 ? Math.max(...durations) : null;
  }
  return { formatName: out.format?.format_name ?? null, duration, video, audio };
}

export async function probe(
  file: string,
  tools: ToolPaths,
  options: { signal?: AbortSignal | undefined; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const { stdout } = await runTool(
    tools.ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...localInputArgs(file, 'ffprobe')],
    { timeoutMs: options.timeoutMs ?? 30_000, signal: options.signal, maxStdoutBytes: 4 * 1024 * 1024 },
  );
  let json: unknown;
  try {
    json = JSON.parse(stdout.toString('utf8'));
  } catch (err) {
    throw new Error(`ffprobe returned invalid JSON: ${(err as Error).message}`);
  }
  return parseProbe(json);
}
