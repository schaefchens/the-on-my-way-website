/**
 * Zoom transition between two levels (plan C, "Zoom mechanics"):
 *
 * 1. capture: before the level changes, the visible part of the old list is cloned into a fixed,
 *    inert "ghost" layer (an exact snapshot, including any pinch preview transform).
 * 2. The new level mounts at the anchored scroll offset (computed from the row model).
 * 3. play: the ghost fades and scales away around the pointer while the new list fades and
 *    scales in around the same point; the anchor item morphs from its old box to its new one,
 *    above both layers, as a crossfade of two clones that each keep their own shape (uniform
 *    scale, clipped to their own rounded corners): the old one (a trip collage, a square tile)
 *    flies into the new box and fades out, the new one (a round avatar, a tile) grows in place.
 *    No stretched rectangles, no corners popping at the end, no disc sweeping over a title
 *    (L3-06).
 *
 * This is the shared-element ("layoutId") morph done by hand: Motion's layout projection
 * assumes the scroll position does not change between snapshot and layout, while zoom anchoring
 * changes it in the same commit. Plain WAAPI also keeps Motion's layout features out of the
 * bundle. Reduced motion: no animation at all.
 */
import type { Point } from './pinch-math';
import type { ZoomDirection } from './search';

export const ZOOM_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';
export const ZOOM_DURATION_MS = 340;
/** The incoming morph shape grows into place from this scale. */
const INCOMING_START_SCALE = 0.6;
/** How much the outgoing level grows (zoom in) or shrinks (zoom out) while it fades. */
const GHOST_SCALE = { in: 1.16, out: 0.88 } as const;

// ---------------------------------------------------------------------------------------------
// Anchor elements: [data-anchor="YYYY-MM-DD"] or [data-anchor-range="from..to"]

export function anchorElementFor(root: ParentNode, date: string): HTMLElement | null {
  let best: HTMLElement | null = null;
  for (const el of root.querySelectorAll<HTMLElement>('[data-anchor],[data-anchor-range]')) {
    const single = el.dataset.anchor;
    if (single !== undefined) {
      if (single === date) return el;
      continue;
    }
    const [from, to] = (el.dataset.anchorRange ?? '').split('..');
    if (from && to && from <= date && date <= to) best ??= el;
  }
  return best;
}

/**
 * The date an anchor element stands for: its own date, or for a range (trip and loose cards)
 * `prefer` when the range contains it (the focused date stays put), else the newest of the range.
 */
export function anchorDateOf(el: Element | null, prefer?: string | null): string | null {
  const anchor = el?.closest<HTMLElement>('[data-anchor],[data-anchor-range]');
  if (!anchor) return null;
  if (anchor.dataset.anchor !== undefined) return anchor.dataset.anchor;
  const [from, to] = (anchor.dataset.anchorRange ?? '').split('..');
  if (!from || !to) return null;
  return prefer && from <= prefer && prefer <= to ? prefer : to;
}

/** Whether an element's box is (at least partly) inside the viewport. */
export function isInViewport(el: Element | null): boolean {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
}

// ---------------------------------------------------------------------------------------------
// Capture

/** Corner radii in px: top-left, top-right, bottom-right, bottom-left (physical). */
export type Radii = readonly [number, number, number, number];

const CORNERS = [
  ['borderTopLeftRadius', 'top', 'left'],
  ['borderTopRightRadius', 'top', 'right'],
  ['borderBottomRightRadius', 'bottom', 'right'],
  ['borderBottomLeftRadius', 'bottom', 'left'],
] as const;

/**
 * The rounded shape an element is SEEN with: anchors are often plain boxes inside a clipping
 * parent (a round avatar link, a rounded tile, a card). Per corner, the nearest of the element
 * and its ancestors (up to 3 levels) whose corner sits where the element's does and is rounded.
 */
export function visibleRadii(el: Element): Radii {
  const box = el.getBoundingClientRect();
  const limit = Math.min(box.width, box.height) / 2;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  CORNERS.forEach(([prop, v, h], i) => {
    let node: Element | null = el;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const r = node.getBoundingClientRect();
      if (Math.abs(r[v] - box[v]) > 1.5 || Math.abs(r[h] - box[h]) > 1.5) break;
      const style = getComputedStyle(node);
      const radius = Number.parseFloat(style[prop]) || 0;
      const clips = node === el || style.overflow !== 'visible';
      if (radius > 0 && clips) {
        out[i] = Math.min(radius, limit);
        break;
      }
    }
  });
  return out;
}

function roundedClip(radii: Radii): string {
  return `inset(0 round ${radii.map((r) => `${r.toFixed(1)}px`).join(' ')})`;
}

export interface ZoomSnapshot {
  layer: HTMLElement;
  /** Box of the anchor item before the change (viewport coordinates). */
  anchorRect: DOMRect | null;
  /** Its visible corner radii. */
  anchorRadii: Radii;
  /** The clone of the old anchor (hidden while the morph runs). */
  ghostAnchor: HTMLElement | null;
  origin: Point;
  direction: ZoomDirection;
  /** Scale of a pinch preview that was showing at capture time (1 otherwise). */
  scale: number;
}

/**
 * Deep clone that carries every inline style over through the CSSOM. Generated pages ship a CSP
 * without 'unsafe-inline' for styles; engines may drop copied style *attributes* under it, while
 * CSSOM writes are always allowed. (The trees are identical, so a parallel walk pairs them.)
 */
export function cloneWithStyles<T extends Element>(source: T): T {
  const clone = source.cloneNode(true) as T;
  const from = document.createTreeWalker(source, NodeFilter.SHOW_ELEMENT);
  const to = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
  let a: Node | null = from.currentNode;
  let b: Node | null = to.currentNode;
  while (a && b) {
    const css = (a as HTMLElement | SVGElement).style?.cssText;
    if (css) (b as HTMLElement | SVGElement).style.cssText = css;
    a = from.nextNode();
    b = to.nextNode();
  }
  return clone;
}

let running: { finish: () => void } | null = null;
let pendingLayers: HTMLElement[] = [];

/** Ends a running transition immediately (a new zoom started). */
export function finishRunningZoom(): void {
  running?.finish();
  running = null;
  for (const layer of pendingLayers) layer.remove();
  pendingLayers = [];
}

export function captureZoom(
  list: HTMLElement,
  opts: { anchorDate: string | null; origin: Point; direction: ZoomDirection; scale: number },
): ZoomSnapshot {
  finishRunningZoom();
  const rect = list.getBoundingClientRect();
  const anchor = opts.anchorDate ? anchorElementFor(list, opts.anchorDate) : null;
  const anchorRect = anchor?.getBoundingClientRect() ?? null;
  const anchorRadii: Radii = anchor ? visibleRadii(anchor) : [0, 0, 0, 0];

  const clone = cloneWithStyles(list);
  // Sticky headers sit wherever they are stuck right now; the clone does not scroll, so pin them
  // there with a relative offset (they are always the first box of their row).
  const stickies = list.querySelectorAll<HTMLElement>('[data-sticky]');
  const cloneStickies = clone.querySelectorAll<HTMLElement>('[data-sticky]');
  stickies.forEach((el, i) => {
    const row = el.parentElement;
    const target = cloneStickies[i];
    if (!row || !target) return;
    const delta = el.getBoundingClientRect().top - row.getBoundingClientRect().top;
    target.style.position = 'relative';
    target.style.top = `${Math.round(delta)}px`;
  });
  // Filmstrips keep their horizontal scroll position.
  const strips = list.querySelectorAll<HTMLElement>('[data-strip]');
  const cloneStrips = clone.querySelectorAll<HTMLElement>('[data-strip]');
  for (const el of clone.querySelectorAll('[id]')) el.removeAttribute('id');
  clone.removeAttribute('id');
  clone.setAttribute('aria-hidden', 'true');
  clone.inert = true;
  Object.assign(clone.style, {
    position: 'absolute',
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
  });

  const layer = document.createElement('div');
  layer.dataset.zoomGhost = '';
  layer.setAttribute('aria-hidden', 'true');
  Object.assign(layer.style, {
    position: 'fixed',
    inset: '0',
    overflow: 'hidden',
    pointerEvents: 'none',
    zIndex: '15',
    transformOrigin: `${opts.origin.x}px ${opts.origin.y}px`,
    transform: opts.scale !== 1 ? `scale(${opts.scale})` : '',
  });
  layer.append(clone);
  document.body.append(layer);
  strips.forEach((el, i) => {
    const target = cloneStrips[i];
    if (target) target.scrollLeft = el.scrollLeft;
  });
  pendingLayers.push(layer);

  const ghostAnchor = anchor ? (anchorElementFor(clone, opts.anchorDate ?? '') ?? null) : null;
  return {
    layer,
    anchorRect,
    anchorRadii,
    ghostAnchor,
    origin: opts.origin,
    direction: opts.direction,
    scale: opts.scale,
  };
}

/** Drops a snapshot without animating (zoom aborted or reduced motion). */
export function discardZoom(snapshot: ZoomSnapshot): void {
  snapshot.layer.remove();
  pendingLayers = pendingLayers.filter((l) => l !== snapshot.layer);
}

// ---------------------------------------------------------------------------------------------
// Play

export function playZoom(
  snapshot: ZoomSnapshot,
  list: HTMLElement,
  anchor: HTMLElement | null,
  reducedMotion: boolean,
): Promise<void> {
  if (reducedMotion || typeof list.animate !== 'function') {
    discardZoom(snapshot);
    return Promise.resolve();
  }
  const k = GHOST_SCALE[snapshot.direction];
  const timing: KeyframeAnimationOptions = { duration: ZOOM_DURATION_MS, easing: ZOOM_EASING };
  const animations: Animation[] = [];
  const cleanups: Array<() => void> = [];

  // Outgoing level.
  animations.push(
    snapshot.layer.animate(
      [
        { opacity: 1, transform: `scale(${snapshot.scale})` },
        { opacity: 0, transform: `scale(${snapshot.scale * k})` },
      ],
      { ...timing, fill: 'forwards' },
    ),
  );

  // Anchor morph: two clones crossfade while flying from the old box to the new one.
  const newRect = anchor?.getBoundingClientRect() ?? null;
  const old = snapshot.anchorRect;
  if (anchor && newRect && old && newRect.width > 0 && newRect.height > 0 && old.width > 0 && old.height > 0) {
    const flight = { ...timing, duration: ZOOM_DURATION_MS + 60, fill: 'forwards' as const };
    const cx = (r: DOMRect) => r.left + r.width / 2;
    const cy = (r: DOMRect) => r.top + r.height / 2;
    /** Uniform scale s (origin top left) that centres box `from` (size × s) on box `to`. */
    const placeOn = (from: DOMRect, to: DOMRect, s: number) =>
      `translate(${(cx(to) - from.left - (from.width * s) / 2).toFixed(2)}px, ${(cy(to) - from.top - (from.height * s) / 2).toFixed(2)}px) scale(${s.toFixed(4)})`;
    // "Contain": the old shape always fits inside the box it flies to, never stretched.
    const outScale = Math.min(newRect.width / old.width, newRect.height / old.height);

    const flyers: HTMLElement[] = [];
    const makeFlyer = (source: HTMLElement, rect: DOMRect, radii: Radii) => {
      const flyer = cloneWithStyles(source);
      for (const el of flyer.querySelectorAll('[id]')) el.removeAttribute('id');
      flyer.removeAttribute('id');
      flyer.setAttribute('aria-hidden', 'true');
      flyer.inert = true;
      Object.assign(flyer.style, {
        position: 'fixed',
        top: `${rect.top}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        margin: '0',
        zIndex: '16',
        pointerEvents: 'none',
        transformOrigin: '0 0',
        clipPath: roundedClip(radii),
        visibility: 'visible',
      });
      document.body.append(flyer);
      flyers.push(flyer);
      return flyer;
    };

    // The old shape flies into the new box (uniform scale, its own corners) and fades out.
    if (snapshot.ghostAnchor) {
      const outgoing = makeFlyer(snapshot.ghostAnchor, old, snapshot.anchorRadii);
      animations.push(
        outgoing.animate(
          [
            { transform: 'none', opacity: 1 },
            { opacity: 0, offset: 0.7 },
            { transform: placeOn(old, newRect, outScale), opacity: 0 },
          ],
          flight,
        ),
      );
      snapshot.ghostAnchor.style.visibility = 'hidden';
    }
    // The new shape materialises in place: it never sweeps across its neighbours (a day title
    // right beside a landing avatar stays readable all along).
    const incoming = makeFlyer(anchor, newRect, visibleRadii(anchor));
    incoming.style.transformOrigin = '50% 50%';
    animations.push(
      incoming.animate(
        [
          { transform: `scale(${INCOMING_START_SCALE})`, opacity: 0 },
          { opacity: 1, offset: 0.5 },
          { transform: 'none', opacity: 1 },
        ],
        flight,
      ),
    );
    const prevVisibility = anchor.style.visibility;
    anchor.style.visibility = 'hidden';
    cleanups.push(() => {
      for (const f of flyers) f.remove();
      anchor.style.visibility = prevVisibility;
    });
  }

  // Incoming level.
  const rect = list.getBoundingClientRect();
  const origin = `${Math.round(snapshot.origin.x - rect.left)}px ${Math.round(snapshot.origin.y - rect.top)}px`;
  list.style.transformOrigin = origin;
  animations.push(
    list.animate(
      [
        { opacity: 0, transform: `scale(${1 / k})` },
        { opacity: 1, transform: 'none' },
      ],
      timing,
    ),
  );
  cleanups.push(() => {
    list.style.transformOrigin = '';
  });

  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      for (const a of animations) a.cancel();
      for (const c of cleanups) c();
      discardZoom(snapshot);
      if (running?.finish === finish) running = null;
      resolve();
    };
    running = { finish };
    Promise.all(animations.map((a) => a.finished)).then(finish, finish);
  });
}
