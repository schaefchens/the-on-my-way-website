/**
 * Runtime site context: basePath + data context + boot, created once in main.tsx and shared by
 * the router (loaders) and React (hooks).
 */
import type { LocaleCode } from '@omw/contracts/i18n';
import type { HereNow, TimePrecision } from '@omw/contracts/site';
import { QueryCache, QueryClient, useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext } from 'react';
import { configureAccess, onAccessEnded } from './access/access';
import type { SiteBoot } from './boot';
import { FALLBACK_LOCALE } from './config';
import { AccessEndedError, DataFetchError } from './data/fetch';
import { createVersionStore, type DataContext, manifestQueryOptions, seedFromBoot } from './data/queries';

/**
 * Baseline of "new moments" (data/hooks.ts manifestNews): the boot's manifest version until the
 * first manifest of this page load settles it. Mutable, one per page load.
 */
export interface ManifestBaseline {
  version: number | null;
  settled: boolean;
}

export interface SiteContextValue extends DataContext {
  boot: SiteBoot;
  defaultLocale: LocaleCode;
  /** Manifest version the page was generated from (null until known). */
  initialManifestVersion: number | null;
  manifestBaseline: ManifestBaseline;
}

/**
 * Retry network failures and 5xx twice; 4xx and contract violations are final. A refused request
 * (AccessEndedError) is never retried: the access layer takes over (src/access/access.ts).
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof AccessEndedError) return false;
  if (failureCount >= 2) return false;
  if (error instanceof DataFetchError) return error.status === 0 || error.status >= 500;
  return false;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    // Any query (a loader, the manifest poll, a prefetch) the gate refuses ends viewing.
    queryCache: new QueryCache({
      onError: (error) => {
        if (error instanceof AccessEndedError) void onAccessEnded();
      },
    }),
    defaultOptions: {
      queries: { retry: shouldRetry, refetchOnWindowFocus: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
}

export function createSiteContext(boot: SiteBoot, queryClient: QueryClient = createQueryClient()): SiteContextValue {
  const ctx: SiteContextValue = {
    basePath: boot.basePath,
    queryClient,
    timelineVersion: createVersionStore(boot.timelineV),
    boot,
    defaultLocale: boot.locale ?? FALLBACK_LOCALE,
    initialManifestVersion: boot.manifestVersion,
    manifestBaseline: { version: boot.manifestVersion, settled: false },
  };
  seedFromBoot(ctx, boot);
  configureAccess({ access: boot.access, queryClient });
  return ctx;
}

const SiteContext = createContext<SiteContextValue | null>(null);

export function SiteProvider({ value, children }: { value: SiteContextValue; children: ReactNode }) {
  return <SiteContext.Provider value={value}>{children}</SiteContext.Provider>;
}

export function useSite(): SiteContextValue {
  const ctx = useContext(SiteContext);
  if (!ctx) throw new Error('useSite() outside <SiteProvider>');
  return ctx;
}

export interface SiteFlags {
  /** SiteInfo.hereNow (Q2): how the current stay is shown; absent = "city_badge". */
  hereNow: HereNow;
  /** SiteInfo.timePrecision: "part_of_day" shows parts of the day instead of clock times. */
  timePrecision: TimePrecision;
}

const DEFAULT_FLAGS: SiteFlags = { hereNow: 'city_badge', timePrecision: 'exact' };

/** The site's display flags from the manifest (defaults until it has loaded). */
export function useSiteFlags(): SiteFlags {
  const { basePath } = useSite();
  const { data } = useQuery({
    ...manifestQueryOptions(basePath),
    // The flags only read the shared manifest; the polling observer lives in useNewMoments.
    refetchInterval: false,
    refetchOnWindowFocus: false,
    select: (m): SiteFlags => ({
      hereNow: m.site.hereNow ?? DEFAULT_FLAGS.hereNow,
      timePrecision: m.site.timePrecision ?? DEFAULT_FLAGS.timePrecision,
    }),
  });
  return data ?? DEFAULT_FLAGS;
}
