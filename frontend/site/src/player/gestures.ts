/**
 * Gesture and key mapping of the journey player (plan C "Gestures", "RTL readiness").
 * Pure functions over physical pointer coordinates; `fwd` is forwardSign(locale): +1 for LTR,
 * -1 for RTL, so every horizontal decision mirrors in RTL.
 *
 *   tap           first 30 % of the reading direction = back, the other 70 % = forward
 *   hold          pause while the pointer is down (no tap on release)
 *   swipe up      next day
 *   swipe down    previous day; on the first day (no previous one) it closes the player.
 *                 A pull that starts on the top bar (progress + title) always closes,
 *                 like pulling a sheet down by its handle.
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
  /** … or a flick faster than this (px/ms) with at least slopPx * 2 travel. */
  flickVelocity: 0.5,
  /** The dominant axis must be this much larger than the other. */
  axisRatio: 1.2,
  /** Back zone: the first 30 % of the reading direction. */
  backZone: 0.3,
  /** Top bar height (px) where a pull-down always closes. */
  closeZonePx: 96,
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

export type SwipeAction = 'nextDay' | 'prevDay' | 'close' | 'nextItem' | 'prevItem';

export interface SwipeInput {
  /** Physical deltas (px): positive dx = right, positive dy = down. */
  dx: number;
  dy: number;
  /** Gesture duration in ms. */
  dt: number;
  /** Where the pointer went down, relative to the stage top (px). */
  startY: number;
  fwd: Direction;
  hasPrevDay: boolean;
  hasNextDay: boolean;
}

/** Classifies a finished drag; null when it was too short/slow or too diagonal. */
export function classifySwipe({ dx, dy, dt, startY, fwd, hasPrevDay, hasNextDay }: SwipeInput): SwipeAction | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const travel = Math.max(ax, ay);
  const velocity = travel / Math.max(1, dt);
  const isSwipe = travel >= GESTURE.swipeMinPx || (velocity >= GESTURE.flickVelocity && travel >= GESTURE.slopPx * 2);
  if (!isSwipe) return null;

  if (ay >= ax * GESTURE.axisRatio) {
    if (dy < 0) return hasNextDay ? 'nextDay' : null;
    if (startY <= GESTURE.closeZonePx || !hasPrevDay) return 'close';
    return 'prevDay';
  }
  if (ax >= ay * GESTURE.axisRatio) {
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
