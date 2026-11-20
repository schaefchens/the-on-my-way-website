/**
 * SQLite connection (better-sqlite3): WAL for file databases, busy_timeout, foreign keys.
 */
import { chmodSync, closeSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

/** store.db and its -wal/-shm are owner-only (L1-09); SQLite gives -wal/-shm the db file's mode. */
const DB_FILE_MODE = 0o600;
const DB_DIR_MODE = 0o700;

/** Creates the database file 0600 before SQLite does (its default is 0644) and tightens old ones. */
function preparePrivateFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: DB_DIR_MODE });
  closeSync(openSync(path, 'a', DB_FILE_MODE));
  for (const p of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      if ((statSync(p).mode & 0o077) !== 0) chmodSync(p, DB_FILE_MODE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

export type Db = Database.Database;

export const MEMORY = ':memory:';

export interface OpenOptions {
  readonly?: boolean;
  /** ms to wait for locks (default 5000). */
  busyTimeoutMs?: number;
}

export function openDatabase(path: string, options: OpenOptions = {}): Db {
  const memory = path === MEMORY;
  if (!memory && !options.readonly) preparePrivateFile(path);
  const db = new Database(path, { readonly: options.readonly ?? false, fileMustExist: options.readonly ?? false });
  db.pragma(`busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 5000))}`);
  db.pragma('foreign_keys = ON');
  if (!memory && !options.readonly) {
    db.pragma('journal_mode = WAL');
    // NORMAL is durable across application crashes in WAL mode (only an OS crash may lose the
    // last transactions); the inbox files remain the durable source for captures.
    db.pragma('synchronous = NORMAL');
  }
  return db;
}
