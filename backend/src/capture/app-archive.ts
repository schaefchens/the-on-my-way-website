/**
 * Home archive of the traveler app's entries (app-plan §3.1, §3.7; owner decision Q2 c):
 *
 *   ARCHIVE_DIR/app/YYYY/MM/DD/app-<ULID>.json            the record (type "omw.app-entry")
 *                              app-<ULID>.<jpg|mp4|m4a>   the published artifact (role media)
 *                              app-<ULID>.preview.jpg     the phone's 640w preview
 *                              app-<ULID>.original.<ext>  the untouched original (photos AND videos)
 *
 * dated by the UTC day of the corrected occurredAt. The separate "app/" subtree keeps the WhatsApp
 * archive walk (archive.ts listArchiveRecords: numeric year directories only) unchanged.
 *
 * The record is self-describing like the WhatsApp one: the AppEntry exactly as the phone sent it,
 * the server's corrected time, the zone and local date the capture was filed under, each file's
 * name/hash/size and the withdrawal time. `reprocess` and the restore rebuild the capture from it.
 * Only the media file is ever processed for the site; the original is never published.
 *
 * Everything here is private (L1-09): files 0600, directories 0700.
 */
import { promises as fsp } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { CapturePublicId, IsoUtc, LocalDate, Sha256Hex, SourceKey, TimeZone } from '@omw/contracts';
import { AppEntry, AppEntryId, AppFileRole } from '@omw/contracts/app';
import { z } from 'zod';
import { copyDurable } from '../fsutil.js';
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  removeStaleTemps,
  sha256File,
  writeFileDurable,
} from '../pipeline/files.js';
import type { CaptureRow } from '../store/index.js';

export const APP_ARCHIVE_SUBDIR = 'app';

export const AppArchiveFile = z.object({
  /** File name next to the record, e.g. "app-01JD….jpg". */
  file: z.string().regex(/^app-[0-9A-Z]{26}(?:\.(?:preview|original))?\.[a-z0-9]{1,8}$/),
  sha256Hex: Sha256Hex,
  bytes: z.int().min(0),
  mimetype: z.string().min(1),
});
export type AppArchiveFile = z.infer<typeof AppArchiveFile>;

export const AppArchiveRecord = z.object({
  schema: z.literal(1),
  type: z.literal('omw.app-entry'),
  sourceKey: SourceKey,
  publicId: CapturePublicId,
  entryId: AppEntryId,
  /** Corrected by the API (correctAppOccurredAt); entry.occurredAt is the phone's clock. */
  occurredAt: IsoUtc,
  tz: TimeZone,
  localDate: LocalDate,
  receivedAt: IsoUtc,
  clamped: z.boolean(),
  heldBack: z.boolean(),
  phone: z.object({ id: z.int().positive(), name: z.string() }),
  archivedAt: IsoUtc,
  updatedAt: IsoUtc,
  files: z.partialRecord(AppFileRole, AppArchiveFile),
  withdrawnAt: IsoUtc.nullable(),
  /** The entry as the phone sent it (verbatim). */
  entry: AppEntry,
});
export type AppArchiveRecord = z.infer<typeof AppArchiveRecord>;

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/dng': 'dng',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/3gpp': '3gp',
  'video/webm': 'webm',
  'audio/mp4': 'm4a',
};

/** File extension for a mimetype the app contract allows ("bin" for anything else). */
export function extForMimetype(mimetype: string): string {
  return MIME_EXT[mimetype] ?? 'bin';
}

/** "app/2026/11/20" (UTC day of the corrected occurredAt). */
export function appArchiveDayDir(occurredAt: string): string {
  const d = new Date(occurredAt);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Invalid occurredAt: ${occurredAt}`);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${APP_ARCHIVE_SUBDIR}/${y}/${m}/${day}`;
}

/** Record path relative to ARCHIVE_DIR. */
export function appRecordRelPath(occurredAt: string, entryId: string): string {
  return `${appArchiveDayDir(occurredAt)}/app-${AppEntryId.parse(entryId)}.json`;
}

/** File name of one role next to the record. */
export function appFileName(entryId: string, role: AppFileRole, mimetype: string): string {
  const base = `app-${AppEntryId.parse(entryId)}`;
  const ext = extForMimetype(mimetype);
  return role === 'media' ? `${base}.${ext}` : `${base}.${role}.${ext}`;
}

export async function writeAppRecord(archiveDir: string, record: AppArchiveRecord): Promise<string> {
  const rel = appRecordRelPath(record.occurredAt, record.entryId);
  const parsed = AppArchiveRecord.parse(record);
  const target = join(archiveDir, rel);
  await removeStaleTemps(dirname(target), `app-${record.entryId}.json`);
  await writeFileDurable(target, `${JSON.stringify(parsed, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
    dirMode: PRIVATE_DIR_MODE,
  });
  return rel;
}

export async function readAppRecord(archiveDir: string, relPath: string): Promise<AppArchiveRecord> {
  const text = await fsp.readFile(join(archiveDir, relPath), 'utf8');
  return AppArchiveRecord.parse(JSON.parse(text));
}

export async function readAppRecordIfExists(archiveDir: string, relPath: string): Promise<AppArchiveRecord | null> {
  try {
    return await readAppRecord(archiveDir, relPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export class AppArchiveIntegrityError extends Error {
  override name = 'AppArchiveIntegrityError';
}

/**
 * Copies a downloaded, sha256-verified file into the archive (copy + fsync) and verifies the copy.
 * An existing archived file with the right hash is kept (replays and restarts are harmless).
 */
export async function archiveAppFile(
  archiveDir: string,
  source: string,
  dayDir: string,
  fileName: string,
  expectedSha256: string,
): Promise<{ file: string; sha256Hex: string; bytes: number }> {
  const target = join(archiveDir, dayDir, fileName);
  const existing = await sha256File(target).catch(() => null);
  if (existing?.sha256 === expectedSha256) return { file: fileName, sha256Hex: existing.sha256, bytes: existing.bytes };
  await removeStaleTemps(dirname(target), `${fileName.split('.')[0] ?? fileName}.`);
  await copyDurable(source, target, { mode: PRIVATE_FILE_MODE, dirMode: PRIVATE_DIR_MODE });
  const copied = await sha256File(target);
  if (copied.sha256 !== expectedSha256) {
    await fsp.rm(target, { force: true });
    throw new AppArchiveIntegrityError(
      `sha256 mismatch for ${fileName}: expected ${expectedSha256}, got ${copied.sha256}`,
    );
  }
  return { file: fileName, sha256Hex: copied.sha256, bytes: copied.bytes };
}

/** Absolute path of an archived role of a record at `recordRelPath` (null when not archived). */
export function appArchivedPath(
  archiveDir: string,
  recordRelPath: string,
  record: AppArchiveRecord,
  role: AppFileRole,
): string | null {
  const f = record.files[role];
  return f ? join(archiveDir, dirname(recordRelPath), f.file) : null;
}

/** True for the archive path of an app capture (captures.archive_path). */
export function isAppRecordPath(relPath: string | null): relPath is string {
  return relPath?.startsWith(`${APP_ARCHIVE_SUBDIR}/`) === true;
}

/**
 * The pipeline input of an archived app capture (capture/ingest.ts processStep): the MEDIA file,
 * never the private original.
 */
export async function appPipelineInput(
  archiveDir: string,
  row: Pick<CaptureRow, 'archivePath' | 'originalSha256' | 'kind'>,
): Promise<{ file: string | null; sha256: string | null }> {
  if (!isAppRecordPath(row.archivePath)) throw new Error('not an app capture');
  const record = await readAppRecord(archiveDir, row.archivePath);
  if (row.kind === 'text') return { file: null, sha256: null };
  const file = appArchivedPath(archiveDir, row.archivePath, record, 'media');
  if (!file) throw new Error('app archive record has no media file');
  return { file, sha256: row.originalSha256 ?? record.files.media?.sha256Hex ?? null };
}

/** All app record paths (relative to ARCHIVE_DIR), sorted. */
export async function listAppRecords(archiveDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory() && depth < 3 && /^\d{2,4}$/.test(e.name)) await walk(path, depth + 1);
      else if (e.isFile() && depth === 3 && /^app-[0-9A-Z]{26}\.json$/.test(e.name)) {
        out.push(relative(archiveDir, path).split(sep).join('/'));
      }
    }
  };
  await walk(join(archiveDir, APP_ARCHIVE_SUBDIR), 0);
  return out.sort();
}
