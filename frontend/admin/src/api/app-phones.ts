/**
 * "Connect a phone" (the traveler app, app-plan §3.6–3.7): pairing codes, connected phones with
 * Disconnect, and the details behind the App badge. Routes: api/src/Http/App/AppRoutes.php;
 * bodies: @omw/contracts/app (pairing) and @omw/contracts/app-inbox (phones, entry info).
 *
 * A pairing code is a secret: it lives only in the creating component's state (never in the
 * persisted query cache) and is single use, valid 1 h by default (24 h at most).
 */
import type { AppPairingCreated } from '@omw/contracts/app';
import type { AppEntryAdminInfo, AppPhoneListResponse } from '@omw/contracts/app-inbox';
import { queryOptions } from '@tanstack/react-query';
import { apiRequest } from './client';

export const appKeys = {
  phones: ['admin', 'app-phones'] as const,
  entry: (sourceKey: string) => ['admin', 'app-entry', sourceKey] as const,
};

export const appPhonesApi = {
  phones: (signal?: AbortSignal) => apiRequest<AppPhoneListResponse>('/app-phones', signal ? { signal } : {}),
  /** A new code cancels the open one. */
  createPairing: (ttlMinutes: number) =>
    apiRequest<AppPairingCreated>('/app-pairings', { method: 'POST', body: { ttlMinutes } }),
  /** 204 also when the phone was disconnected already. */
  disconnect: (id: number) => apiRequest<void>(`/app-phones/${id}`, { method: 'DELETE' }),
  entry: (sourceKey: string, signal?: AbortSignal) =>
    apiRequest<AppEntryAdminInfo>(`/app-entries/${encodeURIComponent(sourceKey)}`, signal ? { signal } : {}),
};

export const appPhonesQuery = () =>
  queryOptions({
    queryKey: appKeys.phones,
    queryFn: ({ signal }) => appPhonesApi.phones(signal),
    staleTime: 15_000,
    // A phone she just connected shows up without a reload.
    refetchInterval: 30_000,
  });

export const appEntryQuery = (sourceKey: string) =>
  queryOptions({
    queryKey: appKeys.entry(sourceKey),
    queryFn: ({ signal }) => appPhonesApi.entry(sourceKey, signal),
    staleTime: 60_000,
    retry: false,
  });

/** Pairing lifetimes the owner can pick (minutes): the code may travel by chat across time zones. */
export const PAIRING_TTLS = [60, 24 * 60] as const;
