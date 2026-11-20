/**
 * Public interfaces of the capture module (WaSource = where statuses come from, Ingest = inbox ->
 * store -> archive -> media pipeline). Members marked "optional" were added after the interface was
 * agreed between the backend modules; implementations in this module always provide them.
 */
import type { WaCommand, WaEvent, WaState, WaStateReason } from '@omw/contracts/wa';
import type { WaMode } from '../config.js';

/** Lifecycle of the source process (helper) or the fixture replay. */
export type WaProcessState =
  /** not started or stopped */
  | 'stopped'
  /** spawning / waiting for the first output */
  | 'starting'
  /** process alive */
  | 'running'
  /** exited; restart scheduled at nextRestartAt */
  | 'backoff';

export interface WaSourceState {
  mode: WaMode;
  /** Last WhatsApp connection state ("connecting" until the helper reports one). */
  wa: WaState;
  reason: WaStateReason | null;
  /** Human-readable detail of the last state/exit (logs and control UI only). */
  detail: string | null;
  /** Ban end (state "banned"). */
  until: string | null;
  /** Own JID of the linked device once connected. */
  jid: string | null;
  process: WaProcessState;
  pid: number | null;
  helperVersion: string | null;
  /** Restarts since start(). */
  restarts: number;
  nextRestartAt: string | null;
  lastExit: { code: number | null; signal: string | null; at: string; meaning: string } | null;
  /** Current pairing QR (cleared once connected). */
  qr: { code: string; expiresAt: string } | null;
  pairCode: string | null;
  traveler: { pn: string | null; lid: string | null };
  /** Time of the last `status` event. */
  lastStatusAt: string | null;
  lastEventAt: string | null;
  /** Helper counters (last `stats` event). */
  stats: Record<string, number>;
  /** stdout lines that were not valid WaEvents. */
  invalidLines: number;
}

export interface WaSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Writes one command line to the helper's stdin (dropped with a warning when it is not running). */
  send(cmd: WaCommand): void;
  state(): WaSourceState;
  onEvent(cb: (e: WaEvent) => void): () => void;
  /** Called whenever state() changed (QR, connection, process lifecycle). */
  onStateChange?(cb: (s: WaSourceState) => void): () => void;
  /** Kills a running helper / cancels a pending backoff and starts it now (control UI). */
  restart?(): Promise<void>;
  /**
   * Zone in effect when the status was captured, when the source knows it (fixtures record it);
   * null = use the mirrored setting "timezone.current" (else DEFAULT_TIMEZONE).
   */
  tzHint?(msgId: string): string | null;
}

export interface IngestChange {
  sourceKeys: string[];
  /** Affected local dates: stored and effective (owner placement) dates, ascending, unique. */
  localDates: string[];
}

export interface DrainResult {
  /** New captures inserted into the store. */
  ingested: number;
  /** Captures that reached state "ready". */
  processed: number;
  /** Pipeline failures recorded (retry scheduled or given up). */
  failed: number;
}

export interface Ingest {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Scans the inbox and processes everything that is due now; resolves when idle. */
  drain(): Promise<DrainResult>;
  /**
   * Rebuilds from ARCHIVE_DIR: without a key, first restores captures missing from the store from
   * the archive records, then re-runs the media pipeline for every archived capture. Returns the
   * number of captures (re)processed.
   */
  reprocess(sourceKey?: string): Promise<number>;
  onChange(cb: (c: IngestChange) => void): () => void;
  stats(): Record<string, number>;
  /** Resumes a failed/media_lost capture (control UI "retry"); false when nothing to resume. */
  retry?(sourceKey: string): boolean;
}
