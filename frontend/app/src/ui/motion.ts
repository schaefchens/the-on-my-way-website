/**
 * Motion tokens (app-plan §5.2, ux.md §4): the site's springs as Reanimated physics with mass 1
 * (from the token snapshot), the 240 ms crossfade, and the reduced-motion rule: spatial movement
 * becomes a ≤ 120 ms fade. Only transform and opacity animate, on the UI thread.
 */
import { Easing, ReduceMotion, type WithSpringConfig, type WithTimingConfig } from 'react-native-reanimated';
import tokens from '../theme/tokens.generated.json';

type SpringName = keyof typeof tokens.springs;

function spring(name: SpringName): WithSpringConfig {
  const { stiffness, damping, mass } = tokens.springs[name];
  return { stiffness, damping, mass, reduceMotion: ReduceMotion.System };
}

/** soft: sheets, cards, morphs · snappy: toggles, chips, press · float: the send flight. */
export const SPRINGS = {
  soft: spring('soft'),
  snappy: spring('snappy'),
  float: spring('float'),
} as const;

/** --ease-soft of the site. */
export const EASE_SOFT = Easing.bezier(0.22, 1, 0.36, 1);

export const CROSSFADE: WithTimingConfig = { duration: 240, easing: EASE_SOFT };
/** What every spatial movement becomes with "Remove animations" on. */
export const REDUCED_FADE: WithTimingConfig = { duration: 120, easing: Easing.linear };
/** Viewfinder dim on the shot (no white flash). */
export const SHUTTER_DIM = { in: 90, out: 160, opacity: 0.85 } as const;
