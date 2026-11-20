/**
 * Pointer gestures on the player stage: tap zones, hold-to-pause and swipes (see gestures.ts
 * for the mapping). Listeners are native and the drag feedback writes styles directly, so a
 * drag never re-renders React.
 *
 * A second pointer going down during a gesture (two fingers: a pinch-zoom attempt, the stage is
 * touch-none so the browser does not zoom) turns it into nothing: the stage snaps back, and the
 * release is neither a tap nor a swipe. Flicks are judged by the speed at release
 * (releaseVelocity over the last GESTURE.flickWindowMs), not the average over the whole drag.
 *
 * Drag feedback (not under reduced motion): a vertical drag moves the stage. Pulling down lifts
 * it (dragFeedback: follows the finger, shrinks, rounds its corners) and fades every
 * `[data-lift-fade]` element inside the closest `[data-lift-scope]` (the backdrop), so the page
 * below shows through; `[data-lift-fade="rail"]` (the side rails) fades faster. Released short of closing, it snaps back; closing fades it out while the
 * player goes away.
 */
import { type RefObject, useEffect, useRef } from 'react';
import {
  classifySwipe,
  type Direction,
  dragFeedback,
  GESTURE,
  type PointerSample,
  releaseVelocity,
  type SwipeAction,
  scrollsVertically,
  type TapAction,
  tapZone,
} from './gestures';

export interface StageGestureHandlers {
  onTap(action: TapAction): void;
  onHoldStart(): void;
  onHoldEnd(): void;
  onSwipe(action: SwipeAction): void;
}

export interface StageGestureOptions {
  fwd: Direction;
  hasNextDay: boolean;
  enabled: boolean;
  /** Element that follows vertical drags (defaults to the stage). */
  dragTarget?: RefObject<HTMLElement | null>;
  reducedMotion: boolean;
}

/** Interactive children (buttons, links, the story card's CTA) keep their own clicks. */
const INTERACTIVE = 'button, a, input, select, textarea, [role="button"], [data-no-gesture]';

const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
const SNAP_BACK_MS = 320;
const DISMISS_MS = 180;
/** If the player is still there this long after a close (it should be gone), it comes back. */
const DISMISS_RESTORE_MS = 900;

/** Whether the pointer went down inside vertically scrollable content of the stage (long text). */
function startsInScroller(target: EventTarget | null, stage: HTMLElement): boolean {
  for (let el = target instanceof Element ? target : null; el && el !== stage; el = el.parentElement) {
    if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight + 1) continue;
    const { overflowY } = getComputedStyle(el);
    if (scrollsVertically({ overflowY, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight })) return true;
  }
  return false;
}

/** Inline styles written by a drag, so they can be animated back or cleared. */
interface Dragged {
  el: HTMLElement;
  fades: HTMLElement[];
  /** The stage's own corner radius (px): a lift never makes it squarer. */
  baseRadius: number;
}

function clearDragStyles(d: Dragged): void {
  for (const el of [d.el, ...d.fades]) {
    el.style.transition = '';
    el.style.opacity = '';
  }
  d.el.style.transform = '';
  d.el.style.borderRadius = '';
}

export function useStageGestures(
  ref: RefObject<HTMLElement | null>,
  handlers: StageGestureHandlers,
  options: StageGestureOptions,
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const stage = ref.current;
    if (!stage || !options.enabled) return;

    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let startT = 0;
    let moved = false;
    let holding = false;
    /** The axis the drag locked to once it left the tap slop. */
    let axis: 'x' | 'y' | null = null;
    let inScroller = false;
    /** A second pointer went down during this gesture (pinch): it ends as nothing. */
    let multi = false;
    /** Recent positions of the gesture's pointer (for the speed at release). */
    let samples: PointerSample[] = [];
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let dragged: Dragged | null = null;

    const target = () => optionsRef.current.dragTarget?.current ?? stage;

    const clearHold = () => {
      if (holdTimer !== null) clearTimeout(holdTimer);
      holdTimer = null;
    };

    const clearSettle = () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = null;
    };

    /** Writes the drag feedback for a vertical offset `dy`. */
    const follow = (dy: number) => {
      if (!dragged) {
        clearSettle();
        const el = target();
        const scope = stage.closest('[data-lift-scope]');
        dragged = {
          el,
          fades: scope ? [...scope.querySelectorAll<HTMLElement>('[data-lift-fade]')] : [],
          baseRadius: Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0,
        };
      }
      const { el, fades, baseRadius } = dragged;
      const f = dragFeedback(dy, el.clientHeight);
      el.style.transition = '';
      el.style.transform = `translate3d(0, ${f.y.toFixed(1)}px, 0) scale(${f.scale.toFixed(4)})`;
      el.style.borderRadius = f.lift > 0 ? `${Math.max(baseRadius, f.radius).toFixed(1)}px` : '';
      for (const fade of fades) {
        fade.style.transition = '';
        const opacity = fade.dataset.liftFade === 'rail' ? f.rails : f.backdrop;
        fade.style.opacity = f.lift > 0 ? opacity.toFixed(3) : '';
      }
    };

    /** Ends the drag feedback: animate back to rest, or fade out (closing), or clear at once. */
    const settle = (how: 'back' | 'dismiss' | 'now') => {
      const d = dragged;
      if (!d) return;
      clearSettle();
      if (how === 'now' || optionsRef.current.reducedMotion) {
        clearDragStyles(d);
        dragged = null;
        return;
      }
      const all = [d.el, ...d.fades];
      if (how === 'back') {
        d.el.style.transition = `transform ${SNAP_BACK_MS}ms ${EASE_OUT}, border-radius ${SNAP_BACK_MS}ms ${EASE_OUT}`;
        for (const fade of d.fades) fade.style.transition = `opacity ${SNAP_BACK_MS}ms ${EASE_OUT}`;
        d.el.style.transform = '';
        d.el.style.borderRadius = '';
        for (const fade of d.fades) fade.style.opacity = '';
      } else {
        for (const el of all) el.style.transition = `opacity ${DISMISS_MS}ms ease-out`;
        for (const el of all) el.style.opacity = '0';
      }
      settleTimer = setTimeout(
        () => {
          settleTimer = null;
          if (dragged === d) dragged = null;
          clearDragStyles(d);
        },
        how === 'back' ? SNAP_BACK_MS + 40 : DISMISS_RESTORE_MS,
      );
    };

    const finish = (e: PointerEvent, cancelled: boolean) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      clearHold();
      if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
      const wasHolding = holding;
      holding = false;
      if (wasHolding) handlersRef.current.onHoldEnd();
      if (cancelled || multi) {
        multi = false;
        settle('back');
        return;
      }
      const rect = stage.getBoundingClientRect();
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const dt = e.timeStamp - startT;
      if (!moved) {
        settle('now');
        if (!wasHolding) handlersRef.current.onTap(tapZone(startX - rect.left, rect.width, optionsRef.current.fwd));
        return;
      }
      const { fwd, hasNextDay } = optionsRef.current;
      samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
      const { vx, vy } = releaseVelocity(samples);
      const action = classifySwipe({ dx, dy, dt, fwd, hasNextDay, inScroller, vx, vy });
      settle(action === 'close' ? 'dismiss' : 'back');
      if (action) handlersRef.current.onSwipe(action);
    };

    const onDown = (e: PointerEvent) => {
      if (pointerId !== null) {
        // A second finger while one is down: a pinch, never a tap or a swipe.
        if (e.pointerId !== pointerId && !multi) {
          multi = true;
          clearHold();
          settle('back');
        }
        return;
      }
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      if (e.target instanceof Element && e.target.closest(INTERACTIVE)) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      startT = e.timeStamp;
      moved = false;
      holding = false;
      multi = false;
      samples = [{ t: e.timeStamp, x: e.clientX, y: e.clientY }];
      axis = null;
      inScroller = startsInScroller(e.target, stage);
      // A new drag takes over from a stage still snapping back.
      settle('now');
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic events in tests cannot be captured.
      }
      clearHold();
      holdTimer = setTimeout(() => {
        holdTimer = null;
        if (pointerId === null || moved) return;
        holding = true;
        handlersRef.current.onHoldStart();
      }, GESTURE.holdMs);
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId || multi) return;
      samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
      // Only the recent past matters for the speed at release.
      if (samples.length > 32) samples = samples.slice(-16);
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > GESTURE.slopPx) {
        moved = true;
        axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
        clearHold();
      }
      // Also after a hold: holding to look, then pulling down, lifts the stage too.
      if (!moved || axis !== 'y' || inScroller || optionsRef.current.reducedMotion) return;
      follow(dy);
    };

    const onUp = (e: PointerEvent) => finish(e, false);
    const onCancel = (e: PointerEvent) => finish(e, true);
    const onContextMenu = (e: Event) => e.preventDefault();

    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onCancel);
    stage.addEventListener('contextmenu', onContextMenu);
    return () => {
      clearHold();
      clearSettle();
      if (dragged) clearDragStyles(dragged);
      dragged = null;
      stage.removeEventListener('pointerdown', onDown);
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerup', onUp);
      stage.removeEventListener('pointercancel', onCancel);
      stage.removeEventListener('contextmenu', onContextMenu);
      if (holding) handlersRef.current.onHoldEnd();
    };
  }, [ref, options.enabled]);
}
