/** The shared, ticking "now" behind the "here now" chips (W2-19), with fake timers. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLive } from '../src/components/decor';
import { createNowStore, NOW_TICK_MS, type NowEnvironment } from '../src/components/now';

function fakeEnvironment() {
  let hidden = false;
  const listeners = new Set<() => void>();
  let intervals = 0;
  const env: NowEnvironment = {
    now: () => Date.now(),
    setInterval: (cb, ms) => {
      intervals++;
      return setInterval(cb, ms);
    },
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    hidden: () => hidden,
    onVisibilityChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return {
    env,
    intervals: () => intervals,
    setHidden(value: boolean) {
      hidden = value;
      for (const l of listeners) l();
    },
  };
}

describe('ticking now', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a "here now" chip turns into "last seen here" in a tab left open', () => {
    const { env } = fakeEnvironment();
    const store = createNowStore(env);
    const seen: boolean[] = [];
    const lastAt = '2026-11-15T12:30:00Z'; // 47.5 h before the page opened
    const unsubscribe = store.subscribe(() => seen.push(isLive(lastAt, store.get())));
    expect(isLive(lastAt, store.get())).toBe(true);
    vi.advanceTimersByTime(29 * NOW_TICK_MS);
    expect(seen.at(-1)).toBe(true);
    vi.advanceTimersByTime(2 * NOW_TICK_MS); // 48 h passed
    expect(seen.at(-1)).toBe(false);
    expect(isLive(lastAt, store.get())).toBe(false);
    unsubscribe();
  });

  it('one interval for all subscribers, none while hidden or unobserved; catches up on return', () => {
    const fake = fakeEnvironment();
    const store = createNowStore(fake.env);
    const a = vi.fn();
    const b = vi.fn();
    const offA = store.subscribe(a);
    const offB = store.subscribe(b);
    expect(fake.intervals()).toBe(1);
    vi.advanceTimersByTime(NOW_TICK_MS);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    fake.setHidden(true);
    vi.advanceTimersByTime(10 * NOW_TICK_MS);
    expect(a).toHaveBeenCalledTimes(1);
    const before = store.get();
    fake.setHidden(false); // back: updates at once, then ticks again
    expect(a).toHaveBeenCalledTimes(2);
    expect(store.get() - before).toBe(10 * NOW_TICK_MS);
    expect(fake.intervals()).toBe(2);

    offA();
    offB();
    vi.advanceTimersByTime(5 * NOW_TICK_MS);
    expect(a).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
