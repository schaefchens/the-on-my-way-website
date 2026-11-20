/**
 * Runtime site context: basePath + data context + boot, created once in main.tsx and shared by
 * the router (loaders) and React (hooks).
 */
import type { LocaleCode } from '@omw/contracts/i18n';
import { QueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext } from 'react';
import type { SiteBoot } from './boot';
import { FALLBACK_LOCALE } from './config';
import { DataFetchError } from './data/fetch';
import { createVersionStore, type DataContext, seedFromBoot } from './data/queries';

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

/** Retry network failures and 5xx twice; 4xx and contract violations are final. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (error instanceof DataFetchError) return error.status === 0 || error.status >= 500;
  return false;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
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
