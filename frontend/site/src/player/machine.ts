/**
 * Journey player state machine (plan C, "Journey player"):
 *
 *   loading ──loaded──▶ ready ──(no pause reasons)──▶ playing ⇄ paused
 *      │                                                  │  ▲
 *      └──failed──▶ error ──(3 s)──▶ skip                  │  └── unstall
 *                     ▲                                   ▼
 *                     └──────(15 s stalled)────────── buffering (video stalled)
 *   itemEnd / next ──▶ next item (loading) or dayEnd
 *
 * - `paused` is a SET of reasons (user, hold, sheet, hidden, needsSound): playback runs only
 *   when it is empty, so e.g. releasing a hold does not resume a story the visitor paused on
 *   purpose. "needsSound" holds a voice note while it could only play silently (muted, or
 *   autoplay with sound refused): its clock must not run without the audio.
 * - "ready" = loaded but not yet started on this item (e.g. paused before it began);
 *   "paused" = it ran and was paused.
 * - Every item (re)start bumps `seq`. Events about media/timers carry the seq they were armed
 *   with, so late events from a previous item are ignored.
 *
 * Pure reducer, no DOM, no timers: the component owns clocks and media and dispatches events.
 * Which timeout to arm in which state (load, stall, error skip) is decided here too
 * (pendingTimer), so the whole timing logic is testable with fake timers.
 */
import { DURATIONS } from './durations';

export type PauseReason = 'user' | 'hold' | 'sheet' | 'hidden' | 'needsSound';
export const PAUSE_REASONS: readonly PauseReason[] = ['user', 'hold', 'sheet', 'hidden', 'needsSound'];

export type LoadState = 'loading' | 'ready' | 'error';

export type PlayerStatus = 'loading' | 'ready' | 'playing' | 'paused' | 'buffering' | 'error' | 'dayEnd';

export interface PlayerState {
  readonly count: number;
  /** Current item, 0..count-1 (stays on the last item while the day-end card shows). */
  readonly index: number;
  readonly load: LoadState;
  /** Whether the current item has started playing (distinguishes "ready" from "paused"). */
  readonly started: boolean;
  readonly paused: ReadonlySet<PauseReason>;
  /** A video/audio element reported a stall ("waiting") while playing. */
  readonly stalled: boolean;
  /** The day-end card is shown. */
  readonly ended: boolean;
  /** Direction of the last navigation: 1 forward, -1 back (for transitions). */
  readonly direction: 1 | -1;
  /** Bumped on every item (re)start. */
  readonly seq: number;
}

export type PlayerEvent =
  | { type: 'loaded'; seq: number }
  | { type: 'failed'; seq: number }
  | { type: 'stall'; seq: number }
  | { type: 'unstall'; seq: number }
  /** The media stayed stalled for DURATIONS.stallTimeoutMs: give up on this item (error). */
  | { type: 'stallTimeout'; seq: number }
  /** The item's clock or media element finished. */
  | { type: 'itemEnd'; seq: number }
  /** Error auto-skip (dispatched by the component 3 s after "failed"). */
  | { type: 'skip'; seq: number }
  | { type: 'pause'; reason: PauseReason }
  | { type: 'resume'; reason: PauseReason }
  /** The always-visible pause button, Space and K. */
  | { type: 'toggle' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'goto'; index: number }
  /** Start the day over (day-end card, "replay"). */
  | { type: 'replay' }
  /** Restart the current item from 0 (e.g. after switching data-saver mode). */
  | { type: 'restart' };

export interface InitOptions {
  count: number;
  /** Start index (clamped). */
  index?: number;
  /** Initial pause reasons, e.g. ['user'] when reduced motion disables autoplay. */
  paused?: readonly PauseReason[];
}

export function initialState({ count, index = 0, paused = [] }: InitOptions): PlayerState {
  const safeCount = Math.max(0, Math.floor(count));
  return {
    count: safeCount,
    index: safeCount === 0 ? 0 : clampIndex(index, safeCount),
    load: 'loading',
    started: false,
    paused: new Set(paused),
    stalled: false,
    ended: safeCount === 0,
    direction: 1,
    seq: 1,
  };
}

function clampIndex(index: number, count: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(Math.max(0, Math.floor(index)), Math.max(0, count - 1));
}

/** Derived, user-facing status. */
export function statusOf(s: PlayerState): PlayerStatus {
  if (s.ended) return 'dayEnd';
  if (s.load === 'loading') return 'loading';
  if (s.load === 'error') return 'error';
  if (s.paused.size > 0) return s.started ? 'paused' : 'ready';
  if (s.stalled) return 'buffering';
  return 'playing';
}

/** True while the item clock should advance (and media should play). */
export function isRunning(s: PlayerState): boolean {
  return statusOf(s) === 'playing';
}

/** True when media should be playing (also while buffering: the element is trying to play). */
export function wantsMediaPlaying(s: PlayerState): boolean {
  const status = statusOf(s);
  return status === 'playing' || status === 'buffering';
}

export function isPausedBy(s: PlayerState, reason: PauseReason): boolean {
  return s.paused.has(reason);
}

function withReason(set: ReadonlySet<PauseReason>, reason: PauseReason, on: boolean): ReadonlySet<PauseReason> {
  if (set.has(reason) === on) return set;
  const next = new Set(set);
  if (on) next.add(reason);
  else next.delete(reason);
  return next;
}

/** Marks the item as started once it is loaded and nothing holds it back. */
function settle(s: PlayerState): PlayerState {
  if (!s.started && !s.ended && s.load === 'ready' && s.paused.size === 0) return { ...s, started: true };
  return s;
}

function moveTo(s: PlayerState, index: number, direction: 1 | -1): PlayerState {
  return {
    ...s,
    index,
    load: 'loading',
    started: false,
    stalled: false,
    ended: false,
    direction,
    seq: s.seq + 1,
  };
}

function forward(s: PlayerState): PlayerState {
  if (s.ended) return s;
  if (s.index + 1 < s.count) return moveTo(s, s.index + 1, 1);
  return { ...s, ended: true, stalled: false, direction: 1, seq: s.seq + 1 };
}

export function reducer(s: PlayerState, e: PlayerEvent): PlayerState {
  switch (e.type) {
    case 'loaded':
      if (e.seq !== s.seq || s.ended || s.load !== 'loading') return s;
      return settle({ ...s, load: 'ready' });
    case 'failed':
      if (e.seq !== s.seq || s.ended) return s;
      return { ...s, load: 'error', stalled: false };
    case 'stall':
      if (e.seq !== s.seq || s.ended || s.stalled) return s;
      return { ...s, stalled: true };
    case 'unstall':
      if (e.seq !== s.seq || !s.stalled) return s;
      return { ...s, stalled: false };
    case 'stallTimeout':
      if (e.seq !== s.seq || s.ended || !s.stalled || s.load !== 'ready') return s;
      return { ...s, load: 'error', stalled: false };
    case 'itemEnd':
      if (e.seq !== s.seq || s.ended || s.load !== 'ready') return s;
      return settle(forward(s));
    case 'skip':
      if (e.seq !== s.seq || s.load !== 'error') return s;
      return settle(forward(s));
    case 'pause': {
      const paused = withReason(s.paused, e.reason, true);
      return paused === s.paused ? s : { ...s, paused };
    }
    case 'resume': {
      const paused = withReason(s.paused, e.reason, false);
      return paused === s.paused ? s : settle({ ...s, paused });
    }
    case 'toggle':
      return settle({ ...s, paused: withReason(s.paused, 'user', !s.paused.has('user')) });
    case 'next':
      return settle(forward(s));
    case 'prev':
      if (s.count === 0) return s;
      if (s.ended) return settle(moveTo(s, s.count - 1, -1));
      if (s.index > 0) return settle(moveTo(s, s.index - 1, -1));
      return settle(moveTo(s, 0, -1));
    case 'goto': {
      if (s.count === 0) return s;
      const index = clampIndex(e.index, s.count);
      return settle(moveTo(s, index, index >= s.index ? 1 : -1));
    }
    case 'replay':
      if (s.count === 0) return s;
      return settle(moveTo(s, 0, 1));
    case 'restart':
      if (s.ended || s.count === 0) return s;
      return settle(moveTo(s, s.index, s.direction));
  }
}

export interface PendingTimer {
  /** Changes whenever the timer must be re-armed (new item, new state). */
  key: string;
  delayMs: number;
  event: PlayerEvent;
}

/**
 * The timeout the session must arm in this state, if any:
 *   loading    -> "failed" after DURATIONS.loadTimeoutMs
 *   buffering  -> "stallTimeout" after DURATIONS.stallTimeoutMs (W2-20: a stall never ends by itself)
 *   error      -> "skip" after DURATIONS.errorSkipMs, only while nothing pauses (WCAG 2.2.2)
 * A pause (e.g. the visitor pausing a stalled video) disarms it; resuming re-arms it in full.
 */
export function pendingTimer(s: PlayerState): PendingTimer | null {
  const status = statusOf(s);
  switch (status) {
    case 'loading':
      return { key: `load:${s.seq}`, delayMs: DURATIONS.loadTimeoutMs, event: { type: 'failed', seq: s.seq } };
    case 'buffering':
      return { key: `stall:${s.seq}`, delayMs: DURATIONS.stallTimeoutMs, event: { type: 'stallTimeout', seq: s.seq } };
    case 'error':
      return s.paused.size === 0
        ? { key: `skip:${s.seq}`, delayMs: DURATIONS.errorSkipMs, event: { type: 'skip', seq: s.seq } }
        : null;
    default:
      return null;
  }
}

/**
 * Whether "back" (tap in the back zone, ←, a swipe back, the previous-moment buttons) leaves the
 * day: on its first moment, or on an empty day, it goes to the previous day's last moment (the
 * component decides whether there is one, else "prev" restarts the moment). Everywhere else
 * "prev" stays inside the day; from the day-end card it returns to the last moment.
 */
export function backLeavesDay(s: PlayerState): boolean {
  return s.count === 0 || (!s.ended && s.index === 0);
}

/** Space-separated pause reasons in a stable order (for data attributes and tests). */
export function pauseReasonsAttr(s: PlayerState): string {
  return PAUSE_REASONS.filter((r) => s.paused.has(r)).join(' ');
}
