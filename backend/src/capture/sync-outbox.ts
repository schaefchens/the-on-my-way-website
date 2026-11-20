/**
 * Sync outbox items queued by the capture pipeline for the API sync client (plan A6, B4b).
 *
 *   kind       key                      payload                       API call
 *   capture    <sourceKey>              CaptureMirror                 PUT  /api/v1/backend/captures/{sourceKey}
 *   preview    <sourceKey>#<role>       PreviewOutboxPayload          POST /api/v1/backend/captures/{sourceKey}/preview
 *   revoke     <sourceKey>              CaptureRevoke                 POST /api/v1/backend/captures/{sourceKey}/revoke
 *
 * The outbox coalesces per (kind, key), so re-enqueueing only replaces the pending payload.
 * Previews point at a file in MEDIA_DIR (mediaFilePath(config.dirs.media, relPath)): photos send
 * the w640 WebP as role "preview", videos/GIFs the poster_w640 WebP as role "poster". The API
 * answers 404 capture_not_mirrored until the capture PUT went through; the sender retries.
 */
import { CONTRACT_VERSION } from '@omw/contracts';
import { type CaptureMedia, CaptureMirror, type CaptureRevoke, type MediaState, PreviewRole } from '@omw/contracts/api';
import { isMediaKind } from '@omw/contracts/wa';
import { z } from 'zod';
import { previewVariant } from '../pipeline/site-media.js';
import { textStyleFromInbox } from '../pipeline/text.js';
import type { CaptureRow, Store } from '../store/index.js';

export const PreviewOutboxPayload = z.object({
  sourceKey: z.string(),
  role: PreviewRole,
  /** D8 media path; the file is mediaFilePath(MEDIA_DIR, relPath). */
  relPath: z.string().regex(/^media\/[0-9a-f]{2}\/[0-9a-f]{16}_[a-z0-9_]+\.[a-z0-9]+$/),
  contentType: z.enum(['image/webp', 'image/jpeg']),
  bytes: z.int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  w: z.int().positive().optional(),
  h: z.int().positive().optional(),
});
export type PreviewOutboxPayload = z.infer<typeof PreviewOutboxPayload>;

/** Outbox key of a preview item. */
export function previewOutboxKey(sourceKey: string, role: PreviewRole): string {
  return `${sourceKey}#${role}`;
}

export function mediaStateOf(row: CaptureRow): MediaState {
  if (!isMediaKind(row.kind)) return 'none';
  if (row.state === 'media_lost') return 'lost';
  if (row.state === 'ready') return 'ok';
  return 'pending';
}

function mirrorMedia(row: CaptureRow): CaptureMedia | null {
  if (!isMediaKind(row.kind)) return null;
  const meta = row.processedMeta;
  const media: CaptureMedia = {};
  const w = meta?.w ?? row.media?.width;
  const h = meta?.h ?? row.media?.height;
  const duration = meta?.duration ?? row.media?.seconds;
  if (w) media.w = w;
  if (h) media.h = h;
  if (duration !== undefined) media.duration = duration;
  if (meta?.color) media.color = meta.color;
  if (meta?.thumbhash) media.thumbhash = meta.thumbhash;
  return media;
}

/** CaptureMirror body of a stored capture (validated). */
export function captureMirrorFromRow(row: CaptureRow): CaptureMirror {
  return CaptureMirror.parse({
    contractVersion: CONTRACT_VERSION,
    sourceKey: row.sourceKey,
    publicId: row.publicId,
    kind: row.kind,
    occurredAt: row.occurredAt,
    tz: row.tz,
    localDate: row.localDate,
    caption: row.caption,
    text: row.kind === 'text' && row.text ? textStyleFromInbox(row.text) : null,
    media: mirrorMedia(row),
    mediaState: mediaStateOf(row),
    revokedAt: row.revokedAt,
  });
}

export function enqueueCaptureMirror(store: Store, row: CaptureRow): void {
  store.outbox.enqueue('capture', row.sourceKey, captureMirrorFromRow(row));
}

export function enqueueRevoke(store: Store, row: CaptureRow): void {
  if (!row.revokedAt) return;
  const body: CaptureRevoke = { contractVersion: CONTRACT_VERSION, at: row.revokedAt };
  store.outbox.enqueue('revoke', row.sourceKey, body);
}

/** Queues the admin preview of a ready capture (nothing for kinds without an image). */
export function enqueuePreviews(store: Store, row: CaptureRow): number {
  const variant = previewVariant(row);
  if (!variant) return 0;
  const role: PreviewRole = row.kind === 'photo' ? 'preview' : 'poster';
  const payload: PreviewOutboxPayload = PreviewOutboxPayload.parse({
    sourceKey: row.sourceKey,
    role,
    relPath: variant.relPath,
    contentType: 'image/webp',
    bytes: variant.bytes,
    sha256: variant.sha256,
    ...(variant.w ? { w: variant.w } : {}),
    ...(variant.h ? { h: variant.h } : {}),
  });
  store.outbox.enqueue('preview', previewOutboxKey(row.sourceKey, role), payload);
  return 1;
}
