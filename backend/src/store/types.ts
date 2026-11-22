/**
 * Types and JSON-column schemas of the content store.
 */
import { Base64, CaptureKind, CapturePublicId, HexColor, LocalDate, SourceKey, TimeZone } from '@omw/contracts';
import {
  DownloadFailureReason,
  DownloadState,
  InboxMedia,
  InboxSender,
  InboxText,
  StatusSource,
} from '@omw/contracts/wa';
import { z } from 'zod';

/**
 * Where a stored capture came from: WhatsApp's StatusSource (live, history, fixture) or the
 * traveler app ("app", sourceKey "app:<ULID>", capture/app-source.ts; store migration v2).
 */
export const CaptureSource = z.enum([...StatusSource.options, 'app']);
export type CaptureSource = z.infer<typeof CaptureSource>;

/** Injected clock (tests pass a fixed one). */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/**
 * awaiting_media: a media status whose original the helper has not downloaded yet (download
 * pending, retrying, or failed but not permanently). Not picked up by the pipeline.
 */
export const CAPTURE_STATES = [
  'awaiting_media',
  'received',
  'archived',
  'processed',
  'ready',
  'failed',
  'media_lost',
] as const;
export type CaptureState = (typeof CAPTURE_STATES)[number];

/** One processed output file (DATA_DIR/<relPath>). */
export const ProcessedVariant = z.object({
  /** What the file is used for. */
  role: z.enum(['image', 'poster', 'video', 'audio', 'og', 'preview']),
  /** D8 variant name: w320…w1600, poster_w320…poster_w1600, video, voice, og (or "preview"). */
  variant: z.string().regex(/^(?:(?:poster_)?w\d{2,4}|video|voice|og|preview)$/),
  format: z.enum(['avif', 'webp', 'mp4', 'm4a', 'jpg']),
  w: z.int().positive().optional(),
  h: z.int().positive().optional(),
  /** Relative to DATA_DIR (and OUT_DIR when published), e.g. "media/ab/ab12…_w640.avif". */
  relPath: z.string().regex(/^media\/[0-9a-f]{2}\/[0-9a-f]{16}_[a-z0-9_]+\.[a-z0-9]+$/),
  bytes: z.int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ProcessedVariant = z.infer<typeof ProcessedVariant>;

/** Facts derived by the media pipeline. */
export const ProcessedMeta = z.object({
  w: z.int().positive().optional(),
  h: z.int().positive().optional(),
  /** Seconds. */
  duration: z.number().min(0).optional(),
  thumbhash: Base64.optional(),
  color: HexColor.optional(),
  /** Voice waveform peaks 0..1. */
  peaks: z.array(z.number().min(0).max(1)).optional(),
  /** Video/GIF: whether the processed file has an audio stream (GIFs: always false). */
  hasAudio: z.boolean().optional(),
});
export type ProcessedMeta = z.infer<typeof ProcessedMeta>;

export interface CaptureRow {
  sourceKey: string;
  publicId: string;
  msgId: string | null;
  source: CaptureSource;
  kind: CaptureKind;
  occurredAt: string;
  receivedAt: string | null;
  tz: string;
  localDate: string;
  caption: string | null;
  text: InboxText | null;
  media: InboxMedia | null;
  sender: InboxSender | null;
  state: CaptureState;
  downloadState: DownloadState;
  downloadReason: DownloadFailureReason | null;
  downloadPermanent: boolean | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  archivePath: string | null;
  originalSha256: string | null;
  variants: ProcessedVariant[] | null;
  processedMeta: ProcessedMeta | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const NewCapture = z.object({
  sourceKey: SourceKey,
  publicId: CapturePublicId,
  msgId: z.string().nullable(),
  source: CaptureSource,
  kind: CaptureKind,
  occurredAt: z.string(),
  receivedAt: z.string().nullable().optional(),
  tz: TimeZone,
  /** Derived from occurredAt + tz when omitted. */
  localDate: LocalDate.optional(),
  caption: z.string().nullable().optional(),
  text: InboxText.nullable().optional(),
  media: InboxMedia.nullable().optional(),
  sender: InboxSender.nullable().optional(),
  /** InboxMeta.download; defaults to "ok" for media kinds and "not_applicable" otherwise. */
  download: z
    .object({
      state: DownloadState,
      reason: DownloadFailureReason.optional(),
      permanent: z.boolean().optional(),
      error: z.string().optional(),
    })
    .optional(),
});
export type NewCapture = z.input<typeof NewCapture>;
