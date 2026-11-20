/**
 * Session lifecycle around the cookie session: after login the CSRF token is set, writes that
 * failed with 401 are replayed and paused writes resume; logout drops every trace of the owner's
 * data on this device (query cache, persisted IndexedDB copy, queued writes, drafts).
 */
import type { Me } from '@omw/contracts/api';
import type { QueryClient } from '@tanstack/react-query';
import type { Persister } from '@tanstack/react-query-persist-client';
import { adminApi, setCsrfToken } from './api/client';
import { clearOutbox, flushOutbox } from './api/outbox';
import { resetVersions } from './api/writes';
import { authQueryKey, rememberMe } from './auth';
import { clearDrafts, clearFieldDrafts } from './lib/drafts';
import { lastChangeStore } from './lib/publish';

let persister: Persister | null = null;

export function setSessionPersister(p: Persister | null): void {
  persister = p;
}

export async function completeLogin(qc: QueryClient, me: Me): Promise<void> {
  setCsrfToken(me.csrfToken);
  rememberMe(me);
  qc.setQueryData(authQueryKey, { me, error: null });
  await flushOutbox(qc);
  void qc.resumePausedMutations();
  void qc.invalidateQueries({ predicate: (q) => q.queryKey[1] !== 'auth' });
}

/** Ends the session on the server (best effort) and wipes local owner data. */
export async function logout(qc: QueryClient): Promise<void> {
  try {
    await adminApi.logout();
  } catch {
    // Already logged out or offline: the local wipe below still happens.
  }
  setCsrfToken(null);
  rememberMe(null);
  clearOutbox();
  clearDrafts();
  clearFieldDrafts();
  resetVersions();
  lastChangeStore.set(null);
  qc.getMutationCache().clear();
  qc.clear();
  qc.setQueryData(authQueryKey, { me: null, error: null });
  await persister?.removeClient();
}
