/**
 * The minimal remote filesystem the deploy engine needs. Implemented by the SFTP connector
 * (sftp.ts), the local folder target (local.ts) and the in-memory fake used by the crash tests.
 * Paths are absolute POSIX paths on the remote side.
 */
import { posix } from 'node:path';
import { PublishError } from './types.js';

export type RemoteEntryType = 'file' | 'dir' | 'other';

export interface RemoteStat {
  type: RemoteEntryType;
  size: number;
}

export interface RemoteEntry extends RemoteStat {
  name: string;
}

export interface RemoteFs {
  /** e.g. "sftp://user@host:22" (never contains secrets). */
  readonly description: string;
  /** replace() is a single atomic operation (posix-rename / rename(2)). */
  readonly atomicReplace: boolean;
  /** Creates or truncates `path` with `data`. */
  writeFile(path: string, data: Buffer): Promise<void>;
  /** Streams a local file to `path` (large files). */
  uploadFile(localPath: string, path: string, size: number): Promise<void>;
  /** File content, or null when it does not exist. */
  readFile(path: string): Promise<Buffer | null>;
  /**
   * Moves `from` onto `to`, replacing `to`. Atomic when atomicReplace; otherwise the connector
   * falls back to delete + rename (a short window in which `to` is missing).
   */
  replace(from: string, to: string): Promise<void>;
  /** Deletes a file; false when it did not exist. */
  remove(path: string): Promise<boolean>;
  /** Creates one directory level; succeeds when it already exists as a directory. */
  mkdir(path: string): Promise<void>;
  /** Removes an empty directory; false when it is missing or not empty. */
  rmdir(path: string): Promise<boolean>;
  stat(path: string): Promise<RemoteStat | null>;
  list(path: string): Promise<RemoteEntry[]>;
  close(): Promise<void>;
  /**
   * Sets the mode of a file or directory (the access store's 0600/0711, spec-wave5 §2.2). Optional:
   * connectors without it keep their own modes.
   */
  chmod?(path: string, mode: number): Promise<void>;
}

export type RemoteErrorKind = 'not_found' | 'permission' | 'failure' | 'connection' | 'timeout' | 'unsupported';

/** Error raised by connectors for remote operations. */
export class RemoteError extends PublishError {
  override name = 'RemoteError';
  readonly kind: RemoteErrorKind;

  constructor(kind: RemoteErrorKind, message: string, cause?: unknown) {
    const transient = kind === 'connection' || kind === 'timeout';
    super(kind === 'timeout' ? 'timeout' : kind === 'connection' ? 'connection' : 'remote', message, {
      transient,
      cause,
    });
    this.kind = kind;
  }
}

/** Joins a site-relative path onto the remote root ("/", "/www") -> "/www/data/x.json". */
export function remoteJoin(root: string, rel: string): string {
  return rel === '' ? root : posix.join(root, rel);
}

/** Runs `fn` with a deadline; on expiry calls `onTimeout` (e.g. drop the connection) and throws. */
export async function withTimeout<T>(
  ms: number,
  what: string,
  fn: () => Promise<T>,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new RemoteError('timeout', `${what} timed out after ${Math.round(ms / 1000)} s`));
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([fn(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Bounded parallelism; stops scheduling after the first failure and rethrows it once all settle. */
export async function runPool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (err) {
        if (!failed) {
          failed = true;
          firstError = err;
        }
      }
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  if (failed) throw firstError;
}
