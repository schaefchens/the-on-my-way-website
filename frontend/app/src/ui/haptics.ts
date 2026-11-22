/**
 * The haptics facade: one meaning per Android feedback constant (app-plan §5.3, ux.md §5). Screens
 * call `feedback.<moment>()` from her own touch handlers only, never for background events
 * (uploaded, Archived ✓, sync stay silent). The omw-native facade below adds the rules: at most
 * one effect per 100 ms, the in-app switch, silence while recording (suppressHaptics), and only
 * View.performHapticFeedback (no VIBRATE).
 */
import { type HapticConstant, haptic } from '../../modules/omw-native';

/** The map of moments to constants: the single source for the whole app (unit-tested). */
export const HAPTIC_MOMENTS = {
  /** Shutter tap (the photo is being saved). */
  shutter: 'VIRTUAL_KEY',
  /** Holding reached video, fired before the recorder starts. */
  holdToRecord: 'LONG_PRESS',
  /** Recording stopped or hit 60 s, fired after the recorder stopped; voice cancelled. */
  recordEnd: 'GESTURE_END',
  /** Discrete steps: mode rail, zoom stop, font/colour step, publish option, day chip. */
  step: 'SEGMENT_TICK',
  /** Continuous sliders crossing a mark (trim scrub stops). */
  slide: 'SEGMENT_FREQUENT_TICK',
  /** "Release now and it happens": trim end at 60 s, voice cancel line. */
  threshold: 'GESTURE_THRESHOLD_ACTIVATE',
  /** Moved back out of a threshold. */
  thresholdBack: 'GESTURE_THRESHOLD_DEACTIVATE',
  /** A drag started (sheet handle). */
  dragStart: 'DRAG_START',
  /** Shared: the moment is safely in the outbox. Also: pairing succeeded. */
  confirm: 'CONFIRM',
  /** Something she started failed (expired code, a retry failed); confirmed deletes. */
  reject: 'REJECT',
  /** Undo. */
  undo: 'CLOCK_TICK',
  toggleOn: 'TOGGLE_ON',
  toggleOff: 'TOGGLE_OFF',
} as const satisfies Record<string, HapticConstant>;

export type HapticMoment = keyof typeof HAPTIC_MOMENTS;

function play(moment: HapticMoment): void {
  void haptic(HAPTIC_MOMENTS[moment]);
}

export const feedback = {
  shutter: () => play('shutter'),
  holdToRecord: () => play('holdToRecord'),
  recordEnd: () => play('recordEnd'),
  step: () => play('step'),
  slide: () => play('slide'),
  threshold: () => play('threshold'),
  thresholdBack: () => play('thresholdBack'),
  dragStart: () => play('dragStart'),
  confirm: () => play('confirm'),
  reject: () => play('reject'),
  undo: () => play('undo'),
  toggle: (on: boolean) => play(on ? 'toggleOn' : 'toggleOff'),
} as const;
