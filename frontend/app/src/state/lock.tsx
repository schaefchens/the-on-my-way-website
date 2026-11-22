/**
 * App lock (expo-local-authentication, the system prompt: fingerprint, face or the phone's PIN).
 * It protects sharing, the queue and Settings; capture and drafts always work, so a moment is never
 * lost to a lock screen (ux.md §3.14). After a cold start, and after the chosen time in the
 * background (immediately, 1 min, 5 min), the next protected action asks once.
 *
 * Without a screen lock on the phone there is nothing to ask with: the lock stays open and
 * Settings says so.
 */
import { useLingui } from '@lingui/react/macro';
import * as LocalAuthentication from 'expo-local-authentication';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useAppSettings } from './app-settings';

export type LockAvailability = 'unknown' | 'ready' | 'no_screen_lock';

/** Pure rule (unit-tested): must the next protected action ask? */
export function lockDue(input: {
  enabled: boolean;
  available: boolean;
  unlockedOnce: boolean;
  backgroundSince: number | null;
  afterSeconds: number;
  now: number;
}): boolean {
  if (!input.enabled || !input.available) return false;
  if (!input.unlockedOnce) return true;
  if (input.backgroundSince === null) return false;
  return input.now - input.backgroundSince >= input.afterSeconds * 1000;
}

interface Ctx {
  availability: LockAvailability;
  /** Resolves true when the action may go on (unlocked now or not needed). */
  requireUnlock(reason?: string): Promise<boolean>;
}

const LockContext = createContext<Ctx>({ availability: 'unknown', requireUnlock: async () => true });

export function LockProvider({ children }: { children: ReactNode }) {
  const { t } = useLingui();
  const { settings } = useAppSettings();
  const [availability, setAvailability] = useState<LockAvailability>('unknown');
  const unlockedOnce = useRef(false);
  const backgroundSince = useRef<number | null>(null);
  const due = useRef(false);

  useEffect(() => {
    let alive = true;
    const probe = async () => {
      try {
        const level = await LocalAuthentication.getEnrolledLevelAsync();
        if (alive) setAvailability(level === LocalAuthentication.SecurityLevel.NONE ? 'no_screen_lock' : 'ready');
      } catch {
        if (alive) setAvailability('no_screen_lock');
      }
    };
    void probe();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') backgroundSince.current = Date.now();
      if (state === 'active') {
        due.current =
          due.current ||
          lockDue({
            enabled: true,
            available: true,
            unlockedOnce: unlockedOnce.current,
            backgroundSince: backgroundSince.current,
            afterSeconds: settings.lock.afterSeconds,
            now: Date.now(),
          });
        backgroundSince.current = null;
        void probe();
      }
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, [settings.lock.afterSeconds]);

  const requireUnlock = useCallback(
    async (reason?: string) => {
      const needed = settings.lock.enabled && availability === 'ready' && (!unlockedOnce.current || due.current);
      if (!needed) return true;
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: reason ?? t`Unlock On My Way`,
        cancelLabel: t`Not now`,
        disableDeviceFallback: false,
      });
      if (result.success) {
        unlockedOnce.current = true;
        due.current = false;
      }
      return result.success;
    },
    [availability, settings.lock.enabled, t],
  );

  const value = useMemo(() => ({ availability, requireUnlock }), [availability, requireUnlock]);
  return <LockContext.Provider value={value}>{children}</LockContext.Provider>;
}

export function useLock(): Ctx {
  return useContext(LockContext);
}
