/**
 * Focus restoration for the overlay routes (journey player, story sheet).
 *
 * The opener (the timeline link, the "Read the story" button) is captured in a LAYOUT effect of
 * the route component, i.e. in the commit that also makes the page behind `inert`, before the
 * browser's focus fixup moves focus off the now-inert opener. The dialogs themselves are lazy
 * chunks that mount later (after a Suspense fallback), when focus already sits on <body>, so
 * they cannot record the opener. On unmount the opener (or a better target) gets focus back one
 * frame later, once the overlay's `inert` has been lifted.
 *
 * Tiny and dependency-free on purpose: it lives in the main chunk (routes/day.tsx, story.tsx).
 */
import { useLayoutEffect, useRef } from 'react';

export interface RestoreFocusOptions {
  /** Preferred target at close time, e.g. the timeline link of the day that was watched last. */
  preferred?: () => HTMLElement | null;
  /** Used when neither the preferred target nor the opener can take focus. */
  fallback?: () => HTMLElement | null;
  /**
   * Read at close time: someone else places focus (e.g. the timeline focuses the day a trip's
   * "show in the timeline" went to, once it has rendered it), so nothing is restored.
   */
  skip?: () => boolean;
}

/** Connected, not inside an inert subtree, and not <body>. */
export function canTakeFocus(el: Element | null | undefined): el is HTMLElement {
  if (!el || typeof (el as HTMLElement).focus !== 'function') return false;
  return el !== el.ownerDocument?.body && el.isConnected && !el.closest('[inert]');
}

/**
 * Picks the element that should get focus back: none when focus already sits on a live element
 * (something moved it on purpose), else the first of preferred, opener, fallback that can take it.
 */
export function restoreTarget(
  current: Element | null,
  candidates: readonly (HTMLElement | null | undefined)[],
): HTMLElement | null {
  if (canTakeFocus(current)) return null;
  return candidates.find(canTakeFocus) ?? null;
}

export function useRestoreFocus(options: RestoreFocusOptions = {}): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useLayoutEffect(() => {
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    return () => {
      if (optionsRef.current.skip?.()) return;
      requestAnimationFrame(() => {
        const { preferred, fallback } = optionsRef.current;
        const target = restoreTarget(document.activeElement, [preferred?.(), opener, fallback?.()]);
        target?.focus({ preventScroll: true });
      });
    };
  }, []);
}
