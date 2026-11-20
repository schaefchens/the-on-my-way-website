/**
 * The zoomable timeline (plan C, "Semantic zoom levels" + "Zoom mechanics").
 *
 * - One window-scrolled TanStack virtual list per level; rows come from the deterministic row
 *   model, so `estimateSize` is exact and offsets can be computed before anything renders.
 * - Zooming keeps the date under the pointer (or the focused item, or the focus line) fixed: the
 *   old level is snapshotted into a ghost layer, the new list mounts at the anchored offset
 *   (initialOffset + scrollTo in the same commit) and the two crossfade around the pointer.
 * - Inputs: zoom pill, keys (+/-, 1-3), ctrl+wheel, touch pinch, Safari gestures, tile clicks.
 * - URL: ?z=<level>&d=<focused date>, always REPLACED (debounced on scroll).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { LocaleCode } from '@omw/contracts/i18n';
import type { TimelineIndex } from '@omw/contracts/site';
import { isRtl } from '@omw/ui/locale';
import { prefersReducedMotion } from '@omw/ui/motion';
import { useNavigate } from '@tanstack/react-router';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { memo, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TimelineContext, type TimelineContextValue, type ZoomRequest } from './context';
import { takeDayFocus } from './focus-request';
import {
  anchorAt,
  buildModel,
  keepHeaderInView,
  nearestDate,
  type RowModel,
  rowIndexForDate,
  scrollTargetFor,
} from './model';
import type { Point } from './pinch-math';
import { preloadOverviewRows, RowView } from './rows';
import {
  DEFAULT_ZOOM,
  type HomeSearch,
  homeSearch,
  isTypingTarget,
  stepLevel,
  type ZoomLevel,
  zoomDirection,
  zoomKeyAction,
} from './search';
import { usePinchZoom } from './use-pinch-zoom';
import { ZoomPill } from './zoom-pill';
import {
  anchorDateOf,
  anchorElementFor,
  captureZoom,
  isInViewport,
  playZoom,
  type ZoomSnapshot,
} from './zoom-transition';

/** Content box: max 68rem, gutters 1rem (2rem from 40rem viewport width). */
export function contentWidthFor(viewportWidth: number): number {
  const gutter = viewportWidth >= 640 ? 32 : 16;
  return Math.min(viewportWidth, 1088) - 2 * gutter;
}

/** Viewport y of the focus line: where `d` sits after a reload and what keyboard zooms keep. */
export function focusLineY(viewportHeight: number): number {
  return Math.round(Math.min(260, Math.max(120, viewportHeight * 0.3)));
}

/** Debounce of the URL update after scrolling (Safari limits replaceState to 100 per 10 s). */
const FOCUS_SYNC_MS = 450;

interface Intent {
  date: string | null;
  viewportY: number;
}

interface PendingZoom extends Intent {
  snapshot: ZoomSnapshot;
  keyboard: boolean;
  from: ZoomLevel;
  /**
   * Where the new level goes: the anchor under the pointer ("anchor"); for zooms without a
   * pointer the top of the page when the reader was there or on the newest day ("top"), else
   * the anchor with its year/month header kept in view ("header"), L3-07.
   */
  place: 'anchor' | 'top' | 'header';
}

interface Placed {
  /** Window scroll position the list was placed at. */
  y: number;
  date: string;
}

/** Whether the window has not scrolled since the list was placed for `date`. */
function unmovedSince(placed: Placed | null, date: string | undefined, scrollY: number): boolean {
  return !!date && placed?.date === date && Math.abs(scrollY - placed.y) <= 2;
}

// ---------------------------------------------------------------------------------------------
// One level

const LevelList = memo(function LevelList({
  model,
  scrollMargin,
  initialOffset,
  listRef,
  onPlaced,
}: {
  model: RowModel;
  scrollMargin: number;
  initialOffset: number;
  listRef: RefObject<HTMLDivElement | null>;
  /** Called once after mounting with the window scroll position the list was placed at. */
  onPlaced: (scrollY: number) => void;
}) {
  const getItemKey = useCallback((i: number) => model.rows[i]?.key ?? i, [model]);
  const estimateSize = useCallback((i: number) => model.rows[i]?.size ?? 0, [model]);
  const virtualizer = useWindowVirtualizer({
    count: model.rows.length,
    estimateSize,
    getItemKey,
    scrollMargin,
    initialOffset,
    overscan: model.level === 'months' ? 8 : 3,
    // Without a window (server rendering) the first screen of a phone is rendered.
    initialRect: { width: model.metrics.width, height: 812 },
  });

  // The list mounts at the anchored offset: scroll there before the first paint.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount only (a new offset remounts)
  useLayoutEffect(() => {
    if (Math.abs(window.scrollY - initialOffset) > 0.5) window.scrollTo({ top: initialOffset, behavior: 'instant' });
    onPlaced(window.scrollY);
  }, []);

  return (
    <div ref={listRef} data-level={model.level} className="relative" style={{ height: model.total }}>
      {virtualizer.getVirtualItems().map((item) => {
        const row = model.rows[item.index];
        if (!row) return null;
        return (
          <div
            key={item.key}
            data-row={row.kind}
            data-row-date={row.kind === 'day' ? row.day.date : undefined}
            className="absolute inset-x-0"
            // `top`, not a transform: rows never move while scrolling, and scroll-driven
            // animations (the route thread) need the real layout position.
            style={{ height: row.size, top: item.start - scrollMargin }}
          >
            <RowView row={row} m={model.metrics} level={model.level} index={item.index} />
          </div>
        );
      })}
    </div>
  );
});

// ---------------------------------------------------------------------------------------------

export interface ZoomableTimelineProps {
  timeline: TimelineIndex;
  /** Accepted timeline hash (part of the list identity). */
  timelineV: string;
  locale: LocaleCode;
  search: HomeSearch;
  /** False while an overlay (player, trip) covers the timeline: no input, no URL updates. */
  active: boolean;
}

export function ZoomableTimeline({ timeline, timelineV, locale, search, active }: ZoomableTimelineProps) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const level = search.z ?? DEFAULT_ZOOM;
  const rtl = isRtl(locale);

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() =>
    contentWidthFor(typeof document === 'undefined' ? 375 : document.documentElement.clientWidth),
  );
  // Server rendering (tests, prerendering) has no layout: assume the list starts at the top.
  const [listTop, setListTop] = useState<number | null>(typeof document === 'undefined' ? 0 : null);
  /** Room below the list (clear of the floating zoom pill), part of the scrollable range. */
  const [endPad, setEndPad] = useState(0);
  const [announcement, setAnnouncement] = useState('');

  const model = useMemo(() => buildModel(level, timeline, width), [level, timeline, width]);
  const modelRef = useRef(model);
  const pendingRef = useRef<PendingZoom | null>(null);
  const zoomingRef = useRef(false);
  /** The `d` this component wrote (or started from); anything else in the URL is external. */
  const knownDRef = useRef<string | undefined>(search.d);
  /**
   * Where the list was last placed for the focused date (zoom, deep link, restore). Until the
   * reader scrolls away from there, that date stays the focus: also at either end of the list,
   * where its anchor cannot reach the focus line, so the URL keeps it and the next zoom anchors
   * on it again (a zoom out and back in returns to the same day).
   */
  const placedRef = useRef<Placed | null>(null);
  /**
   * Bumped by an external focus change so the list remounts at the new date. A ref, not state:
   * the change arrives with the render that carries the new search, and the list key must change
   * in that same render (with state, a key that changes for another reason in the same render —
   * the level, e.g. "show in the timeline" from the years view — would consume the restore under
   * a stale key and lose it).
   */
  const restoreSeqRef = useRef(0);
  const restoreRef = useRef<Intent | null>(search.d ? { date: search.d, viewportY: -1 } : null);

  // External focus change (a link to ?d=…, closing an overlay): jump there, unless that date is
  // already on screen at this level (e.g. the day the player was opened from): then nothing moves.
  if (search.d !== knownDRef.current && !pendingRef.current) {
    knownDRef.current = search.d;
    const list = listRef.current;
    const shown = search.d ? nearestDate(modelRef.current, search.d) : null;
    const inView =
      shown !== null &&
      list !== null &&
      modelRef.current.level === level &&
      list.dataset.level === level &&
      isInViewport(anchorElementFor(list, shown));
    if (inView && search.d) {
      placedRef.current = { y: window.scrollY, date: search.d };
    } else {
      restoreRef.current = { date: search.d ?? null, viewportY: -1 };
      restoreSeqRef.current += 1;
    }
  }

  // ---- geometry ----------------------------------------------------------------------------
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      setListTop(Math.round(rect.top + window.scrollY));
      setWidth(Math.round(rect.width));
      setEndPad(Math.round(Number.parseFloat(getComputedStyle(el).paddingBottom) || 0));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    ro.observe(document.body);
    return () => ro.disconnect();
  }, []);

  // ---- where the (re)mounted list starts ----------------------------------------------------
  const listKey = `${level}|${width}|${timelineV}|${restoreSeqRef.current}`;
  const offsetRef = useRef<{ key: string; offset: number } | null>(null);
  let initialOffset = 0;
  if (listTop !== null) {
    if (offsetRef.current?.key === listKey) {
      initialOffset = offsetRef.current.offset;
    } else if (typeof window !== 'undefined') {
      const viewportH = window.innerHeight;
      const maxScroll = listTop + model.total + endPad - viewportH;
      const prev = modelRef.current;
      const pending = pendingRef.current;
      let intent: Intent | null = pending ?? restoreRef.current;
      if (!intent && offsetRef.current && prev !== model) {
        // Same level, new width or data: keep the date at the focus line.
        const y = focusLineY(viewportH);
        const at = anchorAt(prev, window.scrollY + y - listTop);
        intent = at && window.scrollY > listTop / 2 ? { date: at.date, viewportY: y } : null;
      }
      if (pending?.place === 'top') {
        initialOffset = 0;
      } else if (intent?.date != null) {
        const target =
          scrollTargetFor(
            model,
            intent.date,
            intent.viewportY < 0 ? focusLineY(viewportH) : intent.viewportY,
            listTop,
            maxScroll,
          ) ?? 0;
        initialOffset =
          pending?.place === 'header' ? keepHeaderInView(model, intent.date, target, listTop, viewportH) : target;
      } else {
        initialOffset =
          intent || !offsetRef.current
            ? // An explicit "no focused date" (?d= removed by a link): the top of the timeline.
              0
            : Math.min(window.scrollY, Math.max(0, maxScroll));
      }
      offsetRef.current = { key: listKey, offset: initialOffset };
      const placedDate = intent?.date != null && intent.date === knownDRef.current ? intent.date : null;
      placedRef.current = placedDate ? { y: initialOffset, date: placedDate } : null;
      restoreRef.current = null;
    }
  }
  modelRef.current = model;

  // The real position after mounting (the browser may clamp the computed offset).
  const onPlaced = useCallback((y: number) => {
    if (placedRef.current) placedRef.current.y = y;
  }, []);

  // ---- zoom ---------------------------------------------------------------------------------
  const zoomTo = useCallback(
    (target: ZoomLevel, req: ZoomRequest = {}) => {
      const list = listRef.current;
      const stage = stageRef.current;
      const current = modelRef.current;
      if (!list || !stage || zoomingRef.current || listTop === null) return;
      const direction = zoomDirection(current.level, target);
      if (!direction) return;

      const rect = list.getBoundingClientRect();
      const inlineX = (x: number) => (rtl ? rect.right - x : x - rect.left);
      let date = req.anchorDate ?? null;
      let origin: Point | null = req.origin ?? null;
      const known = knownDRef.current;
      if (!date && origin) date = anchorAt(current, origin.y - rect.top, inlineX(origin.x))?.date ?? null;
      const focused = document.activeElement;
      if (!date && req.keyboard && focused instanceof HTMLElement && focused !== list && list.contains(focused)) {
        // The focused item: inside a day row (header, strip, button), or a link that holds an
        // anchor (month tile, trip or loose card).
        const holder =
          focused.closest<HTMLElement>('[data-row-date],[data-anchor],[data-anchor-range]') ??
          focused.querySelector<HTMLElement>('[data-anchor],[data-anchor-range]');
        if (holder && list.contains(holder)) {
          date = holder.dataset.rowDate ?? anchorDateOf(holder, known);
          const anchorEl = date ? anchorElementFor(list, date) : null;
          const r = (anchorEl ?? holder).getBoundingClientRect();
          origin = { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 48) };
        }
      }
      const focusY = focusLineY(window.innerHeight);
      if (!date && !origin && known) {
        // No pointer, no focused item: keep the focused date while the reader still looks at it
        // (its row is at the focus line, or nothing scrolled since the list was placed for it).
        const unmoved = unmovedSince(placedRef.current, known, window.scrollY);
        if (unmoved || anchorAt(current, focusY - rect.top)?.row === rowIndexForDate(current, known)) {
          date = known;
          const anchorEl = unmoved ? anchorElementFor(list, known) : null;
          if (anchorEl && isInViewport(anchorEl)) {
            const r = anchorEl.getBoundingClientRect();
            origin = { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 48) };
          }
        }
      }
      if (!origin) origin = { x: rect.left + rect.width / 2, y: focusY };
      if (!date) date = anchorAt(current, origin.y - rect.top)?.date ?? null;
      // Without a pointer, the page should not jump away from where the reader is: from the top
      // (or the newest day) it stays at the top; elsewhere the new level keeps the anchor's
      // year/month header in view.
      const newest = timeline.days.at(-1)?.date ?? null;
      const place: PendingZoom['place'] = req.origin
        ? 'anchor'
        : window.scrollY <= 1 || (date !== null && date === newest)
          ? 'top'
          : 'header';

      for (const a of stage.getAnimations()) a.cancel();
      stage.style.transform = '';
      zoomingRef.current = true;
      const snapshot = captureZoom(list, { anchorDate: date, origin, direction, scale: req.scale ?? 1 });
      pendingRef.current = {
        date,
        viewportY: origin.y,
        snapshot,
        keyboard: !!req.keyboard,
        from: current.level,
        place,
      };
      knownDRef.current = date ?? undefined;
      void navigate({
        to: '/$locale/',
        params: { locale },
        search: homeSearch(target, date),
        replace: true,
        resetScroll: false,
      });
    },
    [listTop, locale, navigate, rtl, timeline],
  );

  // After the new level committed (its list already scrolled into place): animate.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the level changes
  useLayoutEffect(() => {
    const pending = pendingRef.current;
    const list = listRef.current;
    if (!pending || !list || pending.from === level) return;
    pendingRef.current = null;
    const date = pending.date ? nearestDate(model, pending.date) : null;
    const anchor = date ? anchorElementFor(list, date) : null;
    const labels: Record<ZoomLevel, string> = { trips: t`Years`, months: t`Months`, days: t`Days` };
    setAnnouncement(t`Zoom: ${labels[level]}`);
    void playZoom(pending.snapshot, list, anchor, prefersReducedMotion()).then(() => {
      zoomingRef.current = false;
      if (pending.keyboard && anchor) {
        const focusable =
          anchor.closest<HTMLElement>('a,button') ??
          anchor.closest<HTMLElement>('[data-row]')?.querySelector<HTMLElement>('a[href]:not([tabindex="-1"]),button');
        focusable?.focus({ preventScroll: true });
      }
    });
  }, [level]);

  // Safety net: a navigation that never lands (or an aborted one) must not block zooming.
  useEffect(() => {
    if (!zoomingRef.current) return;
    const id = setTimeout(() => {
      if (pendingRef.current) {
        pendingRef.current.snapshot.layer.remove();
        pendingRef.current = null;
      }
      zoomingRef.current = false;
    }, 1500);
    return () => clearTimeout(id);
  });

  const step = useCallback(
    (direction: 'in' | 'out', req: ZoomRequest = {}) => {
      const target = stepLevel(modelRef.current.level, direction);
      if (target) zoomTo(target, req);
      else bump(stageRef.current, direction);
    },
    [zoomTo],
  );

  // The overview levels are a lazy chunk: fetch it once the first screen is idle.
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1200));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const id = idle(() => void preloadOverviewRows(), { timeout: 4000 });
    return () => cancel(id);
  }, []);

  // ---- keyboard -----------------------------------------------------------------------------
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      const action = zoomKeyAction(e);
      if (!action) return;
      e.preventDefault();
      if (action.type === 'step') step(action.direction, { keyboard: true });
      else zoomTo(action.level, { keyboard: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, step, zoomTo]);

  // ---- pinch --------------------------------------------------------------------------------
  usePinchZoom(
    stageRef,
    {
      onPreview(scale, origin) {
        const stage = stageRef.current;
        if (!stage || zoomingRef.current) return;
        if (!stage.style.transform) {
          // Fix the origin at the gesture start (the rect below is still untransformed).
          const r = stage.getBoundingClientRect();
          stage.style.transformOrigin = `${origin.x - r.left}px ${origin.y - r.top}px`;
        }
        stage.style.transform = `scale(${scale})`;
      },
      onCommit(direction, origin, scale) {
        const target = stepLevel(modelRef.current.level, direction);
        if (target) zoomTo(target, { origin, scale });
        else settle(stageRef.current);
      },
      onCancel() {
        settle(stageRef.current);
      },
    },
    active,
  );

  // ---- "show in the timeline" from an overlay: focus that day once it is shown (W2-22) ---------
  useEffect(() => {
    const d = search.d;
    if (!active || !d || level !== 'days' || !takeDayFocus(d)) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row-date="${d}"]`);
    row?.querySelector<HTMLElement>('[data-day-cta]')?.focus({ preventScroll: true });
  });

  // ---- focus date -> URL (replace, debounced) -------------------------------------------------
  useEffect(() => {
    if (!active || listTop === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => {
      if (zoomingRef.current) return;
      const known = knownDRef.current;
      // Our own placement (zoom, deep link) is not the reader scrolling: the focus stays.
      if (unmovedSince(placedRef.current, known, window.scrollY)) return;
      const m = modelRef.current;
      const y = focusLineY(window.innerHeight);
      const atTop = window.scrollY < listTop / 2;
      const at = atTop ? null : anchorAt(m, window.scrollY + y - listTop);
      // Keep the current date while its row is still the one at the focus line (a week row or a
      // trip card stands for many dates; only leaving the row changes the focus).
      if (at && known && rowIndexForDate(m, known) === at.row) return;
      const date = at?.date;
      if (date === known) return;
      knownDRef.current = date;
      void navigate({
        to: '/$locale/',
        params: { locale },
        search: homeSearch(m.level, date),
        replace: true,
        resetScroll: false,
      });
    };
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(sync, FOCUS_SYNC_MS);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener('scroll', onScroll);
    };
  }, [active, listTop, locale, navigate]);

  const ctx = useMemo<TimelineContextValue>(
    () => ({ locale, level, latestDate: timeline.days.at(-1)?.date ?? null, zoomTo }),
    [locale, level, timeline, zoomTo],
  );

  const levelLabels: Record<ZoomLevel, string> = { trips: t`Years and trips`, months: t`Months`, days: t`Days` };

  return (
    <TimelineContext.Provider value={ctx}>
      <section
        aria-label={t`Timeline: ${levelLabels[level]}`}
        className="mx-auto max-w-[68rem] px-gutter sm:px-gutter-wide"
      >
        {/* The end of the list stays clear of the floating zoom pill (L3-08). */}
        <div ref={containerRef} className="pb-[calc(4.5rem+env(safe-area-inset-bottom))]">
          <div ref={stageRef} className="zoom-stage">
            {listTop !== null && (
              <LevelList
                key={listKey}
                model={model}
                scrollMargin={listTop}
                initialOffset={initialOffset}
                listRef={listRef}
                onPlaced={onPlaced}
              />
            )}
          </div>
        </div>
      </section>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      <ZoomPill level={level} onSelect={(z) => zoomTo(z)} disabled={!active} />
    </TimelineContext.Provider>
  );
}

// ---------------------------------------------------------------------------------------------
// Little tactile feedback

function settle(stage: HTMLElement | null): void {
  if (!stage) return;
  const from = stage.style.transform;
  stage.style.transform = '';
  if (!from || prefersReducedMotion()) return;
  stage.animate([{ transform: from }, { transform: 'none' }], {
    duration: 220,
    easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)',
  });
}

/** Rubber-band nudge when there is no level further in/out. */
function bump(stage: HTMLElement | null, direction: 'in' | 'out'): void {
  if (!stage || prefersReducedMotion()) return;
  const s = direction === 'in' ? 1.025 : 0.975;
  stage.style.transformOrigin = `50% ${focusLineY(window.innerHeight) - stage.getBoundingClientRect().top}px`;
  stage.animate([{ transform: 'none' }, { transform: `scale(${s})` }, { transform: 'none' }], {
    duration: 260,
    easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)',
  });
}

export function TimelineSkeleton() {
  return (
    <div aria-hidden="true" className="mx-auto max-w-[68rem] space-y-8 px-gutter pt-4 sm:px-gutter-wide">
      {[0, 1, 2].map((i) => (
        <div key={i} className="ps-14">
          <div className="skeleton h-5 w-40 rounded-pill" />
          <div className="skeleton mt-3 h-7 w-64 max-w-full rounded-pill" />
          <div className="mt-4 flex gap-3 overflow-hidden">
            {[0.75, 1.3, 0.8, 0.75].map((a, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
              <div key={j} className="skeleton h-[216px] shrink-0 rounded-tile" style={{ width: 216 * a }} />
            ))}
          </div>
        </div>
      ))}
      <span className="sr-only">
        <Trans>Loading…</Trans>
      </span>
    </div>
  );
}
