/**
 * "Live ✓ / publishing…" (plan C): derived from the backend's publish reports (StatusResponse.
 * publish) against the owner's latest saved change (change_log seq returned by the API) and the
 * latest captured status.
 */
import type {
  CaptureListItem,
  ItemPublishState,
  PublishedReport,
  PublishStateInput,
  StatusResponse,
  TargetPublishStatus,
} from '@omw/contracts/api';
import { capturePublishAt, modeForCapture, type PolicySettings } from '@omw/contracts/policy';
import { createStore, localStore } from './store';

const KEY = 'omw.admin.lastChange';

export interface LastChange {
  /** Highest change_log seq the API returned for one of our writes. */
  seq: number;
  at: string;
}

export const lastChangeStore = createStore<LastChange | null>(localStore.read<LastChange | null>(KEY, null));
lastChangeStore.subscribe(() => localStore.write(KEY, lastChangeStore.get()));

export function noteChange(seq: number, at: Date = new Date()): void {
  const prev = lastChangeStore.get();
  if (prev && prev.seq >= seq) return;
  lastChangeStore.set({ seq, at: at.toISOString() });
}

/**
 * - never: the status says nothing was deployed yet (no publish report at all);
 * - unknown: there is no status to go by (the request failed and nothing is cached).
 */
export type SiteState = 'live' | 'publishing' | 'failing' | 'never' | 'unknown';

export interface PublishSummary {
  state: SiteState;
  targets: TargetPublishStatus[];
  /** Newest deploy time over all targets. */
  lastAt: string | null;
  lastVersion: number | null;
  /** Something newer than the last deploy that it does not contain yet. */
  waitingFor: Array<'edits' | 'captures'>;
}

function covers(r: TargetPublishStatus, seq: number, lastCaptureAt: string | null): Array<'edits' | 'captures'> {
  const missing: Array<'edits' | 'captures'> = [];
  if (seq > r.feedSeq) missing.push('edits');
  if (lastCaptureAt && (r.capturesThrough === null || Date.parse(lastCaptureAt) > Date.parse(r.capturesThrough))) {
    missing.push('captures');
  }
  return missing;
}

export function publishSummary(
  status: StatusResponse | undefined,
  lastChange: LastChange | null,
  pendingWrites = 0,
): PublishSummary {
  const targets = status?.publish ?? [];
  const lastAt = targets.reduce<string | null>((max, t) => (max === null || t.at > max ? t.at : max), null);
  const lastVersion = targets.reduce<number | null>(
    (max, t) => (max === null || t.version > max ? t.version : max),
    null,
  );
  if (!status) return { state: 'unknown', targets, lastAt, lastVersion, waitingFor: pendingWrites ? ['edits'] : [] };
  if (targets.length === 0) {
    return { state: 'never', targets, lastAt, lastVersion, waitingFor: pendingWrites ? ['edits'] : [] };
  }
  if (targets.some((t) => !t.ok)) return { state: 'failing', targets, lastAt, lastVersion, waitingFor: [] };
  const lastCaptureAt = status.backend?.wa.lastStatusAt ?? null;
  const waiting = new Set<'edits' | 'captures'>();
  for (const t of targets) for (const m of covers(t, lastChange?.seq ?? 0, lastCaptureAt)) waiting.add(m);
  if (pendingWrites > 0) waiting.add('edits');
  return {
    state: waiting.size ? 'publishing' : 'live',
    targets,
    lastAt,
    lastVersion,
    waitingFor: [...waiting],
  };
}

/** How often to ask for the status: soon while something is on its way, else once a minute. */
export const STATUS_POLL_FAST_MS = 10_000;
export const STATUS_POLL_SLOW_MS = 60_000;

export function statusPollMs(status: StatusResponse | undefined, lastChange: LastChange | null): number {
  return publishSummary(status, lastChange).state === 'publishing' ? STATUS_POLL_FAST_MS : STATUS_POLL_SLOW_MS;
}

/** The newest deploy this device has seen (for "status unknown right now" without a cache). */
export interface LastPublish {
  at: string;
  version: number | null;
}

const PUBLISH_KEY = 'omw.admin.lastPublish';
export const lastPublishStore = createStore<LastPublish | null>(localStore.read<LastPublish | null>(PUBLISH_KEY, null));
lastPublishStore.subscribe(() => localStore.write(PUBLISH_KEY, lastPublishStore.get()));

export function notePublish(summary: Pick<PublishSummary, 'lastAt' | 'lastVersion'>): void {
  if (!summary.lastAt) return;
  const prev = lastPublishStore.get();
  if (prev && prev.at >= summary.lastAt) return;
  lastPublishStore.set({ at: summary.lastAt, version: summary.lastVersion });
}

export type ItemState = ItemPublishState | 'saving' | 'queued';

/**
 * Per item: "queued" while one of our writes for it waits for the connection, "saving" while it
 * is being sent, else the contracts' rule.
 */
export function itemState(
  item: PublishStateInput,
  status: StatusResponse | undefined,
  saving: boolean | 'queued',
): ItemState {
  if (saving === 'queued') return 'queued';
  if (saving) return 'saving';
  return publishStateOf(item, status?.publish ?? []);
}

type ReportLike = Pick<PublishedReport, 'ok' | 'feedSeq' | 'capturesThrough'> & Partial<Pick<PublishedReport, 'at'>>;

/**
 * The rule of itemPublishState() in @omw/contracts/api, restated here because importing any
 * value from contracts/api.ts pulls its zod schemas (and zod, ~55 kB gzip) into the admin
 * bundle: rolldown cannot drop chained zod builder calls. test/lib.test.ts checks that both
 * implementations agree on every case.
 */
export function publishStateOf(item: PublishStateInput, reports: readonly ReportLike[]): ItemPublishState {
  if (item.visibility !== 'public' || item.mediaState === 'lost') return 'not_public';
  if (reports.length === 0 || item.mediaState === 'pending') return 'publishing';
  const covered = (r: ReportLike) =>
    r.ok &&
    item.changeSeq <= r.feedSeq &&
    (item.occurredAt === undefined ||
      (r.capturesThrough !== null && Date.parse(item.occurredAt) <= Date.parse(r.capturesThrough))) &&
    (item.publishAt === undefined || (r.at !== undefined && Date.parse(item.publishAt) <= Date.parse(r.at)));
  return reports.every(covered) ? 'live' : 'publishing';
}

/**
 * The publish-state input of a capture. In delayed mode a status without an override becomes
 * public only at occurredAt + delay: a deploy built before that cannot contain it, even if its
 * watermark covers occurredAt, so the instant is passed as `publishAt` (contracts api.ts).
 * (A status whose media arrives late is not covered by this: that needs a readyAt field.)
 */
export function capturePublishInput(
  c: Pick<
    CaptureListItem,
    'effectiveVisibility' | 'changeSeq' | 'occurredAt' | 'mediaState' | 'annotation' | 'revokedAt'
  >,
  settings: PolicySettings | undefined,
): PublishStateInput {
  const input: PublishStateInput = {
    visibility: c.effectiveVisibility,
    changeSeq: c.changeSeq,
    occurredAt: c.occurredAt,
    mediaState: c.mediaState,
  };
  if (!settings || c.annotation?.visibility || modeForCapture(c, settings) !== 'delayed') return input;
  const publishAt = capturePublishAt(c, null, settings);
  return publishAt ? { ...input, publishAt } : input;
}
