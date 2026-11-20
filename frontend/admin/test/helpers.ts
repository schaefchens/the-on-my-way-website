/** Test data built from the contracts (validated, so tests never drift from the API shapes). */
import {
  AdminDayDetail,
  AdminPost,
  AdminTrip,
  CaptureListItem,
  SETTINGS_DEFAULTS,
  type Settings,
} from '@omw/contracts/api';
import type { AdminApi } from '../src/api/client';
import { ApiRequestError } from '../src/api/client';

export function capture(overrides: Partial<CaptureListItem> = {}): CaptureListItem {
  return CaptureListItem.parse({
    sourceKey: 'wa:3EB0B028C9D92EFF4C5B',
    publicId: 'e_abcdefghijkl',
    kind: 'photo',
    occurredAt: '2026-11-15T02:12:00.000Z',
    tz: 'Asia/Ho_Chi_Minh',
    localDate: '2026-11-15',
    caption: 'Hội An',
    mediaState: 'ok',
    annotation: null,
    previewUrl: '/api/v1/admin/captures/wa%3A3EB0B028C9D92EFF4C5B/preview',
    posterUrl: null,
    effectiveVisibility: 'public',
    effectiveLocalDate: '2026-11-15',
    effectiveTz: 'Asia/Ho_Chi_Minh',
    changeSeq: 0,
    ...overrides,
  });
}

export function post(overrides: Partial<AdminPost> = {}): AdminPost {
  return AdminPost.parse({
    publicId: 'p_01JX0000000000000000000000',
    kind: 'note',
    occurredAt: '2026-11-15T05:00:00.000Z',
    tz: 'Asia/Ho_Chi_Minh',
    localDate: '2026-11-15',
    origLocale: 'de',
    visibility: 'public',
    updatedAt: '2026-11-15T05:00:00.000Z',
    content: { de: { body: 'Hallo' } },
    changeSeq: 3,
    ...overrides,
  });
}

export function dayDetail(overrides: Partial<AdminDayDetail> = {}): AdminDayDetail {
  return AdminDayDetail.parse({
    localDate: '2026-11-15',
    day: null,
    captures: [],
    posts: [],
    trip: null,
    changeSeq: 0,
    ...overrides,
  });
}

export function trip(overrides: Partial<AdminTrip> = {}): AdminTrip {
  return AdminTrip.parse({
    slug: 'vietnam-2026',
    title: { de: 'Vietnam 2026' },
    startDate: '2026-11-14',
    endDate: '2026-11-17',
    updatedAt: '2026-11-14T00:00:00.000Z',
    changeSeq: 1,
    ...overrides,
  });
}

export const settings: Settings = { ...SETTINGS_DEFAULTS, 'timezone.current': 'Asia/Ho_Chi_Minh' };

export interface Call {
  method: keyof AdminApi;
  args: unknown[];
}

/** An AdminApi whose methods are scripted per test (unscripted calls reject with 501). */
export function fakeApi(impl: Partial<{ [K in keyof AdminApi]: (...args: Parameters<AdminApi[K]>) => unknown }>) {
  const calls: Call[] = [];
  const api = new Proxy({} as AdminApi, {
    get(_target, prop: string) {
      return async (...args: unknown[]) => {
        calls.push({ method: prop as keyof AdminApi, args });
        const fn = (impl as Record<string, ((...a: unknown[]) => unknown) | undefined>)[prop];
        if (!fn) throw new ApiRequestError(501, 'not_scripted', `${prop} not scripted`);
        return fn(...args);
      };
    },
  });
  return { api, calls };
}

export const networkDown = () => {
  throw new ApiRequestError(0, 'network', 'API unreachable: offline');
};

export function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `check` passes (for retry/backoff timing in tests). */
export async function eventually(check: () => void, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await flush(10);
    }
  }
}
