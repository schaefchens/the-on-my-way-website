/**
 * Immediate access client (spec-wave5 §7.2): people, devices, lock, panic link, privacy notice,
 * owner notices and the password change.
 *
 * These actions never go through writes.ts (offline queue, optimistic updates, 401 parking):
 * - plain requests through client.ts (same CSRF header and error type), run by
 *   `useMutation({ retry: 0, networkMode: 'always', gcTime: 0 })` under keys outside
 *   MUTATION_NAMES (keys.ts `ak`), which the persister never writes to IndexedDB (persist.ts);
 * - secrets (passwords) live only in the closure of one call, never in mutation variables;
 * - every store-changing result carries `effect`: applied → "In effect ✓"; not applied → "Not in
 *   effect yet ⏳" with "Try again" (POST /admin/access/retry) until a poll of /admin/access
 *   shows no pending op; a network failure → "Not sent – no connection" (never a success); a 401
 *   goes to the login screen (client.ts hook) and the action is not replayed.
 * Queries about people are defined in queries.ts with meta.persist = false.
 */
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type {
  AccessActionResult,
  AccessStatus,
  AccessSummary,
  AdminFollower,
  Effect,
  FollowerCreate,
  FollowerCreated,
  FollowerDataExport,
  FollowerListResponse,
  FollowerPatch,
  LockRequest,
  OwnerNoticeList,
  PanicLinkCreated,
  PersonalLinkCreated,
  PrivacyNoticeDraft,
  PrivacyState,
} from '@omw/contracts/access';
import type { PasswordChange, StatusResponse } from '@omw/contracts/api';
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { friendlyError } from '../lib/errors';
import { notify } from '../lib/notices';
import { createStore } from '../lib/store';
import { ApiRequestError, apiRequest } from './client';
import { ak, qk } from './keys';

const enc = encodeURIComponent;

/** Every admin access route of spec §3.5 / §3.12, exactly as the contracts name them. */
export const accessApi = {
  status: (signal?: AbortSignal) =>
    apiRequest<AccessStatus>('/access', { schema: 'AccessStatus', ...(signal ? { signal } : {}) }),
  followers: (signal?: AbortSignal) =>
    apiRequest<FollowerListResponse>('/followers', { schema: 'FollowerListResponse', ...(signal ? { signal } : {}) }),
  follower: (fid: string, signal?: AbortSignal) =>
    apiRequest<AdminFollower>(`/followers/${enc(fid)}`, { schema: 'AdminFollower', ...(signal ? { signal } : {}) }),
  createFollower: (body: FollowerCreate) =>
    apiRequest<FollowerCreated>('/followers', { method: 'POST', body, schema: 'FollowerCreated' }),
  patchFollower: (fid: string, body: FollowerPatch) =>
    apiRequest<AdminFollower>(`/followers/${enc(fid)}`, { method: 'PATCH', body, schema: 'AdminFollower' }),
  rotateLink: (fid: string) =>
    apiRequest<PersonalLinkCreated>(`/followers/${enc(fid)}/link`, {
      method: 'POST',
      body: {},
      schema: 'PersonalLinkCreated',
    }),
  revokeFollower: (fid: string) =>
    apiRequest<AccessActionResult>(`/followers/${enc(fid)}/revoke`, {
      method: 'POST',
      body: {},
      schema: 'AccessActionResult',
    }),
  exportFollower: (fid: string) =>
    apiRequest<FollowerDataExport>(`/followers/${enc(fid)}/export`, { schema: 'FollowerDataExport' }),
  deleteFollower: (fid: string) =>
    apiRequest<AccessActionResult>(`/followers/${enc(fid)}/delete`, {
      method: 'POST',
      body: { confirm: true },
      schema: 'AccessActionResult',
    }),
  approveDevice: (did: string) =>
    apiRequest<AccessActionResult>(`/devices/${enc(did)}/approve`, {
      method: 'POST',
      body: {},
      schema: 'AccessActionResult',
    }),
  declineDevice: (did: string) =>
    apiRequest<AccessActionResult>(`/devices/${enc(did)}/decline`, {
      method: 'POST',
      body: {},
      schema: 'AccessActionResult',
    }),
  revokeDevice: (did: string) =>
    apiRequest<AccessActionResult>(`/devices/${enc(did)}/revoke`, {
      method: 'POST',
      body: {},
      schema: 'AccessActionResult',
    }),
  lock: (body: LockRequest) =>
    apiRequest<AccessActionResult>('/access/lock', { method: 'POST', body, schema: 'AccessActionResult' }),
  retry: () => apiRequest<AccessStatus>('/access/retry', { method: 'POST', body: {}, schema: 'AccessStatus' }),
  storeInit: () =>
    apiRequest<AccessActionResult>('/access/store-init', { method: 'POST', body: {}, schema: 'AccessActionResult' }),
  createPanicLink: () =>
    apiRequest<PanicLinkCreated>('/access/panic-link', { method: 'POST', body: {}, schema: 'PanicLinkCreated' }),
  deletePanicLink: () => apiRequest<void>('/access/panic-link', { method: 'DELETE' }),
  privacy: (signal?: AbortSignal) =>
    apiRequest<PrivacyState>('/privacy', { schema: 'PrivacyState', ...(signal ? { signal } : {}) }),
  savePrivacyDraft: (draft: PrivacyNoticeDraft) =>
    apiRequest<PrivacyState>('/privacy/draft', { method: 'PUT', body: draft, schema: 'PrivacyState' }),
  publishPrivacy: (ifDraftSha256: string) =>
    apiRequest<PrivacyState>('/privacy/publish', {
      method: 'POST',
      body: { ifDraftSha256 },
      schema: 'PrivacyState',
    }),
  notices: (signal?: AbortSignal) =>
    apiRequest<OwnerNoticeList>('/notices', { schema: 'OwnerNoticeList', ...(signal ? { signal } : {}) }),
  readNotices: (ids: number[]) => apiRequest<void>('/notices/read', { method: 'POST', body: { ids } }),
  changePassword: (body: PasswordChange) => apiRequest<void>('/me/password', { method: 'PUT', body }),
};

export type AccessApi = typeof accessApi;

// ---------------------------------------------------------------------------------------------
// Outcomes ("In effect ✓" / "Not in effect yet ⏳" / "Not sent")

export type ActionOutcome =
  | { kind: 'applied'; via: Effect['via'] }
  | { kind: 'not_applied'; via: Effect['via']; pendingOps: number }
  /** No HTTP answer: the action did not reach the server (never shown as a success). */
  | { kind: 'unsent' }
  /** 401: the login screen takes over; the action is not replayed. */
  | { kind: 'login' }
  | { kind: 'error'; error: unknown };

/** What one access action achieved, from its result or its error. */
export function outcomeOf(
  result: Pick<AccessActionResult, 'effect'> | null | undefined,
  error?: unknown,
): ActionOutcome {
  if (error !== undefined && error !== null) {
    if (error instanceof ApiRequestError && error.status === 0) return { kind: 'unsent' };
    if (error instanceof ApiRequestError && error.status === 401) return { kind: 'login' };
    return { kind: 'error', error };
  }
  if (!result) return { kind: 'error', error: new Error('no result') };
  const e = result.effect;
  return e.applied ? { kind: 'applied', via: e.via } : { kind: 'not_applied', via: e.via, pendingOps: e.pendingOps };
}

/** The last access action and how far it got (the effect badge renders it). */
export interface EffectEntry {
  id: number;
  /** What was done ("Device allowed"), translated when rendered. */
  what: MessageDescriptor;
  values?: Record<string, unknown>;
  outcome: ActionOutcome;
  /** When the outcome was recorded (ms); a status fetched after this may settle "not applied". */
  at: number;
}

export const effectStore = createStore<EffectEntry | null>(null);
let nextEffectId = 1;

export function recordEffect(
  what: MessageDescriptor,
  outcome: ActionOutcome,
  values?: Record<string, unknown>,
  now = Date.now(),
): EffectEntry | null {
  if (outcome.kind === 'login' || outcome.kind === 'error') return null;
  const entry: EffectEntry = { id: nextEffectId++, what, outcome, at: now, ...(values ? { values } : {}) };
  effectStore.set(entry);
  return entry;
}

/**
 * A pending effect is in the store once the API reports no pending op any more (fetched after
 * the action). Returns the settled entry, or the same entry when nothing changed.
 */
export function settleEffect(
  entry: EffectEntry,
  status: Pick<AccessSummary, 'pendingOps' | 'writer'> | undefined,
  fetchedAt: number,
): EffectEntry {
  if (entry.outcome.kind !== 'not_applied' || !status || fetchedAt <= entry.at) return entry;
  if (status.pendingOps > 0) return entry;
  const via: Effect['via'] = status.writer.mode === 'none' ? 'mac' : status.writer.mode;
  return { ...entry, outcome: { kind: 'applied', via } };
}

export function dismissEffect(id: number): void {
  if (effectStore.get()?.id === id) effectStore.set(null);
}

// ---------------------------------------------------------------------------------------------
// Errors in the owner's words

/** Warm copy for the access-specific error codes of spec §3.5/§3.12; null = use friendlyError. */
export function accessErrorCopy(err: unknown): MessageDescriptor | null {
  if (!(err instanceof ApiRequestError)) return null;
  switch (err.code) {
    case 'config_missing':
      return msg`The server does not know the address of your website yet (SITE_ORIGIN in its settings).`;
    case 'notice_incomplete':
      return msg`The privacy notice is not complete yet.`;
    case 'conflict':
      // The API answers an approve during a restore check with a 409 conflict, too (§3.8.6).
      if (/restore/i.test(err.message))
        return msg`After a restore, access is still being checked. Try again in a minute.`;
      return msg`This was changed elsewhere in the meantime. Look at it again, then try once more.`;
    case 'wrong_password':
      return msg`The current password is not right.`;
    case 'restoring':
      return msg`After a restore, access is still being checked. Try again in a minute.`;
    case 'device_limit':
      return msg`This person already has the most devices allowed. Remove one first.`;
    default:
      break;
  }
  if (err.status === 403 && err.code === 'forbidden') return msg`The password is not right.`;
  if (err.status === 429) return msg`Too many attempts. Please wait a little and try again.`;
  return null;
}

export function accessErrorMessage(err: unknown): { message: MessageDescriptor; detail: string | null } {
  const friendly = friendlyError(err);
  return { message: accessErrorCopy(err) ?? friendly.message, detail: friendly.detail };
}

// ---------------------------------------------------------------------------------------------
// Cache glue

/** Puts an action's result into the caches at once, then refetches everything about access. */
export function applyActionResult(qc: QueryClient, result: Partial<AccessActionResult>): void {
  const follower = result.follower;
  if (follower) {
    qc.setQueryData(qk.access.follower(follower.id), follower);
    qc.setQueryData<FollowerListResponse>(qk.access.followers, (list) =>
      list ? { ...list, items: list.items.map((f) => (f.id === follower.id ? follower : f)) } : list,
    );
  }
  const device = result.device;
  if (device && !follower) {
    const patchDevices = (f: AdminFollower): AdminFollower =>
      f.devices.some((d) => d.id === device.id)
        ? { ...f, devices: f.devices.map((d) => (d.id === device.id ? device : d)) }
        : f;
    qc.setQueryData<FollowerListResponse>(qk.access.followers, (list) =>
      list ? { ...list, items: list.items.map(patchDevices) } : list,
    );
    for (const q of qc.getQueryCache().findAll({ queryKey: [...qk.access.all, 'follower'] })) {
      qc.setQueryData<AdminFollower>(q.queryKey, (f) => (f ? patchDevices(f) : f));
    }
  }
  if (result.status) noteAccessSummary(qc, result.status);
  void qc.invalidateQueries({ queryKey: qk.access.all });
  void qc.invalidateQueries({ queryKey: qk.status });
}

/** The counts-only summary of the (persisted) status query follows every fresh answer. */
export function noteAccessSummary(qc: QueryClient, summary: AccessSummary): void {
  const { locked, lockedAt, lockedBy, pendingDevices, pendingOps, oldestPendingOpAt, writer } = summary;
  const { restoring, mismatch, unreadNotices, noticeVersion } = summary;
  // Only the AccessSummary fields: AccessStatus carries names (pending cards), which must never
  // reach the persisted status query.
  const clean: AccessSummary = {
    locked,
    lockedAt,
    lockedBy,
    pendingDevices,
    pendingOps,
    oldestPendingOpAt,
    writer,
    restoring,
    mismatch,
    unreadNotices,
    noticeVersion,
  };
  qc.setQueryData<StatusResponse>(qk.status, (s) => (s ? { ...s, access: clean } : s));
}

// ---------------------------------------------------------------------------------------------
// Hooks

export interface AccessActionRun<T> {
  /** What is being done, for the effect badge ("Device allowed"). */
  what: MessageDescriptor;
  values?: Record<string, unknown>;
  /** The request; secrets stay inside this closure. */
  call: () => Promise<T>;
  /** True when the caller explains this error itself (inline); otherwise a toast does. */
  handles?: (error: unknown) => boolean;
}

/**
 * Store-changing actions (approve, decline, revoke, lock, store init, delete): the result goes
 * into the caches and the effect badge. Errors other than "not sent" are returned to the caller
 * (onError) so it can explain them where the owner is looking.
 */
export function useAccessAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ak.action,
    retry: 0,
    networkMode: 'always',
    gcTime: 0,
    mutationFn: (run: AccessActionRun<AccessActionResult>) => run.call(),
    onSuccess: (result, run) => {
      applyActionResult(qc, result);
      recordEffect(run.what, outcomeOf(result), run.values);
    },
    onError: (error, run) => {
      const outcome = outcomeOf(null, error);
      recordEffect(run.what, outcome, run.values);
      if (outcome.kind === 'error' && !run.handles?.(error)) notifyAccessError(error);
      void qc.invalidateQueries({ queryKey: qk.access.all });
    },
  });
}

/** Error toast in the owner's words (network failures: "Not sent – no connection"). */
export function notifyAccessError(error: unknown): void {
  if (error instanceof ApiRequestError && error.status === 401) return;
  if (error instanceof ApiRequestError && error.status === 0) {
    notify({ tone: 'error', message: msg`Not sent – no connection` });
    return;
  }
  const m = accessErrorMessage(error);
  notify({ tone: 'error', message: m.message, ...(m.detail ? { detail: m.detail } : {}) });
}

/** Other immediate requests (create, rename, rotate link, privacy, notices): no store effect. */
export function useAccessRequest<T>() {
  return useMutation({
    mutationKey: ak.action,
    retry: 0,
    networkMode: 'always',
    gcTime: 0,
    mutationFn: (call: () => Promise<T>) => call(),
  });
}

// ---------------------------------------------------------------------------------------------
// Files

/** "on-my-way-data-oma-2026-11-20.json" (ASCII, short; the name only helps the owner find it). */
export function exportFileName(name: string, now = new Date()): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  const date = now.toISOString().slice(0, 10);
  return `on-my-way-data-${slug ? `${slug}-` : ''}${date}.json`;
}

/** Saves JSON as a download (Blob URL, revoked right after). */
export function downloadJson(data: unknown, fileName: string): void {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
