/**
 * The outbox on disk: one folder per entry (documents/outbox/<ULID>/) holding manifest.json and
 * the entry's files (source, media, preview). The folders are the truth; the SQLite index
 * (index-db.ts) is rebuilt from them.
 *
 * Manifest writes are atomic: the new revision goes to manifest.next.json first and is then
 * renamed over manifest.json (rename(2) on the same filesystem). expo-file-system deletes the old
 * file right before the rename, so the reader also accepts manifest.next.json and keeps the
 * highest valid revision. A crash at any point leaves at least one complete revision.
 * Residual: there is no fsync from JS; a kernel crash or power loss within the page-cache window
 * may lose the last revision (process death and app kills are covered).
 */
import { Directory, File, Paths } from 'expo-file-system';
import { OUTBOX_PHASES, type OutboxManifest } from '../core/outbox-machine';

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const MANIFEST = 'manifest.json';
const MANIFEST_NEXT = 'manifest.next.json';

export function outboxDir(): Directory {
  return new Directory(Paths.document, 'outbox');
}

export function entryDir(entryId: string): Directory {
  if (!ULID_RE.test(entryId)) throw new RangeError(`Not an entry id: ${entryId}`);
  return new Directory(Paths.document, 'outbox', entryId);
}

export function entryFile(entryId: string, name: string): File {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) || name.includes('..')) throw new RangeError(`Bad file name: ${name}`);
  return new File(entryDir(entryId), name);
}

export function ensureEntryDir(entryId: string): Directory {
  const dir = entryDir(entryId);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function isManifest(value: unknown, entryId: string): value is OutboxManifest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Partial<OutboxManifest>;
  return (
    m.schema === 1 &&
    m.entryId === entryId &&
    typeof m.rev === 'number' &&
    typeof m.kind === 'string' &&
    (OUTBOX_PHASES as readonly string[]).includes(m.phase ?? '') &&
    Array.isArray(m.files)
  );
}

function readCandidate(file: File, entryId: string): OutboxManifest | null {
  try {
    if (!file.exists) return null;
    const parsed: unknown = JSON.parse(file.textSync());
    return isManifest(parsed, entryId) ? parsed : null;
  } catch {
    return null; // a torn or half-written file: the other candidate wins
  }
}

/** The newest complete revision of an entry's manifest, or null when there is none. */
export function readManifest(entryId: string): OutboxManifest | null {
  const a = readCandidate(entryFile(entryId, MANIFEST), entryId);
  const b = readCandidate(entryFile(entryId, MANIFEST_NEXT), entryId);
  if (a && b) return b.rev > a.rev ? b : a;
  return a ?? b;
}

/** Writes a manifest revision durably (see the header). The folder must exist. */
export async function writeManifest(m: OutboxManifest): Promise<void> {
  ensureEntryDir(m.entryId);
  const next = entryFile(m.entryId, MANIFEST_NEXT);
  // write() is async in expo-file-system 58: the rename must wait for the complete file.
  await next.write(JSON.stringify(m));
  await next.move(entryFile(m.entryId, MANIFEST), { overwrite: true });
}

/** Ids of every entry folder (unknown or foreign names are ignored). */
export function listEntryIds(): string[] {
  const dir = outboxDir();
  if (!dir.exists) return [];
  return dir
    .list()
    .filter((item): item is Directory => item instanceof Directory)
    .map((d) => d.name)
    .filter((name) => ULID_RE.test(name))
    .sort();
}

export function deleteEntryDir(entryId: string): void {
  const dir = entryDir(entryId);
  if (dir.exists) dir.delete();
}

/**
 * Brings a captured or picked file into the entry folder. Camera and recorder files in the cache
 * are moved (no second copy on a full phone); picker results are copied (the picker owns them).
 */
export async function importIntoEntry(
  entryId: string,
  sourceUri: string,
  name: string,
  how: 'move' | 'copy',
): Promise<{ uri: string; bytes: number }> {
  ensureEntryDir(entryId);
  const target = entryFile(entryId, name);
  const source = new File(sourceUri);
  if (how === 'move') {
    try {
      await source.move(target, { overwrite: true });
    } catch {
      await new File(sourceUri).copy(target, { overwrite: true });
    }
  } else {
    await source.copy(target, { overwrite: true });
  }
  return { uri: target.uri, bytes: target.size ?? 0 };
}

/** sha256 (lowercase hex, streamed natively) and size of a file in the entry folder. */
export async function fileFacts(entryId: string, name: string): Promise<{ sha256Hex: string; bytes: number }> {
  const file = entryFile(entryId, name);
  const sha256Hex = (await file.digest('SHA-256')).toLowerCase();
  return { sha256Hex, bytes: file.size ?? 0 };
}

/** Bytes used by the whole outbox (Settings › Storage). */
export function outboxBytes(): number {
  const dir = outboxDir();
  return dir.exists ? (dir.size ?? 0) : 0;
}

/** Free space on the phone's internal storage. */
export function freeBytes(): number {
  try {
    return Paths.availableDiskSpace;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
