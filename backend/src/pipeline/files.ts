/**
 * Atomic, durable file writes for media variants and archive records.
 *
 * Every output is written to "<target>.tmp-<pid>-<random>" in the target's directory, fsynced and
 * renamed into place (same directory: never EXDEV), so readers (generator, publisher) only ever
 * see complete files and a crash leaves at most a stale temp file, which removeStaleTemps()
 * cleans up before the same capture is processed again.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, createReadStream, promises as fsp, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const TEMP_MARKER = '.tmp-';

/**
 * File modes (L1-09). Private data (archive originals + records, Node-written inbox files, the
 * store and everything else in DATA_DIR) is owner-only, like the Go helper's files: the archive
 * holds the untouched originals with their EXIF/GPS and the raw WhatsApp metadata of hidden items
 * too. Public output (MEDIA_DIR variants, OUT_DIR) stays world-readable. Modes are set explicitly
 * (chmod after create), never through process.umask, so neither a restrictive nor a lax umask
 * changes them.
 */
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;
export const PUBLIC_FILE_MODE = 0o644;
export const PUBLIC_DIR_MODE = 0o755;

/**
 * mkdir -p whose new directories get exactly `mode` (mkdir's own mode is narrowed by the umask).
 * Directories that already exist keep their mode.
 */
export async function mkdirWithMode(dir: string, mode: number): Promise<void> {
  const first = await fsp.mkdir(dir, { recursive: true, mode });
  if (!first) return;
  for (let d = dir; ; d = dirname(d)) {
    await fsp.chmod(d, mode);
    if (d === first || dirname(d) === d) break;
  }
}

/** mkdirWithMode, synchronously (startup). */
export function mkdirWithModeSync(dir: string, mode: number): void {
  const first = mkdirSync(dir, { recursive: true, mode });
  if (!first) return;
  for (let d = dir; ; d = dirname(d)) {
    chmodSync(d, mode);
    if (d === first || dirname(d) === d) break;
  }
}

/**
 * Identifies this process in temp names. The pid alone is not enough: in Docker (init: true) the
 * backend gets the same low pid on every start, so a crashed run's temp files would look like ours.
 */
const INSTANCE = `${process.pid}-${randomBytes(4).toString('hex')}`;

export function tempPathFor(target: string): string {
  return `${target}${TEMP_MARKER}${INSTANCE}-${randomBytes(4).toString('hex')}`;
}

export async function fsyncPath(path: string, flags: 'r' | 'r+' = 'r'): Promise<void> {
  const fh = await fsp.open(path, flags);
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** fsync of a directory (makes renames durable). Ignored where directories cannot be opened. */
export async function fsyncDir(dir: string): Promise<void> {
  try {
    await fsyncPath(dir, 'r');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EISDIR' && code !== 'EPERM' && code !== 'EINVAL') throw err;
  }
}

/**
 * Writes `data` to `target` atomically and durably (temp + fsync + rename + dir fsync). With
 * `syncDir: false` the caller fsyncs the directory once after several writes. `mode` (default
 * 0644, public) is applied exactly; missing directories are created with `dirMode` (default 0755).
 */
export async function writeFileDurable(
  target: string,
  data: string | Uint8Array,
  options: { mode?: number; dirMode?: number; syncDir?: boolean } = {},
): Promise<void> {
  const dir = dirname(target);
  await mkdirWithMode(dir, options.dirMode ?? PUBLIC_DIR_MODE);
  const tmp = tempPathFor(target);
  const mode = options.mode ?? PUBLIC_FILE_MODE;
  try {
    const fh = await fsp.open(tmp, 'w', mode);
    try {
      await fh.chmod(mode); // independent of the umask
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  if (options.syncDir !== false) await fsyncDir(dir);
}

/** Moves a finished temp file (same directory) into place durably, with `mode` (default 0644). */
export async function commitTemp(tmp: string, target: string, mode: number = PUBLIC_FILE_MODE): Promise<void> {
  const fh = await fsp.open(tmp, 'r+');
  try {
    await fh.chmod(mode);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, target);
  await fsyncDir(dirname(target));
}

/**
 * Removes group/other permissions below `root` (files and directories, symlinks left alone):
 * the one-time tightening of ARCHIVE_DIR and DATA_DIR written by older versions with 0644/0755.
 * Returns how many entries changed; errors on single entries are counted, never thrown.
 */
export async function restrictTree(root: string): Promise<{ changed: number; errors: number }> {
  let changed = 0;
  let errors = 0;
  const visit = async (path: string): Promise<void> => {
    let st: import('node:fs').Stats;
    try {
      st = await fsp.lstat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') errors++;
      return;
    }
    if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) return;
    if ((st.mode & 0o077) !== 0) {
      try {
        await fsp.chmod(path, st.mode & 0o700);
        changed++;
      } catch {
        errors++;
      }
    }
    if (st.isDirectory()) {
      let names: string[] = [];
      try {
        names = await fsp.readdir(path);
      } catch {
        errors++;
      }
      for (const name of names) await visit(join(path, name));
    }
  };
  await visit(root);
  return { changed, errors };
}

export async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

export function sha256Buffer(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * True for temp names written by THIS process: our own "….tmp-<instance>-<hex>" names, and the
 * "….tmp-<pid>" names of fsutil.copyDurable with our pid (copyDurable reuses that name, so a stale
 * one with a recycled pid is simply overwritten by the next copy).
 */
export function isOwnTemp(name: string): boolean {
  if (name.includes(`${TEMP_MARKER}${INSTANCE}-`)) return true;
  return name.endsWith(`${TEMP_MARKER}${process.pid}`);
}

/**
 * Removes stale temp files "<prefix>*.tmp-*" in `dir` left by a crashed process. Temp files of
 * the current process are kept (a concurrent writer may still be using them).
 */
export async function removeStaleTemps(dir: string, prefix: string): Promise<number> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.includes(TEMP_MARKER) || isOwnTemp(name)) continue;
    await fsp.rm(join(dir, name), { force: true, recursive: true });
    removed++;
  }
  return removed;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}
