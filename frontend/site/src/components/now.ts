/**
 * A shared, ticking "now" (W2-19): the "here now" chips and relative times of a page that stays
 * open for hours must not freeze at load time. One interval for every subscriber, only while
 * someone subscribes and the tab is visible; coming back to the tab updates at once.
 */
import { useSyncExternalStore } from 'react';

/** How often "now" moves (the chips work in hours, relative times in minutes). */
export const NOW_TICK_MS = 60_000;

export interface NowEnvironment {
  now(): number;
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  /** True while the page is hidden (no ticking). */
  hidden(): boolean;
  /** Subscribes to visibility changes; returns the unsubscribe function. */
  onVisibilityChange(cb: () => void): () => void;
}

const browserEnvironment: NowEnvironment = {
  now: () => Date.now(),
  setInterval: (cb, ms) => globalThis.setInterval(cb, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  onVisibilityChange: (cb) => {
    if (typeof document === 'undefined') return () => undefined;
    document.addEventListener('visibilitychange', cb);
    return () => document.removeEventListener('visibilitychange', cb);
  },
};

export interface NowStore {
  get(): number;
  subscribe(listener: () => void): () => void;
}

export function createNowStore(env: NowEnvironment = browserEnvironment, tickMs = NOW_TICK_MS): NowStore {
  let current = env.now();
  const listeners = new Set<() => void>();
  let timer: unknown = null;
  let stopVisibility: (() => void) | null = null;

  const emit = () => {
    current = env.now();
    for (const l of listeners) l();
  };
  const stopTimer = () => {
    if (timer !== null) env.clearInterval(timer);
    timer = null;
  };
  const startTimer = () => {
    if (timer === null && !env.hidden()) timer = env.setInterval(emit, tickMs);
  };
  const onVisibility = () => {
    if (env.hidden()) {
      stopTimer();
    } else {
      emit();
      startTimer();
    }
  };

  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        // The value may be old (nobody watched for a while): catch up first.
        current = env.now();
        stopVisibility = env.onVisibilityChange(onVisibility);
        startTimer();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopTimer();
          stopVisibility?.();
          stopVisibility = null;
        }
      };
    },
  };
}

const sharedNow = createNowStore();

/** Epoch ms, updated every NOW_TICK_MS while the tab is visible (shared by all components). */
export function useNow(store: NowStore = sharedNow): number {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
