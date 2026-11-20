/**
 * Motion presets (plan C, "Design system"): springs soft (0.35 s, bounce 0.15), snappy (0.2 s)
 * and float (0.8 s). Durations are Motion's `visualDuration`: the time the animation takes to
 * visually reach its target; the remaining settle ("bouncy bit") happens after it.
 *
 * Wrap the app in <MotionConfig {...MOTION_CONFIG}> so reduced-motion users get instant
 * transforms; the app must also switch off Ken Burns, route drawing and autoplay then.
 */
import type { Transition } from 'motion/react';

export const SPRINGS = {
  /** Default for cards, sheets and layout morphs. */
  soft: { type: 'spring', visualDuration: 0.35, bounce: 0.15 },
  /** Small, direct feedback: toggles, pills, progress jumps. */
  snappy: { type: 'spring', visualDuration: 0.2, bounce: 0 },
  /** Slow ambient movement: floating chips, the paper plane. */
  float: { type: 'spring', visualDuration: 0.8, bounce: 0.1 },
} as const satisfies Record<string, Transition>;
export type SpringName = keyof typeof SPRINGS;

/** Tween used instead of springs when the user prefers reduced motion. */
export const REDUCED_TRANSITION = { type: 'tween', duration: 0 } as const satisfies Transition;

/** Crossfade for zoom-level changes and route overlays. */
export const CROSSFADE = { type: 'tween', duration: 0.24, ease: [0.22, 1, 0.36, 1] } as const satisfies Transition;

/** Props for <MotionConfig>. */
export const MOTION_CONFIG = { reducedMotion: 'user' } as const;

/** Pinch preview limits and the commit threshold of the semantic zoom (plan C, "Zoom mechanics"). */
export const ZOOM_GESTURE = { minScale: 0.85, maxScale: 1.2, commitLogScale: 0.18 } as const;

/** True when the OS asks for reduced motion (false outside the browser). */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}
