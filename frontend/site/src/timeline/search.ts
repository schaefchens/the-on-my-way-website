/**
 * Timeline search params (plan C, "Routes"): `/$locale/?z=<level>&d=<date>`.
 * - z: zoom level (default "days"); d: focused date (the date at the focus line).
 * - Zoom and focus changes REPLACE the history entry; opening the player PUSHES.
 * Pure helpers, shared by the router (validateSearch) and the timeline.
 */
import { isValidLocalDate } from '@omw/contracts/time';
import { ZOOM_LEVELS, type ZoomLevel } from './model';

export { ZOOM_LEVELS, type ZoomLevel };

export const DEFAULT_ZOOM: ZoomLevel = 'days';

export interface HomeSearch {
  z?: ZoomLevel;
  d?: string;
}

export function isZoomLevel(value: unknown): value is ZoomLevel {
  return typeof value === 'string' && (ZOOM_LEVELS as readonly string[]).includes(value);
}

/** Router validateSearch: unknown or malformed values are dropped (never throws). */
export function validateHomeSearch(search: Record<string, unknown>): HomeSearch {
  const out: HomeSearch = {};
  if (isZoomLevel(search.z)) out.z = search.z;
  if (typeof search.d === 'string' && isValidLocalDate(search.d)) out.d = search.d;
  return out;
}

/** Canonical search object: the default level is omitted, so "/de/" stays clean. */
export function homeSearch(z: ZoomLevel, d: string | null | undefined): HomeSearch {
  const out: HomeSearch = {};
  if (z !== DEFAULT_ZOOM) out.z = z;
  if (d) out.d = d;
  return out;
}

export function sameHomeSearch(a: HomeSearch, b: HomeSearch): boolean {
  return (a.z ?? DEFAULT_ZOOM) === (b.z ?? DEFAULT_ZOOM) && (a.d ?? null) === (b.d ?? null);
}

export type ZoomDirection = 'in' | 'out';

/** "in" = more detail (trips → months → days). Null at either end. */
export function stepLevel(level: ZoomLevel, direction: ZoomDirection): ZoomLevel | null {
  const i = ZOOM_LEVELS.indexOf(level) + (direction === 'in' ? 1 : -1);
  return ZOOM_LEVELS[i] ?? null;
}

export function zoomDirection(from: ZoomLevel, to: ZoomLevel): ZoomDirection | null {
  const d = ZOOM_LEVELS.indexOf(to) - ZOOM_LEVELS.indexOf(from);
  return d > 0 ? 'in' : d < 0 ? 'out' : null;
}

export type ZoomKeyAction = { type: 'step'; direction: ZoomDirection } | { type: 'set'; level: ZoomLevel };

/**
 * Keyboard shortcuts: + / = zoom in, - / _ zoom out, 1-3 pick a level. Keys with Ctrl/Meta/Alt
 * are left to the browser (Ctrl + is page zoom).
 */
export function zoomKeyAction(e: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}): ZoomKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case '+':
    case '=':
      return { type: 'step', direction: 'in' };
    case '-':
    case '_':
      return { type: 'step', direction: 'out' };
    case '1':
      return { type: 'set', level: 'trips' };
    case '2':
      return { type: 'set', level: 'months' };
    case '3':
      return { type: 'set', level: 'days' };
    default:
      return null;
  }
}

/** True when a key event comes from a text field (shortcuts must not fire there). */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; isContentEditable?: boolean; type?: string };
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el.type ?? 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'image'].includes(type);
  }
  return false;
}
