/**
 * Visitor preferences of the player, remembered per browser (localStorage, best effort):
 *   muted      false once the visitor unmuted (plan C: "tap to unmute, remember choice")
 *   dataSaver  smaller image variants, no video autoplay; defaults to the browser's Save-Data hint
 */
import { useSyncExternalStore } from 'react';

export interface PlayerPrefs {
  muted: boolean;
  dataSaver: boolean;
}

const STORAGE_KEY = 'omw.player.v1';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function storage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function saveDataHint(): boolean {
  if (typeof navigator === 'undefined') return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

export function parsePrefs(raw: string | null, defaults: PlayerPrefs): PlayerPrefs {
  if (!raw) return defaults;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return defaults;
    const v = value as Record<string, unknown>;
    return {
      muted: typeof v.muted === 'boolean' ? v.muted : defaults.muted,
      dataSaver: typeof v.dataSaver === 'boolean' ? v.dataSaver : defaults.dataSaver,
    };
  } catch {
    return defaults;
  }
}

export interface PrefsStore {
  get(): PlayerPrefs;
  set(patch: Partial<PlayerPrefs>): void;
  subscribe(listener: () => void): () => void;
}

/** `store` defaults to localStorage, resolved on first use (never at import time). */
export function createPrefsStore(explicit?: StorageLike | null): PrefsStore {
  let resolved: StorageLike | null | undefined = explicit;
  const backing = (): StorageLike | null => {
    if (resolved === undefined) resolved = storage();
    return resolved;
  };
  let current: PlayerPrefs | null = null;
  const listeners = new Set<() => void>();
  const read = (): PlayerPrefs => {
    if (current) return current;
    let raw: string | null = null;
    try {
      raw = backing()?.getItem(STORAGE_KEY) ?? null;
    } catch {
      raw = null;
    }
    current = parsePrefs(raw, { muted: true, dataSaver: saveDataHint() });
    return current;
  };
  return {
    get: read,
    set(patch) {
      const next = { ...read(), ...patch };
      if (next.muted === current?.muted && next.dataSaver === current?.dataSaver) return;
      current = next;
      try {
        backing()?.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Private mode / blocked storage: the choice lasts for this page only.
      }
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const sharedStore = createPrefsStore();

export function usePlayerPrefs(store: PrefsStore = sharedStore): [PlayerPrefs, (patch: Partial<PlayerPrefs>) => void] {
  const prefs = useSyncExternalStore(store.subscribe, store.get, store.get);
  return [prefs, store.set];
}
