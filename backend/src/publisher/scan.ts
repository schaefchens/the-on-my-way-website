/**
 * Desired manifest: walks OUT_DIR and returns path -> (sha256, size) for every publishable file.
 *
 * Hashes are cached by (inode, size, mtimeMs) in memory and, when a cache file is given, on disk
 * (DATA_DIR/publisher/hash-cache.json), so a restart does not re-hash gigabytes of media. The
 * generator replaces files via rename (new inode) and the media pipeline never rewrites a variant
 * in place, so the key changes whenever the content does. The deploy re-verifies every small file
 * it uploads (hash of the exact bytes sent) and invalidates the entry on mismatch.
 *
 * Skipped: names starting with ".omw-" (publisher-reserved on the target), .DS_Store, Thumbs.db,
 * in-progress/stale temp files of the backend's atomic writers ("<name>.tmp-<pid>[-<hex>…]",
 * generator, pipeline, fsutil), files that vanish while the scan runs, symlinked directories,
 * and paths with characters outside [A-Za-z0-9._~@+-] (reported).
 */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fsp, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { runPool } from './remote.js';
import { writeFileAtomic } from './targets.js';

export interface LocalFile {
  /** Site-relative POSIX path ("data/days/2026-11-18.json"). */
  path: string;
  abs: string;
  size: number;
  sha256: string;
  ino: number;
  mtimeMs: number;
}

export interface ScanResult {
  outDir: string;
  files: Map<string, LocalFile>;
  /** Manifest.version of data/manifest.json; null when missing or invalid. */
  manifestVersion: number | null;
  /** Paths left out because of unsupported names. */
  skipped: string[];
  totalBytes: number;
  hashed: number;
}

export const MANIFEST_REL = 'data/manifest.json';
const SAFE_SEGMENT = /^[A-Za-z0-9._~@+-]+$/;
const JUNK = new Set(['.DS_Store', 'Thumbs.db']);
const SMALL_FILE = 4 * 1024 * 1024;

export function isReservedName(name: string): boolean {
  return name.startsWith('.omw-') || JUNK.has(name);
}

/**
 * Temp names of the backend's atomic writers: "<target>.tmp-<pid>" (fsutil), "<target>.tmp-<pid>-
 * <n>" (generator) and "<target>.tmp-<pid>-<hex>-<hex>" (pipeline). A crash can leave them in
 * OUT_DIR; they are never part of the site.
 */
const WRITER_TEMP = /\.tmp-\d+(?:-[0-9a-f]+)*$/i;

export function isWriterTemp(name: string): boolean {
  return WRITER_TEMP.test(name);
}

export function isSafeRelPath(rel: string): boolean {
  return rel.split('/').every((s) => SAFE_SEGMENT.test(s) && s !== '.' && s !== '..');
}

interface CacheEntry {
  ino: number;
  size: number;
  mtimeMs: number;
  sha256: string;
}

const CacheFile = z.object({
  format: z.literal(1),
  entries: z.record(z.string(), z.tuple([z.number(), z.number(), z.number(), z.string().regex(/^[0-9a-f]{64}$/)])),
});

export class HashCache {
  private readonly map = new Map<string, CacheEntry>();
  private dirty = false;
  private loaded = false;
  readonly file: string | null;

  constructor(file: string | null = null) {
    this.file = file;
  }

  lookup(abs: string, st: { ino: number; size: number; mtimeMs: number }): string | undefined {
    this.load();
    const e = this.map.get(abs);
    return e && e.ino === st.ino && e.size === st.size && e.mtimeMs === st.mtimeMs ? e.sha256 : undefined;
  }

  put(abs: string, st: { ino: number; size: number; mtimeMs: number }, sha256: string): void {
    this.load();
    this.map.set(abs, { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, sha256 });
    this.dirty = true;
  }

  invalidate(abs: string): void {
    this.load();
    if (this.map.delete(abs)) this.dirty = true;
  }

  /** Drops entries below `dir` (absolute, no trailing slash) that are not in `keep`. */
  retain(dir: string, keep: ReadonlySet<string>): void {
    this.load();
    const prefix = `${dir}${sep}`;
    for (const k of this.map.keys()) {
      if (k.startsWith(prefix) && !keep.has(k)) {
        this.map.delete(k);
        this.dirty = true;
      }
    }
  }

  save(): void {
    if (!this.file || !this.dirty) return;
    const entries: Record<string, [number, number, number, string]> = {};
    for (const [k, e] of this.map) entries[k] = [e.ino, e.size, e.mtimeMs, e.sha256];
    try {
      writeFileAtomic(this.file, JSON.stringify({ format: 1, entries }), 0o600);
      this.dirty = false;
    } catch {
      // A cache is optional: hashing again is always correct.
    }
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const parsed = CacheFile.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      if (!parsed.success) return;
      for (const [k, [ino, size, mtimeMs, sha256]] of Object.entries(parsed.data.entries)) {
        this.map.set(k, { ino, size, mtimeMs, sha256 });
      }
    } catch {
      // Missing or unreadable cache: start empty.
    }
  }
}

export async function sha256File(abs: string, size?: number): Promise<string> {
  if (size !== undefined && size <= SMALL_FILE) {
    return createHash('sha256')
      .update(await fsp.readFile(abs))
      .digest('hex');
  }
  const h = createHash('sha256');
  for await (const chunk of createReadStream(abs, { highWaterMark: 1024 * 1024 })) h.update(chunk as Buffer);
  return h.digest('hex');
}

export function sha256Buffer(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export async function scanOutDir(
  outDir: string,
  cache: HashCache,
  opts: { concurrency?: number } = {},
): Promise<ScanResult> {
  const found: { rel: string; abs: string; ino: number; size: number; mtimeMs: number }[] = [];
  const skipped: string[] = [];

  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && prefix === '') return;
      throw err;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (isReservedName(e.name) || (!e.isDirectory() && isWriterTemp(e.name))) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = join(dir, e.name);
      if (!isSafeRelPath(rel)) {
        skipped.push(rel);
        continue;
      }
      if (e.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      const st = await fsp.stat(abs).catch(() => null);
      if (!st?.isFile()) {
        if (st?.isDirectory()) skipped.push(`${rel}/`);
        continue;
      }
      found.push({ rel, abs, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  await walk(resolve(outDir), '');

  const files = new Map<string, LocalFile>();
  let hashed = 0;
  let totalBytes = 0;
  await runPool(found, opts.concurrency ?? 8, async (f) => {
    let sha = cache.lookup(f.abs, f);
    if (!sha) {
      try {
        sha = await sha256File(f.abs, f.size);
      } catch (err) {
        // Removed since it was listed (another writer): it is not part of the snapshot.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      cache.put(f.abs, f, sha);
      hashed++;
    }
    totalBytes += f.size;
    files.set(f.rel, { path: f.rel, abs: f.abs, size: f.size, sha256: sha, ino: f.ino, mtimeMs: f.mtimeMs });
  });
  const sorted = new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  cache.retain(resolve(outDir), new Set([...files.values()].map((f) => f.abs)));
  cache.save();

  return {
    outDir,
    files: sorted,
    manifestVersion: await readManifestVersion(join(outDir, MANIFEST_REL)),
    skipped,
    totalBytes,
    hashed,
  };
}

async function readManifestVersion(abs: string): Promise<number | null> {
  try {
    const json = JSON.parse(await fsp.readFile(abs, 'utf8')) as { version?: unknown };
    return typeof json.version === 'number' && Number.isInteger(json.version) && json.version >= 1
      ? json.version
      : null;
  } catch {
    return null;
  }
}
