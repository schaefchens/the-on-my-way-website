/**
 * Browser integrations of the player, all best effort (missing APIs are simply skipped):
 * Screen Wake Lock while playing, Media Session metadata/actions, page visibility,
 * scroll lock of the page behind the overlay.
 */
import { useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------------------------
// Wake Lock

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
}
interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/** Keeps the screen on while `active` (re-acquired after the tab becomes visible again). */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
    if (!active || !wakeLock) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let disposed = false;
    const acquire = () => {
      if (document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return;
      wakeLock.request('screen').then(
        (s) => {
          if (disposed) void s.release().catch(() => undefined);
          else sentinel = s;
        },
        () => undefined,
      );
    };
    acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', acquire);
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => undefined);
    };
  }, [active]);
}

// ---------------------------------------------------------------------------------------------
// Media Session

export interface MediaSessionInfo {
  title: string;
  artist: string;
  album: string;
  artwork: { src: string; sizes: string; type: string }[];
}

export interface MediaSessionHandlers {
  play(): void;
  pause(): void;
  next(): void;
  previous(): void;
}

const ACTIONS: [MediaSessionAction, keyof MediaSessionHandlers][] = [
  ['play', 'play'],
  ['pause', 'pause'],
  ['nexttrack', 'next'],
  ['previoustrack', 'previous'],
];

/** Lock-screen / headset controls; metadata names the day and the current moment. */
export function useMediaSession(info: MediaSessionInfo | null, playing: boolean, handlers: MediaSessionHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    for (const [action, key] of ACTIONS) {
      try {
        session.setActionHandler(action, () => handlersRef.current[key]());
      } catch {
        // Unsupported action in this browser.
      }
    }
    return () => {
      for (const [action] of ACTIONS) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // ignore
        }
      }
      session.metadata = null;
      session.playbackState = 'none';
    };
  }, []);

  // `info` is memoised by the caller, so this runs when the moment changes.
  useEffect(() => {
    if (!info || typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    if (typeof MediaMetadata === 'undefined') return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata(info);
    } catch {
      // Invalid artwork URL etc.
    }
  }, [info]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }, [playing]);
}

// ---------------------------------------------------------------------------------------------
// Visibility and scroll lock

/** Calls `onChange(hidden)` when the tab is hidden or shown again (and once on mount if hidden). */
export function usePageHidden(onChange: (hidden: boolean) => void): void {
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    const handler = () => ref.current(document.visibilityState === 'hidden');
    if (document.visibilityState === 'hidden') handler();
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);
}

/** Stops the page behind the overlay from scrolling while it is mounted. */
export function useScrollLock(): void {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = previous;
    };
  }, []);
}
