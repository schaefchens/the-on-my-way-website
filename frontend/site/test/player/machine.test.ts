import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DURATIONS } from '../../src/player/durations';
import {
  backLeavesDay,
  initialState,
  isRunning,
  type PlayerEvent,
  type PlayerState,
  pauseReasonsAttr,
  pendingTimer,
  reducer,
  statusOf,
  wantsMediaPlaying,
} from '../../src/player/machine';

function run(state: PlayerState, ...events: PlayerEvent[]): PlayerState {
  return events.reduce(reducer, state);
}

const loaded = (s: PlayerState): PlayerEvent => ({ type: 'loaded', seq: s.seq });

describe('player machine', () => {
  it('goes loading -> playing once the item has loaded (autoplay)', () => {
    const s0 = initialState({ count: 3 });
    expect(statusOf(s0)).toBe('loading');
    expect(isRunning(s0)).toBe(false);
    const s1 = reducer(s0, loaded(s0));
    expect(statusOf(s1)).toBe('playing');
    expect(s1.started).toBe(true);
    expect(isRunning(s1)).toBe(true);
  });

  it('stays "ready" when paused before the item started, "paused" after it ran', () => {
    const s0 = initialState({ count: 2, paused: ['user'] });
    const s1 = reducer(s0, loaded(s0));
    expect(statusOf(s1)).toBe('ready');
    const s2 = reducer(s1, { type: 'toggle' });
    expect(statusOf(s2)).toBe('playing');
    const s3 = reducer(s2, { type: 'toggle' });
    expect(statusOf(s3)).toBe('paused');
    expect(pauseReasonsAttr(s3)).toBe('user');
  });

  it('keeps pause reasons as a set: releasing a hold does not resume a user pause', () => {
    let s = initialState({ count: 2 });
    s = run(s, loaded(s), { type: 'pause', reason: 'user' }, { type: 'pause', reason: 'hold' });
    expect(pauseReasonsAttr(s)).toBe('user hold');
    s = reducer(s, { type: 'resume', reason: 'hold' });
    expect(statusOf(s)).toBe('paused');
    s = run(s, { type: 'pause', reason: 'sheet' }, { type: 'pause', reason: 'hidden' }, { type: 'toggle' });
    expect(pauseReasonsAttr(s)).toBe('sheet hidden');
    s = run(s, { type: 'resume', reason: 'sheet' }, { type: 'resume', reason: 'hidden' });
    expect(statusOf(s)).toBe('playing');
  });

  it('returns the same state for no-op pause/resume', () => {
    const s = initialState({ count: 1 });
    expect(reducer(s, { type: 'resume', reason: 'hold' })).toBe(s);
    const p = reducer(s, { type: 'pause', reason: 'hidden' });
    expect(reducer(p, { type: 'pause', reason: 'hidden' })).toBe(p);
  });

  it('advances on itemEnd and ends the day after the last item', () => {
    let s = initialState({ count: 2 });
    s = reducer(s, loaded(s));
    const seq0 = s.seq;
    s = reducer(s, { type: 'itemEnd', seq: seq0 });
    expect(s.index).toBe(1);
    expect(s.seq).toBe(seq0 + 1);
    expect(statusOf(s)).toBe('loading');
    s = run(s, loaded(s), { type: 'itemEnd', seq: s.seq });
    expect(statusOf(s)).toBe('dayEnd');
    expect(s.index).toBe(1);
  });

  it('ignores events from a previous item (stale seq)', () => {
    let s = initialState({ count: 3 });
    s = reducer(s, loaded(s));
    const old = s.seq;
    s = reducer(s, { type: 'next' });
    expect(reducer(s, { type: 'loaded', seq: old })).toBe(s);
    expect(reducer(s, { type: 'itemEnd', seq: old })).toBe(s);
    expect(reducer(s, { type: 'failed', seq: old })).toBe(s);
    expect(reducer(s, { type: 'stall', seq: old })).toBe(s);
  });

  it('does not end an item that has not loaded', () => {
    const s = initialState({ count: 2 });
    expect(reducer(s, { type: 'itemEnd', seq: s.seq })).toBe(s);
  });

  it('buffers on stall and resumes on unstall', () => {
    let s = initialState({ count: 1 });
    s = run(s, loaded(s), { type: 'stall', seq: s.seq });
    expect(statusOf(s)).toBe('buffering');
    expect(isRunning(s)).toBe(false);
    expect(wantsMediaPlaying(s)).toBe(true);
    s = reducer(s, { type: 'pause', reason: 'user' });
    expect(statusOf(s)).toBe('paused');
    expect(wantsMediaPlaying(s)).toBe(false);
    s = run(s, { type: 'toggle' }, { type: 'unstall', seq: s.seq });
    expect(statusOf(s)).toBe('playing');
  });

  it('goes to error on failure and skips only with the matching seq', () => {
    let s = initialState({ count: 2 });
    s = reducer(s, { type: 'failed', seq: s.seq });
    expect(statusOf(s)).toBe('error');
    expect(reducer(s, { type: 'skip', seq: s.seq - 1 })).toBe(s);
    s = reducer(s, { type: 'skip', seq: s.seq });
    expect(s.index).toBe(1);
    expect(statusOf(s)).toBe('loading');
  });

  it('navigates back: previous item, restart at 0, last item from day end', () => {
    let s = initialState({ count: 3 });
    s = run(s, loaded(s), { type: 'next' }, { type: 'prev' });
    expect(s.index).toBe(0);
    expect(s.direction).toBe(-1);
    const seq = s.seq;
    s = reducer(s, { type: 'prev' });
    expect(s.index).toBe(0);
    expect(s.seq).toBe(seq + 1); // restarted
    s = run(s, { type: 'goto', index: 2 }, loaded(s), { type: 'next' });
    expect(statusOf(s)).toBe('dayEnd');
    s = reducer(s, { type: 'prev' });
    expect(s.index).toBe(2);
    expect(s.ended).toBe(false);
  });

  it('back on the first moment leaves the day (to the last moment of the day before); elsewhere it stays', () => {
    let s = initialState({ count: 3 });
    expect(backLeavesDay(s)).toBe(true); // first moment, still loading
    s = reducer(s, loaded(s));
    expect(backLeavesDay(s)).toBe(true); // first moment, playing
    s = run(s, { type: 'next' });
    expect(backLeavesDay(s)).toBe(false);
    s = run(s, loaded(s), { type: 'prev' });
    expect(s.index).toBe(0);
    expect(backLeavesDay(s)).toBe(true);
    // Paused or failed, the first moment is still the first moment.
    expect(backLeavesDay(reducer(s, { type: 'toggle' }))).toBe(true);
    expect(backLeavesDay(reducer(s, { type: 'failed', seq: s.seq }))).toBe(true);
    // From the day-end card, back returns to the last moment of this day first.
    s = run(s, { type: 'goto', index: 2 }, loaded(s), { type: 'next' });
    expect(statusOf(s)).toBe('dayEnd');
    expect(backLeavesDay(s)).toBe(false);
    // A one-moment day: its day-end card goes back to that moment, the moment to the day before.
    let one = initialState({ count: 1 });
    one = run(one, loaded(one), { type: 'next' });
    expect(backLeavesDay(one)).toBe(false);
    expect(backLeavesDay(reducer(one, { type: 'prev' }))).toBe(true);
    // An empty day has nothing to go back to inside it.
    expect(backLeavesDay(initialState({ count: 0 }))).toBe(true);
  });

  it('a day entered from the next one starts at its last moment', () => {
    const s = initialState({ count: 4, index: 4 - 1 });
    expect(s.index).toBe(3);
    expect(backLeavesDay(s)).toBe(false);
    // The start index is clamped (an index past the end, e.g. from a stale count, is the last).
    expect(initialState({ count: 4, index: 99 }).index).toBe(3);
    expect(initialState({ count: 0, index: -1 }).ended).toBe(true);
  });

  it('clamps goto, ignores next at day end, replays from 0', () => {
    let s = initialState({ count: 3 });
    s = reducer(s, { type: 'goto', index: 99 });
    expect(s.index).toBe(2);
    s = run(s, loaded(s), { type: 'next' });
    expect(s.ended).toBe(true);
    expect(reducer(s, { type: 'next' })).toBe(s);
    s = reducer(s, { type: 'replay' });
    expect(s.index).toBe(0);
    expect(statusOf(s)).toBe('loading');
  });

  it('keeps a user pause across navigation (WCAG 2.2.2: paused stays paused)', () => {
    let s = initialState({ count: 3 });
    s = run(s, loaded(s), { type: 'toggle' }, { type: 'next' });
    s = reducer(s, loaded(s));
    expect(statusOf(s)).toBe('ready');
    expect(isRunning(s)).toBe(false);
  });

  it('treats an empty day as ended', () => {
    const s = initialState({ count: 0 });
    expect(statusOf(s)).toBe('dayEnd');
    expect(reducer(s, { type: 'prev' })).toBe(s);
    expect(reducer(s, { type: 'replay' })).toBe(s);
  });

  it('restart reloads the current item', () => {
    let s = initialState({ count: 2 });
    s = reducer(s, loaded(s));
    const r = reducer(s, { type: 'restart' });
    expect(r.index).toBe(0);
    expect(r.seq).toBe(s.seq + 1);
    expect(statusOf(r)).toBe('loading');
  });

  it('needsSound holds a voice note until the visitor asks for sound, independent of other reasons', () => {
    let s = initialState({ count: 2, paused: ['needsSound'] });
    s = reducer(s, loaded(s));
    expect(statusOf(s)).toBe('ready');
    expect(isRunning(s)).toBe(false);
    expect(wantsMediaPlaying(s)).toBe(false);
    expect(pauseReasonsAttr(s)).toBe('needsSound');
    // The play/pause button alone cannot start it silently.
    s = reducer(s, { type: 'toggle' });
    s = reducer(s, { type: 'toggle' });
    expect(statusOf(s)).toBe('ready');
    // "Listen": sound on, the hold goes, the note starts from 0.
    s = reducer(s, { type: 'resume', reason: 'needsSound' });
    expect(statusOf(s)).toBe('playing');
    expect(s.started).toBe(true);
    // Combined with a user pause (reduced motion start): both must go.
    let r = initialState({ count: 1, paused: ['user', 'needsSound'] });
    r = run(r, loaded(r), { type: 'resume', reason: 'needsSound' });
    expect(statusOf(r)).toBe('ready');
    expect(pauseReasonsAttr(r)).toBe('user');
    r = reducer(r, { type: 'resume', reason: 'user' });
    expect(statusOf(r)).toBe('playing');
  });

  it('a stall timeout turns buffering into an error; data resuming in time plays on', () => {
    let s = initialState({ count: 2 });
    s = run(s, loaded(s), { type: 'stall', seq: s.seq });
    expect(statusOf(s)).toBe('buffering');
    const resumed = reducer(s, { type: 'unstall', seq: s.seq });
    expect(statusOf(resumed)).toBe('playing');
    expect(reducer(resumed, { type: 'stallTimeout', seq: s.seq })).toBe(resumed);
    const failed = reducer(s, { type: 'stallTimeout', seq: s.seq });
    expect(statusOf(failed)).toBe('error');
    expect(reducer(s, { type: 'stallTimeout', seq: s.seq - 1 })).toBe(s);
  });
});

/** Drives the reducer with the timers pendingTimer() asks for, like the session component. */
function harness(init: PlayerState) {
  let state = init;
  let timer: { key: string; id: ReturnType<typeof setTimeout> } | null = null;
  const sync = () => {
    const next = pendingTimer(state);
    if (timer && timer.key === next?.key) return;
    if (timer) clearTimeout(timer.id);
    timer = next ? { key: next.key, id: setTimeout(() => dispatch(next.event), next.delayMs) } : null;
  };
  const dispatch = (e: PlayerEvent) => {
    state = reducer(state, e);
    sync();
  };
  sync();
  return { dispatch, get: () => state };
}

describe('player timers (fake clock)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a video stalled for good goes to error after 15 s, then skips after 3 s', () => {
    expect(DURATIONS.stallTimeoutMs).toBe(15_000);
    const p = harness(initialState({ count: 3 }));
    p.dispatch(loaded(p.get()));
    p.dispatch({ type: 'stall', seq: p.get().seq });
    expect(statusOf(p.get())).toBe('buffering');
    vi.advanceTimersByTime(DURATIONS.stallTimeoutMs - 1);
    expect(statusOf(p.get())).toBe('buffering');
    vi.advanceTimersByTime(1);
    expect(statusOf(p.get())).toBe('error');
    expect(p.get().index).toBe(0);
    vi.advanceTimersByTime(DURATIONS.errorSkipMs);
    expect(p.get().index).toBe(1);
    expect(statusOf(p.get())).toBe('loading');
  });

  it('data resuming before the timeout returns to playing and disarms it', () => {
    const p = harness(initialState({ count: 2 }));
    p.dispatch(loaded(p.get()));
    p.dispatch({ type: 'stall', seq: p.get().seq });
    vi.advanceTimersByTime(10_000);
    p.dispatch({ type: 'unstall', seq: p.get().seq });
    expect(statusOf(p.get())).toBe('playing');
    vi.advanceTimersByTime(60_000);
    expect(statusOf(p.get())).toBe('playing');
    expect(p.get().index).toBe(0);
    // A new stall gets the full 15 s again.
    p.dispatch({ type: 'stall', seq: p.get().seq });
    vi.advanceTimersByTime(14_000);
    expect(statusOf(p.get())).toBe('buffering');
  });

  it('pausing while stalled stops the countdown (the visitor decides)', () => {
    const p = harness(initialState({ count: 2 }));
    p.dispatch(loaded(p.get()));
    p.dispatch({ type: 'stall', seq: p.get().seq });
    p.dispatch({ type: 'pause', reason: 'user' });
    vi.advanceTimersByTime(60_000);
    expect(statusOf(p.get())).toBe('paused');
    p.dispatch({ type: 'resume', reason: 'user' });
    expect(statusOf(p.get())).toBe('buffering');
    vi.advanceTimersByTime(DURATIONS.stallTimeoutMs);
    expect(statusOf(p.get())).toBe('error');
  });

  it('an item that never loads fails after the load timeout; a paused error does not skip', () => {
    const p = harness(initialState({ count: 2 }));
    vi.advanceTimersByTime(DURATIONS.loadTimeoutMs);
    expect(statusOf(p.get())).toBe('error');
    p.dispatch({ type: 'pause', reason: 'user' });
    vi.advanceTimersByTime(60_000);
    expect(p.get().index).toBe(0);
    p.dispatch({ type: 'resume', reason: 'user' });
    vi.advanceTimersByTime(DURATIONS.errorSkipMs);
    expect(p.get().index).toBe(1);
  });
});
