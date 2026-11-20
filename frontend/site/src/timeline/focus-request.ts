/**
 * "Focus this day once you show it": a one-shot request from an overlay that closes onto the
 * timeline at a given day (the trip page's "show in the timeline", W2-22). The timeline takes
 * it after it has placed (and rendered) that day and focuses the day row's link; overlays skip
 * their own focus restoration meanwhile. Requests expire, so a stale one never steals focus.
 */
const TTL_MS = 5_000;

let pending: { date: string; expires: number } | null = null;

export function requestDayFocus(date: string, now: number = Date.now()): void {
  pending = { date, expires: now + TTL_MS };
}

/** True (once) when a live request for `date` exists; drops expired requests. */
export function takeDayFocus(date: string, now: number = Date.now()): boolean {
  if (!pending) return false;
  if (now > pending.expires) {
    pending = null;
    return false;
  }
  if (pending.date !== date) return false;
  pending = null;
  return true;
}

/** Drops any pending request (tests). */
export function clearDayFocusRequest(): void {
  pending = null;
}
