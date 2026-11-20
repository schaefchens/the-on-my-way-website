/**
 * Toasts and undo snackbars. Messages are Lingui descriptors (translated when rendered) or plain
 * strings. Created from React and non-React code (mutation callbacks).
 *
 * Rules (a phone screen is small):
 * - at most one status toast (success / info): a new one replaces the previous one;
 * - at most one undo snackbar: a new action replaces the previous offer;
 * - at most two errors;
 * - a route change clears every toast except the undo offer, unless the toast was created right
 *   before (it belongs to the action that navigated, e.g. "Published" after the composer);
 * - a saved write first says "Saved – sending…" and turns into its confirmation once the server
 *   answered (notifyWrite / settleWriteNotice), instead of claiming success up front.
 */
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { createStore } from './store';

export type NoticeTone = 'info' | 'success' | 'error' | 'undo';

export interface Notice {
  id: number;
  tone: NoticeTone;
  message: MessageDescriptor | string;
  /** Values for the descriptor's placeholders. */
  values?: Record<string, unknown>;
  action?: { label: MessageDescriptor; run: () => void };
  /** Technical text behind a "Details" disclosure (errors). */
  detail?: string;
  /** Auto-dismiss after this many ms (0 = stays until dismissed). */
  timeoutMs: number;
  /** Creation time (ms). */
  at: number;
  /** Entity ("day:2026-11-20") whose write turns this "sending" toast into `confirmed`. */
  waitFor?: string;
  confirmed?: MessageDescriptor;
}

export const noticeStore = createStore<Notice[]>([]);

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/** A toast younger than this survives the route change it caused. */
export const NAVIGATION_GRACE_MS = 1500;
/** A "sending…" toast gives up after this long without an answer (the write stays queued). */
const WAIT_MAX_MS = 20_000;
const MAX_ERRORS = 2;

export function defaultTimeout(tone: NoticeTone): number {
  return tone === 'error' ? 8000 : tone === 'undo' ? 6000 : 3500;
}

function schedule(id: number, ms: number): void {
  const old = timers.get(id);
  if (old) clearTimeout(old);
  timers.delete(id);
  if (ms > 0)
    timers.set(
      id,
      setTimeout(() => dismissNotice(id), ms),
    );
}

export function dismissNotice(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  noticeStore.set((list) => (list.some((n) => n.id === id) ? list.filter((n) => n.id !== id) : list));
}

const isStatus = (tone: NoticeTone) => tone === 'success' || tone === 'info';

export function notify(
  notice: Omit<Notice, 'id' | 'timeoutMs' | 'at'> & { timeoutMs?: number },
  now: number = Date.now(),
): number {
  const id = nextId++;
  const timeoutMs = notice.timeoutMs ?? defaultTimeout(notice.tone);
  const replaced: number[] = [];
  noticeStore.set((list) => {
    const errors = list.filter((n) => n.tone === 'error');
    // A new error keeps only the newest MAX_ERRORS - 1 older ones.
    const oldErrors = new Set(
      notice.tone === 'error' ? errors.slice(0, Math.max(0, errors.length - (MAX_ERRORS - 1))) : [],
    );
    const kept = list.filter((n) => {
      const drop =
        (isStatus(notice.tone) && isStatus(n.tone)) ||
        (notice.tone === 'undo' && n.tone === 'undo') ||
        oldErrors.has(n);
      if (drop) replaced.push(n.id);
      return !drop;
    });
    return [...kept, { ...notice, id, timeoutMs, at: now }];
  });
  for (const r of replaced) schedule(r, 0);
  schedule(id, timeoutMs);
  return id;
}

/**
 * Toast for a write that was just queued: offline it says it is kept on this device; online
 * "Saved – sending…" until the server confirms the write of `entity`, then `done`.
 */
export function notifyWrite(entity: string, done: MessageDescriptor, online: boolean): number {
  if (!online) return notify({ tone: 'success', message: msg`Saved on this device, sent when you are online` });
  return notify({
    tone: 'info',
    message: msg`Saved – sending…`,
    waitFor: entity,
    confirmed: done,
    timeoutMs: WAIT_MAX_MS,
  });
}

/** The write of `entity` settled: confirm its "sending…" toast, or drop it (failure, conflict). */
export function settleWriteNotice(entity: string, ok: boolean): void {
  const waiting = noticeStore.get().filter((n) => n.waitFor === entity);
  if (waiting.length === 0) return;
  for (const n of waiting) {
    if (!ok) {
      dismissNotice(n.id);
      continue;
    }
    noticeStore.set((list) =>
      list.map((x) =>
        x.id === n.id
          ? {
              ...x,
              tone: 'success' as const,
              message: x.confirmed ?? x.message,
              timeoutMs: defaultTimeout('success'),
              waitFor: undefined,
              confirmed: undefined,
            }
          : x,
      ),
    );
    schedule(n.id, defaultTimeout('success'));
  }
}

/** Route change: everything but the undo offer goes, except toasts the navigation itself caused. */
export function clearNoticesOnNavigation(now: number = Date.now()): void {
  for (const n of noticeStore.get()) {
    if (n.tone === 'undo' || n.waitFor || now - n.at < NAVIGATION_GRACE_MS) continue;
    dismissNotice(n.id);
  }
}

/** Pauses auto-dismiss while the pointer/focus/finger is on a notice (WCAG 2.2.1). */
export function holdNotice(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

export function releaseNotice(id: number, ms = 3000): void {
  if (!noticeStore.get().some((n) => n.id === id) || timers.has(id)) return;
  timers.set(
    id,
    setTimeout(() => dismissNotice(id), ms),
  );
}
