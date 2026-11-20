/**
 * Media of public entries.
 *
 * - Mapping: the pipeline's ProcessedVariant[] + ProcessedMeta (store/types.ts) -> the site
 *   contract's ImageSet / VideoMedia / AudioMedia. Admin previews (role "preview") are never
 *   published. An entry whose required variants are missing (or whose files are not in
 *   MEDIA_DIR) is left out of the site with a warning instead of referencing missing files.
 * - OUT_DIR/media mirrors exactly the variants referenced by public entries (generate.ts links
 *   them from MEDIA_DIR with fsutil.linkOrCopy and removes unreferenced ones); scanMediaRoot()
 *   lists both directories.
 * - Referenced paths are read from the media fields only (imageSetPaths, entryMediaPaths, …),
 *   never by scanning strings: user text may start with "media/" too.
 */
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type {
  AudioMedia,
  DayDetail,
  Entry,
  ImageSet,
  ImageSource,
  TimelineIndex,
  VideoMedia,
} from '@omw/contracts/site';
import type { ProcessedMeta, ProcessedVariant } from '../store/index.js';

export type MediaProblem = string;

function widthOf(v: ProcessedVariant): number | null {
  if (v.w) return v.w;
  const m = /w(\d{2,4})$/.exec(v.variant);
  return m ? Number(m[1]) : null;
}

function sources(variants: readonly ProcessedVariant[], role: 'image' | 'poster', format: 'avif' | 'webp') {
  const byWidth = new Map<number, ImageSource>();
  for (const v of variants) {
    if (v.role !== role || v.format !== format) continue;
    const w = widthOf(v);
    if (!w) continue;
    if (!byWidth.has(w)) byWidth.set(w, { w, src: v.relPath });
  }
  return [...byWidth.values()].sort((a, b) => a.w - b.w || (a.src < b.src ? -1 : 1));
}

/** ImageSet of a photo (role "image") or a video poster (role "poster"). */
export function imageSetFrom(
  variants: readonly ProcessedVariant[],
  meta: ProcessedMeta | null,
  role: 'image' | 'poster',
): ImageSet | MediaProblem {
  const avif = sources(variants, role, 'avif');
  const webp = sources(variants, role, 'webp');
  if (avif.length === 0 || webp.length === 0) return `no ${role} variants in both avif and webp`;
  if (!meta?.color || !meta.thumbhash) return 'processed meta lacks color/thumbhash';
  const largest = variants.filter((v) => v.role === role && v.w && v.h).sort((a, b) => (b.w ?? 0) - (a.w ?? 0))[0];
  const w = meta.w ?? largest?.w;
  const h = meta.h ?? largest?.h;
  if (!w || !h) return 'unknown image dimensions';
  const og = variants.find((v) => v.role === 'og' && v.format === 'jpg');
  return {
    w,
    h,
    color: meta.color,
    thumbhash: meta.thumbhash,
    sources: { avif, webp },
    ...(og ? { og: og.relPath } : {}),
  };
}

export function videoFrom(
  variants: readonly ProcessedVariant[],
  meta: ProcessedMeta | null,
  gif: boolean,
): VideoMedia | MediaProblem {
  const file = variants.find((v) => v.role === 'video' && v.format === 'mp4');
  if (!file) return 'no mp4 video variant';
  const poster = imageSetFrom(variants, meta, 'poster');
  if (typeof poster === 'string') return poster;
  const duration = meta?.duration;
  if (duration === undefined) return 'processed meta lacks duration';
  // Videos without the pipeline's hasAudio fact (older rows) are assumed to have sound
  // (WhatsApp videos almost always do); GIF playback is always muted.
  const hasAudio = gif ? false : (meta?.hasAudio ?? true);
  return { src: file.relPath, w: poster.w, h: poster.h, duration, hasAudio, poster };
}

export function audioFrom(
  variants: readonly ProcessedVariant[],
  meta: ProcessedMeta | null,
): AudioMedia | MediaProblem {
  const file = variants.find((v) => v.role === 'audio' && v.format === 'm4a');
  if (!file) return 'no m4a audio variant';
  if (meta?.duration === undefined) return 'processed meta lacks duration';
  return { src: file.relPath, duration: meta.duration, peaks: meta.peaks ?? [] };
}

// ---------------------------------------------------------------------------------------------
// Referenced media paths
//
// Collected structurally from the typed media fields only. User text (captions, text statuses,
// notes, titles) can contain anything, including strings that start with "media/"; scanning
// every string would turn such text into "references" (a capture left out as "missing media",
// or mediaFilePath() throwing on a note and failing the whole run).

/** Media paths of an ImageSet: every avif/webp source and the OG JPEG. */
export function imageSetPaths(image: ImageSet | null | undefined, out: Set<string>): Set<string> {
  if (!image) return out;
  for (const s of image.sources.avif) out.add(s.src);
  for (const s of image.sources.webp) out.add(s.src);
  if (image.og) out.add(image.og);
  return out;
}

/** Media paths an entry references (photo image set; video/gif file + poster; voice file). */
export function entryMediaPaths(entry: Entry, out: Set<string>): Set<string> {
  switch (entry.kind) {
    case 'photo':
      return imageSetPaths(entry.image, out);
    case 'video':
    case 'gif':
      out.add(entry.video.src);
      return imageSetPaths(entry.video.poster, out);
    case 'voice':
      out.add(entry.audio.src);
      return out;
    case 'text':
    case 'note':
    case 'story':
      return out;
  }
}

/** Media paths of a day file (its entries). */
export function dayMediaPaths(day: Pick<DayDetail, 'entries'>, out: Set<string>): Set<string> {
  for (const e of day.entries) entryMediaPaths(e, out);
  return out;
}

/** Media paths of the timeline index (day and trip covers). */
export function timelineMediaPaths(timeline: Pick<TimelineIndex, 'days' | 'trips'>, out: Set<string>): Set<string> {
  for (const d of timeline.days) imageSetPaths(d.cover, out);
  for (const t of timeline.trips) imageSetPaths(t.cover, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Directory scans

/** "media/<aa>/<file>" paths present in a media root laid out as <root>/<aa>/<file>. */
export async function scanMediaRoot(root: string): Promise<Set<string>> {
  const out = new Set<string>();
  let subdirs: string[];
  try {
    subdirs = await fsp.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw err;
  }
  for (const sub of subdirs) {
    if (!/^[0-9a-f]{2}$/.test(sub)) continue;
    let files: string[];
    try {
      files = await fsp.readdir(join(root, sub));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') continue;
      throw err;
    }
    for (const name of files) {
      if (name.includes('.tmp')) continue;
      out.add(`media/${sub}/${name}`);
    }
  }
  return out;
}
