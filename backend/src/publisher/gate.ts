/**
 * Gate tree deploy (spec-wave5 §5.6.2 step 1; gate mode only). GATE_OUT_DIR goes to the target's
 * gateRoot (the web root) with its own small record /.omw-gate.json (path → sha256):
 *
 *   1. changed files under _/ (the bundle in _/assets/ first, then the pages), then robots.txt,
 *      favicon.svg, index.html;
 *   2. /.htaccess LAST and only when its hash changed (or forced after a failed gate check);
 *   3. obsolete gate files (in the old record, not generated any more);
 *   4. the new record.
 *
 * It never lists or touches /<secret>/, /.omw-store/, /.well-known/ or any path that is not a gate
 * tree path (GATE_FIXED_FILES, _/assets/*). Every file is written to a temp name and renamed into
 * place; a connection without atomic replace (no posix-rename@openssh.com) is refused: a
 * delete + rename window on a .htaccess must never happen.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { z } from 'zod';
import { GATE_FIXED_FILES } from '../generator/gate.js';
import type { Logger } from '../log.js';
import { writeAtomic } from './record.js';
import { type RemoteFs, remoteJoin } from './remote.js';
import { PublishError } from './types.js';

/** The gate tree's deploy record at gateRoot (a dot path: the gate answers 403 for it). */
export const GATE_RECORD_NAME = '.omw-gate.json';

const GateRecord = z.object({
  format: z.literal(1),
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
});
export type GateRecord = z.infer<typeof GateRecord>;

const FIXED = new Set<string>(GATE_FIXED_FILES);
const ASSET = /^_\/assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** True for the paths the gate tree may contain (and the only ones its deploy writes or deletes). */
export function isGateTreePath(rel: string): boolean {
  return (FIXED.has(rel) || ASSET.test(rel)) && !rel.endsWith('.map');
}

export interface GateFile {
  rel: string;
  abs: string;
  sha256: string;
  size: number;
}

/** Every file of GATE_OUT_DIR with its sha256; refuses anything that is not a gate tree path. */
export async function scanGateDir(gateOutDir: string): Promise<Map<string, GateFile>> {
  const out = new Map<string, GateFile>();
  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs);
        continue;
      }
      const rel = relative(gateOutDir, abs).split(sep).join('/');
      if (!isGateTreePath(rel)) {
        throw new PublishError('gate_config', `GATE_OUT_DIR contains ${rel}, which is not a gate tree file`);
      }
      const data = await fsp.readFile(abs);
      out.set(rel, { rel, abs, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    }
  };
  await walk(gateOutDir);
  return out;
}

/** Upload order of §5.6.2: _/assets/, other _/ files, robots.txt, favicon.svg, index.html; .htaccess separately. */
export function gateUploadOrder(rels: Iterable<string>): string[] {
  const rank = (rel: string) =>
    rel.startsWith('_/assets/')
      ? 0
      : rel.startsWith('_/')
        ? 1
        : rel === 'robots.txt'
          ? 2
          : rel === 'favicon.svg'
            ? 3
            : rel === 'index.html'
              ? 4
              : 5;
  return [...rels].filter((r) => r !== '.htaccess').sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

async function ensureDir(remote: RemoteFs, dir: string, made: Set<string>): Promise<void> {
  if (dir === '/' || made.has(dir)) return;
  const st = await remote.stat(dir);
  if (st?.type === 'dir') {
    made.add(dir);
    return;
  }
  await ensureDir(remote, posix.dirname(dir), made);
  await remote.mkdir(dir);
  made.add(dir);
}

export interface GateDeployOptions {
  gateRoot: string;
  gateOutDir: string;
  /** The content folder: a record naming a path inside it is refused (never touched). */
  secret: string;
  /** Problems of the root .htaccess (verify.ts verifyHtaccess); non-empty refuses the deploy. */
  verifyRoot: (text: string) => string[];
  /** Re-upload /.htaccess even when its hash is unchanged (after a failed gate check). */
  forceHtaccess?: boolean;
  /**
   * The gate record as this backend last wrote it (path → sha256), when it is known for this
   * destination; null = read /.omw-gate.json from the target. With a known record and nothing
   * to do, the deploy does not connect at all.
   */
  known?: Record<string, string> | null;
  log: Logger;
  targetId: string;
}

export interface GateDeployResult {
  uploaded: number;
  deleted: number;
  bytes: number;
  /** /.htaccess was uploaded. */
  htaccess: boolean;
  /** Anything changed on the target. */
  changed: boolean;
  /** The record after this deploy (persist it as the next `known`). */
  files: Record<string, string>;
}

/**
 * Deploys GATE_OUT_DIR to gateRoot (see the module header). `getRemote` opens (or reuses) the
 * connection; the caller checks atomic replace and closes it.
 */
export async function deployGateTree(
  getRemote: () => Promise<RemoteFs>,
  opts: GateDeployOptions,
): Promise<GateDeployResult> {
  const local = await scanGateDir(opts.gateOutDir);
  const root = local.get('.htaccess');
  if (!root)
    throw new PublishError('gate_config', 'GATE_OUT_DIR has no .htaccess: generate the site in gate mode first');
  const problems = opts.verifyRoot(await fsp.readFile(root.abs, 'utf8'));
  if (problems.length > 0) {
    throw new PublishError('gate_config', `the generated /.htaccess fails verification: ${problems.join('; ')}`);
  }
  const files = Object.fromEntries([...local.values()].map((f) => [f.rel, f.sha256]).sort());
  const recordPath = remoteJoin(opts.gateRoot, GATE_RECORD_NAME);
  let previous: Record<string, string>;
  let recordOnTarget = true;
  if (opts.known) previous = opts.known;
  else {
    previous = {};
    const raw = await (await getRemote()).readFile(recordPath);
    recordOnTarget = raw !== null;
    if (raw) {
      try {
        const parsed = GateRecord.safeParse(JSON.parse(raw.toString('utf8')));
        if (parsed.success) previous = parsed.data.files;
        else opts.log.warn({ target: opts.targetId }, 'publisher: ignoring an invalid gate record');
      } catch {
        opts.log.warn({ target: opts.targetId }, 'publisher: ignoring an unreadable gate record');
      }
    }
  }
  const uploads = gateUploadOrder(local.keys()).filter((rel) => previous[rel] !== local.get(rel)?.sha256);
  const htaccess = previous['.htaccess'] !== root.sha256 || opts.forceHtaccess === true;
  // Only ever gate tree paths: a hand-edited record can never make this touch the content.
  const deletes = Object.keys(previous)
    .filter((rel) => !local.has(rel) && isGateTreePath(rel) && !rel.startsWith(`${opts.secret}/`))
    .sort();
  const result: GateDeployResult = { uploaded: 0, deleted: 0, bytes: 0, htaccess: false, changed: false, files };
  const recordSame =
    recordOnTarget &&
    Object.keys(previous).length === local.size &&
    [...local.values()].every((f) => previous[f.rel] === f.sha256);
  if (uploads.length === 0 && !htaccess && deletes.length === 0 && recordSame) return result;

  const remote = await getRemote();
  const made = new Set<string>();
  const upload = async (f: GateFile) => {
    const path = remoteJoin(opts.gateRoot, f.rel);
    await ensureDir(remote, posix.dirname(path), made);
    await writeAtomic(remote, path, await fsp.readFile(f.abs));
    result.uploaded++;
    result.bytes += f.size;
    result.changed = true;
  };
  for (const rel of uploads) await upload(local.get(rel) as GateFile);
  if (htaccess) {
    await upload(root);
    result.htaccess = true;
  }
  for (const rel of deletes) {
    if (await remote.remove(remoteJoin(opts.gateRoot, rel))) {
      result.deleted++;
      result.changed = true;
    }
  }
  if (!recordSame) {
    const record: GateRecord = { format: 1, files };
    await writeAtomic(remote, recordPath, Buffer.from(`${JSON.stringify(record)}\n`));
  }
  return result;
}
