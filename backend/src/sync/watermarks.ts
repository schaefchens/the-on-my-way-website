/**
 * Bookkeeping shared by the orchestrator, the CLI and the sync client (kept in sync_state):
 *
 * - generate snapshot: what the last successful generate contained (site version, change-feed
 *   cursor, capture watermark). PublishedReport.feedSeq/capturesThrough describe the DEPLOYED
 *   files, i.e. the last generate, never "now" (contracts PublishedReport).
 * - publish state: last successful deploy and the latest error, for the heartbeat.
 */
import type { Store } from '../store/index.js';

export const GENERATE_SNAPSHOT_KEY = 'last_generate';
export const PUBLISH_STATE_KEY = 'publish_state';

/**
 * Capture states that are still moving through the pipeline (the backend is working on them and
 * they become ready within minutes). NOT included: awaiting_media. A status whose media WhatsApp
 * has not delivered yet can wait for hours (retries, media retry receipts, up to
 * MEDIA_GIVE_UP_HOURS); holding the watermark back for it would show every newer, already
 * published capture as "publishing…" in the admin for that long. The admin shows such a capture
 * as waiting from the mirror's mediaState ('pending') instead.
 */
const IN_PIPELINE = ['received', 'archived', 'processed'] as const;

/**
 * Capture watermark (contracts PublishedReport.capturesThrough): 1 ms before the oldest capture
 * still in the pipeline, else the newest occurredAt of any capture, else null.
 *
 * Without a capture in the pipeline every ready capture is in the generate that follows, so the
 * newest capture of any state (ready, awaiting_media, failed, media_lost, revoked) is a valid
 * watermark, and it equals the heartbeat's wa.lastStatusAt (lastCaptureAt), which the admin
 * compares against it for the site-wide "Live ✓".
 */
export function capturesThrough(store: Store): string | null {
  const placeholders = IN_PIPELINE.map(() => '?').join(', ');
  const oldest = store.db
    .prepare(`SELECT MIN(occurred_at) AS t FROM captures WHERE state IN (${placeholders})`)
    .get(...IN_PIPELINE) as { t: string | null };
  if (oldest.t) return new Date(new Date(oldest.t).getTime() - 1).toISOString();
  return lastCaptureAt(store);
}

/** occurredAt of the newest capture (any state), for "last status" displays. */
export function lastCaptureAt(store: Store): string | null {
  const r = store.db.prepare('SELECT MAX(occurred_at) AS t FROM captures').get() as { t: string | null };
  return r.t ? new Date(r.t).toISOString() : null;
}

export interface GenerateSnapshot {
  /** Site version written by that generate (Manifest.version). */
  version: number;
  /** When it finished. */
  at: string;
  /** Change-feed cursor taken BEFORE generating (conservative). */
  feedSeq: number;
  /** capturesThrough() taken before generating. */
  capturesThrough: string | null;
  full: boolean;
  durationMs: number;
  changed: number;
  removed: number;
}

export interface PreGenerate {
  feedSeq: number;
  capturesThrough: string | null;
}

/** Taken right before generate() starts. */
export function preGenerateSnapshot(store: Store): PreGenerate {
  return { feedSeq: store.syncState.feedCursor(), capturesThrough: capturesThrough(store) };
}

export function readGenerateSnapshot(store: Store): GenerateSnapshot | null {
  try {
    return store.syncState.getJson<GenerateSnapshot>(GENERATE_SNAPSHOT_KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeGenerateSnapshot(store: Store, snapshot: GenerateSnapshot): void {
  store.syncState.setJson(GENERATE_SNAPSHOT_KEY, snapshot);
}

export interface PublishState {
  /** Site version of the last deploy that succeeded on every target. */
  lastVersion?: number;
  lastAt?: string;
  /** Error of the latest deploy attempt (cleared by a fully successful deploy). */
  lastError?: string;
  /** Per target: last result. */
  targets?: Record<string, { ok: boolean; version: number | null; at: string; error?: string }>;
}

export function readPublishState(store: Store): PublishState {
  try {
    return store.syncState.getJson<PublishState>(PUBLISH_STATE_KEY) ?? {};
  } catch {
    return {};
  }
}

export function writePublishState(store: Store, state: PublishState): void {
  store.syncState.setJson(PUBLISH_STATE_KEY, state);
}

/** One deploy result as the publish state needs it (structural subset of DeployReport). */
export interface PublishOutcome {
  targetId: string;
  ok: boolean;
  version: number | null;
  error?: string | undefined;
}

/**
 * Folds deploy results into the publish state (W2-3). lastVersion/lastAt/lastError describe ALL
 * currently enabled targets (`enabled`), not only the targets of this batch: a later success of
 * target A must not hide that B is still failing. Entries of targets that are no longer enabled
 * (removed or disabled) are dropped. Without `enabled` (unknown) every recorded target counts.
 *
 * - lastVersion/lastAt: updated only while every considered target's last deploy succeeded; the
 *   version is the lowest one among them (the content that is live everywhere).
 * - lastError: the first failing considered target, "<id>: <error>"; absent when none fails.
 */
export function mergePublishState(
  prev: PublishState,
  results: readonly PublishOutcome[],
  at: string,
  enabled: readonly string[] | null,
  fallbackVersion?: number,
): PublishState {
  const targets: NonNullable<PublishState['targets']> = { ...(prev.targets ?? {}) };
  for (const r of results) {
    targets[r.targetId] = { ok: r.ok, version: r.version, at, ...(r.error ? { error: r.error.slice(0, 500) } : {}) };
  }
  if (enabled) {
    const keep = new Set(enabled);
    for (const id of Object.keys(targets)) if (!keep.has(id)) delete targets[id];
  }
  // No enabled target left to judge (e.g. only a disabled target was deployed by hand): judge
  // this batch alone, as before.
  const considered = Object.entries(targets);
  const judged =
    considered.length > 0
      ? considered.map(([id, t]) => ({ targetId: id, ok: t.ok, version: t.version, error: t.error }))
      : results.map((r) => ({ targetId: r.targetId, ok: r.ok, version: r.version, error: r.error }));
  const failing = judged.find((r) => !r.ok);
  const versions = judged.map((r) => r.version).filter((v): v is number => v !== null);
  const okVersion = versions.length > 0 ? Math.min(...versions) : fallbackVersion;
  const allOk = judged.length > 0 && !failing;
  const next: PublishState = { targets };
  if (allOk && okVersion !== undefined) {
    next.lastVersion = okVersion;
    next.lastAt = results.some((r) => r.ok) ? at : (prev.lastAt ?? at);
  } else {
    if (prev.lastVersion !== undefined) next.lastVersion = prev.lastVersion;
    if (prev.lastAt) next.lastAt = prev.lastAt;
  }
  if (failing) next.lastError = `${failing.targetId}: ${failing.error ?? 'deploy failed'}`.slice(0, 500);
  return next;
}

/** The publish state as seen with the currently enabled targets (no new results). */
export function publishStateFor(state: PublishState, enabled: readonly string[] | null): PublishState {
  if (!enabled || !state.targets) return state;
  const merged = mergePublishState(state, [], state.lastAt ?? new Date(0).toISOString(), enabled);
  // Without new results lastVersion only moves when a lagging/failing target went away.
  return merged;
}
