/**
 * Pinch math of the semantic zoom (plan C): the gesture's raw scale `s` drives a clamped
 * preview (0.85–1.2) and commits one level as soon as |ln s| > 0.18. The preview is clamped,
 * the commit decision uses the raw scale (|ln 0.85| < 0.18, so zooming out needs s < 0.835).
 */
import { ZOOM_GESTURE } from '@omw/ui/motion';
import type { ZoomDirection } from './search';

export interface Point {
  x: number;
  y: number;
}

/** Preview scale with a soft rubber band at the limits (never outside [min, max]). */
export function previewScale(raw: number, limits: { minScale: number; maxScale: number } = ZOOM_GESTURE): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const { minScale, maxScale } = limits;
  if (raw >= minScale && raw <= maxScale) return raw;
  // Beyond a limit, move a third as fast and approach the limit asymptotically.
  const edge = raw > maxScale ? maxScale : minScale;
  const over = Math.log(raw / edge);
  const damped = edge * Math.exp(over / 3);
  return raw > maxScale ? Math.min(maxScale, damped) : Math.max(minScale, damped);
}

/** 'in' (spread fingers, s > 1), 'out' (pinch, s < 1) or null below the threshold. */
export function commitDirection(raw: number, threshold: number = ZOOM_GESTURE.commitLogScale): ZoomDirection | null {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const l = Math.log(raw);
  if (l > threshold) return 'in';
  if (l < -threshold) return 'out';
  return null;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Scale of a two-finger gesture relative to its starting finger distance. */
export function pinchScale(startDistance: number, currentDistance: number): number {
  if (startDistance <= 0) return 1;
  return currentDistance / startDistance;
}

/** WheelEvent.deltaMode values. */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/**
 * Scale factor of one ctrl+wheel event (trackpad pinch in Chromium/Firefox sends ctrl+wheel;
 * negative deltaY = fingers apart = zoom in). Clamped per event so a mouse wheel notch
 * (|deltaY| ≈ 100) is one decisive step rather than a jump through several levels.
 */
export function wheelScaleFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === DOM_DELTA_LINE ? deltaY * 16 : deltaMode === DOM_DELTA_PAGE ? deltaY * 400 : deltaY;
  const clamped = Math.max(-50, Math.min(50, px));
  return Math.exp(-clamped * 0.01);
}

/** CSS transform-origin for a viewport point relative to an element's border box. */
export function originWithin(point: Point, rect: { left: number; top: number }): string {
  return `${Math.round(point.x - rect.left)}px ${Math.round(point.y - rect.top)}px`;
}
