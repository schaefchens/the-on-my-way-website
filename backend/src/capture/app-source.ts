/**
 * The "app:" capture source (app-plan §3.1, §3.7; owner decisions Q2 c, Q8 a): pulls the
 * traveler app's committed entries from the API's transit inbox, archives them at home and feeds
 * the same pipeline as WhatsApp captures.
 *
 * Every poll (APP_INBOX_POLL_SECONDS, again within seconds while there is work) asks
 * GET /backend/app/entries and reconciles each item with the archive and the store. Nothing is
 * kept about an item besides the archive record and the capture row, so a crash at any point just
 * repeats the step on the next poll:
 *
 *   uploaded / fetching   download each committed file (Range resume into DATA_DIR/inbox-app/),
 *                         check its sha256, copy it into ARCHIVE_DIR/app/… (fsync), write the
 *                         record (app-archive.ts), insert the capture "app:<ULID>" as archived
 *                         (+ the API mirror), then ack: the API deletes its copy. The ingest's
 *                         worker pool takes it from there (processStep reads the record), with the
 *                         same EXIF/GPS stripping, variants and previews as a WhatsApp status.
 *   archived + original   the untouched original arrived later (on Wi-Fi): archive it the same
 *                         way and ack it (Q2 c: photos and videos).
 *   withdrawnAt           she withdrew it after the archive may have it: revokedAt is set on the
 *                         capture (ingest.on_revoke applies, like a WhatsApp delete), the record
 *                         notes it, then the withdrawal is acked.
 *
 * A file that keeps failing its sha256 (maxShaAttempts downloads) rejects the entry ("Needs you"
 * in the app). 503/429 (the API's single transfer slot is busy, or rate limits) pause the source
 * for Retry-After; 401/403 for 5 min; other failures back off exponentially.
 *
 * The archive-only switch (APP_PUBLISH, default off) is reported with every poll, so the app can
 * say "Archived ✓"; the generator leaves every app: capture out while it is off (generate.ts).
 */
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { type AppEntry, type AppFileRole, appSourceKey } from '@omw/contracts/app';
import { type AppInboxFile, AppInboxItem } from '@omw/contracts/app-inbox';
import { publicIdForSourceKey } from '@omw/contracts/ids';
import { localDateFor } from '@omw/contracts/time';
import type { InboxMedia } from '@omw/contracts/wa';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { mkdirWithMode, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, sha256File } from '../pipeline/files.js';
import type { CaptureRow, NewCapture, Store } from '../store/index.js';
import { type ApiClient, ApiRequestError } from '../sync/client.js';
import { Loop } from '../sync/loop.js';
import {
  type AppArchiveRecord,
  appArchiveDayDir,
  appFileName,
  appRecordRelPath,
  archiveAppFile,
  listAppRecords,
  readAppRecordIfExists,
  writeAppRecord,
} from './app-archive.js';
import { enqueueCaptureMirror, enqueueRevoke } from './sync-outbox.js';
import type { IngestChange } from './types.js';

export interface AppSourceOptions {
  /** Poll interval (default APP_INBOX_POLL_SECONDS). */
  pollMs?: number;
  /** Next poll after a page with work (default 2 s). */
  busyMs?: number;
  /** Downloads of one file that may fail their sha256 before the entry is rejected (default 3). */
  maxShaAttempts?: number;
  /** Backoff after failures: base * 2^n, capped (default 30 s, 15 min). */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Pause after 401/403 (default 5 min). */
  authPauseMs?: number;
  /** Items per page (default 20). */
  pageLimit?: number;
  now?: () => Date;
}

export interface AppSourceDeps extends AppSourceOptions {
  config: Config;
  log: Logger;
  store: Store;
  /** null = no API configured (the source stays idle). */
  client: ApiClient | null;
}

export interface AppSourceStatus {
  enabled: boolean;
  archiveOnly: boolean;
  lastPollAt: string | null;
  lastError: string | null;
  pausedUntil: string | null;
  counters: Record<string, number>;
}

const Envelope = z.object({ items: z.array(z.unknown()), hasMore: z.boolean() });

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/** Thrown to stop a poll early (the source is paused); not an item failure. */
class PauseError extends Error {
  override name = 'PauseError';
}

export class AppSource {
  private readonly config: Config;
  private readonly log: Logger;
  private readonly store: Store;
  private readonly client: ApiClient | null;
  private readonly now: () => Date;
  private readonly opts: Required<Omit<AppSourceOptions, 'now'>>;
  private readonly loop: Loop;
  private readonly listeners = new Set<(c: IngestChange) => void>();
  private readonly shaFailures = new Map<string, number>();
  /** Originals that kept failing their sha256 in this run (left in the inbox; the phone may resend). */
  private readonly skippedOriginals = new Set<string>();
  private readonly invalidSeen = new Set<string>();
  private readonly counters: Record<string, number> = {
    polls: 0,
    entries_archived: 0,
    originals_archived: 0,
    withdrawals: 0,
    rejected: 0,
    downloads: 0,
    download_bytes: 0,
    sha_mismatches: 0,
    invalid_items: 0,
    restored: 0,
    errors: 0,
  };
  private pausedUntilMs = 0;
  private failures = 0;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  private started = false;
  private polling: Promise<number> | null = null;

  constructor(deps: AppSourceDeps) {
    this.config = deps.config;
    this.log = deps.log.child({ component: 'app-source' });
    this.store = deps.store;
    this.client = deps.client;
    this.now = deps.now ?? (() => new Date());
    this.opts = {
      pollMs: deps.pollMs ?? (deps.config.app?.pollSeconds ?? 60) * 1000,
      busyMs: deps.busyMs ?? 2_000,
      maxShaAttempts: deps.maxShaAttempts ?? 3,
      backoffBaseMs: deps.backoffBaseMs ?? 30_000,
      backoffMaxMs: deps.backoffMaxMs ?? 15 * 60_000,
      authPauseMs: deps.authPauseMs ?? 5 * 60_000,
      pageLimit: deps.pageLimit ?? 20,
    };
    this.loop = new Loop(
      'app inbox',
      () => this.opts.pollMs,
      () => this.pollNow(),
      this.log,
    );
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /** Q8 a: app entries stay private until APP_PUBLISH=true. */
  get archiveOnly(): boolean {
    return this.config.app?.publish !== true;
  }

  get inboxDir(): string {
    return join(this.config.dirs.data, 'inbox-app');
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.restoreFromArchive().catch((err: unknown) =>
      this.log.warn({ err: errorMessage(err) }, 'app archive restore failed'),
    );
    if (!this.client) return;
    this.log.info({ archiveOnly: this.archiveOnly, pollMs: this.opts.pollMs }, 'app source started');
    this.loop.start(1_500);
  }

  async stop(): Promise<void> {
    await this.loop.stop();
    await this.polling?.catch(() => {});
    this.started = false;
  }

  onChange(cb: (c: IngestChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  status(): AppSourceStatus {
    return {
      enabled: this.enabled,
      archiveOnly: this.archiveOnly,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      pausedUntil: this.pausedUntilMs > this.now().getTime() ? new Date(this.pausedUntilMs).toISOString() : null,
      counters: { ...this.counters },
    };
  }

  /** One poll: every listed item reconciled; resolves with the number of items handled. */
  pollNow(): Promise<number> {
    if (this.polling) return this.polling;
    this.polling = this.poll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  // ------------------------------------------------------------------------------- polling

  private async poll(): Promise<number> {
    const client = this.client;
    if (!client || this.now().getTime() < this.pausedUntilMs) return 0;
    this.counters.polls = (this.counters.polls ?? 0) + 1;
    let raw: unknown;
    try {
      raw = await client.appInbox(this.archiveOnly, this.opts.pageLimit);
    } catch (err) {
      this.onFailure(err);
      return 0;
    }
    this.lastPollAt = this.now().toISOString();
    const envelope = Envelope.safeParse(raw);
    if (!envelope.success) {
      this.onFailure(new Error(`invalid app inbox page: ${z.prettifyError(envelope.error)}`));
      return 0;
    }
    let handled = 0;
    for (const rawItem of envelope.data.items) {
      const parsed = AppInboxItem.safeParse(rawItem);
      if (!parsed.success) {
        const id = String((rawItem as { entryId?: unknown } | null)?.entryId ?? '?');
        if (!this.invalidSeen.has(id)) {
          this.invalidSeen.add(id);
          this.counters.invalid_items = (this.counters.invalid_items ?? 0) + 1;
          this.log.warn(
            { entryId: id, error: z.prettifyError(parsed.error).slice(0, 500) },
            'app inbox item skipped: not a valid AppInboxItem',
          );
          this.store.events.append('app.invalid_item', { entryId: id });
        }
        continue;
      }
      try {
        if (await this.handleItem(parsed.data)) handled++;
      } catch (err) {
        if (err instanceof PauseError) break;
        if (err instanceof ApiRequestError && err.errorClass !== 'permanent') {
          this.onFailure(err);
          break;
        }
        this.counters.errors = (this.counters.errors ?? 0) + 1;
        this.lastError = `${parsed.data.entryId}: ${errorMessage(err)}`;
        this.log.warn(
          { entryId: parsed.data.entryId, err: errorMessage(err) },
          'app entry not archived yet; retrying on the next poll',
        );
      }
    }
    if (this.now().getTime() >= this.pausedUntilMs) {
      this.failures = 0;
      if (handled > 0 || envelope.data.hasMore) this.loop.kick(this.opts.busyMs);
    }
    return handled;
  }

  private onFailure(err: unknown): void {
    this.counters.errors = (this.counters.errors ?? 0) + 1;
    this.lastError = errorMessage(err);
    const nowMs = this.now().getTime();
    let pauseMs: number;
    if (err instanceof ApiRequestError && err.errorClass === 'auth') pauseMs = this.opts.authPauseMs;
    else if (err instanceof ApiRequestError && err.retryAfterMs !== null) pauseMs = err.retryAfterMs;
    else {
      this.failures++;
      pauseMs = Math.min(this.opts.backoffMaxMs, this.opts.backoffBaseMs * 2 ** Math.min(10, this.failures - 1));
    }
    this.pausedUntilMs = nowMs + pauseMs;
    this.log.warn({ err: this.lastError, pauseMs }, 'app inbox paused');
  }

  /** Throws PauseError (after pausing) for errors that mean "stop this poll". */
  private rethrow(err: unknown): never {
    if (err instanceof ApiRequestError && err.errorClass !== 'permanent') {
      this.onFailure(err);
      throw new PauseError(err.message);
    }
    throw err;
  }

  // ------------------------------------------------------------------------------- one item

  /** @returns true when something was archived, acked or applied */
  private async handleItem(item: AppInboxItem): Promise<boolean> {
    if (item.sourceKey !== appSourceKey(item.entryId))
      throw new Error(`sourceKey ${item.sourceKey} does not match the entry`);
    if (item.withdrawnAt) return this.applyWithdrawal(item, item.withdrawnAt);
    const committed = item.files.filter((f) => f.state === 'committed' && !this.skippedOriginals.has(f.uploadId));
    if (item.state === 'uploaded' || item.state === 'fetching') {
      const record = await this.archiveFiles(item, committed);
      this.ensureCapture(item, record);
      await this.ack(
        item,
        committed.map((f) => f.role),
      );
      this.counters.entries_archived = (this.counters.entries_archived ?? 0) + 1;
      this.log.info(
        { sourceKey: item.sourceKey, kind: item.entry.kind, roles: committed.map((f) => f.role) },
        'app entry archived',
      );
      return true;
    }
    if (item.state === 'archived' && committed.length > 0) {
      await this.archiveFiles(item, committed);
      await this.ack(
        item,
        committed.map((f) => f.role),
      );
      if (committed.some((f) => f.role === 'original')) {
        this.counters.originals_archived = (this.counters.originals_archived ?? 0) + 1;
        this.log.info({ sourceKey: item.sourceKey }, 'app original archived (Q2 c)');
      }
      return true;
    }
    return false;
  }

  private async ack(item: AppInboxItem, roles: AppFileRole[]): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.appAck(item.entryId, { roles });
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 410) {
        // Withdrawn while we fetched: the API relays it on the next page (withdrawnAt).
        this.log.info(
          { sourceKey: item.sourceKey },
          'app entry withdrawn while it was archived; the withdrawal follows',
        );
        return;
      }
      this.rethrow(err);
    }
    await fsp.rm(join(this.inboxDir, item.entryId), { recursive: true, force: true });
  }

  /**
   * Downloads, verifies and archives every committed file that is not in the archive yet and
   * (re)writes the record. Returns the record.
   */
  private async archiveFiles(item: AppInboxItem, files: AppInboxFile[]): Promise<AppArchiveRecord> {
    const archiveDir = this.config.dirs.archive;
    const recordRel = appRecordRelPath(item.occurredAt, item.entryId);
    const existing = await readAppRecordIfExists(archiveDir, recordRel);
    const record: AppArchiveRecord = existing ?? (await this.newRecord(item));
    const dayDir = appArchiveDayDir(item.occurredAt);
    let changed = existing === null;
    for (const file of files) {
      const have = record.files[file.role];
      if (have?.sha256Hex === file.sha256Hex) {
        const st = await fsp.stat(join(archiveDir, dayDir, have.file)).catch(() => null);
        if (st?.isFile() && st.size === have.bytes) continue;
      }
      const part = await this.download(item, file);
      const archived = await archiveAppFile(
        archiveDir,
        part,
        dayDir,
        appFileName(item.entryId, file.role, file.mimetype),
        file.sha256Hex,
      );
      record.files[file.role] = { ...archived, mimetype: file.mimetype };
      changed = true;
    }
    if (changed) {
      record.updatedAt = this.now().toISOString();
      await writeAppRecord(archiveDir, record);
    }
    return record;
  }

  private async newRecord(item: AppInboxItem): Promise<AppArchiveRecord> {
    const now = this.now().toISOString();
    return {
      schema: 1,
      type: 'omw.app-entry',
      sourceKey: item.sourceKey,
      publicId: await publicIdForSourceKey(item.sourceKey),
      entryId: item.entryId,
      occurredAt: item.occurredAt,
      tz: item.entry.tz,
      localDate: localDateFor(item.occurredAt, item.entry.tz),
      receivedAt: item.receivedAt,
      clamped: item.clamped,
      heldBack: item.heldBack,
      phone: item.phone,
      archivedAt: now,
      updatedAt: now,
      files: {},
      withdrawnAt: null,
      entry: item.entry,
    };
  }

  /** Downloads one committed file into DATA_DIR/inbox-app/<entryId>/ (resuming) and checks it. */
  private async download(item: AppInboxItem, file: AppInboxFile): Promise<string> {
    const client = this.client;
    if (!client) throw new Error('no API client');
    const dir = join(this.inboxDir, item.entryId);
    await mkdirWithMode(this.inboxDir, PRIVATE_DIR_MODE);
    await mkdirWithMode(dir, PRIVATE_DIR_MODE);
    const part = join(dir, `${file.uploadId}.part`);
    let size = (await fsp.stat(part).catch(() => null))?.size ?? 0;
    if (size > file.bytes) {
      await fsp.rm(part, { force: true });
      size = 0;
    }
    if (size < file.bytes) {
      const fh = await fsp.open(part, size > 0 ? 'r+' : 'w', PRIVATE_FILE_MODE);
      let position = size;
      try {
        await client.appContent(file.uploadId, size, async (chunk) => {
          await fh.write(chunk, 0, chunk.length, position);
          position += chunk.length;
          this.counters.download_bytes = (this.counters.download_bytes ?? 0) + chunk.length;
        });
        await fh.sync();
      } catch (err) {
        await fh.close().catch(() => {});
        if (err instanceof ApiRequestError && err.status === 416) await fsp.rm(part, { force: true });
        return this.rethrow(err);
      }
      await fh.close();
      this.counters.downloads = (this.counters.downloads ?? 0) + 1;
    }
    const got = await sha256File(part);
    if (got.sha256 === file.sha256Hex && got.bytes === file.bytes) {
      this.shaFailures.delete(file.uploadId);
      return part;
    }
    await fsp.rm(part, { force: true });
    this.counters.sha_mismatches = (this.counters.sha_mismatches ?? 0) + 1;
    const attempts = (this.shaFailures.get(file.uploadId) ?? 0) + 1;
    this.shaFailures.set(file.uploadId, attempts);
    if (attempts >= this.opts.maxShaAttempts) {
      if (file.role === 'original') {
        // The entry itself is archived; only its original is left out of this run.
        this.skippedOriginals.add(file.uploadId);
        this.store.events.append('app.original_failed', { sourceKey: item.sourceKey, attempts });
        this.log.error(
          { sourceKey: item.sourceKey, attempts },
          'app original never matched its sha256; skipped until the next start',
        );
      } else {
        await this.reject(item, `The ${file.role} file never matched its sha256 (${attempts} downloads).`);
      }
    }
    throw new Error(`${file.role} of ${item.entryId}: sha256 mismatch after download (${got.bytes} bytes)`);
  }

  private async reject(item: AppInboxItem, reason: string): Promise<void> {
    if (!this.client) return;
    await this.client.appReject(item.entryId, { reason });
    this.counters.rejected = (this.counters.rejected ?? 0) + 1;
    this.store.events.append('app.rejected', { sourceKey: item.sourceKey, reason });
    this.log.error({ sourceKey: item.sourceKey, reason }, 'app entry rejected');
    await fsp.rm(join(this.inboxDir, item.entryId), { recursive: true, force: true });
  }

  /** Inserts the capture (archived, with its API mirror) unless the store has it. */
  private ensureCapture(item: AppInboxItem, record: AppArchiveRecord): CaptureRow {
    const existing = this.store.captures.get(item.sourceKey);
    if (existing) return existing;
    const recordRel = appRecordRelPath(record.occurredAt, record.entryId);
    return this.insertFromRecord(record, recordRel, 'app.archived');
  }

  private insertFromRecord(record: AppArchiveRecord, recordRel: string, event: string): CaptureRow {
    const input = newCaptureFromApp(record);
    const media = record.files.media ?? null;
    return this.store.transaction(() => {
      const res = this.store.captures.insert(input);
      if (res.inserted) {
        if (record.entry.kind === 'text' || media) {
          if (
            !this.store.captures.markArchived(record.sourceKey, {
              archivePath: recordRel,
              originalSha256: media?.sha256Hex ?? null,
            })
          ) {
            throw new Error(`markArchived refused for ${record.sourceKey}`);
          }
        }
        if (record.withdrawnAt) this.store.captures.setRevoked(record.sourceKey, record.withdrawnAt);
        this.store.events.append(event, { sourceKey: record.sourceKey, kind: record.entry.kind });
      }
      const row = this.store.captures.get(record.sourceKey);
      if (!row) throw new Error(`capture ${record.sourceKey} missing after insert`);
      if (res.inserted && this.config.api) {
        enqueueCaptureMirror(this.store, row);
        enqueueRevoke(this.store, row);
      }
      return row;
    });
  }

  private async applyWithdrawal(item: AppInboxItem, at: string): Promise<boolean> {
    const row = this.store.captures.get(item.sourceKey);
    if (row && !row.revokedAt) {
      const updated = this.store.transaction(() => {
        this.store.captures.setRevoked(item.sourceKey, at);
        const r = this.store.captures.get(item.sourceKey);
        if (!r) throw new Error(`capture ${item.sourceKey} vanished`);
        if (this.config.api) {
          enqueueRevoke(this.store, r);
          enqueueCaptureMirror(this.store, r);
        }
        this.store.events.append('capture.revoked', { sourceKey: item.sourceKey, at, by: 'app' });
        return r;
      });
      this.emit(updated);
      this.log.info({ sourceKey: item.sourceKey, at }, 'app entry withdrawn by the traveler');
    }
    const recordRel = appRecordRelPath(item.occurredAt, item.entryId);
    const record = await readAppRecordIfExists(this.config.dirs.archive, recordRel);
    if (record && record.withdrawnAt === null) {
      await writeAppRecord(this.config.dirs.archive, {
        ...record,
        withdrawnAt: at,
        updatedAt: this.now().toISOString(),
      });
    }
    if (this.client) {
      try {
        await this.client.appAck(item.entryId, { roles: [], withdrawal: true });
      } catch (err) {
        this.rethrow(err);
      }
    }
    await fsp.rm(join(this.inboxDir, item.entryId), { recursive: true, force: true });
    this.counters.withdrawals = (this.counters.withdrawals ?? 0) + 1;
    return true;
  }

  // ------------------------------------------------------------------------------- restore

  /** Inserts captures that exist only as app archive records (store lost or reset). */
  async restoreFromArchive(): Promise<number> {
    let restored = 0;
    for (const rel of await listAppRecords(this.config.dirs.archive)) {
      const record = await readAppRecordIfExists(this.config.dirs.archive, rel).catch((err: unknown) => {
        this.log.warn({ rel, err: errorMessage(err) }, 'invalid app archive record skipped');
        return null;
      });
      if (!record || rel !== appRecordRelPath(record.occurredAt, record.entryId)) continue;
      if (this.store.captures.get(record.sourceKey)) continue;
      if (record.entry.kind !== 'text' && !record.files.media) continue;
      this.insertFromRecord(record, rel, 'app.restored');
      restored++;
    }
    this.counters.restored = (this.counters.restored ?? 0) + restored;
    if (restored > 0) this.log.info({ restored }, 'app captures restored from the archive');
    return restored;
  }

  private emit(row: CaptureRow): void {
    const change: IngestChange = { sourceKeys: [row.sourceKey], localDates: [row.localDate] };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        this.log.error({ err }, 'app source change listener failed');
      }
    }
  }
}

/**
 * The capture of an archived app entry: the same fields as a WhatsApp status (A2). The media facts
 * are those of the published artifact (role media); the original never reaches the pipeline.
 */
export function newCaptureFromApp(record: AppArchiveRecord): NewCapture {
  const entry: AppEntry = record.entry;
  const media = record.files.media;
  let inboxMedia: InboxMedia | null = null;
  if (entry.kind !== 'text' && media) {
    inboxMedia = {
      mimetype: media.mimetype,
      fileSha256B64: Buffer.from(media.sha256Hex, 'hex').toString('base64'),
      fileLength: media.bytes,
      ...(entry.media?.width !== undefined ? { width: entry.media.width } : {}),
      ...(entry.media?.height !== undefined ? { height: entry.media.height } : {}),
      ...(entry.media?.seconds !== undefined ? { seconds: entry.media.seconds } : {}),
      ...(entry.media?.ptt !== undefined ? { ptt: entry.media.ptt } : {}),
    };
  }
  return {
    sourceKey: record.sourceKey,
    publicId: record.publicId,
    msgId: null,
    source: 'app',
    kind: entry.kind,
    occurredAt: record.occurredAt,
    receivedAt: record.receivedAt,
    tz: record.tz,
    localDate: record.localDate,
    caption: entry.caption ?? null,
    text: entry.text
      ? { body: entry.text.body, bgArgb: entry.text.bgArgb, textArgb: entry.text.textArgb, font: entry.text.font }
      : null,
    media: inboxMedia,
    sender: null,
    download: entry.kind === 'text' ? { state: 'not_applicable' } : { state: 'ok' },
  };
}

export function createAppSource(deps: AppSourceDeps): AppSource {
  return new AppSource(deps);
}
