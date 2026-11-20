/**
 * Home archive (plan A2): ARCHIVE_DIR/YYYY/MM/DD/<msgId>.<ext> (the original, copied + fsynced out
 * of the inbox) and <msgId>.json (ArchiveRecord), dated by the UTC day of the status.
 *
 * The record is self-describing so `reprocess` can rebuild the store and every media variant from
 * the archive alone: the InboxMeta as received (incl. rawProtoB64 with the media keys), the zone
 * and local date the capture was filed under, the original's name/hash and the revoke time.
 * It is written when the status is first ingested (so statuses whose media never arrives are kept
 * too) and rewritten when the original is archived, the status is revoked or its media is lost.
 * captures.archive_path holds the record's path relative to ARCHIVE_DIR.
 *
 * Everything here is private (L1-09): files 0600, directories 0700 (pipeline/files.ts modes).
 */
import { promises as fsp } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { CaptureKind, CapturePublicId, IsoUtc, LocalDate, Sha256Hex, SourceKey, TimeZone } from '@omw/contracts';
import { InboxMeta, MsgId } from '@omw/contracts/wa';
import { z } from 'zod';
import { copyDurable } from '../fsutil.js';
import { archiveRelPath } from '../paths.js';
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  removeStaleTemps,
  sha256File,
  writeFileDurable,
} from '../pipeline/files.js';

export const ArchiveOriginal = z.object({
  /** File name next to the record, e.g. "3EB0….jpg". */
  file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.[a-z0-9]{1,8}$/),
  sha256Hex: Sha256Hex,
  bytes: z.int().min(0),
  mimetype: z.string().min(1).nullable(),
});
export type ArchiveOriginal = z.infer<typeof ArchiveOriginal>;

export const ArchiveRecord = z.object({
  schema: z.literal(1),
  type: z.literal('omw.capture'),
  sourceKey: SourceKey,
  publicId: CapturePublicId,
  msgId: MsgId,
  kind: CaptureKind,
  occurredAt: IsoUtc,
  /** Zone in effect when the status was captured, and the local date it was filed under. */
  tz: TimeZone,
  localDate: LocalDate,
  archivedAt: IsoUtc,
  updatedAt: IsoUtc,
  original: ArchiveOriginal.nullable(),
  revokedAt: IsoUtc.nullable(),
  /** inbox meta.json as last seen (verbatim, incl. rawProtoB64). */
  meta: InboxMeta,
});
export type ArchiveRecord = z.infer<typeof ArchiveRecord>;

export function archiveRecordRelPath(occurredAt: string, msgId: string): string {
  return archiveRelPath(occurredAt, msgId, 'json');
}

/** "original.jpg" -> "jpg". */
export function originalExt(file: string): string {
  const m = /\.([a-z0-9]{1,8})$/.exec(file);
  if (!m?.[1] || m[1] === 'json') throw new RangeError(`Original without a usable extension: ${file}`);
  return m[1];
}

export async function writeArchiveRecord(archiveDir: string, record: ArchiveRecord): Promise<string> {
  const rel = archiveRecordRelPath(record.occurredAt, record.msgId);
  const parsed = ArchiveRecord.parse(record);
  const target = join(archiveDir, rel);
  await removeStaleTemps(dirname(target), `${record.msgId}.json`);
  await writeFileDurable(target, `${JSON.stringify(parsed, null, 2)}\n`, {
    mode: PRIVATE_FILE_MODE,
    dirMode: PRIVATE_DIR_MODE,
  });
  return rel;
}

export async function readArchiveRecord(archiveDir: string, relPath: string): Promise<ArchiveRecord> {
  const text = await fsp.readFile(join(archiveDir, relPath), 'utf8');
  return ArchiveRecord.parse(JSON.parse(text));
}

export async function readArchiveRecordIfExists(archiveDir: string, relPath: string): Promise<ArchiveRecord | null> {
  try {
    return await readArchiveRecord(archiveDir, relPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Copies the original into the archive (copy + fsync, never a rename out of the inbox) and verifies
 * it against the sha256 the helper recorded. Returns the archived file's facts.
 */
export async function archiveOriginal(
  archiveDir: string,
  source: string,
  occurredAt: string,
  msgId: string,
  expectedSha256: string | undefined,
): Promise<{ relPath: string; sha256: string; bytes: number }> {
  const rel = archiveRelPath(occurredAt, msgId, originalExt(source));
  const target = join(archiveDir, rel);
  const existing = await sha256File(target).catch(() => null);
  if (existing && (!expectedSha256 || existing.sha256 === expectedSha256)) {
    return { relPath: rel, ...existing };
  }
  await removeStaleTemps(dirname(target), `${msgId}.`);
  await copyDurable(source, target, { mode: PRIVATE_FILE_MODE, dirMode: PRIVATE_DIR_MODE });
  const copied = await sha256File(target);
  if (expectedSha256 && copied.sha256 !== expectedSha256) {
    await fsp.rm(target, { force: true });
    throw new ArchiveIntegrityError(`sha256 mismatch for ${msgId}: expected ${expectedSha256}, got ${copied.sha256}`);
  }
  return { relPath: rel, ...copied };
}

export class ArchiveIntegrityError extends Error {
  override name = 'ArchiveIntegrityError';
}

/** Absolute path of the archived original of a record at `recordRelPath`. */
export function archivedOriginalPath(archiveDir: string, recordRelPath: string, record: ArchiveRecord): string | null {
  return record.original ? join(archiveDir, dirname(recordRelPath), record.original.file) : null;
}

/** All record paths (relative to ARCHIVE_DIR), sorted; skips temp files and non-records. */
export async function listArchiveRecords(archiveDir: string): Promise<string[]> {
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
      else if (e.isFile() && depth === 3 && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/.test(e.name)) {
        out.push(relative(archiveDir, path).split(sep).join('/'));
      }
    }
  };
  await walk(archiveDir, 0);
  return out.sort();
}
