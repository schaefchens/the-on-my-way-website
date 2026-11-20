/**
 * Read side of the helper's inbox (contracts wa.ts): DATA_DIR/inbox/<msgId>/meta.json (InboxMeta)
 * plus the original, and DATA_DIR/inbox/_revokes/<msgId>.json (RevokeRecord). Node reads and
 * copies here; the only write is releaseInboxMedia(): once a status is safely archived (or its
 * download failed permanently) the original and leftover temp files are deleted (L2-06, rule 4
 * allows it for terminal downloads). meta.json always stays as the tombstone: the helper never
 * rewrites an existing meta.json (persistMeta), so the status is never delivered or downloaded
 * again, and its resume() only touches pending/retrying downloads.
 */
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { INBOX_META_FILE, InboxMeta, MsgId, RevokeRecord } from '@omw/contracts/wa';
import { z } from 'zod';

export type InboxProblem = 'missing' | 'io' | 'invalid_json' | 'invalid_schema' | 'msgid_mismatch';

export type InboxReadResult<T> =
  | { ok: true; value: T; version: string }
  | { ok: false; problem: InboxProblem; error: string; version: string | null };

const isMsgId = (name: string) => MsgId.safeParse(name).success;

/**
 * "<inode>:<mtimeMs>:<size>" of a file, or null when it does not exist. The helper replaces
 * meta.json by rename (new inode), so a rewrite is seen even where mtime is coarse and the size
 * did not change.
 */
export async function fileVersion(path: string): Promise<string | null> {
  try {
    const st = await fsp.stat(path);
    return st.isFile() ? `${st.ino}:${st.mtimeMs}:${st.size}` : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function readJsonFile<T>(path: string, schema: z.ZodType<T>, expectedMsgId: string): Promise<InboxReadResult<T>> {
  let version: string | null;
  let text: string;
  try {
    version = await fileVersion(path);
    if (version === null) return { ok: false, problem: 'missing', error: 'file not found', version: null };
    text = await fsp.readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, problem: 'missing', error: 'file not found', version: null };
    return { ok: false, problem: 'io', error: (err as Error).message, version: null };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, problem: 'invalid_json', error: (err as Error).message, version };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, problem: 'invalid_schema', error: z.prettifyError(parsed.error), version };
  const msgId = (parsed.data as { msgId?: unknown }).msgId;
  if (msgId !== expectedMsgId) {
    return { ok: false, problem: 'msgid_mismatch', error: `msgId ${String(msgId)} in ${path}`, version };
  }
  return { ok: true, value: parsed.data, version };
}

export function inboxMetaFile(inboxDir: string, msgId: string): string {
  return join(inboxDir, MsgId.parse(msgId), INBOX_META_FILE);
}

/** Reads and validates inbox/<msgId>/meta.json (never throws for bad content). */
export function readInboxMeta(inboxDir: string, msgId: string): Promise<InboxReadResult<InboxMeta>> {
  return readJsonFile(inboxMetaFile(inboxDir, msgId), InboxMeta, msgId);
}

/** Absolute path of the downloaded original, if meta.json names one. */
export function inboxOriginalPath(inboxDir: string, meta: InboxMeta): string | null {
  return meta.download.file ? join(inboxDir, MsgId.parse(meta.msgId), meta.download.file) : null;
}

/** Message directories (valid MsgId names only; "_revokes" and temp/dot dirs are skipped). */
export async function listInboxMessages(inboxDir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(inboxDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && isMsgId(e.name))
    .map((e) => e.name)
    .sort();
}

/** msgIds that have a revoke record ("<msgId>.json" in inbox/_revokes). */
export async function listRevokes(revokesDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fsp.readdir(revokesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .filter(isMsgId)
    .sort();
}

export function revokeFile(revokesDir: string, msgId: string): string {
  return join(revokesDir, `${MsgId.parse(msgId)}.json`);
}

export function readRevoke(revokesDir: string, msgId: string): Promise<InboxReadResult<RevokeRecord>> {
  return readJsonFile(revokeFile(revokesDir, msgId), RevokeRecord, msgId);
}

/** Helper temp files inside inbox/<msgId>/ (wa-helper inbox.go tmpPrefixMeta / tmpPrefixDownload). */
const HELPER_TEMP = /^\.(?:tmp|dl)-/;

/**
 * Deletes everything in inbox/<msgId>/ except meta.json: the original ("original.<ext>", or the
 * file meta.json names) and helper temp files. The CALLER must have checked that the download is
 * terminal and the original is archived. Returns the bytes freed.
 */
export async function releaseInboxMedia(inboxDir: string, msgId: string): Promise<number> {
  const dir = join(inboxDir, MsgId.parse(msgId));
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  let freed = 0;
  for (const name of names) {
    if (name === INBOX_META_FILE) continue;
    if (!name.startsWith('original.') && !HELPER_TEMP.test(name)) continue;
    const path = join(dir, name);
    try {
      const st = await fsp.lstat(path);
      if (!st.isFile()) continue;
      await fsp.rm(path, { force: true });
      freed += st.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return freed;
}

/** True when inbox/<msgId>/ still holds an original or helper temp files. */
export async function inboxHoldsMedia(inboxDir: string, msgId: string): Promise<boolean> {
  try {
    const names = await fsp.readdir(join(inboxDir, MsgId.parse(msgId)));
    return names.some((n) => n.startsWith('original.') || HELPER_TEMP.test(n));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
