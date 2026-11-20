/**
 * Offline-resumable owner writes (plan C "Admin PWA": paused mutations resume on reconnect).
 *
 * - Every write has a mutation key (keys.ts) whose defaults hold mutationFn + optimistic update,
 *   so a paused mutation restored from IndexedDB after a reload can still run.
 * - All writes share one scope: they replay strictly in the order they were made.
 * - Network failures retry forever with backoff; the online manager (online.ts) pauses them
 *   while the device or the API is offline. 5xx/429 retry 3 times; other 4xx fail at once.
 * - Optimistic updates are recorded (CacheTx) and rolled back on failure; the still-pending
 *   writes are then re-applied (their updaters are idempotent).
 * - ifUpdatedAt is resolved when the request is SENT: if an earlier queued write of the same
 *   entity already moved its updatedAt from X to Y, a later write based on X is sent with Y
 *   (otherwise a series of offline edits would conflict with itself).
 * - Failures: 409 conflict -> conflicts.ts (auto-merge or dialog), 401 -> outbox (replayed after
 *   the next login), anything else -> error toast.
 */
import { msg } from '@lingui/core/macro';
import type { AdminDayDetail, AdminPost, AdminTrip, CaptureListItem, Settings } from '@omw/contracts/api';
import { type Mutation, MutationObserver, type QueryClient } from '@tanstack/react-query';
import { settleFieldDraft } from '../lib/drafts';
import { friendlyError, translate } from '../lib/errors';
import { notify, settleWriteNotice } from '../lib/notices';
import { lastChangeStore, noteChange } from '../lib/publish';
import { localStore } from '../lib/store';
import {
  CacheTx,
  confirmDay,
  optimisticAnnotate,
  optimisticCreatePost,
  optimisticDeletePost,
  optimisticDeleteTrip,
  optimisticPatchDay,
  optimisticPatchSettings,
  optimisticPutTrip,
  optimisticUpdatePost,
  putCapture,
  putPost,
  putTrip,
  removePost,
  removeTrip,
  restoreSnapshot,
} from './cache';
import {
  type AdminApi,
  adminApi,
  isConflictError,
  isNetworkError,
  isTransientError,
  isUnauthorizedError,
} from './client';
import { MUTATION_NAMES, type MutationName, mk, qk, WRITE_SCOPE } from './keys';
import { type DraftRef, entityOf, type Rebaseable, type WriteContext, type WriteResult, type WriteVars } from './types';

// ---------------------------------------------------------------------------------------------
// Version rebasing (entity -> base updatedAt -> latest updatedAt written by us)

const VERSIONS_KEY = 'omw.admin.versions';
const FEED_KEY = 'omw.admin.feedId';
const NO_BASE = '-';
type VersionMap = Record<string, Record<string, string>>;
let versions: VersionMap = localStore.read<VersionMap>(VERSIONS_KEY, {});
let knownFeedId: string | null = localStore.read<string | null>(FEED_KEY, null);

export function resolveBase(entity: string, base: string | null): string | null {
  return versions[entity]?.[base ?? NO_BASE] ?? base;
}

/** The ifUpdatedAt a write is sent with: rebased, unless the base is a fetched server version. */
export function baseToSend(entity: string, vars: Rebaseable): string | null {
  return vars.exactBase ? vars.base : resolveBase(entity, vars.base);
}

export function recordVersion(entity: string, bases: Array<string | null>, updatedAt: string): void {
  const map = { ...(versions[entity] ?? {}) };
  for (const b of bases) map[b ?? NO_BASE] = updatedAt;
  // Keep the map small: only the last few rebases per entity matter.
  const entries = Object.entries(map).slice(-8);
  versions = { ...versions, [entity]: Object.fromEntries(entries) };
  const all = Object.entries(versions);
  if (all.length > 200) versions = Object.fromEntries(all.slice(-200));
  localStore.write(VERSIONS_KEY, versions);
}

export function resetVersions(): void {
  versions = {};
  localStore.write(VERSIONS_KEY, null);
}

/** The rebase map of one entity (tests, diagnostics). */
export function versionsOf(entity: string): Readonly<Record<string, string>> {
  return versions[entity] ?? {};
}

/**
 * Drops the rebase map of an entity that no longer exists (deleted here or elsewhere): a later
 * create with the same key (trip slug) must be sent without an ifUpdatedAt of the old row.
 */
export function forgetVersions(entity: string): void {
  if (!(entity in versions)) return;
  const { [entity]: _gone, ...rest } = versions;
  versions = rest;
  localStore.write(VERSIONS_KEY, Object.keys(versions).length ? versions : null);
}

/**
 * After a 409 the server's current version of the entity is known: every rebase that does not
 * lead to it is stale (the server moved on elsewhere, or went BACK, e.g. restored from a backup)
 * and would only produce the next 409. Keeps the entries that point at `serverUpdatedAt`; a row
 * that is gone (null) forgets the whole entity.
 */
export function pruneVersions(entity: string, serverUpdatedAt: string | null): void {
  const map = versions[entity];
  if (!map) return;
  if (serverUpdatedAt === null) {
    forgetVersions(entity);
    return;
  }
  const kept = Object.entries(map).filter(([, latest]) => latest === serverUpdatedAt);
  if (kept.length === Object.keys(map).length) return;
  if (kept.length === 0) {
    forgetVersions(entity);
    return;
  }
  versions = { ...versions, [entity]: Object.fromEntries(kept) };
  localStore.write(VERSIONS_KEY, versions);
}

/**
 * The API's change feed id as last reported (StatusResponse.backend.sync.feedId). A different id
 * means the API database was restored or reinstalled: every remembered version belongs to the
 * old database, so the whole rebase map is dropped.
 */
export function noteFeedId(feedId: string | null | undefined): void {
  if (!feedId || feedId === knownFeedId) return;
  if (knownFeedId !== null) resetVersions();
  knownFeedId = feedId;
  localStore.write(FEED_KEY, feedId);
}

function withIf<T extends object>(patch: T, base: string | null): T & { ifUpdatedAt?: string } {
  return base ? { ...patch, ifUpdatedAt: base } : patch;
}

// ---------------------------------------------------------------------------------------------
// Request functions (pure functions of the persisted variables)

type Senders = { [N in MutationName]: (vars: WriteVars[N], api: AdminApi) => Promise<WriteResult[N]> };

const send: Senders = {
  annotate: (v, api) => api.annotate(v.sourceKey, withIf(v.patch, baseToSend(entityOf('annotate', v), v))),
  patchDay: (v, api) => api.patchDay(v.date, withIf(v.patch, baseToSend(entityOf('patchDay', v), v))),
  createPost: (v, api) => api.createPost(v.body),
  updatePost: (v, api) => api.updatePost(v.publicId, withIf(v.patch, baseToSend(entityOf('updatePost', v), v))),
  deletePost: async (v, api) => {
    await api.deletePost(v.publicId);
    return undefined;
  },
  putTrip: (v, api) => api.putTrip(withIf(v.body, baseToSend(entityOf('putTrip', v), v))),
  deleteTrip: async (v, api) => {
    await api.deleteTrip(v.slug);
    return undefined;
  },
  patchSettings: (v, api) => api.patchSettings(v.patch),
};

/** The base that was actually sent (for version bookkeeping after success). */
function sentBase<N extends MutationName>(name: N, vars: WriteVars[N]): Array<string | null> {
  if (!('base' in vars)) return [];
  const v = vars as Rebaseable;
  return v.exactBase ? [v.base] : [v.base, resolveBase(entityOf(name, vars), v.base)];
}

// ---------------------------------------------------------------------------------------------
// Optimistic updates and confirmations

type Optimists = { [N in MutationName]: (tx: CacheTx, vars: WriteVars[N], now: number) => void };

const optimistic: Optimists = {
  annotate: (tx, v, now) => optimisticAnnotate(tx, v, now),
  patchDay: (tx, v, now) => optimisticPatchDay(tx, v, now),
  createPost: (tx, v, now) => optimisticCreatePost(tx, v, now),
  updatePost: (tx, v) => optimisticUpdatePost(tx, v),
  deletePost: (tx, v) => optimisticDeletePost(tx, v),
  putTrip: (tx, v, now) => optimisticPutTrip(tx, v, now),
  deleteTrip: (tx, v) => optimisticDeleteTrip(tx, v),
  patchSettings: (tx, v, now) => optimisticPatchSettings(tx, v, now),
};

/** Writes the server's answer into the caches and records the new version. */
function confirm<N extends MutationName>(qc: QueryClient, name: N, data: WriteResult[N], vars: WriteVars[N]): void {
  const tx = new CacheTx(qc, false);
  const entity = entityOf(name, vars);
  // Writes without a returned seq (deletes, settings) are at least one seq newer than the last.
  const nextSeq = () => (lastChangeStore.get()?.seq ?? 0) + 1;
  switch (name) {
    case 'annotate': {
      const item = data as CaptureListItem;
      tx.set(qk.capture(item.sourceKey), item);
      putCapture(tx, item);
      if (item.annotation) recordVersion(entity, sentBase(name, vars), item.annotation.updatedAt);
      noteChange(item.changeSeq);
      break;
    }
    case 'patchDay': {
      const detail = data as AdminDayDetail;
      confirmDay(tx, detail);
      if (detail.day) recordVersion(entity, sentBase(name, vars), detail.day.updatedAt);
      noteChange(detail.changeSeq);
      break;
    }
    case 'createPost':
    case 'updatePost': {
      const post = data as AdminPost;
      putPost(tx, post);
      recordVersion(entity, name === 'createPost' ? [null] : sentBase(name, vars), post.updatedAt);
      noteChange(post.changeSeq);
      break;
    }
    case 'deletePost':
      removePost(tx, (vars as WriteVars['deletePost']).publicId);
      forgetVersions(entity);
      noteChange(nextSeq());
      break;
    case 'putTrip': {
      const trip = data as AdminTrip;
      putTrip(tx, trip);
      recordVersion(entity, sentBase(name, vars), trip.updatedAt);
      noteChange(trip.changeSeq);
      break;
    }
    case 'deleteTrip':
      removeTrip(tx, (vars as WriteVars['deleteTrip']).slug);
      forgetVersions(entity);
      noteChange(nextSeq());
      break;
    case 'patchSettings':
      qc.setQueryData<Settings>(qk.settings, data as Settings);
      noteChange(nextSeq());
      break;
  }
}

/** Queries whose server-side aggregates a write changes (refetched after it settles). */
function staleAfter(name: MutationName): ReadonlyArray<readonly unknown[]> {
  switch (name) {
    case 'annotate':
      return [qk.days, qk.capturesAll, qk.dayAll, qk.status];
    case 'patchDay':
      // A tz fix can move items to D-1/D+1 and changes the effective cover of the list.
      return [qk.days, qk.dayAll, qk.capturesAll, qk.status];
    case 'createPost':
    case 'updatePost':
    case 'deletePost':
      return [qk.days, qk.postsAll, qk.dayAll, qk.status];
    case 'putTrip':
    case 'deleteTrip':
      return [qk.trips, qk.days, qk.status];
    case 'patchSettings':
      return [qk.settings, qk.capturesAll, qk.dayAll, qk.days, qk.status];
  }
}

// ---------------------------------------------------------------------------------------------
// Pending writes

type AnyMutation = Mutation<unknown, unknown, unknown, unknown>;

export interface PendingWrite {
  id: number;
  name: MutationName;
  vars: WriteVars[MutationName];
  paused: boolean;
}

function nameOf(mutation: { options: { mutationKey?: readonly unknown[] | undefined } }): MutationName | null {
  const key = mutation.options.mutationKey?.[0];
  return typeof key === 'string' && (MUTATION_NAMES as string[]).includes(key) ? (key as MutationName) : null;
}

/** Owner writes that have not finished yet, oldest first. */
export function pendingWrites(qc: QueryClient, exceptId?: number): PendingWrite[] {
  return qc
    .getMutationCache()
    .getAll()
    .filter((m) => m.state.status === 'pending' && m.mutationId !== exceptId)
    .sort((a, b) => a.mutationId - b.mutationId)
    .flatMap((m) => {
      const name = nameOf(m);
      return name
        ? [{ id: m.mutationId, name, vars: m.state.variables as WriteVars[MutationName], paused: m.state.isPaused }]
        : [];
    });
}

/** Re-applies the optimistic updates of all pending writes (after a rollback or a refetch). */
export function reapplyPending(qc: QueryClient, exceptId?: number, now = Date.now()): void {
  for (const w of pendingWrites(qc, exceptId)) {
    const tx = new CacheTx(qc, false);
    (optimistic[w.name] as (tx: CacheTx, vars: unknown, now: number) => void)(tx, w.vars, now);
  }
}

// ---------------------------------------------------------------------------------------------
// Failure handling

export interface WriteFailureHandlers {
  /** 409 conflict of a write that carried ifUpdatedAt. */
  onConflict: (name: MutationName, vars: WriteVars[MutationName]) => void;
  /** 401: the session is gone; the write should be replayed after the next login. */
  onUnauthorized: (name: MutationName, vars: WriteVars[MutationName]) => void;
  /**
   * Any other final failure (4xx, 5xx after retries), after the rollback. Returns true when it
   * told the owner itself (e.g. the composer text was put back into a draft); otherwise a
   * generic error toast is shown.
   */
  onFailed?: (name: MutationName, vars: WriteVars[MutationName], error: unknown, reason: string) => boolean;
}

const MAX_TRANSIENT_RETRIES = 3;

export function writeRetry(failureCount: number, error: unknown): boolean {
  if (isNetworkError(error)) return true; // paused by the online manager while offline
  if (isTransientError(error)) return failureCount < MAX_TRANSIENT_RETRIES;
  return false;
}

export function writeRetryDelay(failureCount: number): number {
  return Math.min(1000 * 2 ** failureCount, 30_000);
}

/** The owner-facing reason of a failed write (localized), plus the technical detail. */
function describeError(err: unknown): { reason: string; detail: string | null } {
  const friendly = friendlyError(err);
  return { reason: translate(friendly.message), detail: friendly.detail };
}

/**
 * Registers mutation defaults for every owner write. Returns the MutationCache callbacks the
 * QueryClient must be created with (see query-client.ts).
 */
export function registerWriteDefaults(qc: QueryClient, deps: { api?: AdminApi; now?: () => number } = {}): void {
  const api = deps.api ?? adminApi;
  const now = deps.now ?? Date.now;
  for (const name of MUTATION_NAMES) {
    qc.setMutationDefaults(mk[name], {
      mutationFn: (vars: unknown) => (send[name] as (v: unknown, a: AdminApi) => Promise<unknown>)(vars, api),
      scope: WRITE_SCOPE,
      networkMode: 'online',
      retry: writeRetry,
      retryDelay: writeRetryDelay,
      gcTime: 60_000,
      onMutate: (vars: unknown): WriteContext => {
        const tx = new CacheTx(qc);
        (optimistic[name] as (tx: CacheTx, vars: unknown, now: number) => void)(tx, vars, now());
        return { snapshot: tx.snapshot };
      },
    });
  }
}

/** MutationCache callbacks: confirmation, rollback and failure routing for owner writes. */
export function writeCacheCallbacks(getClient: () => QueryClient, handlers: WriteFailureHandlers) {
  return {
    onSuccess: (data: unknown, vars: unknown, _ctx: unknown, mutation: AnyMutation) => {
      const name = nameOf(mutation);
      if (!name) return;
      const v = vars as WriteVars[MutationName];
      confirm(getClient(), name, data as WriteResult[MutationName], v);
      // The editor draft this write saved is on the server now; "Saved – sending…" is confirmed.
      const draft = (vars as { draft?: DraftRef }).draft;
      if (draft) settleFieldDraft(draft);
      settleWriteNotice(entityOf(name, v), true);
    },
    onError: (error: unknown, vars: unknown, ctx: unknown, mutation: AnyMutation) => {
      const name = nameOf(mutation);
      if (!name) return;
      const qc = getClient();
      restoreSnapshot(qc, (ctx as WriteContext | undefined)?.snapshot);
      reapplyPending(qc, mutation.mutationId);
      const v = vars as WriteVars[MutationName];
      // A conflict merges into a new write of the same entity (its answer settles the toast).
      if (!isConflictError(error)) settleWriteNotice(entityOf(name, v), false);
      if (isConflictError(error)) handlers.onConflict(name, v);
      else if (isUnauthorizedError(error)) handlers.onUnauthorized(name, v);
      else {
        const { reason, detail } = describeError(error);
        if (!handlers.onFailed?.(name, v, error, reason)) {
          notify({ tone: 'error', message: msg`Could not save: ${reason}`, ...(detail ? { detail } : {}) });
        }
      }
    },
    onSettled: (_data: unknown, _error: unknown, _vars: unknown, _ctx: unknown, mutation: AnyMutation) => {
      const name = nameOf(mutation);
      if (!name) return;
      const qc = getClient();
      // Refetch aggregates only when no other write is still queued (they would flicker back).
      if (pendingWrites(qc, mutation.mutationId).length > 0) return;
      for (const queryKey of staleAfter(name)) {
        void qc.invalidateQueries({ queryKey, refetchType: 'active' });
      }
    },
  };
}

/** Runs a write outside React (conflict resolution, outbox replay, undo). */
export function runWrite<N extends MutationName>(
  qc: QueryClient,
  name: N,
  vars: WriteVars[N],
): Promise<WriteResult[N] | undefined> {
  const observer = new MutationObserver<WriteResult[N], unknown, WriteVars[N], WriteContext>(qc, {
    mutationKey: mk[name],
  });
  return observer.mutate(vars).catch(() => undefined);
}
