/**
 * API sync client (plan A6): keeps the PHP API's capture mirror up to date and pulls the owner's
 * content into the local mirror.
 *
 * Push (durable, via the sync_outbox table; coalesced per kind+key, retried with backoff+jitter):
 *   capture    PUT  /api/v1/backend/captures/{sourceKey}            CaptureMirror
 *   preview    POST /api/v1/backend/captures/{sourceKey}/preview    multipart role+file
 *   revoke     POST /api/v1/backend/captures/{sourceKey}/revoke     CaptureRevoke
 *   published  POST /api/v1/backend/published                       PublishedReport (key = target)
 * capture/preview/revoke items are queued by the capture ingest in the same transaction as the
 * state change (capture/sync-outbox.ts); this module sends them. A capture item is always sent
 * with the capture's CURRENT row (captureMirrorFromRow), whatever payload was queued.
 * Heartbeat: POST /api/v1/backend/heartbeat every 60 s, sent directly (a stale heartbeat is
 *   worthless, so it is never queued).
 * Pull: GET /api/v1/backend/changes?after=<cursor> every 15 s and right after own writes, page by
 *   page until hasMore = false -> store.owner.applyChanges() (item-by-item validation and
 *   quarantine live in the store) -> onOwnerChange(). 409 feed_reset or a new feedId ->
 *   owner.beginRebuild() and replay from seq 0; the API may have been restored, so every capture
 *   is pushed again too.
 *
 * Without API_BASE_URL/API_TOKEN the sync is disabled: nothing is queued, every method is a no-op
 * (reportPublished still records the publish state for the control UI).
 *
 * Errors: 401/403 pause all API traffic for `authPauseMs` (the token is wrong or revoked; the
 * control UI shows it). Transient errors back off exponentially with jitter (Retry-After wins).
 * Permanent 4xx answers (e.g. 422 after a contract mismatch) are retried slowly (`permanentMs`),
 * never dropped, so a fixed API heals the queue; previews the API refuses (413/415) and previews
 * whose file is gone are dropped with an event.
 */
import { promises as fsp } from 'node:fs';
import { contractVersion } from '@omw/contracts';
import {
  CaptureMirror,
  CaptureRevoke,
  ChangesPage,
  Heartbeat,
  PREVIEW_UPLOAD,
  type PreviewRole,
  PublishedReport,
} from '@omw/contracts/api';
import type { WaState } from '@omw/contracts/wa';
import { captureMirrorFromRow, enqueueCaptureMirror, enqueuePreviews, enqueueRevoke } from '../capture/sync-outbox.js';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { mediaFilePath } from '../paths.js';
import type { OutboxItem, OutboxStats, Store } from '../store/index.js';
import { ApiClient, ApiRequestError } from './client.js';
import { Loop } from './loop.js';
import {
  type GenerateSnapshot,
  lastCaptureAt,
  mergePublishState,
  publishStateFor,
  readGenerateSnapshot,
  readPublishState,
  capturesThrough as watermark,
  writePublishState,
} from './watermarks.js';

export { ApiClient, ApiRequestError } from './client.js';
export { Loop } from './loop.js';
export * from './watermarks.js';

/** WhatsApp facts the heartbeat reports (provided by the orchestrator's WA monitor). */
export interface WaView {
  state: WaState;
  jid?: string | null | undefined;
  /** Traveler phone digits (TRAVELER_PHONE), null in fixture mode. */
  travelerPn: string | null;
  /** Traveler LID (configured or learned), null while unknown. */
  travelerLid: string | null;
  /** Helper counters (WaStatsEvent). */
  stats: Record<string, number>;
}

/** Structural subset of the publisher's DeployResult (backend/src/publisher). */
export interface DeployReport {
  targetId: string;
  ok: boolean;
  version: number | null;
  uploaded: number;
  deleted: number;
  error?: string | undefined;
}

/** What the deployed files contain (see watermarks.ts); defaults to the last generate snapshot. */
export interface PublishSnapshot {
  version?: number;
  feedSeq: number;
  capturesThrough: string | null;
}

export interface OwnerChange {
  /** Effective local dates whose content may have changed (sorted, unique). */
  localDates: string[];
  /** Trip slugs whose content may have changed. */
  trips: string[];
  /** Settings changed or the mirror was rebuilt: regenerate everything. */
  full: boolean;
  /** Feed items applied. */
  applied: number;
  reason: string;
}

export interface SyncStatus {
  enabled: boolean;
  baseUrl: string | null;
  /** Set while API traffic is paused after 401/403. */
  authPausedUntil: string | null;
  lastPullAt: string | null;
  lastPullError: string | null;
  lastPushAt: string | null;
  lastPushError: string | null;
  lastHeartbeatAt: string | null;
  lastHeartbeatError: string | null;
  feedId: string | null;
  feedSeq: number;
  rebuilding: boolean;
  quarantined: number;
  queue: OutboxStats;
}

export interface SyncOptions {
  pullIntervalMs?: number;
  heartbeatIntervalMs?: number;
  /** How often due outbox items are looked for (enqueueing also kicks the loop). */
  outboxIntervalMs?: number;
  pageLimit?: number;
  maxPagesPerPull?: number;
  authPauseMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  permanentMs?: number;
  /** Delay for 404 capture_not_mirrored (the capture PUT is usually just behind). */
  orderingMs?: number;
  requestTimeoutMs?: number;
  /** Purge completed outbox rows older than this. */
  keepDoneMs?: number;
}

export interface SyncDeps {
  config: Config;
  log: Logger;
  store: Store;
  wa?: () => WaView;
  /** Ingest counters for the heartbeat. */
  stats?: () => Record<string, number>;
  /** Overrides the client built from config.api (tests). null = disabled. */
  client?: ApiClient | null;
  fetch?: typeof fetch;
  now?: () => Date;
  /** [0, 1) for jitter. */
  random?: () => number;
  diskFree?: (dirs: readonly string[]) => Promise<number | null>;
  /** Ids of the enabled publish targets (publish state and heartbeat judge all of them). */
  enabledTargets?: () => readonly string[];
  options?: SyncOptions;
}

export interface Sync {
  readonly enabled: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Pulls the change feed until it is drained; resolves with the number of applied items. */
  pullNow(): Promise<number>;
  /** Sends every due outbox item now. */
  flushNow(): Promise<{ sent: number; failed: number; dropped: number }>;
  heartbeatNow(): Promise<boolean>;
  /**
   * Owner changes, emitted once a pull reached the end of the feed (never for a prefix of it):
   * the merged summary of every page applied since the last emit.
   */
  onOwnerChange(cb: (change: OwnerChange) => void): () => void;
  /**
   * True while the owner mirror may hold a prefix of a change (L2-03): a pull is running, or one
   * ended before the feed was caught up (pending summary, or a page with hasMore = true applied
   * and the rest not yet). Generates wait (BuildScheduler) while this is true.
   */
  catchingUp(): boolean;
  /**
   * L2-02 first-sync gate: true without an API, else once one pull reached the end of the feed
   * since the owner mirror was created or rebuilt (store sync_state owner_synced_at).
   */
  ownerSynced(): boolean;
  /** Called after every pull that reached the end of the feed. */
  onCaughtUp(cb: () => void): () => void;
  /**
   * Queues mirror/preview/revoke pushes for captures changed outside the ingest (control UI
   * retry/skip); no-op when disabled. The ingest queues its own changes.
   */
  capturesChanged(sourceKeys: readonly string[]): void;
  /** Queues every capture again (after an API restore); returns the number of captures. */
  resyncAllCaptures(): number;
  /**
   * Records deploy results (publish state over every enabled target, see mergePublishState) and
   * queues PublishedReports. `enabledTargets` defaults to SyncDeps.enabledTargets.
   */
  reportPublished(
    results: readonly DeployReport[],
    snapshot?: PublishSnapshot,
    enabledTargets?: readonly string[],
  ): void;
  buildHeartbeat(): Promise<Heartbeat>;
  status(): SyncStatus;
}

const DEFAULTS: Required<SyncOptions> = {
  pullIntervalMs: 15_000,
  heartbeatIntervalMs: 60_000,
  outboxIntervalMs: 5_000,
  pageLimit: 200,
  maxPagesPerPull: 500,
  authPauseMs: 5 * 60_000,
  backoffBaseMs: 5_000,
  backoffMaxMs: 15 * 60_000,
  permanentMs: 60 * 60_000,
  orderingMs: 30_000,
  requestTimeoutMs: 20_000,
  keepDoneMs: 7 * 24 * 60 * 60_000,
};

const MIRROR_INIT_KEY = 'mirror_initialized_for';

/** Preview outbox payload (capture/sync-outbox.ts PreviewOutboxPayload; `mime` accepted too). */
interface PreviewPayload {
  sourceKey: string;
  role: PreviewRole;
  relPath: string;
  contentType?: string;
  mime?: string;
}

type SendOutcome =
  | { status: 'sent' }
  | { status: 'dropped'; reason: string }
  | { status: 'failed'; error: ApiRequestError | Error };

export async function statfsFree(dirs: readonly string[]): Promise<number | null> {
  let min: number | null = null;
  for (const dir of new Set(dirs)) {
    try {
      const s = await fsp.statfs(dir);
      const free = Number(s.bavail) * Number(s.bsize);
      if (Number.isFinite(free)) min = min === null ? free : Math.min(min, free);
    } catch {
      // directory missing or statfs unsupported: ignore
    }
  }
  return min;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 2000);

/** ITU-T E.164 country calling codes with one or two digits; every other code has three. */
const CALLING_CODES_1 = new Set(['1', '7']);
const CALLING_CODES_2 = new Set(
  (
    '20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 ' +
    '60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98'
  ).split(' '),
);

/**
 * Masks an international phone number (digits, optionally with "+") to its country calling code
 * and last two digits: "4915187654321" -> "+49…21". null/empty stays null; anything that is not
 * a plausible number is masked completely ("…").
 */
export function maskPhoneNumber(pn: string | null | undefined): string | null {
  if (!pn) return null;
  const digits = pn.replace(/\D/g, '');
  if (digits.length < 6) return '…';
  const cc = CALLING_CODES_1.has(digits.slice(0, 1))
    ? digits.slice(0, 1)
    : CALLING_CODES_2.has(digits.slice(0, 2))
      ? digits.slice(0, 2)
      : digits.slice(0, 3);
  return `+${cc}…${digits.slice(-2)}`;
}

export function createSync(deps: SyncDeps): Sync {
  return new SyncEngine(deps);
}

class SyncEngine implements Sync {
  readonly enabled: boolean;
  private readonly client: ApiClient | null;
  private readonly store: Store;
  private readonly log: Logger;
  private readonly config: Config;
  private readonly opts: Required<SyncOptions>;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly listeners = new Set<(change: OwnerChange) => void>();
  private readonly pullLoop: Loop;
  private readonly outboxLoop: Loop;
  private readonly heartbeatLoop: Loop;
  private stopped = false;
  private started = false;

  private pullRunning: Promise<number> | null = null;
  private pullQueued: Promise<number> | null = null;
  private flushRunning: Promise<{ sent: number; failed: number; dropped: number }> | null = null;
  private authPausedUntil = 0;
  /** Pushes wait until then after a 429/503 (Retry-After or backoff of the failed item). */
  private pushPausedUntil = 0;
  /** The current push pause comes from a 429 (rate limit), which an outage end never lifts. */
  private pushPausedByRateLimit = false;
  private lastPullError: string | null = null;
  private lastPushAt: string | null = null;
  private lastPushError: string | null = null;
  private lastHeartbeatAt: string | null = null;
  private lastHeartbeatError: string | null = null;
  private lastPurgeAt = 0;
  /** Owner change accumulated by pulls that ended before the feed was caught up (L2-03). */
  private pendingChange: {
    dates: Set<string>;
    trips: Set<string>;
    reasons: Set<string>;
    full: boolean;
    applied: number;
  } | null = null;
  /** Pages applied by the running pull (> 0 while a pull runs). */
  private pullPages = 0;
  private readonly caughtUpListeners = new Set<() => void>();
  /**
   * Set (ms) when a request found the API unreachable (network error, timeout, or 502/503/504
   * from a proxy or the deploy's maintenance mode). The next successful request clears it and
   * makes the pushes that failed meanwhile due at once (apiReachable).
   */
  private unreachableSince: number | null = null;

  private readonly deps: SyncDeps;

  constructor(deps: SyncDeps) {
    this.deps = deps;
    this.store = deps.store;
    this.config = deps.config;
    this.log = deps.log.child({ module: 'sync' });
    this.opts = { ...DEFAULTS, ...deps.options };
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? Math.random;
    if (deps.client !== undefined) {
      this.client = deps.client;
    } else if (deps.config.api) {
      this.client = new ApiClient({
        baseUrl: deps.config.api.baseUrl,
        token: deps.config.api.token,
        timeoutMs: this.opts.requestTimeoutMs,
        userAgent: `omw-backend/${deps.config.version ?? 'dev'}`,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
    } else {
      this.client = null;
    }
    this.enabled = this.client !== null;
    this.pullLoop = new Loop(
      'change feed pull',
      () => this.opts.pullIntervalMs,
      () => this.pullNow(),
      this.log,
    );
    this.outboxLoop = new Loop(
      'outbox',
      () => this.opts.outboxIntervalMs,
      () => this.flushNow(),
      this.log,
    );
    this.heartbeatLoop = new Loop(
      'heartbeat',
      () => this.opts.heartbeatIntervalMs,
      () => this.heartbeatNow(),
      this.log,
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.client) {
      this.log.info('API sync disabled (API_BASE_URL/API_TOKEN not set): publishing captures only');
      return;
    }
    const ss = this.store.syncState;
    if (!ss.ownerSyncedAt() && ss.feedCursor() > 0 && !ss.rebuildPending() && !ss.catchingUpSince()) {
      // A mirror from before the first-sync gate existed (cursor advanced, no replay in progress):
      // it was complete when that version last pulled.
      const at = ss.lastPullAt();
      ss.setOwnerSynced(at ? new Date(at) : this.now());
      this.log.info({ feedSeq: ss.feedCursor() }, 'existing owner mirror treated as synced');
    }
    // Items an older version skipped as unknown (e.g. profile settings saved in a newer admin
    // before this backend was upgraded): the cursor is past them, so replay the feed once.
    const known = this.store.owner.replayIgnoredIfKnown();
    if (known.length > 0) {
      this.log.warn({ kinds: known }, 'feed items an older version ignored are known now: replaying the owner feed');
    }
    if (this.store.syncState.get(MIRROR_INIT_KEY) !== this.client.baseUrl) {
      const n = this.resyncAllCaptures();
      this.store.syncState.set(MIRROR_INIT_KEY, this.client.baseUrl);
      this.log.info({ captures: n, api: this.client.baseUrl }, 'queued the full capture mirror for this API');
    }
    this.log.info({ api: this.client.baseUrl }, 'API sync started');
    this.outboxLoop.start(200);
    this.pullLoop.start(500);
    this.heartbeatLoop.start(1_000);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.client?.abortAll();
    await Promise.allSettled([this.pullLoop.stop(), this.outboxLoop.stop(), this.heartbeatLoop.stop()]);
    await Promise.allSettled([this.pullRunning, this.flushRunning].filter(Boolean));
  }

  onOwnerChange(cb: (change: OwnerChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private enabledTargets(): readonly string[] | null {
    try {
      return this.deps.enabledTargets?.() ?? null;
    } catch (err) {
      this.log.warn({ err }, 'cannot list the enabled publish targets');
      return null;
    }
  }

  private authPaused(): boolean {
    return this.authPausedUntil > this.now().getTime();
  }

  private pauseForAuth(err: ApiRequestError): void {
    const until = this.now().getTime() + this.opts.authPauseMs;
    if (!this.authPaused()) {
      this.log.error(
        { status: err.status, code: err.code },
        'API rejected the backend token (API_TOKEN); pausing API sync. Check the token in the admin settings.',
      );
      this.store.events.append('sync.auth_failed', { status: err.status, code: err.code });
    }
    this.authPausedUntil = until;
  }

  /** Remembers the start of an outage when `err` means the API did not answer at all. */
  private noteUnreachable(err: unknown): void {
    if (this.unreachableSince !== null) return;
    if (
      err instanceof ApiRequestError &&
      err.errorClass === 'transient' &&
      (err.kind !== 'http' || err.status === 502 || err.status === 503 || err.status === 504)
    ) {
      this.unreachableSince = this.now().getTime();
    }
  }

  /**
   * The API answered: if it was unreachable before, every push that failed during the outage is
   * due now (no waiting for its exponential backoff) and the outbox loop runs right away.
   */
  private apiReachable(): void {
    if (this.unreachableSince === null) return;
    const since = new Date(this.unreachableSince);
    this.unreachableSince = null;
    if (!this.pushPausedByRateLimit) this.pushPausedUntil = 0;
    let n = 0;
    try {
      n = this.store.outbox.retryFailedSince(since);
    } catch (err) {
      this.log.warn({ err }, 'rescheduling the outbox after the outage failed');
      return;
    }
    this.log.info({ outageSince: since.toISOString(), retrying: n }, 'API reachable again');
    if (n > 0) this.outboxLoop.kick(0);
  }

  // ------------------------------------------------------------------------------- pull

  pullNow(): Promise<number> {
    if (!this.client || this.stopped) return Promise.resolve(0);
    if (this.pullQueued) return this.pullQueued;
    if (this.pullRunning) {
      const queued = this.pullRunning
        .catch(() => 0)
        .then(() => {
          this.pullQueued = null;
          return this.startPull();
        });
      this.pullQueued = queued;
      return queued;
    }
    return this.startPull();
  }

  private startPull(): Promise<number> {
    const p = this.doPull().finally(() => {
      if (this.pullRunning === p) this.pullRunning = null;
    });
    this.pullRunning = p;
    return p;
  }

  /**
   * Pulls pages until the feed reports hasMore = false. The owner change is emitted only then
   * (L2-03): a pull that stops early (page limit, a failed page fetch, a stalled cursor, shutdown)
   * keeps its summary pending and a later pull emits it, merged, once the feed is caught up. So a
   * generate never sees a half-applied change (e.g. a new publish.mode without its mode_since).
   */
  private async doPull(): Promise<number> {
    const client = this.client;
    if (!client || this.stopped) return 0;
    if (this.authPaused()) throw new Error('API sync paused after an authentication failure');
    if (!this.pendingChange) {
      this.pendingChange = {
        dates: new Set<string>(),
        trips: new Set<string>(),
        reasons: new Set<string>(),
        full: false,
        applied: 0,
      };
    }
    const acc = this.pendingChange;
    let applied = 0;
    let resets = 0;
    let pages = 0;
    let caughtUp = false;
    this.pullPages = 0;
    try {
      for (;;) {
        if (this.stopped) break;
        const after = this.store.syncState.feedCursor();
        let raw: unknown;
        try {
          raw = await client.changes(after, this.opts.pageLimit);
        } catch (err) {
          if (err instanceof ApiRequestError && err.errorClass === 'feed_reset') {
            if (++resets > 2) throw new Error('change feed keeps resetting; giving up for this pull');
            this.log.warn({ after }, 'API answered feed_reset: rebuilding the owner mirror from seq 0');
            this.store.owner.beginRebuild(null, `409 feed_reset (after=${after})`);
            acc.full = true;
            acc.reasons.add('feed_reset');
            this.resyncAllCaptures();
            continue;
          }
          throw err;
        }
        const envelope = ChangesPage.safeParse(raw);
        if (!envelope.success) {
          throw new ApiRequestError(`invalid change feed page: ${envelope.error.message.slice(0, 300)}`, {
            kind: 'invalid_response',
          });
        }
        const summary = this.store.owner.applyChanges(envelope.data);
        pages++;
        this.pullPages = pages;
        this.store.syncState.setLastPullAt(this.now());
        if (summary.reset) {
          if (++resets > 2) throw new Error('change feed keeps changing its id; giving up for this pull');
          this.log.warn({ feedId: envelope.data.feedId }, 'API change feed has a new id: rebuilding the owner mirror');
          acc.full = true;
          acc.reasons.add('feed_id_changed');
          this.resyncAllCaptures();
          continue;
        }
        applied += summary.applied;
        acc.applied += summary.applied;
        for (const d of summary.localDates) acc.dates.add(d);
        for (const t of summary.trips) acc.trips.add(t);
        if (summary.settingsChanged) {
          acc.full = true;
          acc.reasons.add(summary.rebuilt ? 'mirror_rebuilt' : 'settings');
        }
        if (summary.quarantined > 0) {
          this.log.warn({ quarantined: summary.quarantined }, 'change feed items quarantined (see control UI)');
        }
        if (!envelope.data.hasMore) {
          caughtUp = true;
          break;
        }
        if (summary.cursor <= after) {
          this.log.warn(
            { after, nextSeq: envelope.data.nextSeq },
            'change feed did not advance; stopping this pull (owner changes stay pending)',
          );
          break;
        }
        if (pages >= this.opts.maxPagesPerPull) {
          this.pullLoop.kick(0);
          break;
        }
      }
      this.lastPullError = null;
      this.apiReachable();
      return applied;
    } catch (err) {
      this.lastPullError = errorMessage(err);
      if (err instanceof ApiRequestError && err.errorClass === 'auth') this.pauseForAuth(err);
      this.noteUnreachable(err);
      throw err;
    } finally {
      this.pullPages = 0;
      if (caughtUp) {
        this.pendingChange = null;
        if (!this.store.syncState.ownerSyncedAt() && !this.store.syncState.rebuildPending()) {
          this.store.syncState.setOwnerSynced(this.now());
          this.log.info({ feedSeq: this.store.syncState.feedCursor() }, 'owner content synced from the API');
        }
        if (acc.applied > 0 || acc.full) {
          if (acc.applied > 0) acc.reasons.add('owner_changes');
          this.emit({
            localDates: [...acc.dates].sort(),
            trips: [...acc.trips].sort(),
            full: acc.full,
            applied: acc.applied,
            reason: [...acc.reasons].join(','),
          });
        }
        this.notifyCaughtUp();
      } else if (acc.applied === 0 && !acc.full && !this.store.syncState.catchingUpSince()) {
        this.pendingChange = null; // nothing applied and nothing half-applied: nothing to hold back
      }
    }
  }

  catchingUp(): boolean {
    return this.pendingChange !== null || this.pullPages > 0 || this.store.syncState.catchingUpSince() !== null;
  }

  ownerSynced(): boolean {
    return !this.enabled || this.store.syncState.ownerSyncedAt() !== null;
  }

  onCaughtUp(cb: () => void): () => void {
    this.caughtUpListeners.add(cb);
    return () => this.caughtUpListeners.delete(cb);
  }

  private notifyCaughtUp(): void {
    for (const cb of this.caughtUpListeners) {
      try {
        cb();
      } catch (err) {
        this.log.error({ err }, 'caught-up listener failed');
      }
    }
  }

  private emit(change: OwnerChange): void {
    for (const cb of this.listeners) {
      try {
        cb(change);
      } catch (err) {
        this.log.error({ err }, 'owner change listener failed');
      }
    }
  }

  // ------------------------------------------------------------------------------- push

  capturesChanged(sourceKeys: readonly string[]): void {
    if (!this.client) return;
    let queued = 0;
    for (const key of new Set(sourceKeys)) queued += this.enqueueCapture(key) ? 1 : 0;
    if (queued > 0) this.outboxLoop.kick(250);
  }

  resyncAllCaptures(): number {
    if (!this.client) return 0;
    const rows = this.store.captures.list();
    this.store.transaction(() => {
      for (const row of rows) this.enqueueCapture(row.sourceKey);
    });
    if (rows.length > 0) this.outboxLoop.kick(250);
    return rows.length;
  }

  private enqueueCapture(sourceKey: string): boolean {
    const row = this.store.captures.get(sourceKey);
    if (!row) return false;
    try {
      enqueueCaptureMirror(this.store, row);
      enqueueRevoke(this.store, row);
      if (row.state === 'ready') enqueuePreviews(this.store, row);
      return true;
    } catch (err) {
      this.log.error({ err, sourceKey }, 'cannot queue the capture mirror');
      return false;
    }
  }

  reportPublished(
    results: readonly DeployReport[],
    snapshot?: PublishSnapshot,
    enabledTargets?: readonly string[],
  ): void {
    if (results.length === 0) return;
    const at = this.now().toISOString();
    const snap: PublishSnapshot | GenerateSnapshot = snapshot ??
      readGenerateSnapshot(this.store) ?? {
        feedSeq: this.store.syncState.feedCursor(),
        capturesThrough: watermark(this.store),
      };
    const enabled = enabledTargets ?? this.enabledTargets();
    writePublishState(this.store, mergePublishState(readPublishState(this.store), results, at, enabled, snap.version));
    if (!this.client) return;
    for (const r of results) {
      const report = PublishedReport.safeParse({
        contractVersion,
        version: r.version ?? snap.version ?? this.store.meta.siteVersion(),
        at,
        target: r.targetId.slice(0, 64) || 'unknown',
        ok: r.ok,
        uploaded: Math.max(0, Math.trunc(r.uploaded)),
        deleted: Math.max(0, Math.trunc(r.deleted)),
        feedSeq: snap.feedSeq,
        capturesThrough: snap.capturesThrough,
        ...(r.error ? { error: r.error.slice(0, 2000) } : {}),
      });
      if (!report.success) {
        this.log.error({ target: r.targetId, error: report.error.message }, 'invalid publish report (not sent)');
        continue;
      }
      this.store.outbox.enqueue('published', report.data.target, report.data);
    }
    this.outboxLoop.kick(0);
  }

  flushNow(): Promise<{ sent: number; failed: number; dropped: number }> {
    if (!this.client || this.stopped) return Promise.resolve({ sent: 0, failed: 0, dropped: 0 });
    if (this.flushRunning) return this.flushRunning;
    const p = this.doFlush().finally(() => {
      this.flushRunning = null;
    });
    this.flushRunning = p;
    return p;
  }

  private async doFlush(): Promise<{ sent: number; failed: number; dropped: number }> {
    const totals = { sent: 0, failed: 0, dropped: 0 };
    if (this.authPaused() || this.pushPausedUntil > this.now().getTime()) return totals;
    this.purgeDone();
    for (let round = 0; round < 40 && !this.stopped; round++) {
      const items = this.store.outbox.due(25);
      if (items.length === 0) break;
      for (const item of items) {
        if (this.stopped) return totals;
        const outcome = await this.sendItem(item);
        if (outcome.status === 'sent') {
          this.store.outbox.markDone(item.id, item.rev);
          this.apiReachable();
          totals.sent++;
          this.lastPushAt = this.now().toISOString();
          this.lastPushError = null;
        } else if (outcome.status === 'dropped') {
          this.store.outbox.markDone(item.id, item.rev);
          this.store.events.append('sync.outbox_dropped', { kind: item.kind, key: item.key, reason: outcome.reason });
          this.log.warn({ kind: item.kind, key: item.key, reason: outcome.reason }, 'outbox item dropped');
          totals.dropped++;
        } else {
          totals.failed++;
          const err = outcome.error;
          const cls = err instanceof ApiRequestError ? err.errorClass : 'permanent';
          if (cls === 'aborted') return totals;
          this.lastPushError = errorMessage(err);
          // Before markFailed: the outage start must not be later than this item's updated_at.
          this.noteUnreachable(err);
          const delay = this.retryDelay(item, err);
          this.store.outbox.markFailed(item.id, errorMessage(err), new Date(this.now().getTime() + delay));
          const level = cls === 'permanent' ? 'error' : 'warn';
          this.log[level](
            { kind: item.kind, key: item.key, attempts: item.attempts + 1, retryInMs: delay, err: errorMessage(err) },
            'API push failed',
          );
          if (err instanceof ApiRequestError && cls === 'auth') {
            this.pauseForAuth(err);
            return totals;
          }
          if (cls === 'transient' && err instanceof ApiRequestError && err.kind !== 'http') {
            // The API is unreachable: do not hammer it with the rest of the batch.
            return totals;
          }
          if (err instanceof ApiRequestError && (err.status === 429 || err.status === 503)) {
            // Rate limited / overloaded: pause every push for as long as this item waits.
            this.pushPausedUntil = this.now().getTime() + delay;
            this.pushPausedByRateLimit = err.status === 429;
            return totals;
          }
        }
      }
    }
    if (totals.sent > 0) this.pullLoop.kick(500); // "pull right after own writes"
    return totals;
  }

  private retryDelay(item: OutboxItem, err: Error): number {
    const cls = err instanceof ApiRequestError ? err.errorClass : 'permanent';
    const jitter = 0.5 + this.random(); // 0.5 .. 1.5
    if (err instanceof ApiRequestError && err.retryAfterMs !== null) return Math.max(1_000, err.retryAfterMs);
    if (cls === 'ordering') return Math.round(Math.min(this.opts.orderingMs * jitter, this.opts.backoffMaxMs));
    if (cls === 'permanent') return Math.round(this.opts.permanentMs * jitter);
    const exp = this.opts.backoffBaseMs * 2 ** Math.min(item.attempts, 20);
    return Math.round(Math.min(exp, this.opts.backoffMaxMs) * jitter);
  }

  private purgeDone(): void {
    const now = this.now().getTime();
    if (now - this.lastPurgeAt < 60 * 60_000) return;
    this.lastPurgeAt = now;
    try {
      this.store.outbox.purgeDone(new Date(now - this.opts.keepDoneMs));
    } catch (err) {
      this.log.warn({ err }, 'outbox purge failed');
    }
  }

  private async sendItem(item: OutboxItem): Promise<SendOutcome> {
    const client = this.client;
    if (!client) return { status: 'failed', error: new Error('sync disabled') };
    try {
      switch (item.kind) {
        case 'capture':
          return await this.sendCapture(client, item);
        case 'preview':
          return await this.sendPreview(client, item);
        case 'revoke': {
          const at = (item.payload as { at?: unknown } | null)?.at;
          const body = CaptureRevoke.safeParse({ contractVersion, at });
          if (!body.success) return { status: 'dropped', reason: 'invalid revoke payload' };
          await client.revoke(item.key, body.data);
          return { status: 'sent' };
        }
        case 'published': {
          const body = PublishedReport.safeParse(item.payload);
          if (!body.success) return { status: 'dropped', reason: 'invalid publish report' };
          await client.published(body.data);
          return { status: 'sent' };
        }
        case 'heartbeat': {
          const body = Heartbeat.safeParse(item.payload);
          if (!body.success) return { status: 'dropped', reason: 'invalid heartbeat' };
          await client.heartbeat(body.data);
          return { status: 'sent' };
        }
      }
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err : new Error(String(err)) };
    }
    return { status: 'dropped', reason: `unknown outbox kind ${String(item.kind)}` };
  }

  private async sendCapture(client: ApiClient, item: OutboxItem): Promise<SendOutcome> {
    const row = this.store.captures.get(item.key);
    let body: CaptureMirror;
    if (row) {
      body = captureMirrorFromRow(row); // freshest state, whatever was queued
    } else {
      const queued = CaptureMirror.safeParse(item.payload);
      if (!queued.success) return { status: 'dropped', reason: 'capture not in the store and no valid payload' };
      body = queued.data;
    }
    await client.putCapture(body);
    return { status: 'sent' };
  }

  private async sendPreview(client: ApiClient, item: OutboxItem): Promise<SendOutcome> {
    const payload = item.payload as Partial<PreviewPayload> | null;
    const mime = payload?.contentType ?? payload?.mime;
    if (!payload?.sourceKey || !payload.role || !payload.relPath || !mime) {
      return { status: 'dropped', reason: 'invalid preview payload' };
    }
    if (!(PREVIEW_UPLOAD.mimeTypes as readonly string[]).includes(mime)) {
      return { status: 'dropped', reason: `unsupported preview type ${mime}` };
    }
    let bytes: Uint8Array;
    try {
      bytes = await fsp.readFile(mediaFilePath(this.config.dirs.media, payload.relPath));
    } catch (err) {
      return { status: 'dropped', reason: `preview file unreadable: ${errorMessage(err)}` };
    }
    if (bytes.byteLength > PREVIEW_UPLOAD.maxBytes) {
      return { status: 'dropped', reason: `preview larger than ${PREVIEW_UPLOAD.maxBytes} bytes` };
    }
    const ext = mime === 'image/webp' ? 'webp' : 'jpg';
    try {
      await client.uploadPreview(payload.sourceKey, payload.role, {
        bytes,
        mime,
        filename: `${payload.role}.${ext}`,
      });
    } catch (err) {
      if (err instanceof ApiRequestError && (err.status === 413 || err.status === 415)) {
        return { status: 'dropped', reason: `API refused the preview: ${err.message}` };
      }
      throw err;
    }
    return { status: 'sent' };
  }

  // ------------------------------------------------------------------------------- heartbeat

  async buildHeartbeat(): Promise<Heartbeat> {
    const wa: WaView = this.deps.wa?.() ?? {
      state: 'closed',
      travelerPn: this.config.wa.travelerPhone,
      travelerLid: this.config.wa.travelerLid,
      stats: {},
    };
    const queue = this.store.outbox.stats();
    const counts = this.store.captures.countByState();
    const stats: Record<string, number> = {};
    for (const [k, v] of Object.entries(wa.stats)) if (Number.isFinite(v)) stats[k] = v;
    for (const [k, v] of Object.entries(this.deps.stats?.() ?? {})) if (Number.isFinite(v)) stats[`ingest.${k}`] = v;
    const dirs = [this.config.dirs.data, this.config.dirs.archive, this.config.dirs.media, this.config.dirs.out];
    const free = await (this.deps.diskFree ?? statfsFree)(dirs);
    const publish = publishStateFor(readPublishState(this.store), this.enabledTargets());
    const lastStatusAt = lastCaptureAt(this.store);
    return Heartbeat.parse({
      contractVersion,
      at: this.now().toISOString(),
      backendVersion: this.config.version ?? 'dev',
      // Privacy (L1-03): the API stores the heartbeat (and its nightly backups) on a shared host.
      // The observer's JID is never sent, the traveler's number only masked ("+49…78"); the full
      // values stay in the local control UI. The admin only checks whether a number is configured.
      wa: {
        state: wa.state,
        ...(lastStatusAt ? { lastStatusAt } : {}),
        traveler: { pn: maskPhoneNumber(wa.travelerPn), lidKnown: Boolean(wa.travelerLid) },
      },
      queue: {
        pending: queue.pending,
        failed: queue.failed,
        ...(queue.oldestAt ? { oldestAt: new Date(queue.oldestAt).toISOString() } : {}),
      },
      sync: {
        feedId: this.store.syncState.feedId() ?? null,
        feedSeq: this.store.syncState.feedCursor(),
        lastPullAt: this.store.syncState.lastPullAt(),
        quarantined: this.store.owner.quarantineCount(),
      },
      captures: { awaitingMedia: counts.awaiting_media, failed: counts.failed, mediaLost: counts.media_lost },
      stats,
      disk: { freeBytes: Math.max(0, Math.trunc(free ?? 0)) },
      publish: {
        ...(publish.lastVersion !== undefined ? { lastVersion: publish.lastVersion } : {}),
        ...(publish.lastAt ? { lastAt: publish.lastAt } : {}),
        ...(publish.lastError ? { lastError: publish.lastError } : {}),
      },
    });
  }

  async heartbeatNow(): Promise<boolean> {
    if (!this.client || this.stopped || this.authPaused()) return false;
    let body: Heartbeat;
    try {
      body = await this.buildHeartbeat();
    } catch (err) {
      this.lastHeartbeatError = `building the heartbeat failed: ${errorMessage(err)}`;
      this.log.error({ err }, 'building the heartbeat failed');
      return false;
    }
    const previous = this.lastHeartbeatError;
    try {
      await this.client.heartbeat(body);
      this.lastHeartbeatAt = body.at;
      this.lastHeartbeatError = null;
      this.apiReachable();
      return true;
    } catch (err) {
      this.lastHeartbeatError = errorMessage(err);
      this.noteUnreachable(err);
      if (err instanceof ApiRequestError && err.errorClass === 'auth') this.pauseForAuth(err);
      else if (!(err instanceof ApiRequestError && err.errorClass === 'aborted')) {
        // Log a failure once; repeats (API down for hours) only at debug level.
        const level = previous === this.lastHeartbeatError ? 'debug' : 'warn';
        this.log[level]({ err: this.lastHeartbeatError }, 'heartbeat failed');
      }
      return false;
    }
  }

  status(): SyncStatus {
    return {
      enabled: this.enabled,
      baseUrl: this.client?.baseUrl ?? null,
      authPausedUntil: this.authPaused() ? new Date(this.authPausedUntil).toISOString() : null,
      lastPullAt: this.store.syncState.lastPullAt(),
      lastPullError: this.lastPullError,
      lastPushAt: this.lastPushAt,
      lastPushError: this.lastPushError,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastHeartbeatError: this.lastHeartbeatError,
      feedId: this.store.syncState.feedId() ?? null,
      feedSeq: this.store.syncState.feedCursor(),
      rebuilding: this.store.syncState.rebuildPending(),
      quarantined: this.store.owner.quarantineCount(),
      queue: this.store.outbox.stats(),
    };
  }
}
