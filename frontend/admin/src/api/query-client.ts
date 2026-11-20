/**
 * The admin's QueryClient: freshness and retry policy, owner-write defaults (writes.ts) and the
 * cache callbacks that confirm, roll back and route failed writes.
 */
import type { StatusResponse } from '@omw/contracts/api';
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { type AdminApi, isNetworkError, isTransientError } from './client';
import { type MutationName, qk } from './keys';
import { CACHE_MAX_AGE_MS } from './persist';
import type { WriteVars } from './types';
import { noteFeedId, pendingWrites, reapplyPending, registerWriteDefaults, writeCacheCallbacks } from './writes';

export interface AdminQueryClientDeps {
  api?: AdminApi;
  now?: () => number;
  onConflict: (qc: QueryClient, name: MutationName, vars: WriteVars[MutationName]) => void;
  onUnauthorizedWrite: (qc: QueryClient, name: MutationName, vars: WriteVars[MutationName]) => void;
  /** Final failure of a write (see WriteFailureHandlers.onFailed); true = the owner was told. */
  onFailedWrite?: (
    qc: QueryClient,
    name: MutationName,
    vars: WriteVars[MutationName],
    error: unknown,
    reason: string,
  ) => boolean;
}

export function queryRetry(failureCount: number, error: unknown): boolean {
  if (isNetworkError(error)) return failureCount < 5; // paused while offline, then retried
  if (isTransientError(error)) return failureCount < 2;
  return false;
}

export function createAdminQueryClient(deps: AdminQueryClientDeps): QueryClient {
  let client: QueryClient | null = null;
  const getClient = () => {
    if (!client) throw new Error('QueryClient not ready');
    return client;
  };
  const callbacks = writeCacheCallbacks(getClient, {
    onConflict: (name, vars) => deps.onConflict(getClient(), name, vars),
    onUnauthorized: (name, vars) => deps.onUnauthorizedWrite(getClient(), name, vars),
    onFailed: (name, vars, error, reason) => deps.onFailedWrite?.(getClient(), name, vars, error, reason) ?? false,
  });
  const queryCache = new QueryCache({
    onSuccess: (data, query) => {
      // A different API change feed (restored/reinstalled database) invalidates every version
      // the rebase map remembers.
      if (query.queryKey[0] === qk.status[0] && query.queryKey[1] === qk.status[1]) {
        noteFeedId((data as StatusResponse | undefined)?.backend?.sync.feedId);
      }
      // A refetch that lands while writes are queued must not hide their optimistic state.
      if (client && pendingWrites(client).length > 0) reapplyPending(client);
    },
  });
  client = new QueryClient({
    queryCache,
    mutationCache: new MutationCache(callbacks),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: CACHE_MAX_AGE_MS,
        retry: queryRetry,
        refetchOnWindowFocus: true,
      },
    },
  });
  registerWriteDefaults(client, { ...(deps.api ? { api: deps.api } : {}), ...(deps.now ? { now: deps.now } : {}) });
  return client;
}
