import type { DayDetail, Manifest, TimelineIndex, TripDetail } from '@omw/contracts/site';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { type ManifestBaseline, useSite } from '../site';
import { dayQueryOptions, findDay, manifestQueryOptions, timelineQueryOptions, tripQueryOptions } from './queries';

/** The accepted timeline hash (moves when the visitor accepts "new moments"). */
export function useTimelineV(): string | null {
  const { timelineVersion } = useSite();
  return useSyncExternalStore(timelineVersion.subscribe, timelineVersion.get, timelineVersion.get);
}

export interface DataState<T> {
  data: T | undefined;
  isPending: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

export function useTimeline(): DataState<TimelineIndex> {
  const { basePath } = useSite();
  const v = useTimelineV();
  const q = useQuery({ ...timelineQueryOptions(basePath, v ?? 'none'), enabled: v !== null });
  return { data: q.data, isPending: q.isPending, error: q.error, refetch: q.refetch };
}

export function useDay(date: string): DataState<DayDetail> {
  const { basePath } = useSite();
  const timeline = useTimeline().data;
  const v = timeline ? findDay(timeline, date)?.v : undefined;
  const q = useQuery({ ...dayQueryOptions(basePath, date, v ?? 'none'), enabled: v !== undefined });
  return { data: q.data, isPending: q.isPending, error: q.error, refetch: q.refetch };
}

export function useTrip(slug: string): { data: TripDetail | undefined; isPending: boolean; error: Error | null } {
  const { basePath } = useSite();
  const timeline = useTimeline().data;
  const v = timeline?.trips.find((t) => t.slug === slug)?.v;
  const q = useQuery({ ...tripQueryOptions(basePath, slug, v ?? 'none'), enabled: v !== undefined });
  return { data: q.data, isPending: q.isPending, error: q.error };
}

/**
 * What a fetched manifest means for "new moments".
 * - The FIRST manifest seen after the page loaded is the baseline. Generated day/story/trip pages
 *   carry the release in which THEIR content last changed (Boot.manifestVersion/timelineV; the
 *   generator keeps unchanged pages byte-identical), and static hosts ignore `?v`, so the data on
 *   screen already is that release: adopt its timeline hash quietly (`adopt`), no toast.
 * - Later manifests (the 5-minute poll) with a higher version are news (`fresh`), unless the
 *   visitor already switched to that timeline.
 */
export function manifestNews(
  baseline: Readonly<ManifestBaseline>,
  manifest: Pick<Manifest, 'version' | 'timeline'>,
  current: string | null,
): { adopt: string | null; fresh: string | null } {
  const v = manifest.timeline.v;
  if (!baseline.settled) return { adopt: v !== current ? v : null, fresh: null };
  const isNewer = baseline.version === null ? v !== current : manifest.version > baseline.version;
  return { adopt: null, fresh: isNewer && v !== current ? v : null };
}

/**
 * Polls the manifest (every 5 min, no-store). Returns the newer timeline hash when the site was
 * regenerated since the page loaded, so the UI can offer "new moments ✨" (see manifestNews).
 */
export function useNewMoments(): { newTimelineV: string | null; version: number | null } {
  const site = useSite();
  const current = useTimelineV();
  const { data } = useQuery(manifestQueryOptions(site.basePath));
  const news = data ? manifestNews(site.manifestBaseline, data, current) : null;
  useEffect(() => {
    if (!data || site.manifestBaseline.settled) return;
    site.manifestBaseline.settled = true;
    site.manifestBaseline.version = data.version;
    site.timelineVersion.set(data.timeline.v);
  }, [data, site]);
  return { newTimelineV: news?.fresh ?? null, version: data?.version ?? null };
}
