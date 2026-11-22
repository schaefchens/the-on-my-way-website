import { nativeModule } from './native';
import type { HapticConstant } from './types';

interface Native {
  perform(constant: HapticConstant): Promise<boolean>;
}

/** At most one effect per 100 ms (app-plan §5.3). */
export const HAPTIC_MIN_INTERVAL_MS = 100;

let enabled = true;
let suppressed = 0;
let lastAt = Number.NEGATIVE_INFINITY;

/** The in-app switch (Settings › Haptics), on top of the system "Touch feedback" setting. */
export function setHapticsEnabled(on: boolean): void {
  enabled = on;
}

export function hapticsEnabled(): boolean {
  return enabled;
}

/**
 * Silences haptics while something records (the microphone would hear the motor). Returns the
 * function that ends this suppression; suppressions nest.
 */
export function suppressHaptics(): () => void {
  suppressed += 1;
  let done = false;
  return () => {
    if (!done) {
      done = true;
      suppressed -= 1;
    }
  };
}

/**
 * Plays one of Android's haptic feedback constants for her own touch. Resolves false when nothing
 * was played (switched off, suppressed, throttled, no native module, or the system declined).
 * Never use it for background events (uploaded, Live ✓).
 */
export async function haptic(constant: HapticConstant, now: number = Date.now()): Promise<boolean> {
  if (!enabled || suppressed > 0 || now - lastAt < HAPTIC_MIN_INTERVAL_MS) return false;
  const native = nativeModule<Native>('OmwHaptics');
  if (!native) return false;
  lastAt = now;
  try {
    return await native.perform(constant);
  } catch {
    return false;
  }
}

/** Test hook: resets the throttle and switches. */
export function resetHapticsForTests(): void {
  enabled = true;
  suppressed = 0;
  lastAt = Number.NEGATIVE_INFINITY;
}
