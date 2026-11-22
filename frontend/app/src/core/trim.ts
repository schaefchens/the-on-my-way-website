/**
 * The video trim window (≤ 60 s, WhatsApp's status limit; APP_LIMITS.videoSeconds). Framework-free:
 * the trim UI and the export request both go through it.
 */
import { APP_LIMITS } from '@omw/contracts/app';

export const MAX_CLIP_MS = APP_LIMITS.videoSeconds * 1000;
/** Shortest clip she can cut (anything shorter is a mis-tap). */
export const MIN_CLIP_MS = 1000;

export interface TrimWindow {
  startMs: number;
  endMs: number;
}

/** The first 60 s ("Choose the best 60 seconds"), or the whole clip. */
export function initialTrim(durationMs: number): TrimWindow {
  return { startMs: 0, endMs: Math.min(Math.max(0, Math.round(durationMs)), MAX_CLIP_MS) };
}

/**
 * Moves one handle and keeps the window valid: inside the clip, at least MIN_CLIP_MS, at most
 * MAX_CLIP_MS (the other handle stays put; the moved one stops at the limit). `atLimit` is true
 * when the 60 s limit stopped the handle (the GESTURE_THRESHOLD_ACTIVATE moment).
 */
export function moveHandle(
  window: TrimWindow,
  handle: 'start' | 'end',
  toMs: number,
  durationMs: number,
): TrimWindow & { atLimit: boolean } {
  const duration = Math.max(0, Math.round(durationMs));
  const minLen = Math.min(MIN_CLIP_MS, duration);
  let { startMs, endMs } = window;
  let atLimit = false;
  if (handle === 'start') {
    startMs = Math.round(Math.min(Math.max(0, toMs), endMs - minLen));
    if (endMs - startMs > MAX_CLIP_MS) {
      startMs = endMs - MAX_CLIP_MS;
      atLimit = true;
    }
  } else {
    endMs = Math.round(Math.max(Math.min(duration, toMs), startMs + minLen));
    if (endMs - startMs > MAX_CLIP_MS) {
      endMs = startMs + MAX_CLIP_MS;
      atLimit = true;
    }
  }
  return { startMs, endMs, atLimit };
}

/** The export parameters: undefined when nothing is cut (no clipping config at all). */
export function trimForExport(window: TrimWindow, durationMs: number): { trimStartMs?: number; trimEndMs?: number } {
  const cutStart = window.startMs > 0;
  const cutEnd = window.endMs < Math.round(durationMs);
  return {
    ...(cutStart ? { trimStartMs: window.startMs } : {}),
    ...(cutEnd ? { trimEndMs: window.endMs } : {}),
  };
}

export function clipLengthMs(window: TrimWindow): number {
  return window.endMs - window.startMs;
}
