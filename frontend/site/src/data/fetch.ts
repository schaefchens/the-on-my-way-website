/**
 * Fetchers for the static data files. In dev builds every response is validated against the
 * @omw/contracts/site schemas (loaded lazily, so zod never reaches the production bundle).
 *
 * - Every request has a deadline (DATA_FETCH_TIMEOUT_MS, for the response AND its body). A
 *   timeout is a network error (DataFetchError status 0), which the query layer retries
 *   (site.ts shouldRetry) before the error screens show.
 * - Requests are plain CORS-mode GETs with the default credentials mode ("same-origin") and no
 *   custom headers, so a generated page's `<link rel="preload" as="fetch" crossorigin>` for the
 *   same URL (timeline.json?v=…) is reused instead of downloaded twice.
 */
import type { DayDetail, Manifest, TimelineIndex, TripDetail } from '@omw/contracts/site';
import { dayUrl, manifestUrl, timelineUrl, tripUrl } from './urls';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** How long one request (headers + body) may take before it counts as a network error. */
export const DATA_FETCH_TIMEOUT_MS = 15_000;

export class DataFetchError extends Error {
  readonly url: string;
  /** HTTP status; 0 for network errors and timeouts. */
  readonly status: number;
  constructor(url: string, status: number, message?: string) {
    super(message ?? `GET ${url} failed with HTTP ${status}`);
    this.name = 'DataFetchError';
    this.url = url;
    this.status = status;
  }
}

export interface SiteDataTypes {
  Manifest: Manifest;
  TimelineIndex: TimelineIndex;
  DayDetail: DayDetail;
  TripDetail: TripDetail;
}
export type SiteDataName = keyof SiteDataTypes;

async function devValidated<K extends SiteDataName>(name: K, data: unknown): Promise<SiteDataTypes[K]> {
  if (import.meta.env.DEV) {
    const { validateSiteData } = await import('./validate.dev');
    return validateSiteData(name, data);
  }
  return data as SiteDataTypes[K];
}

/** Marker reason of a deadline abort (tells a timeout apart from the caller's own abort). */
class Deadline extends Error {
  override name = 'TimeoutError';
}

/**
 * Runs `work` with a signal that aborts after `ms` or when `outer` aborts, and settles no later
 * than that, even if `work` ignores its signal. Rejects with the abort reason (a Deadline for
 * the timeout, the outer signal's reason otherwise).
 */
export function withDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  outer?: AbortSignal | null,
): Promise<T> {
  if (outer?.aborted) return Promise.reject(outer.reason);
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener('abort', onOuterAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Deadline(`timed out after ${ms} ms`)), ms);
  return new Promise<T>((resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    work(controller.signal).then(resolve, reject);
  }).finally(() => {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  });
}

async function getJson(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  outer: AbortSignal | null | undefined,
  timeoutMs: number,
): Promise<unknown> {
  try {
    return await withDeadline(
      async (signal) => {
        let res: Response;
        try {
          res = await fetchImpl(url, { ...init, signal });
        } catch (err) {
          throw new DataFetchError(url, 0, `GET ${url} failed: ${(err as Error).message}`);
        }
        if (!res.ok) throw new DataFetchError(url, res.status);
        try {
          return (await res.json()) as unknown;
        } catch {
          if (signal.aborted) throw signal.reason;
          throw new DataFetchError(url, res.status, `GET ${url} returned invalid JSON`);
        }
      },
      timeoutMs,
      outer,
    );
  } catch (err) {
    if (err instanceof Deadline) throw new DataFetchError(url, 0, `GET ${url} ${err.message}`);
    throw err;
  }
}

export interface FetchOptions {
  fetch?: FetchLike;
  signal?: AbortSignal;
  /** Fetch priority hint (e.g. "low" for the timeline behind a deep-linked player). */
  priority?: RequestPriority;
  /** Deadline of the request (default DATA_FETCH_TIMEOUT_MS). */
  timeoutMs?: number;
}

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

function load(url: string, opts: FetchOptions, init: RequestInit = {}): Promise<unknown> {
  return getJson(
    url,
    opts.priority ? { ...init, priority: opts.priority } : init,
    opts.fetch ?? defaultFetch,
    opts.signal,
    opts.timeoutMs ?? DATA_FETCH_TIMEOUT_MS,
  );
}

export async function fetchManifest(basePath: string, opts: FetchOptions & { now?: number } = {}): Promise<Manifest> {
  const data = await load(manifestUrl(basePath, opts.now), opts, { cache: 'no-store' });
  return devValidated('Manifest', data);
}

export async function fetchTimeline(basePath: string, v: string, opts: FetchOptions = {}): Promise<TimelineIndex> {
  const data = await load(timelineUrl(basePath, v), opts);
  return devValidated('TimelineIndex', data);
}

export async function fetchDay(basePath: string, date: string, v: string, opts: FetchOptions = {}): Promise<DayDetail> {
  const data = await load(dayUrl(basePath, date, v), opts);
  return devValidated('DayDetail', data);
}

export async function fetchTrip(
  basePath: string,
  slug: string,
  v: string,
  opts: FetchOptions = {},
): Promise<TripDetail> {
  const data = await load(tripUrl(basePath, slug, v), opts);
  return devValidated('TripDetail', data);
}
