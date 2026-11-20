/**
 * Service worker registration (production builds only) with a prompt-style update: a new
 * version waits until the owner taps "Reload" (queued writes are persisted, so reloading is
 * always safe). Also the install offer: Chromium's beforeinstallprompt is kept for our own
 * "Install as an app" card; iOS has no such event (the card explains Share -> Add to Home Screen).
 */
import { createStore } from './lib/store';

/** Set when a new version is waiting; calling it activates the new worker and reloads. */
export const updateStore = createStore<(() => Promise<void>) | null>(null);

/** Chromium's install prompt (not in the TS DOM lib). */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** The deferred install prompt (null: none offered, or already used / installed). */
export const installPromptStore = createStore<BeforeInstallPromptEvent | null>(null);

/** Started once at boot: the event fires early and only once per page load. */
export function listenForInstallPrompt(target: Window = window): void {
  target.addEventListener('beforeinstallprompt', (event) => {
    // Our card offers it (instead of Chrome's mini-infobar, which disappears for good when closed).
    event.preventDefault();
    installPromptStore.set(event as BeforeInstallPromptEvent);
  });
  target.addEventListener('appinstalled', () => installPromptStore.set(null));
}

/** Running as the installed app (home-screen icon), not in a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** iPhone / iPad (iPadOS reports itself as a Mac with touch). */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  );
}

export async function registerServiceWorker(): Promise<void> {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const { registerSW } = await import('virtual:pwa-register');
  const update = registerSW({
    immediate: true,
    onNeedRefresh: () => updateStore.set(() => () => update(true)),
    onRegisteredSW: (_url, registration) => {
      // Look for a new version every 30 minutes while the app stays open.
      if (registration) setInterval(() => void registration.update().catch(() => undefined), 30 * 60_000);
    },
  });
}
