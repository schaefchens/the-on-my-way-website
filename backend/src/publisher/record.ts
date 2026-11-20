/**
 * Files the publisher keeps on the target, next to the site (below the target's remote root):
 *
 *   .omw-deploy.json.gz       DeployRecord (gzip-compressed JSON, L2-05): every file the publisher
 *                             put there (path -> [sha256, size]) after the last deploy, plus
 *                             obsolete assets in their grace period. Lets a backend that lost its
 *                             store resume incrementally. Re-uploaded only when its content changes
 *                             (TargetState.recordHash). ~15x smaller than the JSON (5.2 MB -> 350 KB
 *                             at 47k files).
 *   .omw-deploy.json          the uncompressed record of older versions: still read for recovery,
 *                             deleted after the first successful .gz write.
 *   .omw-deploy.pending.json  DeployJournal: the paths a running deploy uploads or deletes. It is
 *                             written before the first upload and removed after the last delete,
 *                             so after an interruption those paths are treated as uncertain.
 *   <dir>/.omw-tmp.<name>     upload in progress (renamed onto <name> when complete).
 *
 * The site never references these names; scan.ts skips ".omw-*" in OUT_DIR. They are publicly
 * readable on hosts that serve dotfiles; they contain only public paths and hashes.
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import type { RemoteFs } from './remote.js';
import { isReservedName, isSafeRelPath } from './scan.js';

export const RECORD_NAME = '.omw-deploy.json.gz';
/** Uncompressed record written by older versions (read for recovery, then removed). */
export const LEGACY_RECORD_NAME = '.omw-deploy.json';
export const JOURNAL_NAME = '.omw-deploy.pending.json';
export const TMP_PREFIX = '.omw-tmp.';

const Sha = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * A site-relative path as the scan produces it. The record and journal are read back from the
 * target (writable by anyone with the SFTP account, readable over HTTP): a path that could never
 * have come from OUT_DIR ("../x", "/x", ".omw-*") makes the whole file invalid, so a tampered
 * record can never steer deletes outside the publisher's own files.
 */
const SitePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => isSafeRelPath(p) && !p.split('/').some(isReservedName), { message: 'Not a site path' });

export const DeployRecord = z.object({
  format: z.literal('omw-deploy/1'),
  target: z.string(),
  version: z.int().nullable(),
  deployedAt: z.string(),
  files: z.record(SitePath, z.tuple([Sha, z.int().min(0)])),
  obsoleteSince: z.record(SitePath, z.string()),
});
export type DeployRecord = z.infer<typeof DeployRecord>;

export const DeployJournal = z.object({
  format: z.literal('omw-deploy-pending/1'),
  target: z.string(),
  startedAt: z.string(),
  version: z.int().nullable(),
  uploads: z.array(SitePath),
  deletes: z.array(SitePath),
});
export type DeployJournal = z.infer<typeof DeployJournal>;

/** "/www/data/x.json" -> "/www/data/.omw-tmp.x.json" (deterministic: a retry overwrites it). */
export function tmpPathFor(remotePath: string): string {
  return posix.join(posix.dirname(remotePath), `${TMP_PREFIX}${posix.basename(remotePath)}`);
}

/** Writes `data` to `path` via the temp name + replace(). */
export async function writeAtomic(remote: RemoteFs, path: string, data: Buffer): Promise<void> {
  const tmp = tmpPathFor(path);
  await remote.writeFile(tmp, data);
  await remote.replace(tmp, path);
}

export type ReadResult<T> = { status: 'ok'; value: T } | { status: 'missing' } | { status: 'invalid'; error: string };

export async function readJsonFile<T>(remote: RemoteFs, path: string, schema: z.ZodType<T>): Promise<ReadResult<T>> {
  const buf = await remote.readFile(path);
  if (!buf) return { status: 'missing' };
  try {
    const parsed = schema.safeParse(JSON.parse(buf.toString('utf8')));
    return parsed.success ? { status: 'ok', value: parsed.data } : { status: 'invalid', error: parsed.error.message };
  } catch (err) {
    return { status: 'invalid', error: (err as Error).message };
  }
}

/** Upper bound for a decompressed record (a tampered .gz must not exhaust memory). */
const MAX_RECORD_BYTES = 256 * 1024 * 1024;

/** Serialized record: deterministic gzip of the JSON (no timestamp in the gzip header). */
export function encodeRecord(record: DeployRecord): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(record)), { level: 9 });
}

export function decodeRecord(data: Buffer): unknown {
  return JSON.parse(gunzipSync(data, { maxOutputLength: MAX_RECORD_BYTES }).toString('utf8'));
}

/** What a record says, without the time it was written: equal hashes need no new upload. */
export function recordContentHash(record: DeployRecord): string {
  const { deployedAt: _at, ...content } = record;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** Reads the gzip record, else the legacy JSON record (status 'missing' when neither exists). */
export async function readDeployRecord(
  remote: RemoteFs,
  root: string,
  join: (root: string, name: string) => string,
): Promise<ReadResult<DeployRecord> & { source?: 'gz' | 'json' }> {
  const gz = await remote.readFile(join(root, RECORD_NAME));
  if (gz) {
    try {
      const parsed = DeployRecord.safeParse(decodeRecord(gz));
      return parsed.success
        ? { status: 'ok', value: parsed.data, source: 'gz' }
        : { status: 'invalid', error: parsed.error.message, source: 'gz' };
    } catch (err) {
      return { status: 'invalid', error: (err as Error).message, source: 'gz' };
    }
  }
  const legacy = await readJsonFile(remote, join(root, LEGACY_RECORD_NAME), DeployRecord);
  return { ...legacy, ...(legacy.status === 'missing' ? {} : { source: 'json' as const }) };
}
