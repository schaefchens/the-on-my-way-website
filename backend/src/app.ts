/**
 * Backend orchestrator (plan A2–A7): wires config -> store -> WaSource -> Ingest -> Generator ->
 * Publisher -> Sync -> control UI, and owns the scheduling between them.
 *
 * Scheduling
 * - Generate: requests from the ingest (new/changed captures) and the change feed (owner edits)
 *   are debounced (3 s of quiet, at most 30 s after the first request) and merged (union of
 *   dates, full if any request was full). Pending dates are persisted (sync_state
 *   "build_pending"), so a crash or shutdown never loses a regeneration.
 * - Publish: after every generate that changed files (or whose version is not live yet), if a
 *   target exists. Single-flight; requests during a deploy coalesce into one follow-up deploy.
 *   Failed deploys are retried with backoff (1 min … 30 min); a startup deploy completes any
 *   deploy interrupted by a crash.
 * - Generate and deploy never overlap (one mutex around OUT_DIR).
 * - Delayed publishing (publish.mode "delayed"): the generator reports `nextRunAt`, the instant
 *   the next pending capture becomes public; a timer requests a generate then.
 * - Startup: one incremental generate (the generator itself goes full when the site build, the
 *   generator version or the settings changed, or the last run was interrupted; the App asks for
 *   a full one after an unclean shutdown, W2-1).
 * - Feed catch-up (L2-03): while the owner mirror holds a prefix of the change feed (a pull that
 *   has not reached hasMore = false), generates wait (BuildScheduler hold, re-checked every 2 s,
 *   at most 10 min); the generator re-checks inside its read transaction.
 * - Publish gates (L2-02): no deploy while a restore from the archive runs or its pipeline work is
 *   not drained, nor while an API is configured and the owner mirror never completed a pull; an
 *   OUT_DIR generated from a store read while a gate was closed is never deployed (outDirGatedBy).
 *   After a restore without an API, automatic deploys wait for a manual publish. The publisher
 *   adds the mass-delete guard and the version floor.
 * - Maintenance (hourly, L2-08): newest 20,000 events kept, quarantined feed items > 90 days
 *   dropped. The API backup is pulled daily (sync/backup.ts, W2-4).
 * - Shutdown (SIGINT/SIGTERM via cli.ts): control UI -> WhatsApp source -> ingest -> running
 *   generate/deploy (bounded wait) -> API backup -> sync -> store.
 *
 * The modules are passed in as factories (main.ts/cli.ts pass the real ones; tests pass fakes).
 */
import {
  closeSync,
  futimesSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { isValidLocalDate } from '@omw/contracts/time';
import { listArchiveRecords } from './capture/archive.js';
import type { Ingest, IngestChange, WaSource } from './capture/index.js';
import type { Config } from './config.js';
import type { Logger } from './log.js';
import { type StatePaths, statePaths } from './paths.js';
import { mkdirWithModeSync, PRIVATE_DIR_MODE, PUBLIC_DIR_MODE, restrictTree } from './pipeline/files.js';
import type { DeployOptions, DeployResult, Publisher } from './publisher/index.js';
import { Store } from './store/index.js';
import { type BackupDeps, type BackupPort, createBackupPuller } from './sync/backup.js';
import {
  createSync,
  type GenerateSnapshot,
  lastCaptureAt,
  preGenerateSnapshot,
  readGenerateSnapshot,
  readPublishState,
  type Sync,
  type SyncDeps,
  statfsFree,
  writeGenerateSnapshot,
} from './sync/index.js';
import { LogRing } from './ui/log-ring.js';
import { type ControlServer, createControlServer } from './ui/server.js';
import type {
  ActionResult,
  AppStatus,
  ControlBackend,
  DeployResultView,
  GenerateSummary,
  TargetOps,
} from './ui/types.js';
import { WaMonitor } from './ui/wa-monitor.js';

// ---------------------------------------------------------------------------------------------
// Module ports (structural subsets of the real modules' interfaces)

export interface GenerateResultLike {
  version: number;
  changed: string[];
  removed: string[];
  full: boolean;
  durationMs: number;
  /** Next instant a pending capture becomes public (delayed mode), if the generator knows it. */
  nextRunAt?: string | null;
}

export interface GeneratorPort {
  generate(opts?: {
    full?: boolean;
    dates?: string[];
    reason?: string;
    /** Fail with FeedCatchingUpError when the owner mirror holds a prefix of the feed (L2-03). */
    holdWhileFeedCatchingUp?: boolean;
  }): Promise<GenerateResultLike>;
  readonly outDir: string;
}

export type PublisherPort = Pick<
  Publisher,
  'listTargets' | 'saveTarget' | 'removeTarget' | 'testTarget' | 'deploy' | 'busy'
> & {
  lastResults?(): DeployResult[];
  /** Highest site version the enabled targets serve (L2-02 d), null if unknown. */
  versionFloor?(): Promise<number | null>;
};

/**
 * sync_state key of a pending `backend publish --force` (ISO time): the CLI writes it next to a
 * running daemon and asks it to publish; the daemon's next deploy consumes it (10 min TTL).
 */
export const FORCE_PUBLISH_KEY = 'publish_force_requested_at';
export const FORCE_PUBLISH_TTL_MS = 10 * 60_000;

export interface AppFactories {
  createWaSource(deps: { config: Config; log: Logger; paths: StatePaths; store: Store }): WaSource;
  createIngest(deps: {
    config: Config;
    log: Logger;
    paths: StatePaths;
    store: Store;
    source: WaSource;
    syncOutbox?: boolean;
  }): Ingest;
  createGenerator(deps: { config: Config; log: Logger; store: Store; siteDistDir?: string }): GeneratorPort;
  createPublisher(deps: { config: Config; log: Logger; store: Store }): PublisherPort;
  createSync?(deps: SyncDeps): Sync;
  /** API backup puller (default createBackupPuller; only with an API configured). */
  createBackup?(deps: BackupDeps): BackupPort;
}

export interface AppOptions {
  /** Debounce: quiet period before a generate (default 3 s). */
  quietMs?: number;
  /** Debounce: maximum wait after the first request (default 30 s). */
  maxWaitMs?: number;
  generateRetryBaseMs?: number;
  generateRetryMaxMs?: number;
  publishRetryBaseMs?: number;
  publishRetryMaxMs?: number;
  /** Max wait for a running generate/deploy on shutdown (default 45 s). */
  shutdownTimeoutMs?: number;
  /** Start the control UI (default true). */
  controlUi?: boolean;
  /** How often local (ntfy) alert conditions are checked (default 60 s). */
  alertCheckMs?: number;
  /** How long WhatsApp must be in a bad state before a local alert (default 2 min). */
  alertGraceMs?: number;
  /** Run a generate at startup (default true). */
  startupGenerate?: boolean;
  /** Sync tuning (tests). */
  sync?: SyncDeps['options'];
  /** Generate hold while the change feed catches up: re-check interval / cap (default 2 s / 10 min). */
  holdRetryMs?: number;
  holdMaxMs?: number;
  /** Housekeeping interval (default 1 h). */
  maintenanceMs?: number;
  /** Max wait for the published site version at startup (default 30 s). */
  versionFloorTimeoutMs?: number;
}

export interface AppDeps {
  config: Config;
  log: Logger;
  logRing?: LogRing;
  /** Injected store (tests); default: opened from DATA_DIR and closed on stop. */
  store?: Store;
  factories: AppFactories;
  options?: AppOptions;
  now?: () => Date;
  /** For local ntfy alerts (tests). */
  fetch?: typeof fetch;
  /** Extra Host names for the control UI (CONTROL_ALLOWED_HOSTS). */
  controlAllowedHosts?: readonly string[];
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 2000);

async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(undefined);
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------
// Mutex (generate and deploy never touch OUT_DIR at the same time)

export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Build scheduler

export interface BuildJob {
  full: boolean;
  /** Sorted, unique; empty = incremental check (the generator diffs its model). */
  dates: string[];
  reason: string;
  /** The hold (BuildSchedulerOptions.hold) lasted longer than holdMaxMs: run regardless. */
  holdExpired?: boolean;
}

export interface BuildRequest {
  dates?: readonly string[];
  full?: boolean;
  reason: string;
}

export interface PendingBuildStore {
  load(): { dates: string[]; full: boolean } | null;
  save(state: { dates: string[]; full: boolean } | null): void;
}

export interface BuildSchedulerOptions {
  /**
   * Runs one job. Resolving with 'deferred' means it did not run because the hold applied
   * meanwhile (re-queued, no failure); any other value means it ran.
   */
  run(job: BuildJob): Promise<unknown>;
  /**
   * Why generates must wait right now (e.g. the change feed is catching up, L2-03), or null.
   * Checked before each job; a held job is re-checked every holdRetryMs and runs anyway (with a
   * warning) after holdMaxMs, so a broken feed cannot stall capture publishing.
   */
  hold?: () => string | null;
  /** Re-check interval while held (default 2 s). */
  holdRetryMs?: number;
  /** Longest hold (default 10 min). */
  holdMaxMs?: number;
  log: Pick<Logger, 'warn' | 'error' | 'debug'>;
  quietMs?: number;
  maxWaitMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  persist?: PendingBuildStore;
  now?: () => number;
}

interface Pending {
  dates: Set<string>;
  full: boolean;
  reasons: Set<string>;
  firstAt: number;
  lastAt: number;
}

/** Debounces generate requests (quiet period + max wait) and runs them one at a time. */
export class BuildScheduler {
  private pending: Pending | null = null;
  private runningJob: BuildJob | null = null;
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private stopped = false;
  /** True while the pending job only waits for the retry timer (no debounce arming). */
  private pendingIsRetry = false;
  private idleWaiters: (() => void)[] = [];
  private holdTimer: NodeJS.Timeout | null = null;
  /** When the current hold began (null = not held). */
  private heldSince: number | null = null;
  private heldReason: string | null = null;
  private holdWarned = false;
  lastError: string | null = null;
  private readonly o: Required<Omit<BuildSchedulerOptions, 'persist' | 'hold'>> & {
    persist?: PendingBuildStore;
    hold?: () => string | null;
  };

  constructor(options: BuildSchedulerOptions) {
    this.o = {
      quietMs: 3_000,
      maxWaitMs: 30_000,
      retryBaseMs: 60_000,
      retryMaxMs: 15 * 60_000,
      holdRetryMs: 2_000,
      holdMaxMs: 10 * 60_000,
      now: Date.now,
      ...options,
    };
  }

  /** Re-queues work persisted by an earlier process (call once at startup). */
  restore(): boolean {
    let saved: { dates: string[]; full: boolean } | null | undefined;
    try {
      saved = this.o.persist?.load();
    } catch (err) {
      // A damaged value must not stop the backend: regenerate everything instead.
      this.o.log.warn({ err }, 'pending generate requests unreadable; scheduling a full generate');
      saved = { dates: [], full: true };
    }
    if (!saved || typeof saved !== 'object') return false;
    const dates = Array.isArray(saved.dates) ? saved.dates.filter((d): d is string => typeof d === 'string') : [];
    const full = saved.full === true;
    if (!full && dates.length === 0) return false;
    this.request({ dates, full, reason: 'resume' });
    return true;
  }

  request(r: BuildRequest): void {
    const now = this.o.now();
    if (!this.pending) {
      this.pending = { dates: new Set(), full: false, reasons: new Set(), firstAt: now, lastAt: now };
    }
    const p = this.pending;
    for (const d of r.dates ?? []) p.dates.add(d);
    p.full ||= Boolean(r.full);
    p.reasons.add(r.reason);
    p.lastAt = now;
    this.pendingIsRetry = false; // new work: run on the normal debounce
    this.persist();
    if (!this.stopped) this.arm();
  }

  private persist(): void {
    if (!this.o.persist) return;
    const dates = new Set<string>([...(this.runningJob?.dates ?? []), ...(this.pending?.dates ?? [])]);
    const full = Boolean(this.runningJob?.full || this.pending?.full);
    try {
      this.o.persist.save(dates.size > 0 || full ? { dates: [...dates].sort(), full } : null);
    } catch (err) {
      this.o.log.warn({ err }, 'could not persist pending generate requests');
    }
  }

  private arm(): void {
    if (!this.pending || this.running || this.stopped || this.pendingIsRetry) return;
    const now = this.o.now();
    const due = Math.min(this.pending.lastAt + this.o.quietMs, this.pending.firstAt + this.o.maxWaitMs);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.runPending(), Math.max(0, due - now));
    this.timer.unref();
  }

  /** Returns true when the job may run now; else re-arms the hold timer (or runs after holdMaxMs). */
  private checkHold(): { run: boolean; expired: boolean } {
    const reason = this.o.hold?.() ?? null;
    if (!reason) {
      if (this.heldSince !== null)
        this.o.log.debug({ heldMs: this.o.now() - this.heldSince }, 'generate hold released');
      this.heldSince = null;
      this.heldReason = null;
      this.holdWarned = false;
      return { run: true, expired: false };
    }
    const now = this.o.now();
    this.heldSince ??= now;
    this.heldReason = reason;
    if (now - this.heldSince < this.o.holdMaxMs) {
      this.armHold();
      return { run: false, expired: false };
    }
    if (!this.holdWarned) {
      this.holdWarned = true;
      this.o.log.warn({ reason, heldMs: now - this.heldSince }, 'generate held back for too long; running it anyway');
    }
    return { run: true, expired: true };
  }

  private armHold(): void {
    if (this.holdTimer || this.stopped) return;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (!this.stopped) void this.runPending();
    }, this.o.holdRetryMs);
    this.holdTimer.unref();
  }

  private requeue(job: BuildJob): void {
    const now = this.o.now();
    this.pending ??= { dates: new Set(), full: false, reasons: new Set(), firstAt: now, lastAt: now };
    for (const d of job.dates) this.pending.dates.add(d);
    this.pending.full ||= job.full;
    for (const r of job.reason.split(',')) if (r) this.pending.reasons.add(r);
  }

  private runPending(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.running) return this.running;
    if (!this.pending || this.stopped) {
      this.notifyIdle();
      return Promise.resolve();
    }
    const hold = this.checkHold();
    if (!hold.run) return Promise.resolve();
    const p = this.pending;
    this.pending = null;
    const job: BuildJob = {
      full: p.full,
      dates: [...p.dates].sort(),
      reason: [...p.reasons].join(','),
      ...(hold.expired ? { holdExpired: true } : {}),
    };
    this.runningJob = job;
    this.running = (async () => {
      try {
        const outcome = await this.o.run(job);
        if (outcome === 'deferred') {
          // The hold applied after the job was picked (e.g. while it waited for a deploy).
          this.requeue(job);
          this.heldSince ??= this.o.now();
          this.armHold();
        } else {
          this.failures = 0;
          this.lastError = null;
        }
      } catch (err) {
        this.failures++;
        this.lastError = errorMessage(err);
        const delay = Math.min(this.o.retryBaseMs * 2 ** (this.failures - 1), this.o.retryMaxMs);
        this.o.log.error({ err, retryInMs: delay, job }, 'generate failed; retrying later');
        this.scheduleRetry(job, delay);
      } finally {
        this.runningJob = null;
        this.running = null;
        this.persist();
      }
      if (this.pending && !this.stopped && !this.pendingIsRetry && !this.holdTimer) this.arm();
      else this.notifyIdle();
    })();
    return this.running;
  }

  private scheduleRetry(job: BuildJob, delay: number): void {
    // Keep the failed job (merged into pending); it runs when the retry timer fires, or earlier
    // together with new work.
    if (!this.pending) {
      const now = this.o.now();
      this.pending = { dates: new Set(), full: false, reasons: new Set(), firstAt: now, lastAt: now };
      this.pendingIsRetry = true;
    }
    for (const d of job.dates) this.pending.dates.add(d);
    this.pending.full ||= job.full;
    this.pending.reasons.add('retry');
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.pendingIsRetry = false;
      if (!this.stopped) void this.runPending();
    }, delay);
    this.retryTimer.unref();
  }

  /** Waits for a running generate, then runs pending work once (skipping the debounce). */
  async flush(): Promise<void> {
    if (this.running) await this.running;
    if (this.pending && !this.stopped) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.pendingIsRetry = false;
      await this.runPending();
    }
  }

  /** Resolves when nothing is running or pending. */
  idle(): Promise<void> {
    if (!this.running && !this.pending) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private notifyIdle(): void {
    if (this.running || (this.pending && !this.stopped)) return;
    for (const w of this.idleWaiters.splice(0)) w();
  }

  /** Stops scheduling (pending work stays persisted) and waits for a running generate. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.timer = null;
    this.retryTimer = null;
    this.holdTimer = null;
    this.persist();
    await this.running;
    for (const w of this.idleWaiters.splice(0)) w();
  }

  state(): {
    running: boolean;
    pending: { full: boolean; dates: number; since: string } | null;
    /** Why pending work waits (hold), null when it does not. */
    held: string | null;
  } {
    return {
      running: this.running !== null,
      held: this.pending && this.heldSince !== null ? this.heldReason : null,
      pending: this.pending
        ? {
            full: this.pending.full,
            dates: this.pending.dates.size,
            since: new Date(this.pending.firstAt).toISOString(),
          }
        : null,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Publish runner

export interface PublishRunnerOptions {
  deploy(opts: { targetId?: string; reason: string; force?: boolean }): Promise<DeployResult[]>;
  /**
   * Why deploys must wait right now (L2-02: restore from the archive in progress, first owner
   * sync pending), or null. A gated automatic deploy is remembered and runs on resume(); a gated
   * manual deploy answers with "paused" results (not counted as failures, not reported).
   */
  gate?: (manual: boolean) => string | null;
  /** Ids of the enabled targets (for "paused" results of a manual deploy of all targets). */
  enabledTargetIds?: () => string[];
  /** Whether a deploy has anything to do: `targetId` exists, or (none given) any target is enabled. */
  hasTargets(targetId?: string): boolean;
  onResults(results: DeployResult[]): void;
  log: Pick<Logger, 'warn' | 'error' | 'info'>;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => number;
}

/** Single-flight deploys; requests during a deploy coalesce into one follow-up deploy. */
export class PublishRunner {
  private running: Promise<DeployResult[]> | null = null;
  private queued: Promise<DeployResult[]> | null = null;
  private queuedTarget: string | undefined | null = null; // null = none requested yet
  private queuedReasons = new Set<string>();
  private retryTimer: NodeJS.Timeout | null = null;
  /** Target of the pending retry (undefined = all enabled targets). */
  private retryTarget: string | undefined = undefined;
  private failures = 0;
  private stopped = false;
  /** An automatic deploy was requested while the gate was closed. */
  private deferred = false;
  private lastGateReason: string | null = null;
  lastResults: DeployResult[] = [];
  lastAt: string | null = null;
  nextRetryAt: string | null = null;
  private readonly o: Required<Omit<PublishRunnerOptions, 'gate' | 'enabledTargetIds'>> &
    Pick<PublishRunnerOptions, 'gate' | 'enabledTargetIds'>;

  constructor(options: PublishRunnerOptions) {
    this.o = { retryBaseMs: 60_000, retryMaxMs: 30 * 60_000, now: Date.now, ...options };
  }

  /** The reason deploys are paused now (null = open); `manual` deploys pass the soft gates. */
  gateReason(manual = false): string | null {
    const reason = this.o.gate?.(manual) ?? null;
    if (reason !== this.lastGateReason) {
      if (reason) this.o.log.info({ reason }, 'publishing paused');
      else if (this.lastGateReason) this.o.log.info({ was: this.lastGateReason }, 'publishing resumed');
      this.lastGateReason = reason;
    }
    return reason;
  }

  /** True when an automatic deploy waits for the gate to open (the caller then regenerates/deploys). */
  takeDeferred(): boolean {
    if (!this.deferred || this.gateReason()) return false;
    this.deferred = false;
    return true;
  }

  private pausedResults(reason: string, targetId?: string): DeployResult[] {
    const ids = targetId ? [targetId] : (this.o.enabledTargetIds?.() ?? ['all']);
    return ids.map((id) => ({
      targetId: id,
      ok: false,
      version: null,
      uploaded: 0,
      deleted: 0,
      bytes: 0,
      durationMs: 0,
      httpCheck: 'skipped',
      error: `paused: ${reason}`,
      errorCode: 'paused',
    }));
  }

  trigger(reason: string, targetId?: string, opts: { force?: boolean } = {}): Promise<DeployResult[]> {
    if (this.stopped || !this.o.hasTargets(targetId)) return Promise.resolve([]);
    const paused = this.gateReason(reason === 'manual');
    if (paused) {
      if (reason === 'manual') return Promise.resolve(this.pausedResults(paused, targetId));
      this.deferred = true;
      return Promise.resolve([]);
    }
    if (opts.force) {
      // A forced deploy never merges into an unforced follow-up: run it on its own.
      return (this.running ?? Promise.resolve([])).catch(() => []).then(() => this.start(reason, targetId, true));
    }
    if (this.queued) {
      this.queuedReasons.add(reason);
      if (this.queuedTarget !== targetId) this.queuedTarget = undefined; // mixed -> all targets
      return this.queued;
    }
    if (this.running) {
      this.queuedReasons = new Set([reason]);
      this.queuedTarget = targetId;
      const follow = this.running
        .catch(() => [])
        .then(() => {
          const target = this.queuedTarget ?? undefined;
          const reasons = [...this.queuedReasons].join(',');
          this.queued = null;
          this.queuedTarget = null;
          this.queuedReasons = new Set();
          return this.start(reasons, target);
        });
      this.queued = follow;
      return follow;
    }
    return this.start(reason, targetId);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryTarget = undefined;
    this.nextRetryAt = null;
  }

  private start(reason: string, targetId?: string, force = false): Promise<DeployResult[]> {
    if (this.stopped) return Promise.resolve([]);
    if (this.gateReason(reason.split(',').includes('manual'))) {
      // The gate closed while this deploy waited behind another one.
      this.deferred = true;
      return Promise.resolve([]);
    }
    // A deploy that covers the pending retry replaces it; a deploy of one other target must not
    // cancel the retry of a failing target.
    if (this.retryTimer && (targetId === undefined || targetId === this.retryTarget)) this.clearRetry();
    const p = (async () => {
      let results: DeployResult[];
      try {
        results = await this.o.deploy({ reason, ...(targetId ? { targetId } : {}), ...(force ? { force } : {}) });
      } catch (err) {
        results = [
          {
            targetId: targetId ?? 'all',
            ok: false,
            version: null,
            uploaded: 0,
            deleted: 0,
            bytes: 0,
            durationMs: 0,
            httpCheck: 'skipped',
            error: errorMessage(err),
          },
        ];
      }
      this.lastResults = results;
      this.lastAt = new Date(this.o.now()).toISOString();
      try {
        this.o.onResults(results);
      } catch (err) {
        this.o.log.error({ err }, 'publish result handler failed');
      }
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0 && !this.stopped) {
        this.failures++;
        const delay = Math.min(this.o.retryBaseMs * 2 ** (this.failures - 1), this.o.retryMaxMs);
        // Keep the broadest scope: a pending retry of another target must survive.
        const scope = this.retryTimer && this.retryTarget !== targetId ? undefined : targetId;
        this.clearRetry();
        this.retryTarget = scope;
        this.nextRetryAt = new Date(this.o.now() + delay).toISOString();
        this.o.log.warn(
          { failed: failed.map((r) => ({ target: r.targetId, error: r.error })), retryInMs: delay },
          'deploy failed; retrying later',
        );
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.retryTarget = undefined;
          this.nextRetryAt = null;
          void this.trigger('retry', scope);
        }, delay);
        this.retryTimer.unref();
      } else if (failed.length === 0 && !this.retryTimer) {
        // Only when nothing else is waiting for a retry (another target may still be failing).
        this.failures = 0;
      }
      return results;
    })().finally(() => {
      if (this.running === p) this.running = null;
    });
    this.running = p;
    return p;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /** Deploys in a row that had a failed target (0 after a fully successful deploy). */
  get consecutiveFailures(): number {
    return this.failures;
  }

  get isQueued(): boolean {
    return this.queued !== null;
  }

  /** Refuses new deploys from now on (shutdown); a running one continues. */
  close(): void {
    this.stopped = true;
    this.clearRetry();
  }

  async stop(): Promise<void> {
    this.close();
    await Promise.allSettled([this.running, this.queued].filter(Boolean));
  }
}

// ---------------------------------------------------------------------------------------------
// Process lock (one daemon per DATA_DIR; one-shot CLI commands talk to it instead)

export interface LockInfo {
  pid: number;
  host: string;
  command: string;
  startedAt: string;
}

export class LockHeldError extends Error {
  override name = 'LockHeldError';
  readonly holder: LockInfo;
  /** The holder runs under another host name (another container or machine sharing DATA_DIR). */
  readonly foreign: boolean;
  constructor(holder: LockInfo, foreign = false) {
    super(
      foreign
        ? `DATA_DIR is in use by the backend on host ${holder.host} (pid ${holder.pid}, ${holder.command}, since ${holder.startedAt})`
        : `DATA_DIR is in use by pid ${holder.pid} (${holder.command}, since ${holder.startedAt})`,
    );
    this.holder = holder;
    this.foreign = foreign;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ProcessLockOptions {
  /** Host name of this process (default os.hostname(); tests fake other containers). */
  hostname?: () => string;
  now?: () => number;
  /** A lock of another host counts as held while its heartbeat is younger than this (default 30 s). */
  staleMs?: number;
  /** How often the holder refreshes its heartbeat (default 10 s). */
  heartbeatMs?: number;
  pidAlive?: (pid: number) => boolean;
}

/** Heartbeat age after which a lock of another host is stale (D-15). */
export const LOCK_STALE_MS = 30_000;
export const LOCK_HEARTBEAT_MS = 10_000;

/**
 * DATA_DIR/backend.lock: {pid, host, command, startedAt}; its mtime is the holder's heartbeat,
 * refreshed every ~10 s (D-15).
 *
 * - Same host: held while the pid is alive (a lock with OUR pid is a leftover of a previous run
 *   of this container: pids repeat in a fresh namespace).
 * - Another host (another container, e.g. `docker compose run` next to the running daemon, or
 *   another machine sharing DATA_DIR): the pid means nothing here, so it is held while the
 *   heartbeat is younger than 30 s, and only stale after that.
 */
export class ProcessLock {
  readonly path: string;
  private released = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly opts: Required<Omit<ProcessLockOptions, 'pidAlive'>> & { pidAlive: (pid: number) => boolean };

  private constructor(path: string, opts: ProcessLock['opts']) {
    this.path = path;
    this.opts = opts;
  }

  private static resolve(options: ProcessLockOptions = {}): ProcessLock['opts'] {
    return {
      hostname: options.hostname ?? hostname,
      now: options.now ?? Date.now,
      staleMs: options.staleMs ?? LOCK_STALE_MS,
      heartbeatMs: options.heartbeatMs ?? LOCK_HEARTBEAT_MS,
      pidAlive: options.pidAlive ?? pidAlive,
    };
  }

  static read(path: string): LockInfo | null {
    try {
      const info = JSON.parse(readFileSync(path, 'utf8')) as LockInfo;
      return typeof info.pid === 'number' ? info : null;
    } catch {
      return null;
    }
  }

  /** Last heartbeat (mtime) of the lock file in ms, null when it is gone. */
  static heartbeat(path: string): number | null {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  }

  /** The live holder of the lock (not this process; stale locks count as free). */
  static holder(path: string, options: ProcessLockOptions = {}): (LockInfo & { foreign: boolean }) | null {
    const o = ProcessLock.resolve(options);
    const info = ProcessLock.read(path);
    if (!info) return null;
    if (info.host === o.hostname()) {
      if (info.pid === process.pid) return null;
      return o.pidAlive(info.pid) ? { ...info, foreign: false } : null;
    }
    const beat = ProcessLock.heartbeat(path);
    return beat !== null && o.now() - beat < o.staleMs ? { ...info, foreign: true } : null;
  }

  static acquire(path: string, command: string, options: ProcessLockOptions = {}): ProcessLock {
    const o = ProcessLock.resolve(options);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
        const fd = openSync(path, 'wx', 0o600);
        const now = o.now();
        const info: LockInfo = {
          pid: process.pid,
          host: o.hostname(),
          command,
          startedAt: new Date(now).toISOString(),
        };
        writeSync(fd, `${JSON.stringify(info)}\n`);
        futimesSync(fd, now / 1000, now / 1000);
        closeSync(fd);
        return new ProcessLock(path, o);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const holder = ProcessLock.holder(path, o);
        if (holder) {
          const { foreign, ...info } = holder;
          throw new LockHeldError(info, foreign);
        }
        try {
          unlinkSync(path); // stale
        } catch {
          // raced with another process: retry once
        }
      }
    }
    const holder = ProcessLock.read(path);
    throw new LockHeldError(holder ?? { pid: -1, host: '?', command: '?', startedAt: '?' });
  }

  /** Refreshes the heartbeat now (mtime = now). */
  refresh(): void {
    if (this.released) return;
    const t = this.opts.now() / 1000;
    try {
      utimesSync(this.path, t, t);
    } catch {
      // the lock file is gone (removed by hand): nothing to refresh
    }
  }

  /** Refreshes the heartbeat every heartbeatMs until release() (unref'ed timer). */
  startHeartbeat(): this {
    if (this.timer || this.released) return this;
    this.timer = setInterval(() => this.refresh(), this.opts.heartbeatMs);
    this.timer.unref();
    return this;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      const info = ProcessLock.read(this.path);
      if (info?.pid === process.pid && info.host === this.opts.hostname()) unlinkSync(this.path);
    } catch {
      // already gone
    }
  }
}

export function lockPath(config: Config): string {
  return join(config.dirs.data, 'backend.lock');
}

// ---------------------------------------------------------------------------------------------
// Local alerts (NTFY_URL; only without an API — with an API its cron sends the alerts)

export interface AlertCondition {
  active: boolean;
  title: string;
  message: string;
  /** Must stay active this long before the alert goes out (ms). */
  graceMs?: number;
}

/** Edge-triggered ntfy notifications: one message when a condition starts, one when it resolves. */
export class LocalAlerts {
  private readonly url: string;
  private readonly log: Pick<Logger, 'warn' | 'info'>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly state = new Map<string, { since: number; notified: boolean }>();

  constructor(url: string, log: Pick<Logger, 'warn' | 'info'>, fetchImpl: typeof fetch = fetch, now = Date.now) {
    this.url = url;
    this.log = log;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async update(kind: string, c: AlertCondition): Promise<void> {
    const prev = this.state.get(kind);
    if (c.active) {
      const entry = prev ?? { since: this.now(), notified: false };
      this.state.set(kind, entry);
      if (!entry.notified && this.now() - entry.since >= (c.graceMs ?? 0)) {
        entry.notified = await this.send(c.title, c.message, 'high', 'warning');
      }
    } else if (prev) {
      this.state.delete(kind);
      if (prev.notified) await this.send(`Resolved: ${c.title}`, c.message, 'default', 'white_check_mark');
    }
  }

  private async send(title: string, message: string, priority: string, tags: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        // ntfy headers must be ASCII/latin1.
        headers: { title: `On My Way: ${title}`.replace(/[^\x20-\x7e]/g, '?'), priority, tags },
        body: message,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.log.info({ title }, 'local alert sent');
      return true;
    } catch (err) {
      this.log.warn({ err: errorMessage(err), title }, 'local alert failed (retried on the next check)');
      return false;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// App

const PENDING_BUILD_KEY = 'build_pending';
/** 'running' while a backend runs; 'stopped' after a clean shutdown (W2-1 unclean-shutdown check). */
const RUN_STATE_KEY = 'backend_run_state';
/** Set once the one-time tightening of ARCHIVE_DIR/DATA_DIR permissions ran (L1-09). */
const PRIVATE_MODES_KEY = 'private_modes_v1';
const NOT_READY_STATES = new Set(['awaiting_media', 'received', 'archived', 'processed']);
/** Captures the restore still works on (awaiting_media waits for WhatsApp, not for the pipeline). */
const PIPELINE_STATES = ['received', 'archived', 'processed'] as const;
/** Newest events kept by the hourly maintenance (L2-08). */
export const EVENTS_KEEP = 20_000;
/** Quarantined change-feed items older than this are deleted (L2-08). */
export const QUARANTINE_KEEP_MS = 90 * 24 * 60 * 60_000;
export const PAUSE_FIRST_SYNC = 'waiting for first owner-content sync';
/**
 * Set (ISO time) when the backend restored its captures from the archive without an API: the
 * owner's content (notes, stories, hidden items, day moves) was in the lost store and only comes
 * back by `backend owner-import`. Automatic deploys wait until an operator publishes by hand.
 */
export const RESTORE_CONFIRM_KEY = 'restore_unconfirmed_since';
export const PAUSE_RESTORE_CONFIRM =
  'restored from the archive without owner content: re-import it (backend owner-import) if the site had any, then run backend publish';

export class App implements ControlBackend {
  readonly config: Config;
  readonly log: Logger;
  readonly logRing: LogRing;
  readonly paths: StatePaths;
  readonly wa: WaMonitor;
  store!: Store;
  source!: WaSource;
  ingest!: Ingest;
  generator!: GeneratorPort;
  publisher!: PublisherPort;
  sync!: Sync;
  scheduler!: BuildScheduler;
  publishRunner!: PublishRunner;
  backup: BackupPort | null = null;
  control: ControlServer | null = null;

  private readonly deps: AppDeps;
  private readonly opts: AppOptions;
  private readonly now: () => Date;
  private readonly outLock = new Mutex();
  private readonly ownsStore: boolean;
  private readonly unsubscribe: (() => void)[] = [];
  private startedAt = new Date(0);
  private started = false;
  private stopping: Promise<void> | null = null;
  private delayedTimer: NodeJS.Timeout | null = null;
  private nextRunAt: string | null = null;
  /** Paths removed by generates since the last fully successful deploy (DeployOptions.knownObsolete). */
  private readonly removedSinceDeploy = new Set<string>();
  /** What the running deploy covers (set inside the OUT_DIR lock, read by onDeployResults). */
  private deployContext: { snapshot: GenerateSnapshot | null; obsolete: string[] } | null = null;
  private lastGenerate: GenerateResultLike | null = null;
  private alerts: LocalAlerts | null = null;
  private alertTimer: NodeJS.Timeout | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;
  /**
   * L2-02 auto-restore: set while the captures of an empty store are rebuilt from ARCHIVE_DIR;
   * deploys stay paused until it is `done` and no capture is left in the pipeline.
   */
  private restoreState: { total: number; done: boolean; promise: Promise<void> } | null = null;
  /**
   * The publish gate as it was when the generate that produced the current OUT_DIR started (null =
   * open). A generate that read the store while publishing was paused (restore not drained, owner
   * content not synced) is never deployed, even if the gate opened while it ran: the next generate
   * starts with the gate open and replaces it.
   */
  private outDirGatedBy: string | null = null;

  constructor(deps: AppDeps) {
    this.deps = deps;
    this.config = deps.config;
    this.log = deps.log;
    this.logRing = deps.logRing ?? new LogRing();
    this.paths = statePaths(deps.config.dirs.data);
    this.opts = deps.options ?? {};
    this.now = deps.now ?? (() => new Date());
    this.ownsStore = !deps.store;
    this.wa = new WaMonitor({
      travelerPhone: deps.config.wa.travelerPhone,
      travelerLid: deps.config.wa.travelerLid,
      now: this.now,
    });
  }

  /** Creates the modules (no I/O besides opening the store); start() runs them. */
  init(): void {
    if (this.store) return;
    const { config, log } = this;
    // Private data owner-only, public output world-readable (L1-09); modes only apply to new dirs,
    // existing installs are tightened once by start() (tightenPrivateModes).
    for (const [dir, mode] of [
      [config.dirs.data, PRIVATE_DIR_MODE],
      [this.paths.inbox, PRIVATE_DIR_MODE],
      [this.paths.revokes, PRIVATE_DIR_MODE],
      [this.paths.wa, PRIVATE_DIR_MODE],
      [config.dirs.archive, PRIVATE_DIR_MODE],
      [config.dirs.config, PRIVATE_DIR_MODE],
      [config.dirs.media, PUBLIC_DIR_MODE],
      [config.dirs.out, PUBLIC_DIR_MODE],
    ] as const) {
      mkdirWithModeSync(dir, mode);
    }
    this.store = this.deps.store ?? Store.open(this.paths.storeDb);
    const f = this.deps.factories;
    this.source = f.createWaSource({ config, log, paths: this.paths, store: this.store });
    this.wa.attach(this.source);
    this.ingest = f.createIngest({
      config,
      log,
      paths: this.paths,
      store: this.store,
      source: this.source,
      // Without an API nothing would ever drain the outbox.
      syncOutbox: config.api !== null,
    });
    this.generator = f.createGenerator({
      config,
      log,
      store: this.store,
      ...(config.siteDistDir ? { siteDistDir: config.siteDistDir } : {}),
    });
    this.publisher = f.createPublisher({ config, log, store: this.store });
    const syncDeps: SyncDeps = {
      config,
      log,
      store: this.store,
      wa: () => this.wa.view(),
      stats: () => this.ingest.stats(),
      enabledTargets: () => this.enabledTargetIds(),
      now: this.now,
      ...(this.opts.sync ? { options: this.opts.sync } : {}),
    };
    this.sync = (f.createSync ?? createSync)(syncDeps);
    if (config.api) {
      const create = f.createBackup ?? ((d: BackupDeps) => createBackupPuller(d));
      this.backup = create({
        config,
        log,
        store: this.store,
        sync: this.sync,
        now: this.now,
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      });
    }

    this.scheduler = new BuildScheduler({
      run: (job) => this.runGenerate(job),
      // L2-03: never generate while the owner mirror holds a prefix of the change feed.
      hold: () => (this.sync.catchingUp() ? 'owner change feed is catching up' : null),
      log,
      ...(this.opts.quietMs !== undefined ? { quietMs: this.opts.quietMs } : {}),
      ...(this.opts.maxWaitMs !== undefined ? { maxWaitMs: this.opts.maxWaitMs } : {}),
      ...(this.opts.generateRetryBaseMs !== undefined ? { retryBaseMs: this.opts.generateRetryBaseMs } : {}),
      ...(this.opts.generateRetryMaxMs !== undefined ? { retryMaxMs: this.opts.generateRetryMaxMs } : {}),
      ...(this.opts.holdRetryMs !== undefined ? { holdRetryMs: this.opts.holdRetryMs } : {}),
      ...(this.opts.holdMaxMs !== undefined ? { holdMaxMs: this.opts.holdMaxMs } : {}),
      persist: {
        load: () => this.store.syncState.getJson<{ dates: string[]; full: boolean }>(PENDING_BUILD_KEY) ?? null,
        save: (state) => {
          if (!this.store.db.open) return;
          if (state) this.store.syncState.setJson(PENDING_BUILD_KEY, state);
          else this.store.syncState.delete(PENDING_BUILD_KEY);
        },
      },
      now: () => this.now().getTime(),
    });
    if (config.ntfyUrl && !config.api) {
      this.alerts = new LocalAlerts(config.ntfyUrl, log, this.deps.fetch ?? fetch, () => this.now().getTime());
    }
    this.publishRunner = new PublishRunner({
      deploy: (opts) => this.runDeploy(opts),
      // One named target is deployed even when disabled (DeployOptions.targetId).
      hasTargets: (targetId) => (targetId ? this.targetExists(targetId) : this.enabledTargets() > 0),
      gate: (manual) => this.publishGate(manual) ?? this.outDirGatedBy,
      enabledTargetIds: () => this.enabledTargetIds(),
      onResults: (results) => this.onDeployResults(results),
      log,
      ...(this.opts.publishRetryBaseMs !== undefined ? { retryBaseMs: this.opts.publishRetryBaseMs } : {}),
      ...(this.opts.publishRetryMaxMs !== undefined ? { retryMaxMs: this.opts.publishRetryMaxMs } : {}),
      now: () => this.now().getTime(),
    });

    this.unsubscribe.push(
      this.ingest.onChange((c: IngestChange) => {
        this.scheduler.request({ dates: c.localDates, reason: 'captures' });
      }),
      this.sync.onOwnerChange((c) => {
        this.scheduler.request({ dates: c.localDates, full: c.full, reason: c.reason || 'owner' });
      }),
      this.sync.onCaughtUp(() => this.gateMayHaveOpened()),
    );
  }

  /**
   * Why deploys must wait (L2-02), or null:
   * - a restore from the archive runs, or its pipeline work is not drained yet;
   * - an API is configured and the owner mirror never completed a pull since it was created or
   *   rebuilt (no timeout: publishing captures without the owner's hide/move decisions could
   *   publish hidden items). A backend that synced once keeps publishing when the API is down.
   */
  publishGate(manual = false): string | null {
    const hard = this.snapshotGate();
    if (hard) return hard;
    if (!manual && this.store.syncState.get(RESTORE_CONFIRM_KEY)) return PAUSE_RESTORE_CONFIRM;
    return null;
  }

  /** The gates a generate's store snapshot must have passed to be publishable (outDirGatedBy). */
  private snapshotGate(): string | null {
    const r = this.restoreState;
    if (r) {
      const left = this.pipelineActive();
      if (!r.done || left > 0) return `restoring ${r.total} captures from the archive (${left} in the pipeline)`;
      this.restoreState = null;
    }
    if (this.config.api && !this.sync.ownerSynced()) return PAUSE_FIRST_SYNC;
    return null;
  }

  /**
   * A gate condition changed. Once it is open, OUT_DIR is regenerated from a store read with the
   * gate open (that generate deploys), if the current OUT_DIR was generated while it was closed or
   * an automatic deploy was held back.
   */
  private gateMayHaveOpened(): void {
    if (this.stopping || this.snapshotGate() !== null) return;
    const deferred = this.publishRunner.takeDeferred();
    if (deferred || this.outDirGatedBy !== null) this.scheduler.request({ reason: 'publish_resumed' });
  }

  private pipelineActive(): number {
    const byState = this.store.captures.countByState() as Record<string, number>;
    return PIPELINE_STATES.reduce((a, s) => a + (byState[s] ?? 0), 0);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.init();
    this.started = true;
    this.startedAt = this.now();
    const { config, log } = this;
    if (config.control.tokenIsDefault) log.warn('CONTROL_TOKEN not set: using the development token');
    this.store.events.append('backend.started', { mode: config.wa.mode, version: config.version ?? 'dev' });
    const unclean = this.store.syncState.get(RUN_STATE_KEY) === 'running';
    this.store.syncState.set(RUN_STATE_KEY, 'running');
    await this.tightenPrivateModes();

    if (this.opts.controlUi !== false) {
      this.control = await createControlServer({
        backend: this,
        token: config.control.token,
        host: config.control.host,
        port: config.control.port,
        allowedHosts: this.deps.controlAllowedHosts ?? config.controlAllowedHosts ?? [],
        log,
        version: config.version ?? 'dev',
      });
      await this.control.listen();
    }
    await this.raiseVersionFloor();
    // Before any generate can run: an empty store next to a filled archive is a restore (gate).
    const restore = await this.detectRestore();
    // OUT_DIR was written by an earlier run: deploy it only after a generate with the gate open.
    this.outDirGatedBy = this.snapshotGate();
    // Work persisted by the previous run first (before new requests are persisted over it).
    this.scheduler.restore();
    if (this.opts.startupGenerate !== false) {
      // After an unclean shutdown (crash, power loss) OUT_DIR may hold files the OS never wrote
      // back: a full run re-checks every file (W2-1; generator writes fsync only data and pages).
      if (unclean) log.warn('previous run did not shut down cleanly: full generate');
      this.scheduler.request({ reason: 'startup', ...(unclean ? { full: true } : {}) });
    }
    // Subscribers first, then the producers (capture/index.ts wiring order).
    await this.ingest.start();
    if (restore) this.runRestore(restore);
    await this.source.start();
    await this.sync.start();
    this.backup?.start();
    if (this.alerts) {
      this.alertTimer = setInterval(() => void this.checkAlerts(), this.opts.alertCheckMs ?? 60_000);
      this.alertTimer.unref();
    }
    this.maintenance();
    this.maintenanceTimer = setInterval(() => this.maintenance(), this.opts.maintenanceMs ?? 60 * 60_000);
    this.maintenanceTimer.unref();
    log.info(
      { mode: config.wa.mode, api: config.api ? config.api.baseUrl : null, out: config.dirs.out },
      'backend started',
    );
  }

  /**
   * L2-02 (a): a store without captures next to an archive with records (lost state volume, new
   * machine, the restore drill) rebuilds the captures from the archive before anything is
   * published. Generates may run meanwhile; deploys wait (publishGate) until the restore's
   * pipeline work is drained and a generate has read the complete store.
   */
  private async detectRestore(): Promise<{ total: number; done: boolean; promise: Promise<void> } | null> {
    if (this.store.captures.count() > 0) return null;
    let records: string[];
    try {
      records = await listArchiveRecords(this.config.dirs.archive);
    } catch (err) {
      this.log.error({ err }, 'cannot list the archive; no automatic restore');
      return null;
    }
    if (records.length === 0) return null;
    const state = { total: records.length, done: false, promise: Promise.resolve() };
    this.restoreState = state;
    // Without an API the owner's content is gone with the store: no automatic publish afterwards.
    if (!this.config.api) this.store.syncState.set(RESTORE_CONFIRM_KEY, this.now().toISOString());
    return state;
  }

  private runRestore(state: { total: number; done: boolean; promise: Promise<void> }): void {
    this.log.warn({ records: state.total }, `restoring ${state.total} captures from the archive`);
    this.store.events.append('backend.restore_started', { records: state.total });
    state.promise = this.ingest
      .reprocess()
      .then(
        (ready) => {
          this.log.info({ ready, records: state.total }, 'archive restore finished');
          this.store.events.append('backend.restore_finished', { ready, records: state.total });
        },
        (err: unknown) => this.log.error({ err }, 'archive restore failed; deploys stay paused until it is redone'),
      )
      .finally(() => {
        state.done = true;
        this.gateMayHaveOpened();
      });
    // Captures becoming ready meanwhile trigger generates; the gate is re-checked after each.
  }

  /** Resolves when an automatic archive restore (if any) has finished (tests, CLI). */
  async restoreDone(): Promise<void> {
    await this.restoreState?.promise;
  }

  /**
   * L2-02 (d): the site version never goes backwards. A fresh store (state volume lost) starts
   * from max(local, deploy record, remote manifest) of the enabled targets.
   */
  private async raiseVersionFloor(): Promise<void> {
    const floorOf = this.publisher.versionFloor?.bind(this.publisher);
    if (!floorOf) return;
    try {
      const floor = await withTimeout(floorOf(), this.opts.versionFloorTimeoutMs ?? 30_000, () =>
        this.log.warn('reading the published site version timed out; the deploy checks it again'),
      );
      const local = this.store.meta.siteVersion();
      if (floor !== undefined && floor !== null && floor > local) {
        this.store.meta.raiseSiteVersion(floor);
        this.log.warn({ local, published: floor }, 'site version continues above the published one');
      }
    } catch (err) {
      this.log.warn({ err }, 'cannot read the published site version; the deploy checks it again');
    }
  }

  /** L1-09: one-time `chmod go-rwx` over ARCHIVE_DIR and DATA_DIR of installs from before. */
  private async tightenPrivateModes(): Promise<void> {
    if (this.store.meta.get(PRIVATE_MODES_KEY)) return;
    let changed = 0;
    let errors = 0;
    for (const dir of new Set([this.config.dirs.archive, this.config.dirs.data])) {
      const r = await restrictTree(dir);
      changed += r.changed;
      errors += r.errors;
    }
    if (changed > 0 || errors > 0) {
      this.log.info({ changed, errors }, 'permissions of ARCHIVE_DIR and DATA_DIR tightened (owner only)');
    }
    this.store.meta.set(PRIVATE_MODES_KEY, this.now().toISOString());
  }

  /** Hourly housekeeping (L2-08): bounded event log and change-feed quarantine. */
  maintenance(): { events: number; quarantined: number } {
    try {
      const events = this.store.events.prune(EVENTS_KEEP);
      const quarantined = this.store.owner.pruneQuarantine(new Date(this.now().getTime() - QUARANTINE_KEEP_MS));
      if (events > 0 || quarantined > 0) this.log.info({ events, quarantined }, 'old events pruned');
      return { events, quarantined };
    } catch (err) {
      this.log.warn({ err }, 'maintenance failed');
      return { events: 0, quarantined: 0 };
    }
  }

  // ------------------------------------------------------------------------------- generate/publish

  private async runGenerate(job: BuildJob): Promise<undefined | 'deferred'> {
    // The generator rejects the whole run for one invalid date; such a job (e.g. from a damaged
    // persisted "build_pending") would otherwise be retried forever.
    const dates = job.dates.filter((d) => isValidLocalDate(d));
    if (dates.length < job.dates.length) {
      this.log.warn(
        { dropped: job.dates.filter((d) => !isValidLocalDate(d)) },
        'ignoring invalid dates in a generate request',
      );
    }
    const result = await this.outLock.run(async () => {
      // Checked again inside the lock: the feed may have started a multi-page catch-up while
      // this job waited for a deploy (L2-03). The generator re-checks in its read transaction.
      if (!job.holdExpired && this.sync.catchingUp()) return null;
      // The gate as of the store snapshot this generate reads (see outDirGatedBy).
      const gateAtStart = this.snapshotGate();
      const pre = preGenerateSnapshot(this.store);
      let r: GenerateResultLike;
      try {
        r = await this.generator.generate({
          ...(job.full ? { full: true } : {}),
          ...(dates.length > 0 ? { dates } : {}),
          reason: job.reason,
          ...(job.holdExpired ? {} : { holdWhileFeedCatchingUp: true }),
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'FeedCatchingUpError') return null;
        throw err;
      }
      const snapshot: GenerateSnapshot = {
        version: r.version,
        at: this.now().toISOString(),
        feedSeq: pre.feedSeq,
        capturesThrough: pre.capturesThrough,
        full: r.full,
        durationMs: Math.round(r.durationMs),
        changed: r.changed.length,
        removed: r.removed.length,
      };
      writeGenerateSnapshot(this.store, snapshot);
      this.outDirGatedBy = gateAtStart;
      return r;
    });
    if (!result) return 'deferred';
    this.lastGenerate = result;
    for (const p of result.removed) this.removedSinceDeploy.add(p);
    this.log.info(
      {
        version: result.version,
        full: result.full,
        changed: result.changed.length,
        removed: result.removed.length,
        ms: Math.round(result.durationMs),
        reason: job.reason,
      },
      'site generated',
    );
    this.scheduleDelayed(result.nextRunAt ?? null);
    const live = readPublishState(this.store).lastVersion;
    if (result.changed.length > 0 || result.removed.length > 0 || live !== result.version) {
      void this.publishRunner.trigger(job.reason.split(',').includes('manual') ? 'manual' : 'generate');
    }
    // The gate opened while this (gated) generate ran: generate again with it open.
    if (this.outDirGatedBy !== null) this.gateMayHaveOpened();
    return undefined;
  }

  private scheduleDelayed(nextRunAt: string | null): void {
    if (this.delayedTimer) clearTimeout(this.delayedTimer);
    this.delayedTimer = null;
    this.nextRunAt = nextRunAt;
    if (!nextRunAt || this.stopping) return;
    const at = Date.parse(nextRunAt);
    if (Number.isNaN(at)) return;
    // +1 s so the item is strictly public when the generator looks; re-armed in steps of <= 6 h.
    const delay = Math.min(Math.max(at - this.now().getTime() + 1_000, 1_000), 6 * 60 * 60_000);
    this.delayedTimer = setTimeout(() => {
      this.delayedTimer = null;
      if (this.now().getTime() >= at) this.scheduler.request({ reason: 'publish_at' });
      else this.scheduleDelayed(nextRunAt);
    }, delay);
    this.delayedTimer.unref();
  }

  private enabledTargets(): number {
    return this.enabledTargetIds().length;
  }

  private enabledTargetIds(): string[] {
    try {
      return this.publisher
        .listTargets()
        .filter((t) => t.enabled)
        .map((t) => t.id);
    } catch (err) {
      this.log.error({ err }, 'cannot read publish targets');
      return [];
    }
  }

  private targetExists(id: string): boolean {
    try {
      return this.publisher.listTargets().some((t) => t.id === id);
    } catch (err) {
      this.log.error({ err }, 'cannot read publish targets');
      return false;
    }
  }

  private async runDeploy(opts: { targetId?: string; reason: string; force?: boolean }): Promise<DeployResult[]> {
    return this.outLock.run(() => {
      // Taken inside the OUT_DIR lock: describes exactly the files this deploy sees, even if the
      // next generate (queued behind this deploy) finishes before the results are handled.
      const obsolete = [...this.removedSinceDeploy];
      this.deployContext = { snapshot: readGenerateSnapshot(this.store), obsolete };
      const deployOpts: DeployOptions = { reason: opts.reason };
      if (opts.targetId) deployOpts.targetId = opts.targetId;
      if (opts.force || this.takeForceToken()) deployOpts.force = true;
      if (obsolete.length > 0) deployOpts.knownObsolete = obsolete;
      return this.publisher.deploy(deployOpts);
    });
  }

  private onDeployResults(results: DeployResult[]): void {
    const ctx = this.deployContext;
    this.deployContext = null;
    if (results.length === 0) return;
    if (results.every((r) => r.ok)) for (const p of ctx?.obsolete ?? []) this.removedSinceDeploy.delete(p);
    for (const r of results) {
      if (r.ok)
        this.log.info({ target: r.targetId, version: r.version, uploaded: r.uploaded, deleted: r.deleted }, 'deployed');
      else this.log.error({ target: r.targetId, error: r.error }, 'deploy failed');
    }
    const snap = ctx ? ctx.snapshot : readGenerateSnapshot(this.store);
    this.sync.reportPublished(
      results,
      snap ? { version: snap.version, feedSeq: snap.feedSeq, capturesThrough: snap.capturesThrough } : undefined,
      this.enabledTargetIds(),
    );
    // A manual publish that succeeded on every target confirms a restore without an API.
    const manual = results.some((r) => (r.reason ?? '').split(',').includes('manual'));
    if (manual && results.every((r) => r.ok) && this.store.syncState.get(RESTORE_CONFIRM_KEY)) {
      this.store.syncState.delete(RESTORE_CONFIRM_KEY);
      this.log.info('restore confirmed by a manual publish: automatic publishing resumes');
    }
    // A target already serves a newer release (store lost): the publisher raised the version
    // floor; the next generate releases above it (L2-02 d).
    if (results.some((r) => r.errorCode === 'version_behind')) this.scheduler.request({ reason: 'version_floor' });
  }

  /**
   * `backend publish --force` next to a running daemon (CLI writes FORCE_PUBLISH_KEY, then asks
   * the daemon to publish): consumed by the next deploy, valid for 10 minutes.
   */
  private takeForceToken(): boolean {
    const at = this.store.syncState.get(FORCE_PUBLISH_KEY);
    if (!at) return false;
    this.store.syncState.delete(FORCE_PUBLISH_KEY);
    const age = this.now().getTime() - Date.parse(at);
    if (!(age >= 0 && age < FORCE_PUBLISH_TTL_MS)) return false;
    this.log.warn('deploy forced (backend publish --force): the mass-delete guard is off for this deploy');
    return true;
  }

  /** Evaluates the local alert conditions (NTFY_URL without an API). */
  async checkAlerts(): Promise<void> {
    if (!this.alerts) return;
    const wa = this.wa.snapshot();
    const waBad = ['logged_out', 'stream_replaced', 'banned', 'error'].includes(wa.state);
    await this.alerts.update('wa', {
      active: waBad,
      title: waBad ? `WhatsApp ${wa.state}` : 'WhatsApp',
      message: !waBad
        ? `WhatsApp is ${wa.state} again.`
        : wa.state === 'logged_out'
          ? 'The observer link was logged out. Open the control UI and link WhatsApp again.'
          : `WhatsApp state ${wa.state}${wa.reason ? ` (${wa.reason})` : ''}${wa.detail ? `: ${wa.detail}` : ''}.`,
      graceMs: this.opts.alertGraceMs ?? 2 * 60_000,
    });
    const failures = this.publishRunner.consecutiveFailures;
    const last = this.publishRunner.lastResults.find((r) => !r.ok);
    await this.alerts.update('publish', {
      active: failures >= 3,
      title: 'publishing fails',
      message:
        failures >= 3
          ? `${failures} deploys in a row failed${last ? `; last error (${last.targetId}): ${last.error ?? 'unknown'}` : ''}.`
          : 'Deploys succeed again.',
    });
  }

  // ------------------------------------------------------------------------------- shutdown

  stop(reason = 'stop'): Promise<void> {
    this.stopping ??= this.doStop(reason);
    return this.stopping;
  }

  private async doStop(reason: string): Promise<void> {
    const log = this.log;
    // One budget for the whole shutdown (compose stop_grace_period is 60 s), not one per step.
    const deadline = Date.now() + (this.opts.shutdownTimeoutMs ?? 45_000);
    log.info({ reason }, 'shutting down');
    if (this.delayedTimer) clearTimeout(this.delayedTimer);
    if (this.alertTimer) clearInterval(this.alertTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    // No new deploys from now on (a running one may finish): a generate that completes during
    // shutdown is deployed by the next start (its version is not live yet).
    this.publishRunner?.close();
    const step = async (name: string, fn: () => Promise<unknown> | unknown) => {
      try {
        await withTimeout(Promise.resolve().then(fn), Math.max(1_000, deadline - Date.now()), () =>
          log.warn({ step: name }, 'shutdown step timed out'),
        );
      } catch (err) {
        log.error({ err, step: name }, 'shutdown step failed');
      }
    };
    if (this.control) await step('control UI', () => this.control?.close());
    if (this.store) {
      await step('WhatsApp source', () => this.source.stop());
      await step('ingest', () => this.ingest.stop());
      await step('generate', () => this.scheduler.stop());
      await step('deploy', () => this.publishRunner.stop());
      if (this.backup) await step('API backup', () => this.backup?.stop());
      await step('sync', () => this.sync.stop());
      for (const off of this.unsubscribe.splice(0)) off();
      this.wa.detach();
      try {
        this.store.events.append('backend.stopped', { reason });
        if (this.started) this.store.syncState.set(RUN_STATE_KEY, 'stopped');
      } catch {
        // store already closed
      }
      if (this.ownsStore) this.store.close();
    }
    log.info('stopped');
  }

  // ------------------------------------------------------------------------------- ControlBackend

  async status(): Promise<AppStatus> {
    const now = this.now();
    const byState = this.store.captures.countByState() as Record<string, number>;
    const total = Object.values(byState).reduce((a, b) => a + b, 0);
    let ingestStats: Record<string, number> = {};
    try {
      ingestStats = this.ingest.stats();
    } catch {
      ingestStats = {};
    }
    const sched = this.scheduler.state();
    const lastResults: DeployResultView[] =
      this.publishRunner.lastResults.length > 0
        ? this.publishRunner.lastResults
        : (this.publisher.lastResults?.() ?? []);
    const nextPublishAt = this.nextRunAt ? { at: this.nextRunAt, dates: [] as string[] } : null;
    return {
      app: 'omw-backend',
      version: this.config.version ?? 'dev',
      env: this.config.env,
      startedAt: this.startedAt.toISOString(),
      now: now.toISOString(),
      uptimeS: Math.round((now.getTime() - this.startedAt.getTime()) / 1000),
      stopping: this.stopping !== null,
      wa: this.wa.snapshot(),
      captures: { byState, total, lastStatusAt: lastCaptureAt(this.store) },
      ingest: ingestStats,
      disk: {
        freeBytes: await statfsFree([
          this.config.dirs.data,
          this.config.dirs.archive,
          this.config.dirs.media,
          this.config.dirs.out,
        ]),
      },
      sync: this.sync.status(),
      build: {
        running: sched.running,
        pending: sched.pending,
        heldReason: sched.held,
        last: readGenerateSnapshot(this.store),
        lastError: this.scheduler.lastError,
        nextPublishAt,
      },
      publish: {
        running: this.publishRunner.busy,
        queued: this.publishRunner.isQueued,
        pausedReason: this.publishGate() ?? this.outDirGatedBy,
        targets: this.enabledTargets(),
        state: readPublishState(this.store),
        lastResults,
        lastAt: this.publishRunner.lastAt ?? readPublishState(this.store).lastAt ?? null,
        nextRetryAt: this.publishRunner.nextRetryAt,
      },
      site: { publicUrl: this.config.site.publicUrl, outDir: this.config.dirs.out },
    };
  }

  get targets(): TargetOps {
    const publisher = this.publisher;
    return {
      list: () => publisher.listTargets() as unknown as Record<string, unknown>[],
      save: (input) => publisher.saveTarget(input as never) as unknown as Record<string, unknown>,
      remove: (id) => publisher.removeTarget(id),
      test: (id) => publisher.testTarget(id),
    };
  }

  async rebuild(full: boolean): Promise<GenerateSummary | null> {
    this.scheduler.request({ full, reason: 'manual' });
    const before = this.lastGenerate;
    await this.scheduler.flush();
    if (this.scheduler.lastError) throw new Error(this.scheduler.lastError);
    const r = this.lastGenerate;
    if (!r || r === before) return null;
    return {
      version: r.version,
      changed: r.changed.length,
      removed: r.removed.length,
      full: r.full,
      durationMs: Math.round(r.durationMs),
    };
  }

  publishNow(targetId?: string, opts: { force?: boolean } = {}): Promise<DeployResultView[]> {
    return this.publishRunner.trigger('manual', targetId, opts.force ? { force: true } : {});
  }

  reprocess(sourceKey?: string): Promise<number> {
    return this.ingest.reprocess(sourceKey);
  }

  pairCode(phone: string): Promise<string> {
    return this.wa.requestPairCode(phone);
  }

  retryCapture(sourceKey: string): ActionResult {
    const row = this.store.captures.get(sourceKey);
    if (!row) return { ok: false, detail: `Unknown capture ${sourceKey}` };
    const ok = this.ingest.retry ? this.ingest.retry(sourceKey) : this.store.captures.retry(sourceKey);
    if (!ok) return { ok: false, detail: `${sourceKey} is ${row.state}: nothing to retry` };
    this.store.events.append('capture.retry', { sourceKey, from: row.state });
    this.sync.capturesChanged([sourceKey]);
    void this.ingest.drain().catch((err: unknown) => this.log.warn({ err }, 'drain after retry failed'));
    return { ok: true, detail: `Retrying ${sourceKey}.` };
  }

  skipCapture(sourceKey: string): ActionResult {
    const row = this.store.captures.get(sourceKey);
    if (!row) return { ok: false, detail: `Unknown capture ${sourceKey}` };
    if (!['awaiting_media', 'received', 'failed'].includes(row.state)) {
      return { ok: false, detail: `${sourceKey} is ${row.state}: only waiting or failed statuses can be skipped` };
    }
    const ok = this.store.captures.markMediaLost(sourceKey, 'skipped in the control UI');
    if (!ok) return { ok: false, detail: `Could not skip ${sourceKey}` };
    this.store.events.append('capture.skipped', { sourceKey, from: row.state });
    this.sync.capturesChanged([sourceKey]);
    return { ok: true, detail: `${sourceKey} marked as media lost.` };
  }

  syncPull(): Promise<number> {
    return this.sync.pullNow();
  }

  resyncCaptures(): number {
    return this.sync.resyncAllCaptures();
  }

  async restartWa(): Promise<ActionResult> {
    const restart = this.source.restart?.bind(this.source);
    if (!restart) return { ok: false, detail: 'This WhatsApp source cannot be restarted' };
    await restart();
    return { ok: true, detail: 'WhatsApp helper restarted.' };
  }

  quarantined(limit = 50) {
    return this.store.owner.quarantined(limit);
  }

  /** Captures still moving through the pipeline (for `backend status`). */
  pipelineCount(): number {
    const byState = this.store.captures.countByState() as Record<string, number>;
    return Object.entries(byState)
      .filter(([s]) => NOT_READY_STATES.has(s))
      .reduce((a, [, n]) => a + n, 0);
  }
}

export function createApp(deps: AppDeps): App {
  return new App(deps);
}
