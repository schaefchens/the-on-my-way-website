/**
 * Ingest (plan A2): inbox -> store -> archive -> media pipeline -> ready.
 *
 * Sources of work (all idempotent, the inbox files are the durable truth):
 * - a scan of DATA_DIR/inbox on start, periodically (scanIntervalMs) and per helper event
 *   (status/media/revoke). meta.json files are re-read only when their mtime/size changed;
 *   invalid ones are logged and counted once per file version and never stop the scan;
 * - the captures table: every capture in received/archived/processed whose retry is due is run
 *   through the pipeline by `workers` (default 2) concurrent workers.
 *
 * Per capture (store state machine, see store/captures.ts):
 *   new meta.json   -> insert (awaiting_media | received | media_lost), archive record written
 *   download ok     -> awaiting_media -> received (meta re-synced from the inbox)
 *   received        -> copy the original into ARCHIVE_DIR (sha256-verified), record -> archived
 *   archived        -> media pipeline from the ARCHIVED copy -> processed + ready (one transaction,
 *                      together with the sync outbox items), then onChange
 * A crash at any point resumes from the furthest persisted step; outputs are written atomically
 * and deterministically, so re-running a step is harmless.
 *
 * Media that does not arrive (wa.ts rules 2/3): a transient failure gets a `redownload` command
 * when its retry is due (backoff); captures whose download is still pending/retrying/failed
 * MEDIA_GIVE_UP_HOURS after receipt become media_lost, but only once the helper has been running
 * for giveUpGraceMs (its downtime never uses up the window) and after a due redownload was sent.
 * Extension of rule 3: `pending` is given up too (a stuck download must not wait forever), and a
 * media_lost capture whose meta.json later reports a successful download is rescued (retry() +
 * download ok) unless the loss was permanent.
 *
 * Inbox space (L2-06): once the original is archived (sha256 verified against the helper's) or the
 * download failed permanently (media_lost), inbox/<msgId>/original.* and helper temp files are
 * deleted; meta.json stays as the tombstone (the helper never re-delivers or re-downloads a status
 * whose meta.json exists). A capture whose meta.json is present but whose original is gone is
 * therefore normal: it is archived already and is never re-archived or given up. start() sweeps
 * entries of older versions once per run (inbox_freed_bytes).
 *
 * Revokes (inbox/_revokes/<msgId>.json) are applied to the capture, or parked in the store until
 * the status arrives (store.captures.insert applies them). Both paths queue the revoke and the
 * updated mirror for the API and rewrite the archive record.
 *
 * Time zone of a new capture: deps.tzFor(meta) > source.tzHint(msgId) (fixtures) > mirrored
 * setting "timezone.current" > DEFAULT_TIMEZONE.
 */
import { promises as fsp } from 'node:fs';
import { basename } from 'node:path';
import { parseSourceKey, waSourceKey } from '@omw/contracts/ids';
import { effectiveLocalDate } from '@omw/contracts/policy';
import { isValidTimeZone } from '@omw/contracts/time';
import { type InboxMeta, isMediaKind, type WaEvent } from '@omw/contracts/wa';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { StatePaths } from '../paths.js';
import { AbortedError, isAbortError, type ToolPaths, toolPathsFromEnv } from '../pipeline/exec.js';
import { exists } from '../pipeline/files.js';
import type { ImageEncodeOptions } from '../pipeline/image.js';
import { type ProcessOutput, processOriginal } from '../pipeline/index.js';
import { type CaptureRow, newCaptureFromInbox, type Store } from '../store/index.js';
import {
  ArchiveIntegrityError,
  type ArchiveOriginal,
  type ArchiveRecord,
  archivedOriginalPath,
  archiveOriginal,
  archiveRecordRelPath,
  listArchiveRecords,
  readArchiveRecord,
  readArchiveRecordIfExists,
  writeArchiveRecord,
} from './archive.js';
import {
  fileVersion,
  inboxHoldsMedia,
  inboxMetaFile,
  inboxOriginalPath,
  listInboxMessages,
  listRevokes,
  readInboxMeta,
  readRevoke,
  releaseInboxMedia,
  revokeFile,
} from './inbox.js';
import { enqueueCaptureMirror, enqueuePreviews, enqueueRevoke } from './sync-outbox.js';
import type { DrainResult, Ingest, IngestChange, WaSource } from './types.js';

export interface IngestOptions {
  /** Clock (default: the store's clock). */
  now?: () => Date;
  /** Environment for FFMPEG_PATH / FFPROBE_PATH (default process.env). */
  env?: Record<string, string | undefined>;
  tools?: ToolPaths;
  /** Concurrent pipeline workers (default 2). */
  workers?: number;
  /** Full inbox scan + awaiting-media check interval (default 30 s). */
  scanIntervalMs?: number;
  /** How often due retries are picked up (default 5 s). */
  pumpIntervalMs?: number;
  encode?: Partial<ImageEncodeOptions>;
  x264Preset?: string;
  /** Queue capture mirror / previews / revokes in store.outbox (default true). */
  syncOutbox?: boolean;
  /** Overrides the time zone of a new capture (null = default resolution). */
  tzFor?: (meta: InboxMeta) => string | null;
  /** Pipeline retries: delay base * 4^(attempt-1), capped; gives up (failed) after maxAttempts. */
  retry?: Partial<{ baseMs: number; maxMs: number; maxAttempts: number }>;
  /** `redownload` backoff for transient download failures: base * 2^attempts, capped. */
  redownload?: Partial<{ baseMs: number; maxMs: number }>;
  /**
   * How long the source must have been running before captures past MEDIA_GIVE_UP_HOURS are
   * given up (default 15 min): lets a restarted helper resume its downloads first.
   */
  giveUpGraceMs?: number;
}

export interface IngestDeps extends IngestOptions {
  config: Config;
  log: Logger;
  paths: StatePaths;
  store: Store;
  source: WaSource;
}

type JobOutcome = 'ready' | 'retry' | 'failed' | 'skipped' | 'aborted';

interface QueueEntry {
  force: boolean;
  waiters: ((outcome: JobOutcome) => void)[];
}

const ACTIVE = new Set(['received', 'archived', 'processed']);
const REPROCESSABLE = new Set(['archived', 'processed', 'ready']);

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 1000);

export class CaptureIngest implements Ingest {
  private readonly config: Config;
  private readonly log: Logger;
  private readonly paths: StatePaths;
  private readonly store: Store;
  private readonly source: WaSource;
  private readonly now: () => Date;
  private readonly tools: ToolPaths;
  private readonly workers: number;
  private readonly scanIntervalMs: number;
  private readonly pumpIntervalMs: number;
  private readonly syncOutbox: boolean;
  private readonly options: IngestOptions;
  private readonly retryPolicy: { baseMs: number; maxMs: number; maxAttempts: number };
  private readonly redownloadPolicy: { baseMs: number; maxMs: number };
  private readonly giveUpGraceMs: number;
  /** When checkAwaiting() first saw the source running (null while it is not). */
  private helperUpSinceMs: number | null = null;

  private readonly counters: Record<string, number> = {
    scans: 0,
    ingested: 0,
    processed: 0,
    reprocessed: 0,
    restored: 0,
    failed: 0,
    invalid_meta: 0,
    invalid_revoke: 0,
    revokes_applied: 0,
    revokes_parked: 0,
    redownloads: 0,
    media_lost: 0,
    media_rescued: 0,
    archive_errors: 0,
    read_receipts: 0,
    inbox_freed_bytes: 0,
  };
  /** meta.json / revoke file versions already handled (inbox.ts fileVersion). */
  private readonly seenMeta = new Map<string, string>();
  private readonly invalidMeta = new Map<string, string>();
  private readonly seenRevokes = new Map<string, string>();

  private readonly queue = new Map<string, QueueEntry>();
  private readonly running = new Map<string, Promise<JobOutcome>>();
  private idleWaiters: (() => void)[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private readonly recordLocks = new Map<string, Promise<unknown>>();

  private readonly listeners = new Set<(c: IngestChange) => void>();
  private pendingKeys = new Set<string>();
  private pendingDates = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;

  private started = false;
  private closing = false;
  private abort = new AbortController();
  private timers: NodeJS.Timeout[] = [];
  private unsubscribe: (() => void) | null = null;

  constructor(deps: IngestDeps) {
    this.config = deps.config;
    this.log = deps.log.child({ component: 'ingest' });
    this.paths = deps.paths;
    this.store = deps.store;
    this.source = deps.source;
    this.options = deps;
    this.now = deps.now ?? deps.store.now;
    this.tools = deps.tools ?? toolPathsFromEnv(deps.env ?? process.env);
    this.workers = Math.max(1, deps.workers ?? 2);
    this.scanIntervalMs = deps.scanIntervalMs ?? 30_000;
    this.pumpIntervalMs = deps.pumpIntervalMs ?? 5_000;
    this.syncOutbox = deps.syncOutbox ?? true;
    this.retryPolicy = { baseMs: 30_000, maxMs: 60 * 60_000, maxAttempts: 5, ...deps.retry };
    this.redownloadPolicy = { baseMs: 10 * 60_000, maxMs: 6 * 60 * 60_000, ...deps.redownload };
    this.giveUpGraceMs = Math.max(0, deps.giveUpGraceMs ?? 15 * 60_000);
  }

  // ------------------------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.closing = false;
    this.helperUpSinceMs = null;
    this.abort = new AbortController();
    for (const dir of [this.paths.inbox, this.paths.revokes, this.config.dirs.archive, this.config.dirs.media]) {
      await fsp.mkdir(dir, { recursive: true });
    }
    this.unsubscribe = this.source.onEvent((e) => this.onSourceEvent(e));
    await this.periodic();
    await this.sweepInbox().catch((err: unknown) => this.log.warn({ err }, 'inbox sweep failed'));
    this.timers.push(setInterval(() => void this.periodic(), this.scanIntervalMs));
    this.timers.push(setInterval(() => this.pump(), this.pumpIntervalMs));
    for (const t of this.timers) t.unref?.();
    this.log.info({ workers: this.workers, tools: this.tools }, 'ingest started');
  }

  async stop(): Promise<void> {
    this.closing = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.abort.abort();
    for (const entry of this.queue.values()) for (const w of entry.waiters) w('aborted');
    this.queue.clear();
    await Promise.allSettled([...this.running.values()]);
    await this.chain.catch(() => {});
    this.flushChanges();
    this.started = false;
    this.log.info('ingest stopped');
  }

  async drain(): Promise<DrainResult> {
    const before = { ...this.counters };
    await this.scanAll();
    await this.checkAwaiting();
    const attempted = new Set<string>();
    for (let round = 0; round < 10_000; round++) {
      const due = this.store.captures.listDue(500).filter((r) => !attempted.has(r.sourceKey));
      if (due.length === 0) break;
      for (const r of due) attempted.add(r.sourceKey);
      await Promise.all(due.map((r) => this.schedule(r.sourceKey)));
    }
    await this.idle();
    this.flushChanges();
    const delta = (k: string) => (this.counters[k] ?? 0) - (before[k] ?? 0);
    return {
      ingested: delta('ingested'),
      processed: delta('processed') + delta('reprocessed'),
      failed: delta('failed'),
    };
  }

  async reprocess(sourceKey?: string): Promise<number> {
    if (sourceKey) {
      const row = this.store.captures.get(sourceKey);
      if (!row) throw new RangeError(`Unknown capture: ${sourceKey}`);
      if (row.state === 'failed') this.store.captures.retry(sourceKey);
      const outcome = await this.schedule(sourceKey, true);
      this.flushChanges();
      return outcome === 'ready' ? 1 : 0;
    }
    await this.restoreFromArchive();
    const rows = this.store.captures
      .list()
      .filter((r) => r.archivePath !== null && (REPROCESSABLE.has(r.state) || r.state === 'received'));
    const outcomes = await Promise.all(rows.map((r) => this.schedule(r.sourceKey, true)));
    this.flushChanges();
    return outcomes.filter((o) => o === 'ready').length;
  }

  onChange(cb: (c: IngestChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  stats(): Record<string, number> {
    const states = this.store.captures.countByState();
    const out: Record<string, number> = { ...this.counters, queued: this.queue.size, running: this.running.size };
    for (const [state, n] of Object.entries(states)) out[`captures_${state}`] = n;
    return out;
  }

  retry(sourceKey: string): boolean {
    const ok = this.store.captures.retry(sourceKey);
    if (ok) {
      this.store.events.append('capture.retry_requested', { sourceKey });
      void this.schedule(sourceKey);
    }
    return ok;
  }

  // ------------------------------------------------------------------------------- scanning

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private async periodic(): Promise<void> {
    if (this.closing) return;
    try {
      await this.scanAll();
      await this.checkAwaiting();
      this.pump();
    } catch (err) {
      this.log.error({ err }, 'inbox scan failed');
    }
  }

  private scanAll(): Promise<void> {
    return this.exclusive(async () => {
      this.counters.scans = (this.counters.scans ?? 0) + 1;
      // One broken entry must never stop the others (it is retried on the next scan).
      for (const msgId of await listInboxMessages(this.paths.inbox)) {
        if (this.closing) return;
        await this.ingestMessage(msgId).catch((err) => this.scanError(err, msgId, 'status'));
      }
      for (const msgId of await listRevokes(this.paths.revokes)) {
        if (this.closing) return;
        await this.applyRevokeFile(msgId).catch((err) => this.scanError(err, msgId, 'revoke'));
      }
    });
  }

  private scanError(err: unknown, msgId: string, what: 'status' | 'revoke'): void {
    this.counters.scan_errors = (this.counters.scan_errors ?? 0) + 1;
    this.log.error({ err, msgId }, `ingesting the ${what} failed; retrying on the next scan`);
  }

  private onSourceEvent(e: WaEvent): void {
    if (this.closing) return;
    if (e.type === 'status' || e.type === 'media') {
      this.exclusive(() => this.ingestMessage(e.msgId))
        .then(() => this.pump())
        .catch((err) => this.log.error({ err, msgId: e.msgId }, 'ingest after helper event failed'));
    } else if (e.type === 'revoke') {
      this.exclusive(() => this.applyRevokeFile(e.msgId)).catch((err) =>
        this.log.error({ err, msgId: e.msgId }, 'revoke after helper event failed'),
      );
    }
  }

  /** Reads inbox/<msgId>/meta.json (if changed) and syncs it into the store. Call under exclusive(). */
  private async ingestMessage(msgId: string): Promise<void> {
    const version = await fileVersion(inboxMetaFile(this.paths.inbox, msgId));
    if (version === null) return; // no meta.json (yet)
    if (this.seenMeta.get(msgId) === version || this.invalidMeta.get(msgId) === version) return;
    const res = await readInboxMeta(this.paths.inbox, msgId);
    if (!res.ok) {
      if (res.problem === 'missing') return;
      const v = res.version ?? version;
      if (this.invalidMeta.get(msgId) !== v) {
        this.invalidMeta.set(msgId, v);
        this.counters.invalid_meta = (this.counters.invalid_meta ?? 0) + 1;
        this.log.warn(
          { msgId, problem: res.problem, error: res.error.slice(0, 500) },
          'invalid inbox meta.json skipped',
        );
        this.store.events.append('capture.invalid_meta', {
          msgId,
          problem: res.problem,
          error: res.error.slice(0, 500),
        });
      }
      return;
    }
    this.invalidMeta.delete(msgId);
    await this.syncMeta(res.value);
    this.seenMeta.set(msgId, res.version);
  }

  private resolveTz(meta: InboxMeta): string {
    const mirrored = this.store.owner.rawSettings()['timezone.current'];
    const candidates = [this.options.tzFor?.(meta), this.source.tzHint?.(meta.msgId), mirrored];
    for (const tz of candidates) if (typeof tz === 'string' && isValidTimeZone(tz)) return tz;
    return this.config.defaultTimezone;
  }

  private async syncMeta(meta: InboxMeta): Promise<void> {
    const sourceKey = waSourceKey(meta.msgId);
    const existing = this.store.captures.get(sourceKey);
    if (!existing) {
      await this.insertCapture(meta);
      return;
    }
    if (!isMediaKind(existing.kind)) return;
    const d = meta.download;

    // Rescue only a loss that happened while the download was outstanding (Node gave up, or the
    // control UI skipped a waiting capture). A capture whose original had already arrived was
    // lost for another reason (skipped after failing in the pipeline) and stays lost: meta.json
    // is re-read on every restart and must not undo that decision.
    if (
      existing.state === 'media_lost' &&
      existing.downloadPermanent !== true &&
      existing.downloadState !== 'ok' &&
      d.state === 'ok'
    ) {
      const rescued = this.store.transaction(() => {
        if (!this.store.captures.retry(sourceKey)) return null;
        this.store.captures.updateWaMetadata(sourceKey, { media: meta.media ?? null });
        this.store.captures.setDownloadResult(sourceKey, { state: 'ok' });
        const row = this.mustGet(sourceKey);
        if (this.syncOutbox) enqueueCaptureMirror(this.store, row);
        this.store.events.append('capture.media_rescued', { sourceKey });
        return row;
      });
      if (rescued) {
        this.counters.media_rescued = (this.counters.media_rescued ?? 0) + 1;
        this.log.info({ sourceKey }, 'media arrived after giving up: capture resumed');
      }
      return;
    }

    if (existing.state !== 'awaiting_media') return;
    const unchanged =
      d.state === existing.downloadState &&
      (d.reason ?? null) === existing.downloadReason &&
      (d.permanent ?? null) === existing.downloadPermanent;
    if (unchanged) return;
    const row = this.store.transaction(() => {
      if (d.state === 'ok') {
        this.store.captures.updateWaMetadata(sourceKey, { media: meta.media ?? null });
        this.store.captures.setDownloadResult(sourceKey, { state: 'ok' });
      } else if (d.state === 'failed') {
        this.store.captures.setDownloadResult(sourceKey, {
          state: 'failed',
          reason: d.reason,
          permanent: d.permanent,
          error: d.error,
          retryAt: d.permanent ? undefined : new Date(this.now().getTime() + this.redownloadDelay(existing.attempts)),
        });
      } else {
        this.store.captures.setDownloadResult(sourceKey, { state: d.state, error: d.error });
      }
      const updated = this.mustGet(sourceKey);
      if (this.syncOutbox) enqueueCaptureMirror(this.store, updated);
      return updated;
    });
    this.log.info({ sourceKey, download: d.state, state: row.state }, 'download state updated');
    if (row.state === 'media_lost') await this.onMediaLost(row, d.error ?? `download ${d.reason ?? 'failed'}`, meta);
  }

  /**
   * The archive record of a status that is not in the store (store.db lost or reset while the
   * inbox survived, or a relink re-delivering archived statuses), if it is readable and matches.
   */
  private async archivedFiling(meta: InboxMeta): Promise<{ tz: string; localDate: string } | null> {
    const rel = archiveRecordRelPath(meta.timestamp, meta.msgId);
    const record = await readArchiveRecordIfExists(this.config.dirs.archive, rel).catch((err) => {
      this.log.warn({ rel, err: errorMessage(err) }, 'unreadable archive record ignored on ingest');
      return null;
    });
    if (!record || record.msgId !== meta.msgId) return null;
    return { tz: record.tz, localDate: record.localDate };
  }

  private async insertCapture(meta: InboxMeta): Promise<void> {
    // Keep the zone/date a status was filed under: the current setting may differ by now.
    const filed = await this.archivedFiling(meta);
    const tz = filed?.tz ?? this.resolveTz(meta);
    const input = await newCaptureFromInbox(meta, tz);
    if (filed) input.localDate = filed.localDate;
    const { inserted, row } = this.store.transaction(() => {
      let res = this.store.captures.insert(input);
      const d = meta.download;
      if (res.inserted && res.row.state === 'awaiting_media' && d.state === 'failed' && d.permanent === false) {
        // The helper already tried once: the first `redownload` waits one backoff interval.
        this.store.captures.setDownloadResult(res.row.sourceKey, {
          state: 'failed',
          reason: d.reason,
          permanent: false,
          error: d.error,
          retryAt: new Date(this.now().getTime() + this.redownloadDelay(0)),
        });
        res = { inserted: true, row: this.mustGet(res.row.sourceKey) };
      }
      if (res.inserted) {
        if (this.syncOutbox) {
          enqueueCaptureMirror(this.store, res.row);
          enqueueRevoke(this.store, res.row);
        }
        this.store.events.append('capture.ingested', {
          sourceKey: res.row.sourceKey,
          kind: res.row.kind,
          state: res.row.state,
          source: res.row.source,
        });
      }
      return res;
    });
    if (!inserted) return;
    this.counters.ingested = (this.counters.ingested ?? 0) + 1;
    if (row.revokedAt) this.counters.revokes_applied = (this.counters.revokes_applied ?? 0) + 1;
    this.log.info(
      { sourceKey: row.sourceKey, kind: row.kind, state: row.state, localDate: row.localDate, tz: row.tz },
      'status ingested',
    );
    if (row.state === 'media_lost') {
      await this.onMediaLost(row, meta.download.error ?? `download ${meta.download.reason ?? 'failed'}`, meta, false);
    } else {
      await this.safeWriteRecord(row, { meta });
    }
  }

  private async onMediaLost(row: CaptureRow, reason: string, meta?: InboxMeta, enqueue = true): Promise<void> {
    this.counters.media_lost = (this.counters.media_lost ?? 0) + 1;
    this.store.events.append('capture.media_lost', { sourceKey: row.sourceKey, reason });
    if (enqueue && this.syncOutbox) enqueueCaptureMirror(this.store, row);
    this.log.warn({ sourceKey: row.sourceKey, reason }, 'media lost');
    const recorded = await this.safeWriteRecord(row, meta ? { meta } : {});
    // A permanent failure is terminal (wa.ts rule 4): partial downloads can go. A give-up after
    // MEDIA_GIVE_UP_HOURS is not (the media may still arrive and rescue the capture).
    if (recorded && meta?.download.state === 'failed' && meta.download.permanent === true) {
      await this.releaseInbox(meta.msgId, 'media_lost');
    }
  }

  private async applyRevokeFile(msgId: string): Promise<void> {
    const version = await fileVersion(revokeFile(this.paths.revokes, msgId));
    if (version === null || this.seenRevokes.get(msgId) === version) return;
    const res = await readRevoke(this.paths.revokes, msgId);
    if (!res.ok) {
      if (res.problem === 'missing') return;
      this.seenRevokes.set(msgId, res.version ?? version);
      this.counters.invalid_revoke = (this.counters.invalid_revoke ?? 0) + 1;
      this.log.warn({ msgId, problem: res.problem, error: res.error.slice(0, 500) }, 'invalid revoke record skipped');
      this.store.events.append('capture.invalid_revoke', { msgId, problem: res.problem });
      return;
    }
    const record = res.value;
    const current = this.store.captures.getByMsgId(msgId);
    if (current?.revokedAt) {
      this.seenRevokes.set(msgId, res.version);
      return;
    }
    const applied = this.store.transaction(() => {
      const outcome = this.store.captures.applyRevoke(msgId, record.at);
      if (outcome === 'pending') {
        this.store.events.append('capture.revoke_parked', { msgId, at: record.at });
        return null;
      }
      const row = this.mustGet(waSourceKey(msgId));
      if (this.syncOutbox) {
        enqueueRevoke(this.store, row);
        enqueueCaptureMirror(this.store, row);
      }
      this.store.events.append('capture.revoked', { sourceKey: row.sourceKey, at: record.at });
      return row;
    });
    this.seenRevokes.set(msgId, res.version);
    if (!applied) {
      this.counters.revokes_parked = (this.counters.revokes_parked ?? 0) + 1;
      this.log.info({ msgId }, 'revoke parked until its status arrives');
      return;
    }
    this.counters.revokes_applied = (this.counters.revokes_applied ?? 0) + 1;
    this.log.info({ sourceKey: applied.sourceKey, at: record.at }, 'status revoked');
    await this.safeWriteRecord(applied, {});
    if (applied.state === 'ready') this.queueChange(applied);
  }

  /**
   * Sends due `redownload` commands and gives up on media that never arrived.
   *
   * Nothing is decided while the source is not running: a stopped or restarting helper drops
   * commands (sending would only spend an attempt and grow the backoff) and cannot download, so
   * its downtime, e.g. the backend being switched off for longer than MEDIA_GIVE_UP_HOURS, must
   * not turn waiting captures into media_lost before the helper had a chance (rule 1: it resumes
   * pending/retrying downloads on start). Giving up therefore also waits until the helper has been
   * running for `giveUpGraceMs`. A due redownload is sent BEFORE the give-up check, so a transient
   * failure always gets one more attempt (also after a control-UI retry() of a lost capture); a
   * download that succeeds after the give-up still rescues the capture (syncMeta).
   */
  private checkAwaiting(): Promise<void> {
    return this.exclusive(async () => {
      const nowMs = this.now().getTime();
      if (this.source.state().process !== 'running') {
        this.helperUpSinceMs = null;
        return;
      }
      this.helperUpSinceMs ??= nowMs;
      const mayGiveUp = nowMs - this.helperUpSinceMs >= this.giveUpGraceMs;
      const giveUpMs = this.config.wa.mediaGiveUpHours * 3_600_000;
      for (const row of this.store.captures.listAwaitingMedia(1000)) {
        if (this.closing) return;
        const transient = row.downloadState === 'failed' && row.downloadPermanent === false && row.msgId !== null;
        const due = !row.nextAttemptAt || Date.parse(row.nextAttemptAt) <= nowMs;
        if (transient && due && row.msgId) this.requestRedownload(row, row.msgId, nowMs);
        const since = Date.parse(row.receivedAt ?? row.createdAt);
        if (!mayGiveUp || !Number.isFinite(since) || nowMs - since < giveUpMs) continue;
        const reason =
          `media not downloaded within ${this.config.wa.mediaGiveUpHours} h ` +
          `(download ${row.downloadState}${row.downloadReason ? `: ${row.downloadReason}` : ''})`;
        if (this.store.captures.markMediaLost(row.sourceKey, reason)) {
          await this.onMediaLost(this.mustGet(row.sourceKey), reason);
        }
      }
    });
  }

  private requestRedownload(row: CaptureRow, msgId: string, nowMs: number): void {
    this.source.send({ type: 'redownload', msgId });
    this.counters.redownloads = (this.counters.redownloads ?? 0) + 1;
    const retryAt = new Date(nowMs + this.redownloadDelay(row.attempts));
    this.store.captures.setDownloadResult(row.sourceKey, {
      state: 'failed',
      reason: row.downloadReason ?? 'unknown',
      permanent: false,
      retryAt,
    });
    this.store.events.append('capture.redownload', { sourceKey: row.sourceKey, attempts: row.attempts + 1 });
    this.log.info({ sourceKey: row.sourceKey, nextAt: retryAt.toISOString() }, 'redownload requested');
  }

  private redownloadDelay(attempts: number): number {
    return Math.min(
      this.redownloadPolicy.maxMs,
      this.redownloadPolicy.baseMs * 2 ** Math.min(20, Math.max(0, attempts)),
    );
  }

  private retryDelay(attempt: number): number {
    return Math.min(this.retryPolicy.maxMs, this.retryPolicy.baseMs * 4 ** Math.min(10, Math.max(0, attempt - 1)));
  }

  // ------------------------------------------------------------------------------- worker pool

  private pump(): void {
    if (this.closing) return;
    try {
      for (const row of this.store.captures.listDue(200)) {
        if (!this.queue.has(row.sourceKey) && !this.running.has(row.sourceKey)) void this.schedule(row.sourceKey);
      }
    } catch (err) {
      this.log.error({ err }, 'pump failed');
    }
  }

  private schedule(sourceKey: string, force = false): Promise<JobOutcome> {
    if (this.closing) return Promise.resolve('aborted');
    let entry = this.queue.get(sourceKey);
    if (entry) entry.force ||= force;
    else {
      entry = { force, waiters: [] };
      this.queue.set(sourceKey, entry);
    }
    const target = entry;
    const promise = new Promise<JobOutcome>((resolve) => target.waiters.push(resolve));
    this.fill();
    return promise;
  }

  private fill(): void {
    while (this.running.size < this.workers && !this.closing) {
      let next: string | undefined;
      for (const key of this.queue.keys()) {
        if (!this.running.has(key)) {
          next = key;
          break;
        }
      }
      if (next === undefined) break;
      const key = next;
      const entry = this.queue.get(key);
      this.queue.delete(key);
      if (!entry) continue;
      const job = this.runJob(key, entry.force)
        .catch((err): JobOutcome => {
          this.log.error({ err, sourceKey: key }, 'pipeline job crashed');
          return 'failed';
        })
        .then((outcome) => {
          this.running.delete(key);
          for (const w of entry.waiters) w(outcome);
          this.fill();
          this.scheduleFlush();
          return outcome;
        });
      this.running.set(key, job);
    }
    if (this.running.size === 0 && this.queue.size === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  private idle(): Promise<void> {
    if (this.running.size === 0 && this.queue.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async runJob(sourceKey: string, force: boolean): Promise<JobOutcome> {
    const signal = this.abort.signal;
    let row = this.store.captures.get(sourceKey);
    if (!row) return 'skipped';
    const forced = force && row.archivePath !== null && REPROCESSABLE.has(row.state);
    if (!forced) {
      if (!ACTIVE.has(row.state)) return 'skipped';
      if (row.nextAttemptAt && Date.parse(row.nextAttemptAt) > this.now().getTime()) return 'skipped';
    }
    const wasReady = row.state === 'ready';
    try {
      if (row.state === 'received') row = await this.archiveStep(row);
      let output: ProcessOutput | null = null;
      if (row.state === 'archived' || forced) output = await this.processStep(row, signal);
      if (signal.aborted && !output) throw new AbortedError();
      const ready = this.finalize(sourceKey, output);
      if (forced && wasReady) this.counters.reprocessed = (this.counters.reprocessed ?? 0) + 1;
      else this.counters.processed = (this.counters.processed ?? 0) + 1;
      this.log.info({ sourceKey, kind: ready.kind, summary: output?.summary, reprocess: forced }, 'capture ready');
      this.queueChange(ready);
      return 'ready';
    } catch (err) {
      if (isAbortError(err) || signal.aborted) {
        this.log.debug({ sourceKey }, 'pipeline job aborted (shutdown)');
        return 'aborted';
      }
      return this.recordFailure(sourceKey, err, forced);
    }
  }

  private recordFailure(sourceKey: string, err: unknown, forced: boolean): JobOutcome {
    const message = errorMessage(err);
    this.counters.failed = (this.counters.failed ?? 0) + 1;
    const row = this.store.captures.get(sourceKey);
    if (!row || !ACTIVE.has(row.state)) {
      // e.g. a failed reprocess of a ready capture: it keeps its published variants.
      this.log.error({ sourceKey, err: message, state: row?.state, reprocess: forced }, 'processing failed');
      this.store.events.append('capture.reprocess_failed', { sourceKey, error: message });
      return 'failed';
    }
    const attempt = row.attempts + 1;
    const giveUp = err instanceof ArchiveIntegrityError || attempt >= this.retryPolicy.maxAttempts;
    const next = giveUp ? null : new Date(this.now().getTime() + this.retryDelay(attempt));
    this.store.captures.recordFailure(sourceKey, message, next);
    this.store.events.append(giveUp ? 'capture.failed' : 'capture.retry', {
      sourceKey,
      attempt,
      error: message,
      nextAttemptAt: next?.toISOString() ?? null,
    });
    if (giveUp) this.log.error({ sourceKey, attempt, err: message }, 'processing failed; giving up');
    else
      this.log.warn(
        { sourceKey, attempt, err: message, nextAttemptAt: next?.toISOString() },
        'processing failed; will retry',
      );
    return giveUp ? 'failed' : 'retry';
  }

  private mustGet(sourceKey: string): CaptureRow {
    const row = this.store.captures.get(sourceKey);
    if (!row) throw new Error(`capture ${sourceKey} vanished`);
    return row;
  }

  private msgIdOf(row: CaptureRow): string {
    return row.msgId ?? parseSourceKey(row.sourceKey).id;
  }

  // ------------------------------------------------------------------------------- steps

  /** received -> archived: copy the original (verified) and write the archive record. */
  private async archiveStep(row: CaptureRow): Promise<CaptureRow> {
    const msgId = this.msgIdOf(row);
    const res = await readInboxMeta(this.paths.inbox, msgId);
    let meta: InboxMeta;
    let original: ArchiveOriginal | null = null;
    let sha: string | null = null;
    if (res.ok) {
      meta = res.value;
      if (isMediaKind(row.kind)) {
        const src = inboxOriginalPath(this.paths.inbox, meta);
        if (meta.download.state !== 'ok' || !src) throw new Error('original not downloaded');
        const archived = await archiveOriginal(
          this.config.dirs.archive,
          src,
          row.occurredAt,
          msgId,
          meta.download.sha256Hex,
        );
        original = {
          file: basename(archived.relPath),
          sha256Hex: archived.sha256,
          bytes: archived.bytes,
          mimetype: meta.media?.mimetype ?? null,
        };
        sha = archived.sha256;
      }
    } else {
      // The inbox entry is gone: an archive record with its original is enough.
      const rel = archiveRecordRelPath(row.occurredAt, msgId);
      const record = await readArchiveRecordIfExists(this.config.dirs.archive, rel);
      const file = record ? archivedOriginalPath(this.config.dirs.archive, rel, record) : null;
      if (!record || (isMediaKind(row.kind) && !(file && (await exists(file))))) {
        throw new Error(`inbox meta.json unavailable (${res.problem}: ${res.error})`);
      }
      meta = record.meta;
      original = record.original;
      sha = record.original?.sha256Hex ?? null;
    }
    const recordRel = await this.writeRecord(row, { meta, original });
    if (!this.store.captures.markArchived(row.sourceKey, { archivePath: recordRel, originalSha256: sha })) {
      throw new Error(`markArchived refused in state ${this.store.captures.get(row.sourceKey)?.state}`);
    }
    this.sendReadReceipt(row);
    // The archived copy is verified against the helper's sha256 and the record is written: the
    // inbox copy is redundant now (L2-06).
    if (res.ok && original && meta.download.state === 'ok' && original.sha256Hex === meta.download.sha256Hex) {
      await this.releaseInbox(msgId, 'archived');
    }
    return this.mustGet(row.sourceKey);
  }

  /** Deletes the inbox original + temp files of a terminal, archived entry (keeps meta.json). */
  private async releaseInbox(msgId: string, why: 'archived' | 'media_lost'): Promise<number> {
    try {
      const freed = await releaseInboxMedia(this.paths.inbox, msgId);
      if (freed > 0) {
        this.counters.inbox_freed_bytes = (this.counters.inbox_freed_bytes ?? 0) + freed;
        this.log.debug({ msgId, freed, why }, 'inbox original released');
      }
      return freed;
    } catch (err) {
      this.log.warn(
        { msgId, err: errorMessage(err) },
        'could not release the inbox original (retried on the next start)',
      );
      return 0;
    }
  }

  /**
   * Releases the inbox originals of entries that are already safe: archived (record with an
   * original of the helper's sha256 and size) or permanently failed (media_lost). Idempotent;
   * mainly for installs from before L2-06. Non-terminal downloads are never touched.
   */
  private async sweepInbox(): Promise<{ entries: number; bytes: number }> {
    let entries = 0;
    let bytes = 0;
    for (const msgId of await listInboxMessages(this.paths.inbox)) {
      if (this.closing) break;
      if (!(await inboxHoldsMedia(this.paths.inbox, msgId))) continue;
      const res = await readInboxMeta(this.paths.inbox, msgId);
      if (!res.ok || !isMediaKind(res.value.kind)) continue;
      const d = res.value.download;
      const row = this.store.captures.getByMsgId(msgId);
      if (!row) continue;
      let safe = false;
      if (d.state === 'failed' && d.permanent === true) {
        safe = row.state === 'media_lost';
      } else if (d.state === 'ok' && row.archivePath) {
        const record = await readArchiveRecordIfExists(this.config.dirs.archive, row.archivePath).catch(() => null);
        const file = record ? archivedOriginalPath(this.config.dirs.archive, row.archivePath, record) : null;
        const st = file ? await fsp.stat(file).catch(() => null) : null;
        const original = record?.original ?? null;
        safe =
          original !== null &&
          original.sha256Hex === d.sha256Hex &&
          row.originalSha256 === d.sha256Hex &&
          st?.isFile() === true &&
          st.size === original.bytes;
      }
      if (!safe) continue;
      const freed = await this.releaseInbox(msgId, d.state === 'ok' ? 'archived' : 'media_lost');
      if (freed > 0) {
        entries++;
        bytes += freed;
      }
    }
    if (entries > 0) {
      this.log.info({ entries, bytes }, `inbox sweep freed ${bytes} bytes of originals that are in the archive`);
      this.store.events.append('ingest.inbox_swept', { entries, bytes });
    }
    return { entries, bytes };
  }

  /**
   * Optional "captured ✓" signal (SEND_READ_RECEIPT, observer mode only, see wa-helper README):
   * once the status and its original are safely in the home archive, the helper sends the status
   * read receipt. Sent once, on the received -> archived step (never for fixtures, never for media
   * that was lost, never again on reprocess or restore).
   */
  private sendReadReceipt(row: CaptureRow): void {
    if (!this.config.wa.sendReadReceipt || this.config.wa.mode !== 'observer' || row.source === 'fixture') return;
    this.source.send({ type: 'mark_read', msgId: this.msgIdOf(row) });
    this.counters.read_receipts = (this.counters.read_receipts ?? 0) + 1;
  }

  private async processStep(row: CaptureRow, signal: AbortSignal): Promise<ProcessOutput> {
    if (!row.archivePath) throw new Error('capture has no archive record');
    const record = await readArchiveRecord(this.config.dirs.archive, row.archivePath);
    const file = archivedOriginalPath(this.config.dirs.archive, row.archivePath, record);
    if (isMediaKind(row.kind) && !file) throw new Error('archive record has no original');
    return processOriginal(
      {
        kind: row.kind,
        file,
        sha256: row.originalSha256 ?? record.original?.sha256Hex ?? null,
        media: row.media ?? record.meta.media ?? null,
        signal,
      },
      {
        mediaDir: this.config.dirs.media,
        tools: this.tools,
        encode: this.options.encode,
        x264Preset: this.options.x264Preset,
      },
    );
  }

  /** processed (+ variants) -> ready, with the sync outbox items, in one transaction. */
  private finalize(sourceKey: string, output: ProcessOutput | null): CaptureRow {
    return this.store.transaction(() => {
      if (
        output &&
        !this.store.captures.markProcessed(sourceKey, { variants: output.variants, processedMeta: output.meta })
      ) {
        throw new Error(`markProcessed refused in state ${this.store.captures.get(sourceKey)?.state}`);
      }
      if (!this.store.captures.markReady(sourceKey)) {
        throw new Error(`markReady refused in state ${this.store.captures.get(sourceKey)?.state}`);
      }
      const ready = this.mustGet(sourceKey);
      if (this.syncOutbox) {
        enqueueCaptureMirror(this.store, ready);
        enqueuePreviews(this.store, ready);
      }
      this.store.events.append('capture.ready', { sourceKey, kind: ready.kind, localDate: ready.localDate });
      return ready;
    });
  }

  // ------------------------------------------------------------------------------- archive records

  private async withRecordLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.recordLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.catch(() => {});
    this.recordLocks.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.recordLocks.get(key) === settled) this.recordLocks.delete(key);
    }
  }

  /**
   * Writes/refreshes ARCHIVE_DIR/…/<msgId>.json from the CURRENT store row (re-read under a
   * per-capture lock, so concurrent revoke/archive writes cannot drop each other's facts).
   */
  private writeRecord(
    row: CaptureRow,
    patch: { meta?: InboxMeta; original?: ArchiveOriginal | null },
  ): Promise<string> {
    const msgId = this.msgIdOf(row);
    return this.withRecordLock(msgId, async () => {
      const current = this.store.captures.get(row.sourceKey) ?? row;
      const rel = archiveRecordRelPath(current.occurredAt, msgId);
      const existing = await readArchiveRecordIfExists(this.config.dirs.archive, rel).catch((err) => {
        this.log.warn({ rel, err: errorMessage(err) }, 'unreadable archive record will be rewritten');
        return null;
      });
      let meta = patch.meta ?? existing?.meta;
      if (!meta) {
        const res = await readInboxMeta(this.paths.inbox, msgId);
        if (res.ok) meta = res.value;
      }
      if (!meta) throw new Error(`no inbox meta for the archive record of ${row.sourceKey}`);
      const now = this.now().toISOString();
      const record: ArchiveRecord = {
        schema: 1,
        type: 'omw.capture',
        sourceKey: current.sourceKey,
        publicId: current.publicId,
        msgId,
        kind: current.kind,
        occurredAt: current.occurredAt,
        tz: current.tz,
        localDate: current.localDate,
        archivedAt: existing?.archivedAt ?? now,
        updatedAt: now,
        original: patch.original !== undefined ? patch.original : (existing?.original ?? null),
        revokedAt: current.revokedAt,
        meta,
      };
      if (existing && JSON.stringify({ ...existing, updatedAt: '' }) === JSON.stringify({ ...record, updatedAt: '' })) {
        return rel;
      }
      return writeArchiveRecord(this.config.dirs.archive, record);
    });
  }

  private async safeWriteRecord(row: CaptureRow, patch: { meta?: InboxMeta }): Promise<boolean> {
    try {
      await this.writeRecord(row, patch);
      return true;
    } catch (err) {
      this.counters.archive_errors = (this.counters.archive_errors ?? 0) + 1;
      this.log.error({ sourceKey: row.sourceKey, err: errorMessage(err) }, 'archive record not written');
      return false;
    }
  }

  /** Inserts captures that exist only in the archive (store lost or reset). */
  private async restoreFromArchive(): Promise<number> {
    let restored = 0;
    for (const rel of await listArchiveRecords(this.config.dirs.archive)) {
      let record: ArchiveRecord;
      try {
        record = await readArchiveRecord(this.config.dirs.archive, rel);
      } catch (err) {
        this.counters.archive_errors = (this.counters.archive_errors ?? 0) + 1;
        this.log.warn({ rel, err: errorMessage(err) }, 'invalid archive record skipped');
        continue;
      }
      if (rel !== archiveRecordRelPath(record.occurredAt, record.msgId)) {
        this.log.warn({ rel }, 'archive record in an unexpected place skipped');
        continue;
      }
      if (this.store.captures.get(record.sourceKey)) continue;
      const file = archivedOriginalPath(this.config.dirs.archive, rel, record);
      const haveOriginal = file !== null && (await exists(file));
      const input = await newCaptureFromInbox(record.meta, record.tz);
      input.localDate = record.localDate;
      if (isMediaKind(record.kind) && haveOriginal) input.download = { state: 'ok' };
      const inserted = this.store.transaction(() => {
        const res = this.store.captures.insert(input);
        if (!res.inserted) return false;
        if (!isMediaKind(record.kind) || haveOriginal) {
          this.store.captures.markArchived(record.sourceKey, {
            archivePath: rel,
            originalSha256: record.original?.sha256Hex ?? null,
          });
        }
        if (record.revokedAt) this.store.captures.applyRevoke(record.msgId, record.revokedAt);
        const row = this.mustGet(record.sourceKey);
        if (this.syncOutbox) {
          enqueueCaptureMirror(this.store, row);
          enqueueRevoke(this.store, row);
        }
        this.store.events.append('capture.restored', { sourceKey: record.sourceKey, state: row.state });
        return true;
      });
      if (inserted) restored++;
    }
    this.counters.restored = (this.counters.restored ?? 0) + restored;
    if (restored > 0) this.log.info({ restored }, 'captures restored from the archive');
    return restored;
  }

  // ------------------------------------------------------------------------------- notifications

  private queueChange(row: CaptureRow): void {
    this.pendingKeys.add(row.sourceKey);
    this.pendingDates.add(row.localDate);
    try {
      const annotation = this.store.owner.getAnnotation(row.sourceKey) ?? null;
      this.pendingDates.add(effectiveLocalDate(row, annotation, this.store.owner.dayTz(row.localDate)));
    } catch (err) {
      this.log.warn({ err, sourceKey: row.sourceKey }, 'effective date unavailable');
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.pendingKeys.size === 0) return;
    this.flushTimer = setTimeout(() => this.flushChanges(), 0);
  }

  private flushChanges(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.pendingKeys.size === 0) return;
    const change: IngestChange = {
      sourceKeys: [...this.pendingKeys].sort(),
      localDates: [...this.pendingDates].sort(),
    };
    this.pendingKeys = new Set();
    this.pendingDates = new Set();
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        this.log.error({ err }, 'ingest change listener failed');
      }
    }
  }
}
