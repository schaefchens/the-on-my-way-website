/** Timeline-wide values for the (memoized) row views. */
import type { LocaleCode } from '@omw/contracts/i18n';
import { createContext, useContext } from 'react';
import type { Point } from './pinch-math';
import type { ZoomLevel } from './search';

export interface ZoomRequest {
  /** Date to keep fixed (defaults to the date under `origin` or the focus line). */
  anchorDate?: string;
  /** Viewport point the zoom happens around (pointer, tile centre, …). */
  origin?: Point;
  /** Set when a pinch preview is showing, so the transition continues from it. */
  scale?: number;
  /** Keyboard-initiated: move focus to the anchor afterwards. */
  keyboard?: boolean;
}

export interface TimelineContextValue {
  locale: LocaleCode;
  level: ZoomLevel;
  /** Newest day of the timeline. */
  latestDate: string | null;
  zoomTo(level: ZoomLevel, request?: ZoomRequest): void;
}

export const TimelineContext = createContext<TimelineContextValue | null>(null);

export function useTimelineContext(): TimelineContextValue {
  const ctx = useContext(TimelineContext);
  if (!ctx) throw new Error('useTimelineContext() outside <TimelineContext>');
  return ctx;
}

/** Centre of an element in viewport coordinates (zoom origin for clicks and keys). */
export function centerOf(el: Element): Point {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
