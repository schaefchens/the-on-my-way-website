import type { DayDetail, Manifest, TimelineIndex } from '@omw/contracts/site';
import { describe, expect, it } from 'vitest';
import type { SiteBoot } from '../src/boot';
import { DataFetchError, type FetchLike } from '../src/data/fetch';
import {
  adjacentDays,
  bootDayFor,
  ensureDay,
  ensureTimeline,
  ensureTrip,
  prefetchAdjacentDays,
  queryKeys,
  startInitialFetches,
} from '../src/data/queries';
import { ContractViolation } from '../src/data/validate.dev';
import { createQueryClient, createSiteContext, shouldRetry } from '../src/site';

const TL_V = 'tl000001';
const manifest: Manifest = {
  contractVersion: 1,
  version: 3,
  generatedAt: '2026-11-19T10:00:00.000Z',
  site: { title: 'On My Way', locales: ['de', 'en'], defaultLocale: 'de', basePath: '/travel/', indexable: false },
  timeline: { v: TL_V },
};

function summary(date: string, v: string) {
  return {
    date,
    v,
    tz: 'Asia/Ho_Chi_Minh',
    counts: { photo: 0, video: 0, gif: 0, voice: 0, text: 1, note: 0, story: 0 },
    firstAt: `${date}T01:00:00Z`,
    lastAt: `${date}T01:00:00Z`,
  };
}

const timeline: TimelineIndex = {
  contractVersion: 1,
  generatedAt: '2026-11-19T10:00:00.000Z',
  trips: [
    {
      slug: 'vietnam-2026',
      v: 'trip0001',
      title: { de: 'Vietnam' },
      start: '2026-11-14',
      end: '2026-11-16',
      countries: ['VN'],
      dayCount: 3,
    },
  ],
  days: [summary('2026-11-14', 'd14v0001'), summary('2026-11-15', 'd15v0001'), summary('2026-11-16', 'd16v0001')],
};

function day(date: string, v: string): DayDetail {
  return {
    contractVersion: 1,
    date,
    v,
    tz: 'Asia/Ho_Chi_Minh',
    entries: [
      {
        id: 'e_aaaaaaaaaaaa',
        kind: 'text',
        at: `${date}T01:00:00Z`,
        tz: 'Asia/Ho_Chi_Minh',
        text: { body: 'Xin chào', bg: '#3b2341ff', fg: '#ffffffff', font: 'SYSTEM' },
      },
    ],
  };
}

const FILES: Record<string, unknown> = {
  '/travel/data/timeline.json': timeline,
  '/travel/data/days/2026-11-14.json': day('2026-11-14', 'd14v0001'),
  '/travel/data/days/2026-11-15.json': day('2026-11-15', 'd15v0001'),
  '/travel/data/days/2026-11-16.json': day('2026-11-16', 'd16v0001'),
  '/travel/data/trips/vietnam-2026.json': {
    contractVersion: 1,
    slug: 'vietnam-2026',
    v: 'trip0001',
    title: { de: 'Vietnam' },
    start: '2026-11-14',
    end: '2026-11-16',
    days: ['2026-11-14', '2026-11-15', '2026-11-16'],
  },
};

function fakeFetch(overrides: Record<string, unknown> = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl: FetchLike = async (input, init) => {
    calls.push({ url: input, init });
    const path = input.split('?')[0] ?? '';
    const body = path === '/travel/data/manifest.json' ? manifest : path in overrides ? overrides[path] : FILES[path];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { impl, calls };
}

function boot(partial: Partial<SiteBoot> = {}): SiteBoot {
  return {
    basePath: '/travel/',
    locale: 'de',
    route: null,
    manifestVersion: null,
    timelineV: null,
    day: null,
    source: 'document',
    ...partial,
  };
}

function withFetch(fetchImpl: FetchLike, b: SiteBoot) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => fetchImpl(String(input), init)) as typeof fetch;
  const ctx = createSiteContext(b, createQueryClient());
  return { ctx, restore: () => (globalThis.fetch = original) };
}

describe('data layer', () => {
  it('resolves manifest -> timeline -> day with basePath, no-store and hashed URLs', async () => {
    const { impl, calls } = fakeFetch();
    const { ctx, restore } = withFetch(impl, boot());
    try {
      const d = await ensureDay(ctx, '2026-11-15');
      expect(d?.date).toBe('2026-11-15');
      expect(calls.map((c) => c.url.replace(/\?t=\d+$/, '?t=*'))).toEqual([
        '/travel/data/manifest.json?t=*',
        `/travel/data/timeline.json?v=${TL_V}`,
        '/travel/data/days/2026-11-15.json?v=d15v0001',
      ]);
      expect(calls[0]?.init?.cache).toBe('no-store');
      expect(ctx.queryClient.getQueryData(queryKeys.day('2026-11-15', 'd15v0001'))).toBeDefined();
      expect(ctx.timelineVersion.get()).toBe(TL_V);
      // Second call is served from the cache.
      await ensureDay(ctx, '2026-11-15');
      expect(calls).toHaveLength(3);
      // Unknown day and trip.
      expect(await ensureDay(ctx, '2026-11-20')).toBeNull();
      expect((await ensureTrip(ctx, 'vietnam-2026'))?.days).toHaveLength(3);
      expect(await ensureTrip(ctx, 'nope')).toBeNull();
    } finally {
      restore();
    }
  });

  it('serves the day inlined in the boot JSON without manifest or timeline', async () => {
    const { impl, calls } = fakeFetch();
    const { ctx, restore } = withFetch(impl, boot({ timelineV: TL_V, day: day('2026-11-15', 'd15v0001') }));
    try {
      expect((await ensureDay(ctx, '2026-11-15'))?.v).toBe('d15v0001');
      expect(calls).toEqual([]);
      expect(bootDayFor(ctx, '2026-11-15')?.date).toBe('2026-11-15');
      expect(bootDayFor(ctx, '2026-11-16')).toBeNull();
      // Once the visitor switched to another timeline, the timeline decides again.
      ctx.timelineVersion.set('tl000002');
      expect(bootDayFor(ctx, '2026-11-15')).toBeNull();
    } finally {
      restore();
    }
  });

  it('starts the manifest and exactly the boot timeline at once; the manifest only validates', async () => {
    const { impl, calls } = fakeFetch();
    const { ctx, restore } = withFetch(impl, boot({ timelineV: TL_V }));
    try {
      startInitialFetches(ctx, { timelinePriority: 'low' });
      // Both requests were issued synchronously (no round trip in between).
      expect(calls.map((c) => c.url.replace(/\?t=\d+$/, '?t=*')).sort()).toEqual([
        '/travel/data/manifest.json?t=*',
        `/travel/data/timeline.json?v=${TL_V}`,
      ]);
      const timelineCall = calls.find((c) => c.url.includes('timeline'));
      expect(timelineCall?.init?.priority).toBe('low');
      // Preload-compatible: default credentials mode, no custom headers.
      for (const c of calls) {
        expect(c.init?.credentials).toBeUndefined();
        expect(c.init?.headers).toBeUndefined();
        expect(c.init?.signal).toBeInstanceOf(AbortSignal);
      }
      await ensureTimeline(ctx);
      expect(calls).toHaveLength(2); // the speculative result was used
      expect(ctx.timelineVersion.get()).toBe(TL_V);
    } finally {
      restore();
    }
  });

  it('switches to the manifest timeline when the page is older than the site', async () => {
    const { impl, calls } = fakeFetch();
    const { ctx, restore } = withFetch(impl, boot({ timelineV: 'tlold001', day: day('2026-11-15', 'd15v0001') }));
    try {
      startInitialFetches(ctx);
      const tl = await ensureTimeline(ctx);
      expect(tl.days).toHaveLength(3);
      expect(ctx.timelineVersion.get()).toBe(TL_V);
      expect(calls.map((c) => c.url.replace(/\?t=\d+$/, '?t=*')).sort()).toEqual([
        '/travel/data/manifest.json?t=*',
        `/travel/data/timeline.json?v=${TL_V}`,
        '/travel/data/timeline.json?v=tlold001',
      ]);
      // The inlined day is no longer trusted blindly: it comes through the (new) timeline.
      expect(bootDayFor(ctx, '2026-11-15')).toBeNull();
    } finally {
      restore();
    }
  });

  it('keeps the boot timeline when the manifest cannot be loaded (no retries holding the page)', async () => {
    const failing: FetchLike = async (input, init) => {
      if (input.includes('/manifest.json')) return new Response('down', { status: 503 });
      return fakeFetch().impl(input, init);
    };
    const calls: string[] = [];
    const counting: FetchLike = (input, init) => {
      calls.push(input);
      return failing(input, init);
    };
    const { ctx, restore } = withFetch(counting, boot({ timelineV: TL_V }));
    try {
      await ensureTimeline(ctx);
      expect(ctx.timelineVersion.get()).toBe(TL_V);
      expect(calls.filter((u) => u.includes('manifest'))).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("a trip or day page's data does not queue behind the manifest check", async () => {
    let releaseManifest: () => void = () => undefined;
    const slowManifest: FetchLike = async (input, init) => {
      if (input.includes('/manifest.json')) await new Promise<void>((r) => (releaseManifest = r));
      return fakeFetch().impl(input, init);
    };
    const { ctx, restore } = withFetch(slowManifest, boot({ timelineV: TL_V }));
    try {
      startInitialFetches(ctx);
      // Resolves although the manifest has not answered yet.
      expect((await ensureTrip(ctx, 'vietnam-2026'))?.slug).toBe('vietnam-2026');
      expect((await ensureDay(ctx, '2026-11-14'))?.date).toBe('2026-11-14');
      // The timeline view itself still waits for the check.
      let validated = false;
      const view = ensureTimeline(ctx).then(() => {
        validated = true;
      });
      await new Promise((r) => setTimeout(r, 10));
      expect(validated).toBe(false);
      releaseManifest();
      await view;
      expect(validated).toBe(true);
    } finally {
      restore();
    }
  });

  it('prefetches neighbouring days', async () => {
    const { impl, calls } = fakeFetch();
    const { ctx, restore } = withFetch(impl, boot({ timelineV: TL_V }));
    try {
      const tl = await ensureTimeline(ctx);
      expect(adjacentDays(tl, '2026-11-15')).toMatchObject({
        prev: { date: '2026-11-14' },
        next: { date: '2026-11-16' },
      });
      expect(adjacentDays(tl, '2026-11-14').prev).toBeUndefined();
      await prefetchAdjacentDays(ctx, tl, '2026-11-15');
      expect(calls.map((c) => c.url.replace(/\?t=\d+$/, '?t=*')).sort()).toEqual([
        '/travel/data/days/2026-11-14.json?v=d14v0001',
        '/travel/data/days/2026-11-16.json?v=d16v0001',
        '/travel/data/manifest.json?t=*',
        `/travel/data/timeline.json?v=${TL_V}`,
      ]);
    } finally {
      restore();
    }
  });

  it('reports HTTP errors and (in dev) contract violations', async () => {
    const broken = { ...timeline, days: [{ date: 'yesterday' }] };
    const { impl } = fakeFetch({
      '/travel/data/timeline.json': broken,
      '/travel/data/days/2026-11-15.json': undefined,
    });
    const { ctx, restore } = withFetch(impl, boot({ timelineV: TL_V }));
    const error = console.error;
    console.error = () => {};
    try {
      expect(import.meta.env.DEV).toBe(true);
      await expect(ensureTimeline(ctx)).rejects.toBeInstanceOf(ContractViolation);
    } finally {
      console.error = error;
      restore();
    }

    const missing = fakeFetch({ '/travel/data/timeline.json': undefined });
    const second = withFetch(missing.impl, boot({ timelineV: TL_V }));
    try {
      ctx.queryClient.clear();
      await expect(ensureTimeline(second.ctx)).rejects.toMatchObject({ name: 'DataFetchError', status: 404 });
      expect(new DataFetchError('/x', 500).message).toBe('GET /x failed with HTTP 500');
      expect(shouldRetry(0, new DataFetchError('/x', 503))).toBe(true);
      expect(shouldRetry(0, new DataFetchError('/x', 0))).toBe(true);
      expect(shouldRetry(2, new DataFetchError('/x', 503))).toBe(false);
      expect(shouldRetry(0, new DataFetchError('/x', 404))).toBe(false);
      expect(shouldRetry(0, new Error('contract'))).toBe(false);
    } finally {
      second.restore();
    }
  });
});
