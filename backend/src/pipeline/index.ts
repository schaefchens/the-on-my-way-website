/**
 * Media pipeline (plan A2): turns an archived original into the D8 variants in MEDIA_DIR plus the
 * facts the generator needs (ProcessedMeta). Pure with respect to the store: the caller (capture
 * ingest) records the result. See image.ts, video.ts, voice.ts for the per-kind treatment.
 *
 * Kinds without media (text, unsupported) produce no variants; text styling is derived at read
 * time by textStyleFromInbox(), unsupported statuses are stored but never rendered.
 */
import { join } from 'node:path';
import type { CaptureKind } from '@omw/contracts';
import type { InboxMedia } from '@omw/contracts/wa';
import type { ProcessedMeta, ProcessedVariant } from '../store/index.js';
import type { ToolPaths } from './exec.js';
import { removeStaleTemps } from './files.js';
import { type ImageEncodeOptions, processImage } from './image.js';
import { processVideo } from './video.js';
import { processVoice } from './voice.js';

export { AbortedError, isAbortError, ToolError, type ToolPaths, toolPathsFromEnv } from './exec.js';
export { sha256File, writeFileDurable } from './files.js';
export { DEFAULT_IMAGE_OPTIONS, type ImageEncodeOptions, processImage, widthTargets } from './image.js';
export { probe } from './probe.js';
export {
  audioMediaFromCapture,
  imageSetFromCapture,
  previewVariant,
  videoMediaFromCapture,
} from './site-media.js';
export { DEFAULT_TEXT_STYLE, textStyleFromInbox } from './text.js';
export { canRemux, processVideo } from './video.js';
export { PEAK_COUNT, peaksFromPcm, peaksFromWhatsAppWaveform, processVoice } from './voice.js';

export interface PipelineOptions {
  mediaDir: string;
  tools: ToolPaths;
  encode?: Partial<ImageEncodeOptions> | undefined;
  /** x264 preset for transcodes (default "medium"). */
  x264Preset?: string | undefined;
}

export interface ProcessInput {
  kind: CaptureKind;
  /** Absolute path of the original (archived copy); null for kinds without media. */
  file: string | null;
  /** sha256 hex of the original (D8 naming key). */
  sha256: string | null;
  media: InboxMedia | null;
  signal?: AbortSignal | undefined;
}

export interface ProcessOutput {
  variants: ProcessedVariant[];
  meta: ProcessedMeta;
  /** Human-readable summary for logs. */
  summary: string;
}

/** Removes temp files a crashed run left for this original (call before processing it). */
export async function cleanupStaleOutputs(mediaDir: string, sha256: string): Promise<number> {
  return removeStaleTemps(join(mediaDir, sha256.slice(0, 2)), `${sha256.slice(0, 16)}_`);
}

export async function processOriginal(input: ProcessInput, options: PipelineOptions): Promise<ProcessOutput> {
  const { kind, signal } = input;
  if (kind === 'text' || kind === 'unsupported') return { variants: [], meta: {}, summary: kind };
  if (!input.file || !input.sha256) throw new Error(`kind "${kind}" needs an original file`);
  await cleanupStaleOutputs(options.mediaDir, input.sha256);
  switch (kind) {
    case 'photo': {
      const r = await processImage(input.file, {
        sha256: input.sha256,
        mediaDir: options.mediaDir,
        role: 'image',
        og: true,
        encode: options.encode,
        signal,
      });
      return {
        variants: r.variants,
        meta: { w: r.w, h: r.h, color: r.color, thumbhash: r.thumbhash },
        summary: `photo ${r.w}x${r.h}, ${r.variants.length} variants`,
      };
    }
    case 'video':
    case 'gif': {
      const r = await processVideo(input.file, {
        sha256: input.sha256,
        mediaDir: options.mediaDir,
        tools: options.tools,
        gif: kind === 'gif',
        encode: options.encode,
        signal,
        ...(options.x264Preset ? { x264Preset: options.x264Preset } : {}),
      });
      return {
        variants: r.variants,
        meta: {
          w: r.w,
          h: r.h,
          duration: r.duration,
          hasAudio: kind === 'gif' ? false : r.hasAudio,
          color: r.color,
          thumbhash: r.thumbhash,
        },
        summary: `${kind} ${r.mode} ${r.w}x${r.h} ${r.duration}s audio=${r.hasAudio}`,
      };
    }
    case 'voice': {
      const r = await processVoice(input.file, {
        sha256: input.sha256,
        mediaDir: options.mediaDir,
        tools: options.tools,
        waveformB64: input.media?.waveformB64,
        signal,
      });
      return {
        variants: r.variants,
        meta: { duration: r.duration, peaks: r.peaks },
        summary: `voice ${r.duration}s peaks=${r.peaksSource}`,
      };
    }
  }
}
