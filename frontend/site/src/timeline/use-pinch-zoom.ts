/**
 * usePinchZoom: one hook for the three pinch inputs of the semantic zoom (plan C).
 * - Touch: two pointers (Pointer Events). A non-passive touchmove listener cancels the
 *   browser's own pinch/pan while two fingers are down, so the pointer stream keeps flowing.
 * - Trackpads in Chromium/Firefox and Ctrl + mouse wheel: `wheel` events with ctrlKey.
 * - Safari (macOS trackpad, iOS): the proprietary gesturestart/change/end events.
 * Each gesture commits at most one level (as soon as |ln s| > 0.18); until then the handlers get
 * a clamped preview scale. Math lives in pinch-math.ts.
 */
import { type RefObject, useEffect, useRef } from 'react';
import {
  commitDirection,
  distance,
  midpoint,
  type Point,
  pinchScale,
  previewScale,
  wheelScaleFactor,
} from './pinch-math';
import type { ZoomDirection } from './search';

export interface PinchHandlers {
  /** Preview while the gesture runs (scale already clamped to the preview range). */
  onPreview(scale: number, origin: Point): void;
  /** The gesture crossed the threshold; the preview should hand over to the zoom transition. */
  onCommit(direction: ZoomDirection, origin: Point, scale: number): void;
  /** The gesture ended below the threshold: settle the preview back to 1. */
  onCancel(): void;
}

/** Quiet time after the last ctrl+wheel event that ends a wheel "gesture". */
const WHEEL_END_MS = 160;

interface GestureEvent extends UIEvent {
  scale: number;
  clientX: number;
  clientY: number;
}

export function usePinchZoom(ref: RefObject<HTMLElement | null>, handlers: PinchHandlers, enabled = true): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    const h = () => handlersRef.current;

    let committed = false;
    let active: 'touch' | 'wheel' | 'safari' | null = null;
    const finish = () => {
      if (active && !committed) h().onCancel();
      active = null;
      committed = false;
    };
    const update = (raw: number, origin: Point) => {
      if (committed) return;
      const dir = commitDirection(raw);
      if (dir) {
        committed = true;
        h().onCommit(dir, origin, previewScale(raw));
      } else {
        h().onPreview(previewScale(raw), origin);
      }
    };

    // ---- touch (pointer events) ----
    const pointers = new Map<number, Point>();
    let startDistance = 0;
    const pair = (): [Point, Point] | null => {
      const [a, b] = [...pointers.values()];
      return a && b ? [a, b] : null;
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const p = pair();
      if (pointers.size === 2 && p && active === null) {
        active = 'touch';
        committed = false;
        startDistance = distance(p[0], p[1]);
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const p = pair();
      if (active === 'touch' && p) update(pinchScale(startDistance, distance(p[0], p[1])), midpoint(p[0], p[1]));
    };
    const onPointerEnd = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      if (active === 'touch' && pointers.size < 2) finish();
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length >= 2 && e.cancelable) e.preventDefault();
    };

    // ---- ctrl + wheel ----
    let wheelRaw = 1;
    let wheelTimer: ReturnType<typeof setTimeout> | undefined;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || active === 'safari' || active === 'touch') return;
      e.preventDefault();
      if (active !== 'wheel') {
        active = 'wheel';
        committed = false;
        wheelRaw = 1;
      }
      wheelRaw *= wheelScaleFactor(e.deltaY, e.deltaMode);
      update(wheelRaw, { x: e.clientX, y: e.clientY });
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(finish, WHEEL_END_MS);
    };

    // ---- Safari gesture events ----
    const onGestureStart = (e: Event) => {
      if (active === 'touch') return;
      e.preventDefault();
      active = 'safari';
      committed = false;
    };
    const onGestureChange = (e: Event) => {
      if (active !== 'safari') return;
      e.preventDefault();
      const g = e as GestureEvent;
      update(g.scale, { x: g.clientX, y: g.clientY });
    };
    const onGestureEnd = (e: Event) => {
      if (active !== 'safari') return;
      e.preventDefault();
      finish();
    };

    const nonPassive = { passive: false } as const;
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerEnd);
    el.addEventListener('pointercancel', onPointerEnd);
    el.addEventListener('touchmove', onTouchMove, nonPassive);
    el.addEventListener('wheel', onWheel, nonPassive);
    el.addEventListener('gesturestart', onGestureStart, nonPassive);
    el.addEventListener('gesturechange', onGestureChange, nonPassive);
    el.addEventListener('gestureend', onGestureEnd, nonPassive);
    return () => {
      clearTimeout(wheelTimer);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerEnd);
      el.removeEventListener('pointercancel', onPointerEnd);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
      el.removeEventListener('gestureend', onGestureEnd);
    };
  }, [ref, enabled]);
}
