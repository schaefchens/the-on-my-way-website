/**
 * Post-deploy HTTP check: GET <publicBaseUrl>data/manifest.json?t=<now> (no-store) and compare
 * Manifest.version. Catches wrong remote roots, wrong public URLs and stale caches/CDNs.
 */
import type { HttpCheck } from './types.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpCheckOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Tries (a stale cache may need a moment). Default 3. */
  attempts?: number;
  /** Delay between tries (default 1500 ms). */
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface HttpCheckResult {
  status: HttpCheck;
  detail: string;
  url: string;
}

export function manifestUrl(publicBaseUrl: string, now: Date): string {
  const base = publicBaseUrl.endsWith('/') ? publicBaseUrl : `${publicBaseUrl}/`;
  const url = new URL('data/manifest.json', base);
  url.searchParams.set('t', String(now.getTime()));
  return url.toString();
}

export async function checkPublishedVersion(
  publicBaseUrl: string | null,
  expected: number | null,
  opts: HttpCheckOptions = {},
): Promise<HttpCheckResult> {
  if (!publicBaseUrl) return { status: 'skipped', detail: 'no public URL configured', url: '' };
  if (expected === null) return { status: 'skipped', detail: 'no manifest version to compare', url: '' };
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, opts.attempts ?? 3);
  let last: HttpCheckResult = { status: 'error', detail: 'not checked', url: '' };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(opts.retryDelayMs ?? 1500);
    const url = manifestUrl(publicBaseUrl, (opts.now ?? (() => new Date()))());
    last = await once(doFetch, url, expected, opts.timeoutMs ?? 15_000);
    if (last.status === 'ok') return last;
  }
  return last;
}

async function once(doFetch: FetchLike, url: string, expected: number, timeoutMs: number): Promise<HttpCheckResult> {
  try {
    const res = await doFetch(url, {
      cache: 'no-store',
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { status: 'error', detail: `HTTP ${res.status}`, url };
    }
    const text = await res.text();
    let version: unknown;
    try {
      version = (JSON.parse(text) as { version?: unknown }).version;
    } catch {
      return { status: 'error', detail: 'response is not JSON', url };
    }
    if (typeof version !== 'number') return { status: 'error', detail: 'response has no numeric version', url };
    return version === expected
      ? { status: 'ok', detail: `version ${version}`, url }
      : { status: 'mismatch', detail: `expected version ${expected}, got ${version}`, url };
  } catch (err) {
    const e = err as Error;
    return { status: 'error', detail: e.name === 'TimeoutError' ? 'timed out' : e.message, url };
  }
}
