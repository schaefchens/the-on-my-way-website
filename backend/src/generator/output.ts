/**
 * OUT_DIR file operations: atomic writes (temp file in the same directory + rename), removal,
 * and scans used by full runs to find stray files.
 *
 * Safety: full runs delete files below OUT_DIR that the generator did not plan. So a run refuses
 * to start when a directory it must never touch (DATA_DIR with store.db and the WhatsApp
 * session, ARCHIVE_DIR, CONFIG_DIR, MEDIA_DIR, the site build, the repository) is OUT_DIR or
 * lies inside it (assertSafeOutDir), and stray-file removal is limited to the generator's own
 * namespaces (isGeneratorPath): foreign files are left alone.
 */
import { promises as fsp } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { LOCALE_CODES } from '@omw/contracts/i18n';
import { fsyncDir, mkdirWithMode } from '../pipeline/files.js';

let counter = 0;

/** Rejects anything that is not a plain relative path inside OUT_DIR. */
export function outPath(outDir: string, rel: string): string {
  if (rel.length === 0 || rel.startsWith('/') || rel.split('/').some((s) => s === '..' || s === '' || s === '.')) {
    throw new RangeError(`Invalid output path: ${rel}`);
  }
  return join(outDir, ...rel.split('/'));
}

/** Public output: world-readable files and directories, independent of the umask (L1-09). */
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

export interface WriteOptions {
  /** fsync the file before the rename (default true; asset copies skip it, see generate.ts). */
  durable?: boolean;
  /**
   * Collects the directories whose new entries still need an fsync (the caller runs syncDirs()
   * once for all of them); without it the directory is fsynced right after the rename.
   */
  pendingDirs?: Set<string>;
}

/**
 * Writes `rel` below OUT_DIR atomically AND durably (W2-1): temp file in the same directory,
 * fsync, rename, directory fsync. A crash or power loss can leave the old or the new file, never
 * an empty or torn one (a rename without the data fsync can, on ext4/APFS).
 */
export async function writeAtomic(
  outDir: string,
  rel: string,
  data: string | Uint8Array,
  options: WriteOptions = {},
): Promise<void> {
  const target = outPath(outDir, rel);
  const dir = dirname(target);
  await mkdirWithMode(dir, DIR_MODE);
  const tmp = `${target}.tmp-${process.pid}-${++counter}`;
  try {
    const fh = await fsp.open(tmp, 'w', FILE_MODE);
    try {
      await fh.chmod(FILE_MODE);
      await fh.writeFile(data);
      if (options.durable !== false) await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  if (options.pendingDirs) options.pendingDirs.add(dir);
  else await fsyncDir(dir);
}

export async function copyAtomic(
  source: string,
  outDir: string,
  rel: string,
  options: WriteOptions = {},
): Promise<void> {
  await writeAtomic(outDir, rel, await fsp.readFile(source), options);
}

/** fsync of each directory (makes the renames/links in them durable). */
export async function syncDirs(dirs: Iterable<string>): Promise<void> {
  for (const dir of dirs) await fsyncDir(dir);
}

export async function readIfExists(outDir: string, rel: string): Promise<Buffer | null> {
  try {
    return await fsp.readFile(outPath(outDir, rel));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'EISDIR') {
      return null;
    }
    throw err;
  }
}

/** Removes a file and then its now-empty parent directories (up to OUT_DIR). */
export async function removeOutput(outDir: string, rel: string): Promise<boolean> {
  const target = outPath(outDir, rel);
  let existed = true;
  try {
    await fsp.rm(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    existed = false;
  }
  let dir = dirname(target);
  while (dir.startsWith(outDir + sep) && dir !== outDir) {
    try {
      await fsp.rmdir(dir);
    } catch {
      break;
    }
    dir = dirname(dir);
  }
  return existed;
}

/** Every file below OUT_DIR (posix relative paths), skipping media/ and assets/ (synced separately). */
export async function scanOutputs(outDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(outDir, full).split(sep).join('/');
      if (e.isDirectory()) {
        if (rel === 'media' || rel === 'assets') continue;
        await walk(full);
      } else out.push(rel);
    }
  };
  await walk(outDir);
  return out.sort();
}

export class UnsafeOutDirError extends Error {
  override name = 'UnsafeOutDirError';
}

/** Throws when one of `protectedDirs` is OUT_DIR itself or lies inside it. */
export function assertSafeOutDir(outDir: string, protectedDirs: Readonly<Record<string, string | undefined>>): void {
  const out = resolve(outDir);
  for (const [name, dir] of Object.entries(protectedDirs)) {
    if (!dir) continue;
    const p = resolve(dir);
    if (p === out || p.startsWith(out.endsWith(sep) ? out : out + sep)) {
      throw new UnsafeOutDirError(
        `Refusing to generate into OUT_DIR=${out}: it ${p === out ? 'is' : 'contains'} ${name} (${p}). ` +
          'Full runs delete files in OUT_DIR that the generator did not write; use a dedicated directory.',
      );
    }
  }
}

const ROOT_FILES = new Set([
  'index.html',
  '404.html',
  'robots.txt',
  'sitemap.xml',
  '.htaccess',
  'favicon.svg',
  'favicon.ico',
  'apple-touch-icon.png',
]);
const TEMP_SUFFIX = /\.tmp-\d+-\d+$/;

/**
 * True for OUT_DIR paths in the generator's namespaces (stray files there are removed by full
 * runs): locale trees ("de/…"), data/, the root files it writes, and temp files of those.
 */
export function isGeneratorPath(rel: string): boolean {
  const first = rel.split('/')[0] ?? '';
  if (rel.includes('/')) return first === 'data' || (LOCALE_CODES as readonly string[]).includes(first);
  return ROOT_FILES.has(rel.replace(TEMP_SUFFIX, ''));
}
