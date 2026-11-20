/**
 * Query cache persistence in IndexedDB (idb-keyval): the admin opens with the last known data
 * while offline, and queued writes survive reloads and app restarts.
 *
 * - Persisted: successful queries (except those with meta.persist === false: auth, tokens) and
 *   every PENDING owner write. Pending writes are stored as paused, so after a reload they
 *   resume through QueryClient.resumePausedMutations() (a write whose answer was lost is
 *   replayed: creates are idempotent, and a replayed update that already landed is recognised
 *   by the conflict handler as "already applied").
 * - The buster changes only when the cached data shape changes (not on every deploy), so queued
 *   writes survive app updates.
 */
import { contractVersion } from '@omw/contracts';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type { Mutation, Query } from '@tanstack/react-query';
import type { PersistedClient, Persister, PersistQueryClientOptions } from '@tanstack/react-query-persist-client';
import { createStore as createIdbStore, del, get, set } from 'idb-keyval';

/** Bump when a cached query's data shape changes incompatibly. */
const CACHE_SCHEMA = 1;
export const CACHE_BUSTER = `omw-admin-${CACHE_SCHEMA}-c${contractVersion}`;
export const CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const PERSIST_KEY = 'omw-admin-query-cache';

/** Stores still-running writes as paused so a restored client resumes them. */
export function markPendingAsPaused(client: PersistedClient): PersistedClient {
  const mutations = client.clientState.mutations.map((m) =>
    m.state.status === 'pending' && !m.state.isPaused ? { ...m, state: { ...m.state, isPaused: true } } : m,
  );
  return { ...client, clientState: { ...client.clientState, mutations } };
}

export const dehydrateOptions = {
  shouldDehydrateQuery: (query: Query) => query.state.status === 'success' && query.meta?.persist !== false,
  shouldDehydrateMutation: (mutation: Mutation) => mutation.state.status === 'pending',
};

export interface PersistStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
  removeItem(key: string): Promise<void>;
}

/** Persister over any async string storage (IndexedDB in the app, a Map in tests). */
export function createAdminPersister(storage: PersistStorage, throttleTime = 500): Persister {
  return createAsyncStoragePersister({
    storage,
    key: PERSIST_KEY,
    throttleTime,
    serialize: (client) => JSON.stringify(markPendingAsPaused(client)),
  });
}

export function createIdbPersister(): Persister {
  const store = createIdbStore('omw-admin', 'query-cache');
  return createAdminPersister({
    getItem: async (key) => (await get<string>(key, store)) ?? null,
    setItem: (key, value) => set(key, value, store),
    removeItem: (key) => del(key, store),
  });
}

export function persistOptions(persister: Persister): Omit<PersistQueryClientOptions, 'queryClient'> {
  return {
    persister,
    maxAge: CACHE_MAX_AGE_MS,
    buster: CACHE_BUSTER,
    dehydrateOptions,
  };
}
