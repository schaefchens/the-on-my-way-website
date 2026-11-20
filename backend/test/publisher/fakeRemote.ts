/**
 * In-memory remote filesystem with SFTP-like semantics and crash injection.
 *
 * - atomicReplace=true models posix-rename (rename overwrites in one step); false models an SFTP
 *   v3 server: replace() becomes "delete target" + "rename" (two separate mutations).
 * - crashAt(k, applied): mutation number k (1-based, counted from the call) fails; with
 *   applied=true it takes effect first and only the reply is lost. From then on every operation
 *   (reads included) fails, like a killed process / dropped connection, until clearCrash().
 */
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { type RemoteEntry, RemoteError, type RemoteFs, type RemoteStat } from '../../src/publisher/remote.js';

export class FakeServer {
  readonly files = new Map<string, Buffer>();
  readonly dirs = new Set<string>(['/']);
  readonly log: string[] = [];
  mutations = 0;
  connections = 0;
  atomicReplace: boolean;
  private crash: { at: number; applied: boolean } | null = null;
  crashed = false;
  /** Fails the next matching operation once with the given error. */
  failNext: { op: string; path?: string; error: RemoteError } | null = null;

  constructor(opts: { atomicReplace?: boolean } = {}) {
    this.atomicReplace = opts.atomicReplace ?? true;
  }

  connect(): FakeRemote {
    if (this.crashed) throw new RemoteError('connection', 'server unreachable (crashed)');
    this.connections++;
    return new FakeRemote(this);
  }

  crashAt(mutation: number, applied: boolean): void {
    this.crash = { at: this.mutations + mutation, applied };
  }

  clearCrash(): void {
    this.crash = null;
    this.crashed = false;
  }

  /** Site files below `root` (relative paths), excluding publisher bookkeeping when asked. */
  siteFiles(root = '/', opts: { includeBookkeeping?: boolean } = {}): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    const prefix = root === '/' ? '/' : `${root}/`;
    for (const [p, b] of this.files) {
      if (!p.startsWith(prefix)) continue;
      const rel = p.slice(prefix.length);
      if (!opts.includeBookkeeping && rel.split('/').some((s) => s.startsWith('.omw-'))) continue;
      out.set(rel, b);
    }
    return out;
  }

  /** @internal */
  guard(op: string, path: string, mutating: boolean): { applyThenCrash: boolean } {
    if (this.crashed) throw new RemoteError('connection', `${op} ${path}: connection lost`);
    const f = this.failNext;
    if (f && f.op === op && (f.path === undefined || f.path === path)) {
      this.failNext = null;
      throw f.error;
    }
    if (!mutating) return { applyThenCrash: false };
    this.mutations++;
    this.log.push(`${op} ${path}`);
    if (this.crash && this.mutations >= this.crash.at) {
      this.crashed = true;
      if (!this.crash.applied) throw new RemoteError('connection', `${op} ${path}: killed`);
      return { applyThenCrash: true };
    }
    return { applyThenCrash: false };
  }
}

class FakeRemote implements RemoteFs {
  readonly description = 'fake://';
  private readonly s: FakeServer;

  constructor(server: FakeServer) {
    this.s = server;
  }

  get atomicReplace(): boolean {
    return this.s.atomicReplace;
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    await tick();
    const p = norm(path);
    this.requireParent(p);
    if (this.s.dirs.has(p)) throw new RemoteError('failure', `${p} is a directory`);
    const g = this.s.guard('write', p, true);
    this.s.files.set(p, Buffer.from(data));
    after(g, p);
  }

  async uploadFile(localPath: string, path: string): Promise<void> {
    const data = await readFile(localPath);
    await this.writeFile(path, data);
  }

  async readFile(path: string): Promise<Buffer | null> {
    await tick();
    const p = norm(path);
    this.s.guard('read', p, false);
    const b = this.s.files.get(p);
    return b ? Buffer.from(b) : null;
  }

  async replace(from: string, to: string): Promise<void> {
    await tick();
    const a = norm(from);
    const b = norm(to);
    if (!this.s.files.has(a)) {
      this.s.guard('rename', b, false);
      throw new RemoteError('not_found', `rename: ${a} missing`);
    }
    this.requireParent(b);
    if (!this.s.atomicReplace && this.s.files.has(b)) {
      const g1 = this.s.guard('delete', b, true);
      this.s.files.delete(b);
      after(g1, b);
      await tick();
    }
    const g = this.s.guard('rename', b, true);
    const data = this.s.files.get(a) as Buffer;
    this.s.files.delete(a);
    this.s.files.set(b, data);
    after(g, b);
  }

  async remove(path: string): Promise<boolean> {
    await tick();
    const p = norm(path);
    const g = this.s.guard('delete', p, true);
    const existed = this.s.files.delete(p);
    after(g, p);
    return existed;
  }

  async mkdir(path: string): Promise<void> {
    await tick();
    const p = norm(path);
    if (this.s.dirs.has(p)) {
      this.s.guard('stat', p, false);
      return;
    }
    if (this.s.files.has(p)) throw new RemoteError('failure', `mkdir ${p}: file exists`);
    this.requireParent(p);
    const g = this.s.guard('mkdir', p, true);
    this.s.dirs.add(p);
    after(g, p);
  }

  async rmdir(path: string): Promise<boolean> {
    await tick();
    const p = norm(path);
    if (!this.s.dirs.has(p)) {
      this.s.guard('rmdir', p, false);
      return false;
    }
    const prefix = `${p}/`;
    const busy = [...this.s.files.keys(), ...this.s.dirs].some((x) => x.startsWith(prefix));
    if (busy) {
      this.s.guard('rmdir', p, false);
      return false;
    }
    const g = this.s.guard('rmdir', p, true);
    this.s.dirs.delete(p);
    after(g, p);
    return true;
  }

  async stat(path: string): Promise<RemoteStat | null> {
    await tick();
    const p = norm(path);
    this.s.guard('stat', p, false);
    if (this.s.dirs.has(p)) return { type: 'dir', size: 0 };
    const f = this.s.files.get(p);
    return f ? { type: 'file', size: f.length } : null;
  }

  async list(path: string): Promise<RemoteEntry[]> {
    await tick();
    const p = norm(path);
    this.s.guard('list', p, false);
    if (!this.s.dirs.has(p)) throw new RemoteError('not_found', `list ${p}`);
    const prefix = p === '/' ? '/' : `${p}/`;
    const out: RemoteEntry[] = [];
    for (const d of this.s.dirs) {
      if (d !== p && d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) {
        out.push({ name: d.slice(prefix.length), type: 'dir', size: 0 });
      }
    }
    for (const [f, b] of this.s.files) {
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) {
        out.push({ name: f.slice(prefix.length), type: 'file', size: b.length });
      }
    }
    return out;
  }

  async close(): Promise<void> {}

  private requireParent(p: string): void {
    if (!this.s.dirs.has(posix.dirname(p))) {
      this.s.guard('parent', p, false);
      throw new RemoteError('not_found', `${posix.dirname(p)} does not exist`);
    }
  }
}

function norm(p: string): string {
  return posix.normalize(p.startsWith('/') ? p : `/${p}`);
}

function after(g: { applyThenCrash: boolean }, p: string): void {
  if (g.applyThenCrash) throw new RemoteError('connection', `${p}: killed after applying`);
}

/** Lets concurrent operations interleave like real network I/O. */
function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}
