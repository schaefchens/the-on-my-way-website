/**
 * Focus management for modal dialogs (player, story sheet): Tab/Shift+Tab cycle inside the
 * container, focus moves into it on open and returns to the opener on close.
 */
import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'audio[controls]',
  'video[controls]',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

function isVisible(el: HTMLElement): boolean {
  if (el.closest('[inert]')) return false;
  // checkVisibility is widely available; fall back to layout boxes.
  const check = (el as HTMLElement & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof check === 'function') return check.call(el, { visibilityProperty: true });
  return el.getClientRects().length > 0;
}

export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isVisible);
}

export interface FocusTrapOptions {
  /** Trap only while active (e.g. not while a nested sheet is open). */
  active: boolean;
  /** Element to focus on open; defaults to the container itself (needs tabIndex={-1}). */
  initialFocus?: () => HTMLElement | null;
  /**
   * Give focus back to the opener on unmount (default true). The player and the story sheet
   * turn it off: they are lazy chunks that mount after the opener has lost focus, so their
   * routes restore focus instead (restore-focus.ts).
   */
  restoreFocus?: boolean;
}

export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  { active, initialFocus, restoreFocus = true }: FocusTrapOptions,
): void {
  const initialRef = useRef(initialFocus);
  initialRef.current = initialFocus;
  const openerRef = useRef<HTMLElement | null>(null);
  const restoreRef = useRef(restoreFocus);
  restoreRef.current = restoreFocus;

  // Remember the opener once, restore it when the dialog unmounts (after `inert` is lifted
  // from the page behind it, hence a passive effect plus a frame).
  useEffect(() => {
    const container = ref.current;
    const active = document.activeElement;
    // Only an element outside the dialog is an opener (StrictMode re-runs keep the first one).
    if (active instanceof HTMLElement && active !== document.body && !container?.contains(active)) {
      openerRef.current = active;
    }
    if (container && !container.contains(document.activeElement)) {
      const target = initialRef.current?.() ?? container;
      target.focus({ preventScroll: true });
    }
    return () => {
      const opener = openerRef.current;
      if (!opener || !restoreRef.current) return;
      requestAnimationFrame(() => {
        const stillOpen = container?.isConnected === true;
        if (!stillOpen && opener.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
      });
    };
  }, [ref]);

  useEffect(() => {
    const container = ref.current;
    if (!active || !container) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = focusableWithin(container);
      if (items.length === 0) {
        e.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const current = document.activeElement;
      if (e.shiftKey && (current === first || current === container || !container.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !container.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    // Focus escaping by other means (clicks outside, programmatic) is pulled back in.
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof Node && !container.contains(e.target)) {
        const target = e.target instanceof Element ? e.target : null;
        // Nested dialogs (the story sheet) manage their own focus.
        if (target?.closest('[role="dialog"]')) return;
        container.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [ref, active]);
}
