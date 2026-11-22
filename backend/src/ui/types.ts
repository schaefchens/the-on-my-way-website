/**
 * What the control UI needs from the running backend (implemented by app.ts). Kept structural so
 * the UI can be tested with a fake backend.
 */
import type { QuarantinedItem, Store } from '../store/index.js';
import type { DeployReport, GenerateSnapshot, PublishState, SyncStatus } from '../sync/index.js';
import type { LogRing } from './log-ring.js';
import type { WaMonitor, WaSnapshot } from './wa-monitor.js';

export interface DeployResultView extends DeployReport {
  bytes?: number;
  durationMs?: number;
  httpCheck?: string;
  httpDetail?: string;
  errorCode?: string;
  at?: string;
}

export interface BuildStatus {
  running: boolean;
  pending: { full: boolean; dates: number; since: string } | null;
  last: GenerateSnapshot | null;
  lastError: string | null;
  /** Next delayed-publishing boundary (publish.mode "delayed"). */
  nextPublishAt: { at: string; dates: string[] } | null;
  /** Why pending generate work waits, e.g. "owner change feed is catching up" (null/absent: not held). */
  heldReason?: string | null;
}

export interface PublishStatus {
  running: boolean;
  queued: boolean;
  targets: number;
  state: PublishState;
  lastResults: DeployResultView[];
  lastAt: string | null;
  nextRetryAt: string | null;
  /**
   * Why deploys are paused (absent/null: not paused), e.g. "waiting for first owner-content sync"
   * or "restoring N captures from the archive (…)" (backend app.ts publishGate, L2-02).
   */
  pausedReason?: string | null;
}

export interface AppStatus {
  app: 'omw-backend';
  version: string;
  env: string;
  startedAt: string;
  now: string;
  uptimeS: number;
  stopping: boolean;
  wa: WaSnapshot;
  captures: { byState: Record<string, number>; total: number; lastStatusAt: string | null };
  ingest: Record<string, number>;
  disk: { freeBytes: number | null };
  sync: SyncStatus;
  build: BuildStatus;
  publish: PublishStatus;
  site: { publicUrl: string | null; outDir: string };
  /** Access gate (spec-wave5 §5.6.6); absent in open mode / older backends. */
  access?: { mode: 'open' | 'gate'; writer: string | null };
}

export interface ActionResult {
  ok: boolean;
  detail: string;
}

export interface GenerateSummary {
  version: number;
  changed: number;
  removed: number;
  full: boolean;
  durationMs: number;
}

/** Publisher target operations (see backend/src/publisher). Targets are opaque records here. */
export interface TargetOps {
  list(): Record<string, unknown>[];
  /** Validates and stores (throws with a readable message on invalid input). */
  save(input: Record<string, unknown>): Record<string, unknown>;
  remove(id: string): void;
  test(id: string): Promise<ActionResult>;
}

export interface ControlBackend {
  status(): Promise<AppStatus>;
  readonly store: Store;
  readonly wa: WaMonitor;
  readonly logRing: LogRing;
  readonly targets: TargetOps;
  /** Regenerates (full or pending changes) right away; resolves when the generate finished. */
  rebuild(full: boolean): Promise<GenerateSummary | null>;
  /** `force` overrides the publisher's mass-delete guard (L2-02; optional for older callers). */
  publishNow(targetId?: string, opts?: { force?: boolean }): Promise<DeployResultView[]>;
  reprocess(sourceKey?: string): Promise<number>;
  pairCode(phone: string): Promise<string>;
  retryCapture(sourceKey: string): ActionResult;
  skipCapture(sourceKey: string): ActionResult;
  syncPull(): Promise<number>;
  resyncCaptures(): number;
  /** Restarts the WhatsApp helper (if the source supports it). */
  restartWa(): Promise<ActionResult>;
  quarantined(limit?: number): QuarantinedItem[];
  /** "Website sperren": writes the store's `locked` file over the store target (optional). */
  lockSite?(): Promise<ActionResult>;
}
