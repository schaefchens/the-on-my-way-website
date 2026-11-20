/**
 * Gesture and key mapping of the journey player (plan C "Gestures", "RTL readiness").
 * Pure functions over physical pointer coordinates; `fwd` is forwardSign(locale): +1 for LTR,
 * -1 for RTL, so every horizontal decision mirrors in RTL.
 *
 *   tap           first 30 % of the reading direction = back, the other 70 % = forward.
 *                 Back on the first moment of a day goes to the previous day's last moment
 *                 (machine.ts backLeavesDay), so the previous day stays one tap away.
 *   hold          pause while the pointer is down (no tap on release)
 *   swipe up      next day
 *   swipe down    close the player, from anywhere on the stage (like dismissing a story): the
 *                 stage follows the finger, shrinks and the backdrop fades (dragFeedback); a
 *                 short pull snaps back (a closing flick needs closeFlickMinPx of travel too, so
 *                 a tap that slips a little never closes). A drag that starts in scrollable text
 *                 scrolls it instead.
 *   two fingers   (a pinch-zoom attempt) neither tap nor swipe: the stage snaps back
 *                 (use-stage-gestures.ts).
 *   swipe ← / →   next / previous item (mirrored in RTL)
 *
 *   keys          Space/K pause · ←/→ previous/next item (mirrored in RTL) · ↑/↓ and
 *                 PageUp/PageDown previous/next day · Esc close · M mute.
 *                 Auto-repeat (a held key) is ignored: one press = one step, so holding Space
 *                 does not flicker play/pause and a held arrow does not flood navigation.
 */

export const GESTURE = {
  /** Pointer down this long without moving = hold (pauses). */
  holdMs: 220,
  /** Movement below this is still a tap/hold. */
  slopPx: 10,
  /** Minimum travel for a swipe … */
  swipeMinPx: 56,
  /** … and for a slow pull down that closes (a shorter one snaps back) … */
  closeMinPx: 96,
  /**
   * … or a flick: still this fast (px/ms) when the pointer goes up (releaseVelocity), in the
   * direction of the drag, with at least slopPx * 2 travel …
   */
  flickVelocity: 0.5,
  /** … over this window before the release (ms) … */
  flickWindowMs: 80,
  /** … and at least this much travel for a flick that closes (a quick 20 px slip snaps back). */
  closeFlickMinPx: 48,
  /** The dominant axis must be this much larger than the other. */
  axisRatio: 1.2,
  /** Back zone: the first 30 % of the reading direction. */
  backZone: 0.3,
  /** A pull down this share of the stage height lifts it fully (smallest, backdrop gone). */
  liftFullAt: 0.5,
  /** How much a fully lifted stage shrinks. */
  liftShrink: 0.18,
  /** Corner radius (px) of a fully lifted stage (a full-screen stage has square corners). */
  liftRadiusPx: 28,
  /** The side rails (wide screens) fade this many times faster than the backdrop. */
  railFadeRate: 2,
  /** A pull up follows with resistance up to this share of the stage height. */
  pullUpLimit: 0.35,
} as const;

export type Direction = 1 | -1;

export type TapAction = 'back' | 'forward';

/** Which item a tap at `x` (relative to the stage's left edge) navigates to. */
export function tapZone(x: number, width: number, fwd: Direction): TapAction {
  if (!(width > 0)) return 'forward';
  const fraction = Math.min(1, Math.max(0, x / width));
  const fromStart = fwd === 1 ? fraction : 1 - fraction;
  return fromStart < GESTURE.backZone ? 'back' : 'forward';
}

export type SwipeAction = 'nextDay' | 'close' | 'nextItem' | 'prevItem';

export interface SwipeInput {
  /** Physical deltas (px): positive dx = right, positive dy = down. */
  dx: number;
  dy: number;
  /** Gesture duration in ms. */
  dt: number;
  fwd: Direction;
  hasNextDay: boolean;
  /**
   * The drag started inside vertically scrollable content (long text): vertical moves belong to
   * that scroll, never to the player.
   */
  inScroller?: boolean;
  /**
   * Velocity at release (px/ms, physical axes like dx/dy): the movement over the last
   * GESTURE.flickWindowMs before the pointer went up (releaseVelocity). Defaults to the average
   * over the whole gesture.
   */
  vx?: number;
  vy?: number;
}

export interface PointerSample {
  t: number;
  x: number;
  y: number;
}

/**
 * Velocity (px/ms) at the end of a pointer path (samples in time order): from the earliest
 * sample within `windowMs` before the final one (else the sample just before it) to the final
 * sample. A finger that stopped before letting go has none, however fast the drag was before.
 */
export function releaseVelocity(
  samples: readonly PointerSample[],
  windowMs: number = GESTURE.flickWindowMs,
): { vx: number; vy: number } {
  const last = samples.at(-1);
  let from = samples.at(-2);
  if (!last || !from) return { vx: 0, vy: 0 };
  for (let i = samples.length - 3; i >= 0; i--) {
    const s = samples[i] as PointerSample;
    if (s.t < last.t - windowMs) break;
    from = s;
  }
  const dt = Math.max(1, last.t - from.t);
  return { vx: (last.x - from.x) / dt, vy: (last.y - from.y) / dt };
}

/** A flick along one axis: enough travel, and still moving fast that way at release. */
function isFlick(delta: number, velocity: number, minTravel: number): boolean {
  return Math.abs(delta) >= minTravel && velocity * Math.sign(delta) >= GESTURE.flickVelocity;
}

/** Classifies a finished drag; null when it was too short/slow or too diagonal. */
export function classifySwipe(input: SwipeInput): SwipeAction | null {
  const { dx, dy, dt, fwd, hasNextDay, inScroller = false } = input;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const vx = input.vx ?? dx / Math.max(1, dt);
  const vy = input.vy ?? dy / Math.max(1, dt);
  const flickMin = GESTURE.slopPx * 2;

  if (ay >= ax * GESTURE.axisRatio) {
    if (inScroller) return null;
    if (dy < 0) return hasNextDay && (ay >= GESTURE.swipeMinPx || isFlick(dy, vy, flickMin)) ? 'nextDay' : null;
    return ay >= GESTURE.closeMinPx || isFlick(dy, vy, GESTURE.closeFlickMinPx) ? 'close' : null;
  }
  if (ax >= ay * GESTURE.axisRatio && (ax >= GESTURE.swipeMinPx || isFlick(dx, vx, flickMin))) {
    // Content moves with the finger: a swipe against the reading direction reveals the next item.
    return dx * fwd < 0 ? 'nextItem' : 'prevItem';
  }
  return null;
}

/** Live feedback while dragging vertically: the stage follows with resistance. */
export function rubberBand(delta: number, limit: number): number {
  if (limit <= 0) return 0;
  const sign = delta < 0 ? -1 : 1;
  const d = Math.abs(delta);
  // Linear for small moves, asymptotic towards `limit` for larger ones.
  return sign * ((d * limit) / (d + limit));
}

export interface DragFeedback {
  /** Vertical offset of the stage (px). */
  y: number;
  scale: number;
  /** 0 = resting … 1 = fully lifted (pulled down liftFullAt of the height). */
  lift: number;
  /** Corner radius while lifted (px). */
  radius: number;
  /** Opacity of the backdrop behind the stage. */
  backdrop: number;
  /**
   * Opacity of the side rails (wide screens): gone by half the lift, so the neighbouring days'
   * cards never sit half-faded on top of the timeline that shows through.
   */
  rails: number;
}

/**
 * How the stage follows a vertical drag of `dy` px on a stage `height` px tall. Down "lifts" it
 * off the page like a story being dismissed: it follows the finger 1:1, shrinks a little, rounds
 * its corners and the backdrop fades, so the timeline below shows through. Up (next day) follows
 * with resistance and nothing else.
 */
export function dragFeedback(dy: number, height: number): DragFeedback {
  const rest = { scale: 1, lift: 0, radius: 0, backdrop: 1, rails: 1 };
  if (!(height > 0) || !Number.isFinite(dy) || dy === 0) return { y: 0, ...rest };
  if (dy < 0) return { y: rubberBand(dy, height * GESTURE.pullUpLimit), ...rest };
  const lift = Math.min(1, dy / (height * GESTURE.liftFullAt));
  return {
    y: dy,
    scale: 1 - GESTURE.liftShrink * lift,
    lift,
    radius: GESTURE.liftRadiusPx * lift,
    backdrop: 1 - lift,
    rails: Math.max(0, 1 - GESTURE.railFadeRate * lift),
  };
}

/** Whether an element scrolls vertically (long text): CSS allows it and there is more to see. */
export function scrollsVertically(el: { overflowY: string; scrollHeight: number; clientHeight: number }): boolean {
  return (el.overflowY === 'auto' || el.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
}

export type KeyAction = 'toggle' | 'back' | 'forward' | 'prevDay' | 'nextDay' | 'close' | 'mute';

/**
 * Maps a keydown to an action. `onControl` is true when focus is on a button/link/input:
 * Space/Enter then belong to that control (no double toggle).
 */
export function keyAction(
  e: { key: string; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; repeat?: boolean },
  fwd: Direction,
  onControl = false,
): KeyAction | null {
  if (e.altKey || e.ctrlKey || e.metaKey || e.repeat) return null;
  switch (e.key) {
    case ' ':
    case 'Spacebar':
      return onControl ? null : 'toggle';
    case 'k':
    case 'K':
      return 'toggle';
    case 'ArrowRight':
      return fwd === 1 ? 'forward' : 'back';
    case 'ArrowLeft':
      return fwd === 1 ? 'back' : 'forward';
    case 'ArrowUp':
    case 'PageUp':
      return 'prevDay';
    case 'ArrowDown':
    case 'PageDown':
      return 'nextDay';
    case 'Escape':
    case 'Esc':
      return 'close';
    case 'm':
    case 'M':
      return 'mute';
    default:
      return null;
  }
}
