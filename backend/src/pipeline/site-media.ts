/**
 * Read helpers for consumers of processed captures (generator, sync): build the contracts' media
 * objects (ImageSet, VideoMedia, AudioMedia) from a ready CaptureRow. They return null when the
 * capture lacks the processed facts the contract requires (never throw on stored data).
 *
 * Variant roles (ProcessedVariant.role) written by the pipeline:
 *   photo:      image (w320…w1600 × avif/webp), og (1200x630 jpg)
 *   video/gif:  video (mp4), poster (poster_w320… × avif/webp), og (from the poster)
 *   voice:      audio (m4a)
 * ProcessedMeta: w/h (display size), color + thumbhash (photo, or the poster), duration
 * (video/gif/voice), hasAudio (video/gif), peaks (voice).
 */
import type { AudioMedia, ImageSet, VideoMedia } from '@omw/contracts/site';
import type { CaptureRow, ProcessedVariant } from '../store/index.js';

const byWidth = (a: { w: number }, b: { w: number }) => a.w - b.w;

/** ImageSet of a photo (role "image") or a video poster (role "poster"). */
export function imageSetFromCapture(row: CaptureRow, role: 'image' | 'poster'): ImageSet | null {
  const variants = row.variants ?? [];
  const meta = row.processedMeta;
  if (!meta?.w || !meta.h || !meta.color || !meta.thumbhash) return null;
  const pick = (format: 'avif' | 'webp') =>
    variants
      .filter((v): v is ProcessedVariant & { w: number } => v.role === role && v.format === format && !!v.w)
      .map((v) => ({ w: v.w, src: v.relPath }))
      .sort(byWidth);
  const avif = pick('avif');
  const webp = pick('webp');
  if (avif.length === 0 || webp.length === 0) return null;
  const og = variants.find((v) => v.role === 'og');
  return {
    w: meta.w,
    h: meta.h,
    color: meta.color,
    thumbhash: meta.thumbhash,
    sources: { avif, webp },
    ...(og ? { og: og.relPath } : {}),
  };
}

export function videoMediaFromCapture(row: CaptureRow): VideoMedia | null {
  const video = row.variants?.find((v) => v.role === 'video');
  const meta = row.processedMeta;
  const poster = imageSetFromCapture(row, 'poster');
  if (!video || !meta?.w || !meta.h || meta.duration === undefined || !poster) return null;
  return {
    src: video.relPath,
    w: meta.w,
    h: meta.h,
    duration: meta.duration,
    hasAudio: row.kind === 'gif' ? false : meta.hasAudio === true,
    poster,
  };
}

export function audioMediaFromCapture(row: CaptureRow): AudioMedia | null {
  const audio = row.variants?.find((v) => v.role === 'audio');
  const meta = row.processedMeta;
  if (!audio || meta?.duration === undefined || !meta.peaks) return null;
  return { src: audio.relPath, duration: meta.duration, peaks: meta.peaks };
}

/** The 640w WebP used as private admin preview (photo: image, video/gif: poster). */
export function previewVariant(row: CaptureRow): ProcessedVariant | null {
  const role = row.kind === 'photo' ? 'image' : row.kind === 'video' || row.kind === 'gif' ? 'poster' : null;
  if (!role) return null;
  const candidates = (row.variants ?? []).filter((v) => v.role === role && v.format === 'webp' && v.w);
  if (candidates.length === 0) return null;
  // The w640 bucket, else the largest smaller one, else the smallest.
  const exact = candidates.find((v) => v.variant.endsWith('w640'));
  if (exact) return exact;
  const sorted = [...candidates].sort((a, b) => (a.w ?? 0) - (b.w ?? 0));
  return [...sorted].reverse().find((v) => (v.w ?? 0) <= 640) ?? sorted[0] ?? null;
}
