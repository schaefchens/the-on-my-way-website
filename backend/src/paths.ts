/**
 * Filesystem layout of the backend (D7, D8).
 *
 *   DATA_DIR/        store.db (SQLite, WAL) · inbox/ · wa/ (whatsmeow session)
 *   ARCHIVE_DIR/     YYYY/MM/DD/<msgId>.<ext> + <msgId>.json (UTC date of the status)
 *   OUT_DIR/         generated static site
 *   CONFIG_DIR/      publish targets, SSH keys
 *   MEDIA_DIR/       processed media variants (D8), default backend/data/media
 *
 * Media variants (D8) live in MEDIA_DIR (amended from "DATA_DIR/media": MEDIA_DIR must share a
 * filesystem with OUT_DIR, see config.ts) and are hard-linked into OUT_DIR/media when public:
 *   media/<sha[0:2]>/<sha[0:16]>_<variant>.<ext>   (sha = hex sha256 of the original file)
 * The relative path is the same below MEDIA_DIR's parent and below OUT_DIR, i.e. a variant
 * "media/ab/…_w640.avif" is MEDIA_DIR/ab/…_w640.avif and OUT_DIR/media/ab/…_w640.avif.
 * Archiving copies (+ fsync) out of the inbox; it never renames across directories (EXDEV).
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INBOX_META_FILE, INBOX_REVOKES_DIR, MsgId } from '@omw/contracts/wa';

/** backend/ (works from src/ and dist/). */
export const BACKEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Repository root (one level above backend/). */
export const REPO_ROOT = resolve(BACKEND_ROOT, '..');

export interface StatePaths {
  root: string;
  storeDb: string;
  inbox: string;
  revokes: string;
  wa: string;
  waSession: string;
}

export function statePaths(dataDir: string): StatePaths {
  const inbox = join(dataDir, 'inbox');
  const wa = join(dataDir, 'wa');
  return {
    root: dataDir,
    storeDb: join(dataDir, 'store.db'),
    inbox,
    revokes: join(inbox, INBOX_REVOKES_DIR),
    wa,
    waSession: join(wa, 'session.db'),
  };
}

/** inbox/<msgId>/ — validates the id so it can never escape the inbox. */
export function inboxMessageDir(inboxDir: string, msgId: string): string {
  return join(inboxDir, MsgId.parse(msgId));
}

export function inboxMetaPath(inboxDir: string, msgId: string): string {
  return join(inboxMessageDir(inboxDir, msgId), INBOX_META_FILE);
}

export function revokeRecordPath(inboxDir: string, msgId: string): string {
  return join(inboxDir, INBOX_REVOKES_DIR, `${MsgId.parse(msgId)}.json`);
}

/** Archive path relative to ARCHIVE_DIR: "2026/11/15/<msgId>.<ext>" (UTC date of occurredAt). */
export function archiveRelPath(occurredAt: string, msgId: string, ext: string): string {
  const d = new Date(occurredAt);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid occurredAt: ${occurredAt}`);
  if (!/^[a-z0-9]{1,8}$/.test(ext)) throw new RangeError(`Invalid extension: ${ext}`);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${day}/${MsgId.parse(msgId)}.${ext}`;
}

// ---------------------------------------------------------------------------------------------
// Media variants (D8)

export const IMAGE_WIDTHS = [320, 640, 1080, 1600] as const;
export type ImageWidth = (typeof IMAGE_WIDTHS)[number];

export type ImageVariant = `w${ImageWidth}`;
export type PosterVariant = `poster_w${ImageWidth}`;
export type MediaVariant = ImageVariant | PosterVariant | 'video' | 'voice' | 'og';
export type MediaExt = 'avif' | 'webp' | 'mp4' | 'm4a' | 'jpg';

const ALLOWED_EXT: Record<string, readonly MediaExt[]> = {
  image: ['avif', 'webp'],
  video: ['mp4'],
  voice: ['m4a'],
  og: ['jpg'],
};

export function isMediaVariant(value: string): value is MediaVariant {
  return /^(?:(?:poster_)?w(?:320|640|1080|1600)|video|voice|og)$/.test(value);
}

function allowedExtFor(variant: MediaVariant): readonly MediaExt[] {
  if (variant === 'video' || variant === 'voice' || variant === 'og') return ALLOWED_EXT[variant] ?? [];
  return ALLOWED_EXT.image ?? [];
}

/** "media/ab/ab12cd34ef56ab78_w640.avif" — relative to OUT_DIR (and to MEDIA_DIR's parent layout). */
/** Absolute file of a variant inside MEDIA_DIR ("media/ab/x_w640.avif" -> MEDIA_DIR/ab/x_w640.avif). */
export function mediaFilePath(mediaDir: string, relPath: string): string {
  const m = /^media\/([0-9a-f]{2}\/[0-9a-f]{16}_[a-z0-9_]+\.[a-z0-9]+)$/.exec(relPath);
  if (!m?.[1]) throw new RangeError(`Not a media variant path: ${relPath}`);
  return join(mediaDir, m[1]);
}

export function mediaRelPath(originalSha256Hex: string, variant: MediaVariant, ext: MediaExt): string {
  if (!/^[0-9a-f]{64}$/.test(originalSha256Hex)) throw new RangeError('Expected sha256 hex of the original');
  if (!isMediaVariant(variant)) throw new RangeError(`Unknown media variant: ${variant}`);
  if (!allowedExtFor(variant).includes(ext)) throw new RangeError(`Extension .${ext} not allowed for ${variant}`);
  return `media/${originalSha256Hex.slice(0, 2)}/${originalSha256Hex.slice(0, 16)}_${variant}.${ext}`;
}
