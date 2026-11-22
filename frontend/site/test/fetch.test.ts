/**
 * Request deadlines (W2-18): a data request that never answers fails after
 * DATA_FETCH_TIMEOUT_MS as a retryable network error, and the query layer gives up after its
 * two retries, so the error screens can show instead of a spinner forever.
 */
import type { Manifest } from '@omw/contracts/site';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteBoot } from '../src/boot';
import { DATA_FETCH_TIMEOUT_MS, DataFetchError, type FetchLike, fetchTimeline, withDeadline } from '../src/data/fetch';
import { ensureTimeline } from '../src/data/queries';
import { createQueryClient, createSiteContext, shouldRetry } from '../src/site';

/** A fetch that never settles, not even when its signal aborts (worst case). */
function hangingFetch() {
  const signals: AbortSignal[] = [];
  const impl: FetchLike = (_input, init) => {
    if (init?.signal) signals.push(init.signal);
    return new Promise<Response>(() => {});
  };
  return { impl, signals };
}

describe('request deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is 15 s', () => {
    expect(DATA_FETCH_TIMEOUT_MS).toBe(15_000);
  });

  it('rejects a never-resolving fetch after the timeout as a retryable network error', async () => {
    const { impl, signals } = hangingFetch();
    const result = fetchTimeline('/', 'tl000001', { fetch: impl }).then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(DATA_FETCH_TIMEOUT_MS - 1);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const err = await result;
    expect(err).toBeInstanceOf(DataFetchError);
    expect(err).toMatchObject({ status: 0, url: '/data/timeline.json?v=tl000001' });
    expect((err as Error).message).toMatch(/timed out after 15000 ms/);
    // The request itself was aborted too (no download keeps running in the background).
    expect(signals[0]?.aborted).toBe(true);
    expect(shouldRetry(0, err)).toBe(true);
  });

  it("passes the caller's abort through (not a timeout)", async () => {
    const outer = new AbortController();
    const reason = new DOMException('cancelled', 'AbortError');
    const p = withDeadline(() => new Promise<never>(() => {}), 1000, outer.signal);
    outer.abort(reason);
    await expect(p).rejects.toBe(reason);
    await expect(withDeadline(async () => 1, 1000, outer.signal)).rejects.toBe(reason);
  });

  it('clears its timer when the work settles first', async () => {
    await expect(withDeadline(async () => 42, 1000)).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the query layer retries a hung timeline twice, then fails (error screen)', async () => {
    const manifest: Manifest = {
      contractVersion: 1,
      version: 1,
      generatedAt: '2026-11-19T10:00:00.000Z',
      site: { title: 'On My Way', locales: ['de'], defaultLocale: 'de', basePath: '/', indexable: false },
      timeline: { v: 'tl000001' },
    };
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('manifest')) return Promise.resolve(Response.json(manifest));
      return new Promise<Response>(() => {});
    }) as typeof fetch;
    try {
      const boot: SiteBoot = {
        basePath: '/',
        locale: 'de',
        route: null,
        manifestVersion: 1,
        timelineV: 'tl000001',
        day: null,
        profile: null,
        access: null,
        source: 'document',
      };
      const ctx = createSiteContext(boot, createQueryClient());
      let settled: unknown = 'pending';
      void ensureTimeline(ctx).then(
        () => {
          settled = null;
        },
        (err: unknown) => {
          settled = err;
        },
      );
      // 3 attempts of 15 s plus the back-off between them (1 s, 2 s). Dev builds validate
      // responses through a dynamic import, which settles outside the fake clock.
      let elapsed = 0;
      while (settled === 'pending' && elapsed < 60_000) {
        await vi.dynamicImportSettled();
        await vi.advanceTimersByTimeAsync(250);
        elapsed += 250;
      }
      expect(settled).toBeInstanceOf(DataFetchError);
      expect(elapsed).toBeGreaterThanOrEqual(3 * DATA_FETCH_TIMEOUT_MS + 3_000);
      expect(calls.filter((u) => u.includes('timeline.json'))).toHaveLength(3);
    } finally {
      globalThis.fetch = original;
    }
  });
});
