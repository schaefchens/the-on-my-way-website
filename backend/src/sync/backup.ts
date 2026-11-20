/**
 * API backup pull (plan B "Cron: nightly VACUUM INTO var/backups/…, which the backend pulls home";
 * W2-4): the API's newest SQLite snapshot (owner content, settings, tokens) is copied to
 * DATA_DIR/api-backups/ once a day, so the home machine holds everything needed to rebuild the API.
 *
 *   GET /api/v1/backend/backup/latest   If-None-Match: <ETag of the last file>
 *     304  nothing new          404  no backup yet (the API's cron makes one per night)
 *     200  application/vnd.sqlite3, ETag = "\"<sha256 hex of the file>\"" (BackendController)
 *
 * A 200 body is streamed to "<UTC date>-<etag first 8>.sqlite.tmp" (0600, directory 0700), checked
 * (starts with "SQLite format 3\0", sha256 equals the ETag), fsynced and renamed into place; the
 * newest API_BACKUP_KEEP files are kept. Pulls run at start when the last successful check is older
 * than a day, then daily; failures back off (15 min doubling, at most 6 h), are logged and stored
 * as events (backup.failed), and are never fatal. Nothing is requested while the sync is paused
 * after the API rejected the backend token.
 *
 * Restore use: docs/OPERATIONS.md ("API database backups").
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { fsyncDir, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from '../pipeline/files.js';
import type { Store } from '../store/index.js';
import type { SyncStatus } from './index.js';

export const BACKUP_DIR_NAME = 'api-backups';
export const BACKUP_STATE_KEY = 'api_backup';
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const FILE_RE = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.sqlite$/;
const TMP_RE = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.sqlite\.tmp$/;

export type BackupOutcome =
  | { status: 'saved'; file: string; bytes: number; sha256: string }
  | { status: 'not_modified' }
  | { status: 'none' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

export interface BackupState {
  /** ETag of the newest saved file (as the API sent it, with quotes). */
  etag?: string;
  file?: string;
  /** Last answer that was not a failure (200, 304, 404). */
  checkedAt?: string;
  lastError?: string;
  failures?: number;
  nextAttemptAt?: string;
}

export interface BackupOptions {
  /** Pull interval (default 24 h). */
  intervalMs?: number;
  /** How often the timer looks whether a pull is due (default 10 min). */
  checkMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Request timeout incl. the download (default 30 min). */
  timeoutMs?: number;
}

export interface BackupDeps {
  config: Config;
  log: Logger;
  store: Store;
  /** For the auth pause (status().authPausedUntil). */
  sync?: { status(): Pick<SyncStatus, 'authPausedUntil'> };
  now?: () => Date;
  fetch?: typeof fetch;
  options?: BackupOptions;
}

export interface BackupPort {
  start(): void;
  stop(): Promise<void>;
  /** Pulls now (ignores the schedule, not the auth pause). */
  pullNow(): Promise<BackupOutcome>;
  state(): BackupState;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

export function createBackupPuller(deps: BackupDeps): BackupPort {
  return new BackupPuller(deps);
}

/** "\"abc…\"" / "W/\"abc…\"" -> "abc…" (lowercase), null when it is not a sha256 ETag. */
export function sha256FromEtag(etag: string | null): string | null {
  const m = /^(?:W\/)?"?([0-9a-fA-F]{64})"?$/.exec((etag ?? '').trim());
  return m?.[1] ? m[1].toLowerCase() : null;
}

class BackupPuller implements BackupPort {
  private readonly deps: BackupDeps;
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly opts: Required<BackupOptions>;
  private readonly dir: string;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<BackupOutcome> | null = null;
  private readonly abort = new AbortController();
  private stopped = false;

  constructor(deps: BackupDeps) {
    this.deps = deps;
    this.log = deps.log.child({ module: 'backup' });
    this.now = deps.now ?? (() => new Date());
    this.opts = {
      intervalMs: 24 * 60 * 60_000,
      checkMs: 10 * 60_000,
      retryBaseMs: 15 * 60_000,
      retryMaxMs: 6 * 60 * 60_000,
      timeoutMs: 30 * 60_000,
      ...deps.options,
    };
    this.dir = join(deps.config.dirs.data, BACKUP_DIR_NAME);
  }

  state(): BackupState {
    try {
      return this.deps.store.syncState.getJson<BackupState>(BACKUP_STATE_KEY) ?? {};
    } catch {
      return {};
    }
  }

  private save(state: BackupState): void {
    if (this.deps.store.db.open) this.deps.store.syncState.setJson(BACKUP_STATE_KEY, state);
  }

  start(): void {
    if (!this.deps.config.api || this.timer || this.stopped) return;
    const tick = () => {
      if (this.due()) void this.pullNow();
    };
    this.timer = setInterval(tick, this.opts.checkMs);
    this.timer.unref();
    tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.abort.abort();
    await this.running?.catch(() => {});
  }

  /** A pull is due: never checked, the last check is older than the interval, or a retry is due. */
  private due(): boolean {
    const s = this.state();
    const now = this.now().getTime();
    if (s.nextAttemptAt) return Date.parse(s.nextAttemptAt) <= now;
    return !s.checkedAt || now - Date.parse(s.checkedAt) >= this.opts.intervalMs;
  }

  pullNow(): Promise<BackupOutcome> {
    this.running ??= this.pull().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pull(): Promise<BackupOutcome> {
    const api = this.deps.config.api;
    if (!api || this.stopped) return { status: 'skipped', reason: 'no API configured' };
    if (this.deps.sync?.status().authPausedUntil) {
      return { status: 'skipped', reason: 'API sync paused after an authentication failure' };
    }
    const state = this.state();
    let tmp: string | null = null;
    try {
      const res = await (this.deps.fetch ?? fetch)(`${api.baseUrl}/api/v1/backend/backup/latest`, {
        headers: {
          authorization: `Bearer ${api.token}`,
          accept: 'application/vnd.sqlite3',
          'user-agent': `omw-backend/${this.deps.config.version ?? 'dev'}`,
          ...(state.etag ? { 'if-none-match': state.etag } : {}),
        },
        signal: AbortSignal.any([AbortSignal.timeout(this.opts.timeoutMs), this.abort.signal]),
      });
      if (res.status === 304) {
        await res.body?.cancel();
        return this.checked(state, { status: 'not_modified' });
      }
      if (res.status === 404) {
        await res.body?.cancel();
        return this.checked(state, { status: 'none' });
      }
      if (res.status !== 200 || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
      }
      const etag = res.headers.get('etag');
      const expected = sha256FromEtag(etag);
      if (!expected || !etag) throw new Error(`unexpected ETag ${JSON.stringify(etag)} (expected the sha256)`);
      const day = this.now().toISOString().slice(0, 10);
      const name = `${day}-${expected.slice(0, 8)}.sqlite`;
      await fsp.mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
      tmp = join(this.dir, `${name}.tmp`);
      const { bytes, sha256, head } = await this.download(res.body, tmp);
      if (!head.equals(SQLITE_MAGIC)) throw new Error('the download is not an SQLite database');
      if (sha256 !== expected) throw new Error(`sha256 mismatch: ETag ${expected}, file ${sha256}`);
      await fsp.rename(tmp, join(this.dir, name));
      tmp = null;
      await fsyncDir(this.dir);
      const removed = await this.rotate(name);
      this.save({ etag, file: name, checkedAt: this.now().toISOString() });
      this.deps.store.events.append('backup.saved', { file: name, bytes, removed });
      this.log.info({ file: name, bytes, removed }, 'API backup saved');
      return { status: 'saved', file: name, bytes, sha256 };
    } catch (err) {
      if (tmp) await fsp.rm(tmp, { force: true }).catch(() => {});
      if (this.stopped) return { status: 'skipped', reason: 'stopped' };
      const failures = (state.failures ?? 0) + 1;
      const delay = Math.min(this.opts.retryBaseMs * 2 ** (failures - 1), this.opts.retryMaxMs);
      const error = errorMessage(err);
      this.save({
        ...state,
        failures,
        lastError: error,
        nextAttemptAt: new Date(this.now().getTime() + delay).toISOString(),
      });
      this.deps.store.events.append('backup.failed', { error, failures });
      this.log.warn({ err: error, failures, retryInMs: delay }, 'API backup pull failed (retried later)');
      return { status: 'failed', error };
    }
  }

  private checked(state: BackupState, outcome: BackupOutcome): BackupOutcome {
    const { failures: _f, lastError: _e, nextAttemptAt: _n, ...rest } = state;
    this.save({ ...rest, checkedAt: this.now().toISOString() });
    this.log.debug({ outcome: outcome.status }, 'API backup checked');
    return outcome;
  }

  private async download(
    body: ReadableStream<Uint8Array>,
    file: string,
  ): Promise<{ bytes: number; sha256: string; head: Buffer }> {
    const hash = createHash('sha256');
    const fh = await fsp.open(file, 'w', PRIVATE_FILE_MODE);
    let bytes = 0;
    const head: Buffer[] = [];
    let headLen = 0;
    try {
      await fh.chmod(PRIVATE_FILE_MODE);
      for await (const chunk of body) {
        const buf = Buffer.from(chunk);
        hash.update(buf);
        if (headLen < SQLITE_MAGIC.length) {
          head.push(buf.subarray(0, SQLITE_MAGIC.length - headLen));
          headLen += Math.min(buf.length, SQLITE_MAGIC.length - headLen);
        }
        await fh.write(buf);
        bytes += buf.length;
      }
      await fh.sync();
    } finally {
      await fh.close();
    }
    return { bytes, sha256: hash.digest('hex'), head: Buffer.concat(head) };
  }

  /** Keeps the newest API_BACKUP_KEEP backups (file names sort by date) and drops stale temp files. */
  private async rotate(current: string): Promise<number> {
    const keep = Math.max(1, this.deps.config.apiBackupKeep ?? 7);
    const names = await fsp.readdir(this.dir);
    const backups = names.filter((n) => FILE_RE.test(n)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    // The file just written always stays, even if an older one sorts after it (same day).
    const ordered = [current, ...backups.filter((n) => n !== current)];
    let removed = 0;
    for (const name of ordered.slice(keep)) {
      await fsp.rm(join(this.dir, name), { force: true });
      removed++;
    }
    for (const name of names.filter((n) => TMP_RE.test(n) && n !== `${current}.tmp`)) {
      await fsp.rm(join(this.dir, name), { force: true });
    }
    return removed;
  }
}
