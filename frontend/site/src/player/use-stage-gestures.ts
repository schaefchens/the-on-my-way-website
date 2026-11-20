/**
 * Pointer gestures on the player stage: tap zones, hold-to-pause and swipes (see gestures.ts
 * for the mapping). Listeners are native and the drag feedback writes styles directly, so a
 * drag never re-renders React.
 */
import { type RefObject, useEffect, useRef } from 'react';
import {
  classifySwipe,
  type Direction,
  GESTURE,
  rubberBand,
  type SwipeAction,
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
  hasPrevDay: boolean;
  hasNextDay: boolean;
  enabled: boolean;
  /** Element that follows vertical drags (defaults to the stage). */
  dragTarget?: RefObject<HTMLElement | null>;
  reducedMotion: boolean;
}

/** Interactive children (buttons, links, the story card's CTA) keep their own clicks. */
const INTERACTIVE = 'button, a, input, select, textarea, [role="button"], [data-no-gesture]';

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
    let holdTimer: ReturnType<typeof setTimeout> | null = null;

    const target = () => optionsRef.current.dragTarget?.current ?? stage;

    const clearHold = () => {
      if (holdTimer !== null) clearTimeout(holdTimer);
      holdTimer = null;
    };

    const resetDrag = (animate: boolean) => {
      const el = target();
      if (!el.style.transform) return;
      if (animate && !optionsRef.current.reducedMotion) {
        el.style.transition = 'transform 320ms cubic-bezier(0.22, 1, 0.36, 1)';
        const done = () => {
          el.style.transition = '';
          el.removeEventListener('transitionend', done);
        };
        el.addEventListener('transitionend', done);
      }
      el.style.transform = '';
    };

    const finish = (e: PointerEvent, cancelled: boolean) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      clearHold();
      if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
      const wasHolding = holding;
      holding = false;
      if (wasHolding) handlersRef.current.onHoldEnd();
      if (cancelled) {
        resetDrag(true);
        return;
      }
      const rect = stage.getBoundingClientRect();
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const dt = e.timeStamp - startT;
      if (!moved) {
        resetDrag(false);
        if (!wasHolding) handlersRef.current.onTap(tapZone(startX - rect.left, rect.width, optionsRef.current.fwd));
        return;
      }
      const { fwd, hasPrevDay, hasNextDay } = optionsRef.current;
      const action = classifySwipe({ dx, dy, dt, startY: startY - rect.top, fwd, hasPrevDay, hasNextDay });
      resetDrag(true);
      if (action) handlersRef.current.onSwipe(action);
    };

    const onDown = (e: PointerEvent) => {
      if (pointerId !== null || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      if (e.target instanceof Element && e.target.closest(INTERACTIVE)) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      startT = e.timeStamp;
      moved = false;
      holding = false;
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
      if (e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > GESTURE.slopPx) {
        moved = true;
        clearHold();
      }
      if (!moved || holding) return;
      if (Math.abs(dy) > Math.abs(dx) && !optionsRef.current.reducedMotion) {
        const el = target();
        const limit = el.clientHeight * 0.35;
        const y = rubberBand(dy, limit);
        const scale = dy > 0 ? 1 - Math.min(0.08, (y / Math.max(1, limit)) * 0.08) : 1;
        el.style.transition = '';
        el.style.transform = `translate3d(0, ${y.toFixed(1)}px, 0) scale(${scale.toFixed(4)})`;
      }
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
      stage.removeEventListener('pointerdown', onDown);
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerup', onUp);
      stage.removeEventListener('pointercancel', onCancel);
      stage.removeEventListener('contextmenu', onContextMenu);
      if (holding) handlersRef.current.onHoldEnd();
    };
  }, [ref, options.enabled]);
}
