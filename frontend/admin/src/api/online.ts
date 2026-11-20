/**
 * Connectivity for TanStack Query's onlineManager: online = the browser is online AND the API
 * answered recently. A failed request (no HTTP answer) marks the API unreachable at once, which
 * pauses queued writes instead of failing them; a probe of GET /api/v1/health with backoff
 * (2 s … 30 s) and every later HTTP answer mark it reachable again, which resumes them.
 */
import { onlineManager } from '@tanstack/react-query';
import { createStore } from '../lib/store';

export interface Connectivity {
  browserOnline: boolean;
  apiReachable: boolean;
}

export const connectivityStore = createStore<Connectivity>({
  browserOnline: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  apiReachable: true,
});

export function isOnline(c: Connectivity = connectivityStore.get()): boolean {
  return c.browserOnline && c.apiReachable;
}

type Probe = () => Promise<unknown>;

let probe: Probe | null = null;
let probeTimer: ReturnType<typeof setTimeout> | null = null;
let probeDelay = 2000;

function schedule(): void {
  if (probeTimer || !probe) return;
  const c = connectivityStore.get();
  if (c.apiReachable || !c.browserOnline) return;
  probeTimer = setTimeout(async () => {
    probeTimer = null;
    try {
      await probe?.();
      markApiReachable();
    } catch {
      probeDelay = Math.min(probeDelay * 2, 30_000);
      schedule();
    }
  }, probeDelay);
}

export function markApiUnreachable(): void {
  if (connectivityStore.get().apiReachable) {
    connectivityStore.set((c) => ({ ...c, apiReachable: false }));
  }
  schedule();
}

export function markApiReachable(): void {
  probeDelay = 2000;
  if (probeTimer) {
    clearTimeout(probeTimer);
    probeTimer = null;
  }
  if (!connectivityStore.get().apiReachable) connectivityStore.set((c) => ({ ...c, apiReachable: true }));
}

export function setBrowserOnline(online: boolean): void {
  connectivityStore.set((c) => ({ ...c, browserOnline: online }));
  if (online && !connectivityStore.get().apiReachable) {
    // Back online: probe right away instead of waiting for the backoff.
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = null;
    probeDelay = 300;
    schedule();
  }
}

/**
 * Wires the connectivity store into TanStack's onlineManager (once per app). `probeFn` is the
 * health request; tests pass their own.
 */
export function installOnlineManager(
  probeFn: Probe,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> | null = typeof window === 'undefined'
    ? null
    : window,
): () => void {
  probe = probeFn;
  onlineManager.setEventListener((setOnline) => {
    const sync = () => setOnline(isOnline());
    const unsubscribe = connectivityStore.subscribe(sync);
    const onOnline = () => setBrowserOnline(true);
    const onOffline = () => setBrowserOnline(false);
    target?.addEventListener('online', onOnline);
    target?.addEventListener('offline', onOffline);
    sync();
    return () => {
      unsubscribe();
      target?.removeEventListener('online', onOnline);
      target?.removeEventListener('offline', onOffline);
    };
  });
  return () => {
    probe = null;
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = null;
  };
}
