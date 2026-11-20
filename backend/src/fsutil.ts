/**
 * Filesystem helpers for moving media between MEDIA_DIR, ARCHIVE_DIR and OUT_DIR safely.
 *
 * - linkOrCopy(): hard link (no extra disk space); falls back to a copy when the two paths are on
 *   different filesystems (EXDEV, e.g. a Docker named volume and a bind mount) or links are not
 *   supported (EPERM/ENOTSUP on some network filesystems).
 * - copyDurable(): copy + fsync of file and directory; used for archiving out of the inbox
 *   (never rename: the inbox stays the helper's, see contracts wa.ts rule 4).
 */
import { constants, promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirWithMode } from './pipeline/files.js';

export interface FsOps {
  link(existing: string, target: string): Promise<void>;
  copyFile(src: string, dest: string, mode?: number): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  rm(path: string, options: { force: true }): Promise<void>;
}

const nodeFs: FsOps = {
  link: (a, b) => fsp.link(a, b),
  copyFile: (a, b, mode) => fsp.copyFile(a, b, mode),
  mkdir: (p, o) => fsp.mkdir(p, o),
  rm: (p, o) => fsp.rm(p, o),
};

const FALLBACK_CODES = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK']);

/** Creates `target` as a hard link to `source` (or a copy, see above); replaces an existing target. */
export async function linkOrCopy(source: string, target: string, fs: FsOps = nodeFs): Promise<'link' | 'copy'> {
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.rm(target, { force: true });
  try {
    await fs.link(source, target);
    return 'link';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!code || !FALLBACK_CODES.has(code)) throw err;
    // COPYFILE_FICLONE: copy-on-write clone where the filesystem supports it, else a plain copy.
    await fs.copyFile(source, target, constants.COPYFILE_FICLONE);
    return 'copy';
  }
}

/**
 * Copies `source` to `target` via a temp file, fsyncs the file and its directory, then renames.
 * The copy gets `options.mode` (never the source's mode); missing directories `options.dirMode`.
 */
export async function copyDurable(
  source: string,
  target: string,
  options: { mode?: number; dirMode?: number } = {},
): Promise<void> {
  const dir = dirname(target);
  if (options.dirMode !== undefined) await mkdirWithMode(dir, options.dirMode);
  else await fsp.mkdir(dir, { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  await fsp.copyFile(source, tmp, constants.COPYFILE_FICLONE);
  const fh = await fsp.open(tmp, 'r+');
  try {
    if (options.mode !== undefined) await fh.chmod(options.mode);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, target); // same directory: never EXDEV
  const dh = await fsp.open(dir, 'r');
  try {
    await dh.sync();
  } finally {
    await dh.close();
  }
}
