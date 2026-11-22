/**
 * The outbox state machine (app-plan §3.1, §6.2 "outbox + index + state machine"). One manifest
 * per entry folder (outbox/<ULID>/manifest.json) is the truth; this module is the only place that
 * changes its phase. Pure: transition() returns the next manifest and the effects the caller must
 * run (prepare, enqueue, cancel, …), and deriveStatus() maps a manifest onto the one status
 * vocabulary of @omw/contracts/app (APP_ENTRY_STATUSES).
 *
 *   draft ──share──▶ preparing ──prepared──▶ prepared ──enqueued──▶ enqueued ──upload:uploaded──▶ uploaded
 *     ▲                 │  ▲ prepare_failed (retry later)                 │                          │
 *     │                 └──┘                                             └─ server:archived ────────┴─▶ archived
 *     └──── undo (a new wire id; the old one is withdrawn) ◀── preparing · prepared · enqueued
 *                                                              · uploaded · archived (ux.md: "Undo
 *                                                              works in every upload state")
 *   failed ◀── permanent errors (prepare, upload, server rejected) ── retry ──▶ preparing / prepared
 *   withdrawn ◀── the server says withdrawn
 *   draft · withdrawn · archived · failed ── discard ──▶ (folder deleted, after the withdrawals)
 *
 * "Nothing is ever lost": a draft is already a durable folder; Share flips the phase in the same
 * folder (written atomically) before the CONFIRM haptic and the "Shared" toast.
 *
 * Ids: the folder's entryId never changes (screens and the index key on it). The API and the
 * uploader know the moment by its wire id (wireIdOf: AppEntry.entryId), which the API binds to
 * its first content for good, also once withdrawn. So a moment that goes out again with other
 * content (Undo, edit, Share) or after the API refused it ("Try again") gets a new wire id, and
 * the old one is withdrawn. Withdrawals are durable: the manifest keeps them until the native
 * uploader has them, which then sends the DELETE (paced, retried, also without the app).
 */
import type {
  AppEntry,
  AppEntryKind,
  AppEntryServerState,
  AppEntryStatus,
  AppFileRole,
  AppMedia,
  AppText,
  AppVisibilityChoice,
} from '@omw/contracts/app';
import type { NetworkState, UploadBlock, UploadMode, UploadSettings, UploadStatus } from '../../modules/omw-native';
import { effectiveMode, networkBlock, uploadClass } from './upload-rules';

export const OUTBOX_PHASES = [
  'draft',
  'preparing',
  'prepared',
  'enqueued',
  'uploaded',
  'archived',
  'failed',
  'withdrawn',
] as const;
export type OutboxPhase = (typeof OUTBOX_PHASES)[number];

/** Where the moment came from (drives "Put it on that day?" and the editor). */
export type OutboxOrigin = 'camera' | 'gallery' | 'text' | 'voice';

/** The captured or picked file, copied into the entry folder (the archive original). */
export interface OutboxSource {
  /** File name inside the entry folder, e.g. "source.jpg". */
  name: string;
  mimetype: string;
  bytes: number;
  width?: number;
  height?: number;
  durationMs?: number;
  /** Local date the photo was taken ("YYYY-MM-DD", from EXIF), private: only drives the day chip. */
  takenOn?: string | null;
}

/** A prepared file of the entry (declared in AppEntry.files). */
export interface OutboxFile {
  role: AppFileRole;
  name: string;
  mimetype: string;
  bytes: number;
  sha256Hex: string;
}

/** Video edit, applied by MediaExport on the phone. */
export interface OutboxVideoEdit {
  trimStartMs?: number;
  trimEndMs?: number;
  mute?: boolean;
}

/** The publish sheet's choices. */
export interface OutboxChoice {
  /** Absent = "As usual". */
  visibility?: AppVisibilityChoice;
  /** "Put it on that day?" = yes. */
  localDate?: string;
  /** Per-entry upload override (A4). */
  mode?: UploadMode;
}

export interface OutboxError {
  code: string;
  message: string;
  permanent: boolean;
}

/** What the app last heard from GET /app/entries (AppEntryState, trimmed). */
export interface OutboxServerState {
  state: AppEntryServerState;
  heldBack: boolean;
  publish: { visibility: string; state: 'live' | 'publishing' | 'not_public'; publishAt: string | null } | null;
  backendLastSeenAt: string | null;
  checkedAt: string;
}

export interface OutboxManifest {
  schema: 1;
  /** Bumped on every write; the reader keeps the highest valid revision. */
  rev: number;
  entryId: string;
  kind: AppEntryKind;
  origin: OutboxOrigin;
  createdAt: string;
  updatedAt: string;
  phase: OutboxPhase;
  source?: OutboxSource;
  edit?: OutboxVideoEdit;
  caption?: string;
  text?: AppText;
  /** Voice: seconds of the recording. */
  seconds?: number;
  choice: OutboxChoice;
  /** The "Share" tap (= AppEntry.occurredAt) and the phone's zone then. */
  sharedAt?: string;
  tz?: string;
  files: OutboxFile[];
  media?: AppMedia;
  /** The frozen payload, once prepared. */
  entry?: AppEntry;
  upload?: UploadStatus | null;
  server?: OutboxServerState | null;
  error?: OutboxError | null;
  /** Prepare attempts (backoff and the "Needs you" decision). */
  attempts: number;
  /**
   * The id the API and the uploader know this moment by (AppEntry.entryId); absent = entryId. A
   * new one after Undo and after "Try again" (see the module comment).
   */
  wireId?: string;
  /** Earlier wire ids whose withdrawal the native uploader does not have yet. */
  withdrawals?: string[];
}

export type OutboxEvent =
  | { type: 'edit'; patch: Partial<Pick<OutboxManifest, 'caption' | 'text' | 'edit' | 'choice' | 'seconds'>> }
  | { type: 'share'; at: string; tz: string; choice?: OutboxChoice }
  | { type: 'prepared'; files: OutboxFile[]; media?: AppMedia; entry: AppEntry }
  /** wireId: the id the failed prepare ran for (a stale result for an id Undo replaced is refused). */
  | { type: 'prepare_failed'; error: OutboxError; wireId?: string }
  | { type: 'enqueued' }
  | { type: 'enqueue_failed'; error: OutboxError }
  | { type: 'upload'; status: UploadStatus }
  | { type: 'server'; server: OutboxServerState }
  /** freshId: a new ULID, used when the moment needs a new wire id. */
  | { type: 'undo'; freshId: string }
  | { type: 'retry'; freshId: string }
  /** The native uploader has these withdrawals now (Uploader.withdraw resolved). */
  | { type: 'withdrawals_handed'; ids: readonly string[] }
  | { type: 'discard' };

export type OutboxEffect =
  | { type: 'prepare' }
  | { type: 'enqueue' }
  /** Hand these wire ids to Uploader.withdraw (stops their jobs, owes the API a DELETE). */
  | { type: 'withdraw'; ids: string[] }
  | { type: 'delete_folder' };

export class OutboxTransitionError extends Error {
  constructor(
    readonly phase: OutboxPhase,
    readonly event: OutboxEvent['type'],
  ) {
    super(`Outbox: "${event}" is not allowed in phase "${phase}"`);
    this.name = 'OutboxTransitionError';
  }
}

/** Prepare attempts before a transient error turns into "Needs you". */
export const MAX_PREPARE_ATTEMPTS = 5;

/** omw-native's code for a step the installed build doesn't have yet (MediaExport stub). */
export const NOT_IMPLEMENTED = 'ERR_NOT_IMPLEMENTED';

/** A new draft (the folder and its source file exist before this manifest is written). */
export function newDraft(input: {
  entryId: string;
  kind: AppEntryKind;
  origin: OutboxOrigin;
  now: string;
  source?: OutboxSource;
  text?: AppText;
  seconds?: number;
}): OutboxManifest {
  return {
    schema: 1,
    rev: 0,
    entryId: input.entryId,
    kind: input.kind,
    origin: input.origin,
    createdAt: input.now,
    updatedAt: input.now,
    phase: 'draft',
    ...(input.source ? { source: input.source } : {}),
    ...(input.text ? { text: input.text } : {}),
    ...(input.seconds !== undefined ? { seconds: input.seconds } : {}),
    choice: {},
    files: [],
    upload: null,
    server: null,
    error: null,
    attempts: 0,
  };
}

/**
 * A failure retrying cannot fix. "unauthorized" is not one: the uploader keeps the job and goes on
 * by itself once the phone is paired (again; the API hands the same install its entries back), so
 * the entry only waits (API.md, TokenVault).
 */
export function isTerminalUpload(status: UploadStatus): boolean {
  return status.state === 'failed' && status.error?.permanent === true && status.blockedBy !== 'unauthorized';
}

/**
 * A failed entry the uploader picked up again (an older build marked an unpaired job as failed;
 * after pairing it goes on). Never one the server refused: its job's "uploaded" (replayed on every
 * return to the app) must not turn "Needs you" back into "Uploaded".
 */
export function uploaderResumed(m: OutboxManifest, status: UploadStatus): boolean {
  return m.phase === 'failed' && m.entry !== undefined && m.server?.state !== 'rejected' && !isTerminalUpload(status);
}

/** The id the API and the uploader know the moment by. */
export function wireIdOf(m: Pick<OutboxManifest, 'entryId' | 'wireId'>): string {
  return m.wireId ?? m.entryId;
}

/** Upload errors after which the prepared file itself is the problem: prepare it again. */
const FILE_ERRORS: ReadonlySet<string> = new Set(['file_missing', 'file_changed', 'file_unreadable']);

function withdrawEffects(ids: readonly string[]): OutboxEffect[] {
  return ids.length > 0 ? [{ type: 'withdraw', ids: [...ids] }] : [];
}

export function transition(
  m: OutboxManifest,
  event: OutboxEvent,
  now: string,
): { next: OutboxManifest; effects: OutboxEffect[] } {
  const bad = (): never => {
    throw new OutboxTransitionError(m.phase, event.type);
  };
  const out = (patch: Partial<OutboxManifest>, effects: OutboxEffect[] = []) => ({
    next: { ...m, ...patch, rev: m.rev + 1, updatedAt: now },
    effects,
  });

  switch (event.type) {
    case 'edit':
      if (m.phase !== 'draft') bad();
      return out({ ...event.patch, choice: { ...m.choice, ...(event.patch.choice ?? {}) } });

    case 'share':
      if (m.phase !== 'draft') bad();
      if (m.kind === 'text' && !m.text) bad();
      if ((m.kind === 'photo' || m.kind === 'video' || m.kind === 'voice') && !m.source) bad();
      return out(
        {
          phase: 'preparing',
          sharedAt: event.at,
          tz: event.tz,
          // The publish sheet's final answer replaces the draft's choice.
          choice: event.choice ?? m.choice,
          error: null,
          attempts: 0,
        },
        [{ type: 'prepare' }],
      );

    case 'prepared':
      if (m.phase !== 'preparing') bad();
      // A prepare that ran for an id Undo replaced meanwhile (its content may be outdated).
      if (event.entry.entryId !== wireIdOf(m)) bad();
      return out(
        {
          phase: 'prepared',
          files: event.files,
          ...(event.media ? { media: event.media } : {}),
          entry: event.entry,
          error: null,
        },
        [{ type: 'enqueue' }],
      );

    case 'prepare_failed': {
      if (m.phase !== 'preparing') bad();
      if (event.wireId !== undefined && event.wireId !== wireIdOf(m)) bad();
      // A missing native step (ERR_NOT_IMPLEMENTED) comes with an app update: it never gives up.
      const waitsForUpdate = event.error.code === NOT_IMPLEMENTED;
      const attempts = waitsForUpdate ? m.attempts : m.attempts + 1;
      const permanent = !waitsForUpdate && (event.error.permanent || attempts >= MAX_PREPARE_ATTEMPTS);
      return out({ phase: permanent ? 'failed' : 'preparing', error: event.error, attempts });
    }

    case 'enqueued':
      if (m.phase !== 'prepared' && m.phase !== 'enqueued') bad();
      return out({ phase: 'enqueued', error: null });

    case 'enqueue_failed':
      // The native queue refused or is missing: stay prepared; the next app start tries again.
      if (m.phase !== 'prepared') bad();
      return out({ error: event.error, phase: event.error.permanent ? 'failed' : 'prepared' });

    case 'upload': {
      const status = event.status;
      const resumed = uploaderResumed(m, status);
      if (m.phase !== 'enqueued' && m.phase !== 'uploaded' && m.phase !== 'prepared' && !resumed) bad();
      if (status.entryId !== wireIdOf(m)) bad();
      if (m.phase === 'uploaded' && status.state !== 'uploaded') return out({ upload: status });
      if (status.state === 'uploaded') return out({ phase: 'uploaded', upload: status, error: null });
      if (isTerminalUpload(status)) return out({ phase: 'failed', upload: status, error: status.error });
      if (status.state === 'cancelled') return out({ phase: 'prepared', upload: status });
      return out({ phase: 'enqueued', upload: status });
    }

    case 'server': {
      if (m.phase !== 'enqueued' && m.phase !== 'uploaded' && m.phase !== 'archived') bad();
      const server = event.server;
      switch (server.state) {
        case 'archived':
          return out({ phase: 'archived', server });
        case 'withdrawn':
          return out({ phase: 'withdrawn', server });
        case 'rejected':
          return out({
            phase: 'failed',
            server,
            error: { code: 'rejected', message: 'The home computer could not take it', permanent: true },
          });
        case 'uploaded':
        case 'fetching':
          return out({ phase: m.phase === 'archived' ? 'archived' : 'uploaded', server });
        default:
          return out({ server });
      }
    }

    case 'undo': {
      // "Shared · Undo" works in every upload state and turns the moment back into a draft (ux.md,
      // Share), under a new wire id: whatever she shares next is a new moment for the API. The old
      // id was never handed to the uploader while preparing; after that it may have reached the
      // API, so it is withdrawn (the uploader knows whether a DELETE is owed).
      const undoable: readonly OutboxPhase[] = ['preparing', 'prepared', 'enqueued', 'uploaded', 'archived'];
      if (!undoable.includes(m.phase)) bad();
      const withdrawals = [...(m.withdrawals ?? []), ...(m.phase === 'preparing' ? [] : [wireIdOf(m)])];
      const { sharedAt: _s, tz: _t, entry: _e, media: _m, withdrawals: _w, ...rest } = m;
      return {
        next: {
          ...rest,
          phase: 'draft',
          wireId: event.freshId,
          ...(withdrawals.length > 0 ? { withdrawals } : {}),
          files: [],
          upload: null,
          server: null,
          error: null,
          attempts: 0,
          rev: m.rev + 1,
          updatedAt: now,
        },
        effects: withdrawEffects(withdrawals),
      };
    }

    case 'retry': {
      if (m.phase !== 'failed') bad();
      const pending = m.withdrawals ?? [];
      if (!m.entry) {
        return out({ phase: 'preparing', error: null, attempts: 0 }, [
          ...withdrawEffects(pending),
          { type: 'prepare' },
        ]);
      }
      // The upload failed for good, or the home computer refused it: the API keeps what it has
      // under this id, so the moment goes again under a new one and the old one is withdrawn.
      const withdrawals = [...pending, wireIdOf(m)];
      const fresh = {
        wireId: event.freshId,
        withdrawals,
        upload: null,
        server: null,
        error: null,
        attempts: 0,
      } satisfies Partial<OutboxManifest>;
      if (FILE_ERRORS.has(m.error?.code ?? '')) {
        // The prepared file is gone or changed on the phone: prepare it again from the source.
        const { entry: _e, media: _m, ...rest } = m;
        return {
          next: { ...rest, ...fresh, phase: 'preparing', files: [], rev: m.rev + 1, updatedAt: now },
          effects: [...withdrawEffects(withdrawals), { type: 'prepare' }],
        };
      }
      return out({ ...fresh, phase: 'prepared', entry: { ...m.entry, entryId: event.freshId } }, [
        ...withdrawEffects(withdrawals),
        { type: 'enqueue' },
      ]);
    }

    case 'withdrawals_handed': {
      const left = (m.withdrawals ?? []).filter((id) => !event.ids.includes(id));
      const { withdrawals: _w, ...rest } = m;
      return {
        next: { ...rest, ...(left.length > 0 ? { withdrawals: left } : {}), rev: m.rev + 1, updatedAt: now },
        effects: [],
      };
    }

    case 'discard': {
      if (m.phase !== 'draft' && m.phase !== 'withdrawn' && m.phase !== 'archived' && m.phase !== 'failed') bad();
      // A moment that needs her may be on the API (it failed there, or was refused): withdrawn first.
      const ids = [...(m.withdrawals ?? []), ...(m.phase === 'failed' && m.entry ? [wireIdOf(m)] : [])];
      return out({}, [...withdrawEffects(ids), { type: 'delete_folder' }]);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Status vocabulary

/** Extra reasons the app knows about, beyond UploadBlock. */
export type StatusReason = UploadBlock | 'not_paired' | 'metered_wifi' | 'export_pending' | 'home_offline';

export interface StatusContext {
  settings: UploadSettings;
  network: NetworkState;
  /** A token is in the TokenVault. */
  paired: boolean;
  /** Q8 a: nothing is published yet (from /app/hints; true until the API says otherwise). */
  archiveOnly: boolean;
  /** Now (ISO) and the threshold after which a silent home computer is worth a word. */
  now?: string;
}

export interface EntryStatusView {
  status: AppEntryStatus;
  /** 0..100 while uploading. */
  percent?: number;
  reason?: StatusReason;
  /** Bytes still to send (the "184 MB" in "Waiting for Wi-Fi"). */
  bytesLeft?: number;
}

function bytesOf(m: OutboxManifest, roles: AppFileRole[]): number {
  return m.files.filter((f) => roles.includes(f.role)).reduce((sum, f) => sum + f.bytes, 0);
}

const WAITING_NETWORK: ReadonlySet<UploadBlock> = new Set([
  'no_network',
  'not_validated',
  'backoff',
  'server_busy',
  'inbox_full',
]);

function fromBlock(block: UploadBlock, m: OutboxManifest, ctx: StatusContext): EntryStatusView {
  const bytesLeft = bytesOf(m, ['media', 'preview']) - (m.upload?.sentBytes ?? 0);
  if (block === 'manual') return { status: 'ready', reason: 'manual', bytesLeft };
  if (block === 'wifi_only') {
    // A Wi-Fi that is metered (or a hotspot) counts as mobile data: say so.
    const reason = ctx.network.connected && ctx.network.transport === 'wifi' ? 'metered_wifi' : 'wifi_only';
    return { status: 'waiting_wifi', reason, bytesLeft };
  }
  if (block === 'roaming') return { status: 'waiting_roaming', reason: 'roaming', bytesLeft };
  if (block === 'unauthorized') return { status: 'needs_you', reason: 'unauthorized' };
  return { status: 'waiting_network', reason: WAITING_NETWORK.has(block) ? block : 'no_network', bytesLeft };
}

/** The app's own prediction while the uploader has not reported yet. */
function predicted(m: OutboxManifest, ctx: StatusContext): EntryStatusView {
  if (!ctx.paired)
    return { status: 'waiting_network', reason: 'not_paired', bytesLeft: bytesOf(m, ['media', 'preview']) };
  if (effectiveMode(ctx.settings, m.choice.mode) === 'manual') return fromBlock('manual', m, ctx);
  const block = networkBlock(uploadClass(m.kind), ctx.settings, ctx.network);
  if (block) return fromBlock(block, m, ctx);
  return { status: 'uploading', percent: 0, bytesLeft: bytesOf(m, ['media', 'preview']) };
}

function percentOf(status: UploadStatus): number {
  if (status.totalBytes <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((status.sentBytes / status.totalBytes) * 100)));
}

/**
 * The one status of an entry (null for drafts and withdrawn entries, which the queue doesn't show).
 * API.md mapping: manual → ready; no_network/not_validated/backoff/server_busy/inbox_full →
 * waiting_network; wifi_only → waiting_wifi; roaming → waiting_roaming; uploading/committing →
 * uploading; uploaded → uploaded (then the server decides archived/live/…); permanent failures →
 * needs_you.
 */
export function deriveStatus(m: OutboxManifest, ctx: StatusContext): EntryStatusView | null {
  switch (m.phase) {
    case 'draft':
    case 'withdrawn':
      return null;
    case 'preparing':
      return m.error?.code === NOT_IMPLEMENTED
        ? { status: 'preparing', reason: 'export_pending' }
        : { status: 'preparing' };
    case 'failed':
      return {
        status: 'needs_you',
        ...(m.upload?.blockedBy === 'unauthorized' ? { reason: 'unauthorized' as const } : {}),
      };
    case 'prepared':
      return predicted(m, ctx);
    case 'enqueued': {
      const u = m.upload;
      if (!u) return predicted(m, ctx);
      if (!ctx.paired && (u.blockedBy === 'unauthorized' || u.state !== 'uploading')) {
        return { status: 'waiting_network', reason: 'not_paired', bytesLeft: bytesOf(m, ['media', 'preview']) };
      }
      if (u.state === 'uploading' || u.state === 'committing') return { status: 'uploading', percent: percentOf(u) };
      if (u.blockedBy) return fromBlock(u.blockedBy, m, ctx);
      if (isTerminalUpload(u)) return { status: 'needs_you' };
      // queued/waiting without a reason (the uploader hasn't decided yet): our own prediction.
      return predicted(m, ctx);
    }
    case 'uploaded': {
      const s = m.server;
      const since = s?.backendLastSeenAt ?? null;
      const now = ctx.now ? Date.parse(ctx.now) : Number.NaN;
      const homeOffline = since !== null && !Number.isNaN(now) && now - Date.parse(since) > 30 * 60 * 1000;
      return homeOffline ? { status: 'uploaded', reason: 'home_offline' } : { status: 'uploaded' };
    }
    case 'archived': {
      if (ctx.archiveOnly) return { status: 'archived' };
      const v = m.choice.visibility;
      const publish = m.server?.publish;
      if (publish?.state === 'live') return { status: 'live' };
      if (publish?.state === 'publishing') return { status: 'publishing' };
      if (v === 'hidden' || publish?.visibility === 'hidden') return { status: 'hidden' };
      if (v === 'pending' || m.server?.heldBack || publish?.visibility === 'pending') return { status: 'held' };
      if (publish?.publishAt) return { status: 'scheduled' };
      return { status: 'archived' };
    }
  }
}

/**
 * The private original's own line (Q2 c): photo and video originals follow the published artifact,
 * on Wi-Fi only. null while the artifact itself is still on its way, when there is no original, or
 * once the original is home.
 */
export function originalLine(
  m: OutboxManifest,
): { state: 'next' | 'waiting_wifi' | 'waiting' | 'uploading' | 'failed'; percent: number; bytesLeft: number } | null {
  const o = m.upload?.original;
  if (!o || o.state === 'uploaded') return null;
  if (m.phase !== 'uploaded' && m.phase !== 'archived') return null;
  const bytesLeft = Math.max(0, o.totalBytes - o.sentBytes);
  const percent = o.totalBytes > 0 ? Math.min(100, Math.floor((o.sentBytes / o.totalBytes) * 100)) : 0;
  if (o.state === 'failed') return { state: 'failed', percent, bytesLeft };
  if (o.state === 'uploading') return { state: 'uploading', percent, bytesLeft };
  if (o.state === 'waiting') {
    return { state: o.blockedBy === 'wifi_only' ? 'waiting_wifi' : 'waiting', percent, bytesLeft };
  }
  return { state: 'next', percent, bytesLeft };
}

/** Entries the queue sheet lists, in posting order (oldest share first). */
export function queueOrder(a: OutboxManifest, b: OutboxManifest): number {
  const at = (m: OutboxManifest) => m.sharedAt ?? m.createdAt;
  return at(a) < at(b) ? -1 : at(a) > at(b) ? 1 : a.entryId < b.entryId ? -1 : 1;
}

/** Still on its way (shows up in the sync pill). */
export function isPending(m: OutboxManifest): boolean {
  return m.phase === 'preparing' || m.phase === 'prepared' || m.phase === 'enqueued' || m.phase === 'failed';
}

/** The Today pill: one summary of everything shared that is not home yet. */
export type PillSummary =
  | { kind: 'all_safe' }
  | { kind: 'needs_you'; count: number }
  | { kind: 'ready'; count: number }
  | { kind: 'waiting_wifi'; count: number }
  | { kind: 'on_the_way'; count: number };

export function pillSummary(views: readonly (EntryStatusView | null)[]): PillSummary {
  const live = views.filter((v): v is EntryStatusView => v !== null);
  const count = (pred: (v: EntryStatusView) => boolean) => live.filter(pred).length;
  const needs = count((v) => v.status === 'needs_you');
  if (needs > 0) return { kind: 'needs_you', count: needs };
  const onTheWay = count((v) =>
    ['preparing', 'ready', 'waiting_network', 'waiting_wifi', 'waiting_roaming', 'uploading'].includes(v.status),
  );
  if (onTheWay === 0) return { kind: 'all_safe' };
  const ready = count((v) => v.status === 'ready');
  if (ready === onTheWay) return { kind: 'ready', count: ready };
  const wifi = count((v) => v.status === 'waiting_wifi' || v.status === 'waiting_roaming');
  if (wifi === onTheWay) return { kind: 'waiting_wifi', count: wifi };
  return { kind: 'on_the_way', count: onTheWay };
}
