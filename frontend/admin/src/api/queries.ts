/** Query option factories (one place for keys, fetchers and freshness). */
import type { CaptureListResponse } from '@omw/contracts/api';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { lastChangeStore, statusPollMs } from '../lib/publish';
import { adminApi } from './client';
import { type CaptureFilter, qk } from './keys';

export const CAPTURE_PAGE_SIZE = 40;

/**
 * Every 10 s while something is on its way to the site (our latest change or the newest status
 * is not deployed yet), else every minute; also on focus/visibility and reconnect (QueryClient
 * defaults) and right after the queued writes drained (writes.ts invalidates it).
 */
export const statusQuery = () =>
  queryOptions({
    queryKey: qk.status,
    queryFn: ({ signal }) => adminApi.status(signal),
    staleTime: 5_000,
    refetchInterval: (query) => statusPollMs(query.state.data, lastChangeStore.get()),
    refetchOnWindowFocus: 'always',
  });

export const settingsQuery = () =>
  queryOptions({ queryKey: qk.settings, queryFn: ({ signal }) => adminApi.settings(signal), staleTime: 60_000 });

export const daysQuery = () => queryOptions({ queryKey: qk.days, queryFn: ({ signal }) => adminApi.days(signal) });

export const dayQuery = (date: string) =>
  queryOptions({ queryKey: qk.day(date), queryFn: ({ signal }) => adminApi.day(date, signal) });

export const tripsQuery = () =>
  queryOptions({ queryKey: qk.trips, queryFn: ({ signal }) => adminApi.trips(signal), staleTime: 60_000 });

export const captureQuery = (sourceKey: string) =>
  queryOptions({ queryKey: qk.capture(sourceKey), queryFn: ({ signal }) => adminApi.capture(sourceKey, signal) });

export const postQuery = (publicId: string) =>
  queryOptions({ queryKey: qk.post(publicId), queryFn: ({ signal }) => adminApi.post(publicId, signal) });

export const postsQuery = (filter: { date?: string; kind?: 'note' | 'story' } = {}) =>
  queryOptions({
    queryKey: qk.posts(filter),
    queryFn: ({ signal }) => adminApi.posts({ ...filter, limit: 50 }, signal),
  });

/** Tokens are never persisted (names and hints only, but they are security-relevant). */
export const tokensQuery = () =>
  queryOptions({
    queryKey: qk.tokens,
    queryFn: ({ signal }) => adminApi.tokens(signal),
    meta: { persist: false },
  });

export const capturesQuery = (filter: CaptureFilter = {}) =>
  infiniteQueryOptions({
    queryKey: qk.captures(filter),
    queryFn: ({ pageParam, signal }): Promise<CaptureListResponse> =>
      adminApi.captures(
        {
          ...(filter.date ? { date: filter.date } : {}),
          ...(filter.visibility ? { visibility: filter.visibility } : {}),
          ...(filter.kind ? { kind: filter.kind } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
          limit: CAPTURE_PAGE_SIZE,
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
