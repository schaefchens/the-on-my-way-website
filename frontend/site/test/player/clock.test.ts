import { describe, expect, it, vi } from 'vitest';
import { type FrameScheduler, ItemClock } from '../../src/player/clock';

/** Manual frame scheduler: frame(ms) advances time and runs the pending callbacks. */
function fakeScheduler() {
  let now = 1000;
  let nextId = 1;
  const pending = new Map<number, (t: number) => void>();
  const scheduler: FrameScheduler = {
    request(cb) {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    },
    cancel(id) {
      pending.delete(id);
    },
    now: () => now,
  };
  return {
    scheduler,
    pendingCount: () => pending.size,
    frame(ms: number) {
      now += ms;
      const cbs = [...pending.values()];
      pending.clear();
      for (const cb of cbs) cb(now);
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

function sink() {
  const values: number[] = [];
  return { values, set: (v: number) => values.push(v), last: () => values.at(-1) };
}

describe('ItemClock', () => {
  it('counts timer items only while running and ends exactly once', () => {
    const f = fakeScheduler();
    const s = sink();
    const clock = new ItemClock(f.scheduler, s);
    const onEnd = vi.fn();
    clock.load({ durationMs: 1000, onEnd });
    expect(s.last()).toBe(0);
    expect(f.pendingCount()).toBe(0); // not running: no frames

    clock.setRunning(true);
    f.frame(250);
    expect(s.last()).toBeCloseTo(0.25);
    clock.setRunning(false);
    f.advance(5000); // paused time does not count
    expect(f.pendingCount()).toBe(0);
    clock.setRunning(true);
    f.frame(500);
    expect(s.last()).toBeCloseTo(0.75);
    f.frame(400);
    expect(s.last()).toBe(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    f.frame(100);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(f.pendingCount()).toBe(0);
  });

  it('accounts for the time since the last frame when pausing', () => {
    const f = fakeScheduler();
    const s = sink();
    const clock = new ItemClock(f.scheduler, s);
    clock.load({ durationMs: 1000 });
    clock.setRunning(true);
    f.frame(100);
    f.advance(50);
    clock.setRunning(false);
    expect(clock.elapsedMs()).toBe(150);
  });

  it('follows a media source and never ends by itself', () => {
    const f = fakeScheduler();
    const s = sink();
    const clock = new ItemClock(f.scheduler, s);
    let media = 0;
    const onEnd = vi.fn();
    clock.load({ durationMs: 4000, source: () => media, onEnd });
    clock.setRunning(true);
    media = 1000;
    f.frame(16);
    expect(s.last()).toBeCloseTo(0.25);
    media = 5000;
    f.frame(16);
    expect(s.last()).toBe(1);
    expect(onEnd).not.toHaveBeenCalled();
    clock.setDuration(10_000);
    expect(s.last()).toBeCloseTo(0.5);
  });

  it('restarts at 0 on load and can hold a fixed value', () => {
    const f = fakeScheduler();
    const s = sink();
    const clock = new ItemClock(f.scheduler, s);
    clock.load({ durationMs: 1000 });
    clock.setRunning(true);
    f.frame(500);
    clock.load({ durationMs: 2000 });
    expect(s.last()).toBe(0);
    f.frame(500);
    expect(s.last()).toBeCloseTo(0.25);
    clock.hold(1);
    expect(s.last()).toBe(1);
    clock.dispose();
    expect(f.pendingCount()).toBe(0);
  });
});
