/**
 * Local folder target (development, e2e, a static preview server). Same deploy algorithm as SFTP;
 * the remote root "/" is the target directory. rename(2) replaces atomically.
 */
import { constants, promises as fsp } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { mkdirWithMode } from '../pipeline/files.js';
import { type RemoteEntry, RemoteError, type RemoteFs, type RemoteStat } from './remote.js';

const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

export class LocalRemote implements RemoteFs {
  readonly description: string;
  readonly atomicReplace = true;
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = resolve(rootDir);
    this.description = `file://${this.root}`;
  }

  static async open(rootDir: string): Promise<LocalRemote> {
    await mkdirWithMode(rootDir, DIR_MODE);
    return new LocalRemote(rootDir);
  }

  // Target modes are explicit (files 0644, directories 0755): never the umask, never the mode of
  // the local source file (L1-09).
  async writeFile(path: string, data: Buffer): Promise<void> {
    await wrap(`write ${path}`, async () => {
      await fsp.writeFile(this.abs(path), data, { mode: FILE_MODE });
      await fsp.chmod(this.abs(path), FILE_MODE);
    });
  }

  async uploadFile(localPath: string, path: string): Promise<void> {
    await wrap(`upload ${path}`, async () => {
      await fsp.copyFile(localPath, this.abs(path), constants.COPYFILE_FICLONE);
      await fsp.chmod(this.abs(path), FILE_MODE);
    });
  }

  async readFile(path: string): Promise<Buffer | null> {
    try {
      return await fsp.readFile(this.abs(path));
    } catch (err) {
      if (isCode(err, 'ENOENT')) return null;
      throw mapError(err, `read ${path}`);
    }
  }

  async replace(from: string, to: string): Promise<void> {
    await wrap(`rename ${to}`, () => fsp.rename(this.abs(from), this.abs(to)));
  }

  async remove(path: string): Promise<boolean> {
    try {
      await fsp.unlink(this.abs(path));
      return true;
    } catch (err) {
      if (isCode(err, 'ENOENT')) return false;
      throw mapError(err, `delete ${path}`);
    }
  }

  async mkdir(path: string): Promise<void> {
    try {
      await fsp.mkdir(this.abs(path), { mode: DIR_MODE });
      await fsp.chmod(this.abs(path), DIR_MODE);
    } catch (err) {
      if (isCode(err, 'EEXIST') && (await this.stat(path))?.type === 'dir') return;
      throw mapError(err, `mkdir ${path}`);
    }
  }

  async rmdir(path: string): Promise<boolean> {
    try {
      await fsp.rmdir(this.abs(path));
      return true;
    } catch (err) {
      if (isCode(err, 'ENOENT') || isCode(err, 'ENOTEMPTY') || isCode(err, 'EEXIST')) return false;
      throw mapError(err, `rmdir ${path}`);
    }
  }

  async stat(path: string): Promise<RemoteStat | null> {
    try {
      const st = await fsp.stat(this.abs(path));
      return { type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: st.size };
    } catch (err) {
      if (isCode(err, 'ENOENT') || isCode(err, 'ENOTDIR')) return null;
      throw mapError(err, `stat ${path}`);
    }
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const entries = await wrap(`list ${path}`, () => fsp.readdir(this.abs(path), { withFileTypes: true }));
    const out: RemoteEntry[] = [];
    for (const e of entries) {
      const type = e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other';
      const size = type === 'file' ? (await fsp.stat(join(this.abs(path), e.name))).size : 0;
      out.push({ name: e.name, type, size });
    }
    return out;
  }

  async chmod(path: string, mode: number): Promise<void> {
    await wrap(`chmod ${path}`, () => fsp.chmod(this.abs(path), mode));
  }

  async close(): Promise<void> {}

  /** Maps a remote absolute path ("/data/x.json") into the root; refuses escapes. */
  private abs(remotePath: string): string {
    const p = resolve(this.root, `.${remotePath.startsWith('/') ? remotePath : `/${remotePath}`}`);
    const rel = relative(this.root, p);
    if (rel.startsWith('..') || isAbsolute(rel))
      throw new RemoteError('permission', `Path escapes the target: ${remotePath}`);
    return p;
  }
}

function isCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === code;
}

function mapError(err: unknown, what: string): RemoteError {
  if (err instanceof RemoteError) return err;
  const code = (err as NodeJS.ErrnoException).code;
  const msg = `${what}: ${(err as Error).message}`;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new RemoteError('not_found', msg, err);
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return new RemoteError('permission', msg, err);
  return new RemoteError('failure', msg, err);
}

async function wrap<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw mapError(err, what);
  }
}
