/**
 * The session-file store over the Mac's own connection (spec-wave5 §2.2, §3.8.1, §5.6.6): the
 * fallback writer and the lock button use it on the target that has accessStoreRoot (SFTP, via the
 * existing connectSftp()) or accessStoreDir (a local folder). Same semantics as the API's
 * StoreWriter:
 *
 *   put(rel, content, exclusive)   creates the file; with `exclusive` an existing file is left as is
 *   replace(rel, content)          temp + rename (the marker only)
 *   delete(rel)                    missing = ok
 *   deletePrefix(relDir, prefix)   every entry of relDir whose name starts with prefix
 *   deleteTree(relDir)             missing = ok
 *   list(relDir)                   entry names, [] when missing
 *   read(rel)                      small files only (marker, tombstones, locked)
 *   listing()                      the StoreListing the API reconciles
 *
 * Every path is checked against the store layout (@omw/contracts/access storePathKind) before any
 * remote call; directories are created on demand (mode 0711), files get 0600 when the connection
 * can chmod (ACCESS_STORE_DIR_MODE / ACCESS_STORE_FILE_MODE, P0b-4 → 0755/0644). Every operation
 * has a 5 s deadline, so an op can never outlive the writer's lease. Nothing in the store is a
 * secret except the session files' names; they are never logged.
 */
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import {
  STORE_PATH_PATTERNS,
  STORE_PATHS,
  type StoreListing,
  type StorePathKind,
  storePathKind,
} from '@omw/contracts/access';
import type { Logger } from '../log.js';
import { LocalRemote } from '../publisher/local.js';
import { writeAtomic } from '../publisher/record.js';
import { RemoteError, type RemoteFs, withTimeout } from '../publisher/remote.js';
import { connectSftp } from '../publisher/sftp.js';
import { resolveKeyPath } from '../publisher/targets.js';
import type { StoredTarget } from '../publisher/types.js';

export const STORE_OP_TIMEOUT_MS = 5_000;
export const DEFAULT_STORE_DIR_MODE = 0o711;
export const DEFAULT_STORE_FILE_MODE = 0o600;

/** Listing caps of the StoreListing contract. */
const MAX_ENTRIES = 10_000;
const MAX_STRAYS = 1_000;

export class StoreRemoteError extends Error {
  override name = 'StoreRemoteError';
}

export interface StoreRemoteOptions {
  dirMode?: number;
  fileMode?: number;
  timeoutMs?: number;
}

const SESSION_NAME = /^[a-z2-7]{8}\.[A-Za-z0-9_-]{43}$/;
const FID = /^[a-z2-7]{12}$/;
const DID = /^[a-z2-7]{8}$/;
const TOMBSTONE = /^[a-z2-7]{12}(?:\.[a-z2-7]{8})?$/;

/** Store-relative directories the writer may create or list. */
function isStoreDir(rel: string): boolean {
  return rel === 's' || rel === 'h' || rel === 't' || STORE_PATH_PATTERNS.sessionDir.test(rel);
}

export class StoreRemote {
  private readonly remote: RemoteFs;
  private readonly root: string;
  private readonly dirMode: number;
  private readonly fileMode: number;
  private readonly timeoutMs: number;
  private readonly made = new Set<string>();

  constructor(remote: RemoteFs, root: string, opts: StoreRemoteOptions = {}) {
    if (!root.startsWith('/') || root.split('/').includes('..'))
      throw new StoreRemoteError(`invalid store root ${root}`);
    this.remote = remote;
    this.root = root.length > 1 ? root.replace(/\/+$/, '') : '/';
    this.dirMode = opts.dirMode ?? DEFAULT_STORE_DIR_MODE;
    this.fileMode = opts.fileMode ?? DEFAULT_STORE_FILE_MODE;
    this.timeoutMs = opts.timeoutMs ?? STORE_OP_TIMEOUT_MS;
  }

  get description(): string {
    return this.remote.description;
  }

  private abs(rel: string): string {
    return this.root === '/' ? `/${rel}` : `${this.root}/${rel}`;
  }

  private kind(rel: string, allowed: readonly StorePathKind[]): StorePathKind {
    const kind = storePathKind(rel);
    if (kind === null || !allowed.includes(kind)) throw new StoreRemoteError(`not a store path: ${redact(rel)}`);
    return kind;
  }

  private op<T>(what: string, fn: () => Promise<T>): Promise<T> {
    return withTimeout(this.timeoutMs, what, fn);
  }

  private async ensureDir(relDir: string): Promise<void> {
    if (relDir === '' || relDir === '.' || this.made.has(relDir)) return;
    const parent = posix.dirname(relDir);
    if (parent !== '.') await this.ensureDir(parent);
    const abs = this.abs(relDir);
    const st = await this.op(`stat ${relDir}`, () => this.remote.stat(abs));
    if (st?.type !== 'dir') {
      if (st) throw new StoreRemoteError(`${relDir} is not a directory`);
      await this.op(`mkdir ${relDir}`, () => this.remote.mkdir(abs));
      await this.chmod(abs, this.dirMode);
    }
    this.made.add(relDir);
  }

  private async chmod(abs: string, mode: number): Promise<void> {
    const chmod = this.remote.chmod?.bind(this.remote);
    if (!chmod) return;
    await this.op('chmod', () => chmod(abs, mode)).catch(() => undefined);
  }

  /** The store root exists (the lock button and the marker check need an existing store). */
  async rootExists(): Promise<boolean> {
    const st = await this.op('stat store root', () => this.remote.stat(this.root));
    return st?.type === 'dir';
  }

  async read(rel: string): Promise<string | null> {
    this.kind(rel, ['marker', 'locked', 'personTombstone', 'deviceTombstone', 'htaccess']);
    const buf = await this.op(`read ${rel}`, () => this.remote.readFile(this.abs(rel)));
    if (buf === null) return null;
    if (buf.length > 1000) throw new StoreRemoteError(`${rel} is too large`);
    return buf.toString('utf8');
  }

  async exists(rel: string): Promise<boolean> {
    const st = await this.op('stat', () => this.remote.stat(this.abs(rel)));
    return st !== null;
  }

  /** Creates the file; with `exclusive` an existing file is left untouched (existence files). */
  async put(rel: string, content: string, exclusive: boolean): Promise<boolean> {
    this.kind(rel, ['marker', 'locked', 'session', 'handoff', 'personTombstone', 'deviceTombstone', 'htaccess']);
    await this.ensureDir(posix.dirname(rel));
    const abs = this.abs(rel);
    if (exclusive && (await this.op('stat', () => this.remote.stat(abs))) !== null) return false;
    await this.op(`put ${redact(rel)}`, () => this.remote.writeFile(abs, Buffer.from(content, 'utf8')));
    await this.chmod(abs, this.fileMode);
    return true;
  }

  /**
   * Temp + rename: the marker, the store's `.htaccess` and the one-way upgrade of a person
   * tombstone from "revoked" to "deleted" (the fallback writer checks that before calling this).
   */
  async replace(rel: string, content: string): Promise<void> {
    this.kind(rel, ['marker', 'htaccess', 'personTombstone']);
    const abs = this.abs(rel);
    await this.op(`replace ${rel}`, () => writeAtomic(this.remote, abs, Buffer.from(content, 'utf8')));
    await this.chmod(abs, this.fileMode);
  }

  async delete(rel: string): Promise<void> {
    this.kind(rel, ['locked', 'session', 'handoff', 'stray']);
    await this.op(`delete ${redact(rel)}`, () => this.remote.remove(this.abs(rel)));
  }

  /** Deletes every entry of relDir ("s/<fid>") whose name starts with namePrefix ("<did>."). */
  async deletePrefix(relDir: string, namePrefix: string): Promise<number> {
    this.kind(`${relDir}/${namePrefix}`, ['sessionPrefix']);
    let n = 0;
    for (const name of await this.list(relDir)) {
      if (!name.startsWith(namePrefix)) continue;
      await this.op('delete session', () => this.remote.remove(this.abs(`${relDir}/${name}`)));
      n++;
    }
    return n;
  }

  /** Deletes relDir ("s/<fid>" or a stray directory below s/ or h/) and everything in it. */
  async deleteTree(relDir: string): Promise<void> {
    this.kind(relDir, ['sessionDir', 'stray']);
    await this.removeTree(relDir);
  }

  private async removeTree(rel: string): Promise<void> {
    const abs = this.abs(rel);
    const st = await this.op('stat', () => this.remote.stat(abs));
    if (!st) return;
    if (st.type !== 'dir') {
      await this.op('delete', () => this.remote.remove(abs));
      return;
    }
    const entries = await this.op('list', () => this.remote.list(abs));
    for (const e of entries) {
      if (e.name === '.' || e.name === '..' || e.name.includes('/')) continue;
      await this.removeTree(`${rel}/${e.name}`);
    }
    await this.op('rmdir', () => this.remote.rmdir(abs));
    this.made.delete(rel);
  }

  /** Entry names of a store directory ([] when it is missing). */
  async list(relDir: string): Promise<string[]> {
    if (!isStoreDir(relDir) && !STORE_PATH_PATTERNS.stray.test(relDir)) {
      throw new StoreRemoteError(`not a store directory: ${relDir}`);
    }
    const abs = this.abs(relDir);
    try {
      const entries = await this.op(`list ${relDir}`, () => this.remote.list(abs));
      return entries.map((e) => e.name).filter((n) => n !== '.' && n !== '..');
    } catch (err) {
      if (err instanceof RemoteError && err.kind === 'not_found') return [];
      throw err;
    }
  }

  private async entries(relDir: string): Promise<{ name: string; type: string }[]> {
    try {
      const list = await this.op(`list ${relDir}`, () => this.remote.list(this.abs(relDir)));
      return list.filter((e) => e.name !== '.' && e.name !== '..');
    } catch (err) {
      if (err instanceof RemoteError && err.kind === 'not_found') return [];
      throw err;
    }
  }

  /**
   * The store as the API's reconciler wants it (contract StoreListing): marker and lock content,
   * every s/<fid>/<did>.<sid> path, h/ names, t/ names with contents, and strays below s/ and h/.
   */
  async listing(): Promise<StoreListing> {
    const sessions: string[] = [];
    const handoffs: string[] = [];
    const tombstones: { path: string; content: string }[] = [];
    const strays: string[] = [];
    const stray = (rel: string) => {
      if (strays.length < MAX_STRAYS && rel.length <= 200 && STORE_PATH_PATTERNS.stray.test(rel)) strays.push(rel);
    };
    for (const e of await this.entries('s')) {
      if (e.type !== 'dir' || !FID.test(e.name)) {
        stray(`s/${e.name}`);
        continue;
      }
      for (const f of await this.entries(`s/${e.name}`)) {
        if (f.type === 'file' && SESSION_NAME.test(f.name) && sessions.length < MAX_ENTRIES) {
          sessions.push(`s/${e.name}/${f.name}`);
        } else if (!SESSION_NAME.test(f.name) || f.type !== 'file') stray(`s/${e.name}/${f.name}`);
      }
    }
    for (const e of await this.entries('h')) {
      if (e.type === 'file' && DID.test(e.name) && handoffs.length < MAX_ENTRIES) handoffs.push(e.name);
      else stray(`h/${e.name}`);
    }
    for (const e of await this.entries('t')) {
      if (e.type !== 'file' || !TOMBSTONE.test(e.name) || tombstones.length >= MAX_ENTRIES) continue;
      const path = `t/${e.name}`;
      const content = (await this.read(path)) ?? '';
      tombstones.push({ path, content });
    }
    const marker = await this.read(STORE_PATHS.marker);
    const locked = await this.read(STORE_PATHS.locked);
    return { marker, locked, sessions: sessions.sort(), handoffs: handoffs.sort(), tombstones, strays };
  }

  async close(): Promise<void> {
    await this.remote.close().catch(() => undefined);
  }
}

/** A session path without its secret part, for messages ("s/<fid>/<did>.…"). */
export function redact(rel: string): string {
  return rel.replace(/^(s\/[a-z2-7]{12}\/[a-z2-7]{8}\.)[A-Za-z0-9_-]+$/, '$1…');
}

// ---------------------------------------------------------------------------------------------
// Opening the store of a target

export interface OpenStoreOptions {
  /** Base for relative privateKeyPath values (CONFIG_DIR). */
  configDir: string;
  log?: Logger;
  dirMode?: number;
  fileMode?: number;
}

/**
 * The store of a target: SFTP (accessStoreRoot, pinned host keys required: the store connection
 * never trusts a key on first use) or a local folder (accessStoreDir, never created here).
 */
export async function openStoreRemote(target: StoredTarget, opts: OpenStoreOptions): Promise<StoreRemote> {
  const modes = {
    ...(opts.dirMode !== undefined ? { dirMode: opts.dirMode } : {}),
    ...(opts.fileMode !== undefined ? { fileMode: opts.fileMode } : {}),
  };
  if (target.kind === 'local') {
    if (!target.accessStoreDir) throw new StoreRemoteError(`target ${target.id} has no accessStoreDir`);
    return new StoreRemote(new LocalRemote(target.accessStoreDir), '/', modes);
  }
  if (!target.accessStoreRoot) throw new StoreRemoteError(`target ${target.id} has no accessStoreRoot`);
  if (target.hostKeys.length === 0) {
    throw new StoreRemoteError(`target ${target.id}: pin the host key first (test the target once)`);
  }
  const privateKey =
    target.privateKey ??
    (target.privateKeyPath ? await readFile(resolveKeyPath(target.privateKeyPath, opts.configDir), 'utf8') : undefined);
  const remote = await connectSftp({
    host: target.host,
    port: target.port,
    username: target.username,
    ...(privateKey ? { privateKey } : { password: target.password }),
    ...(target.passphrase ? { passphrase: target.passphrase } : {}),
    hostKeys: target.hostKeys,
    trustOnFirstUse: false,
    readyTimeoutMs: 20_000,
    opTimeoutMs: STORE_OP_TIMEOUT_MS,
    ...(opts.log ? { log: opts.log } : {}),
  });
  return new StoreRemote(remote, target.accessStoreRoot, modes);
}
