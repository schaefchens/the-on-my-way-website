/**
 * Theme preference (dawn = light, dusk = night, system = follow the OS), persisted per browser.
 * Applied as <html data-theme="dawn" | "night"> (see styles/theme.css); "system" removes the
 * attribute. Storage is a per-viewer convenience only: every access is guarded, and the page
 * renders correctly without it (private mode, blocked storage).
 */
import { useCallback, useSyncExternalStore } from 'react';

export const THEME_PREFERENCES = ['system', 'dawn', 'dusk'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const THEME_STORAGE_KEY = 'omw-theme';

/** <meta name="theme-color"> per resolved theme (the page background). */
export const THEME_COLORS = { dawn: '#fff8f6', dusk: '#1b1322' } as const;

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** Value of the data-theme attribute for a preference (null = follow the OS). */
export function themeAttribute(pref: ThemePreference): 'dawn' | 'night' | null {
  return pref === 'dawn' ? 'dawn' : pref === 'dusk' ? 'night' : null;
}

/** Next preference of the cycling toggle: system → dawn → dusk → system. */
export function nextThemePreference(pref: ThemePreference): ThemePreference {
  const i = THEME_PREFERENCES.indexOf(pref);
  return THEME_PREFERENCES[(i + 1) % THEME_PREFERENCES.length] ?? 'system';
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readThemePreference(store: StorageLike | null = storage()): ThemePreference {
  try {
    const value = store?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function writeThemePreference(pref: ThemePreference, store: StorageLike | null = storage()): void {
  try {
    if (pref === 'system') store?.removeItem(THEME_STORAGE_KEY);
    else store?.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Storage blocked: the choice lasts for this page view only.
  }
}

/** Whether the resolved theme is dusk (preference, else the OS setting). */
export function resolvesToDusk(pref: ThemePreference): boolean {
  if (pref !== 'system') return pref === 'dusk';
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

/** Sets <html data-theme> and the theme-color meta tags for a preference. */
export function applyThemePreference(pref: ThemePreference, doc: Document | undefined = globalThis.document): void {
  if (!doc) return;
  const attr = themeAttribute(pref);
  if (attr) doc.documentElement.setAttribute('data-theme', attr);
  else doc.documentElement.removeAttribute('data-theme');
  const forced = pref === 'system' ? null : THEME_COLORS[pref];
  for (const meta of doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    // Keep the media-specific pair for "system"; force both to one colour otherwise.
    const original = meta.dataset.omwColor ?? meta.content;
    meta.dataset.omwColor = original;
    meta.content = forced ?? original;
  }
}

/**
 * Inline <head> script for generated pages: applies a stored preference before first paint
 * (no flash of the wrong theme). Needs a CSP hash/nonce if the page's CSP forbids inline scripts.
 */
export const THEME_BOOT_SCRIPT =
  "try{var t=localStorage.getItem('omw-theme');if(t==='dawn'||t==='dusk')document.documentElement.setAttribute('data-theme',t==='dusk'?'night':'dawn')}catch(e){}";

// ---------------------------------------------------------------------------------------------
// React hook (one shared store, so several toggles stay in sync)

const listeners = new Set<() => void>();
let current: ThemePreference | null = null;

function getPreference(): ThemePreference {
  if (current === null) current = readThemePreference();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setThemePreference(pref: ThemePreference): void {
  current = pref;
  writeThemePreference(pref);
  applyThemePreference(pref);
  for (const l of listeners) l();
}

export function useThemePreference(): [ThemePreference, (pref: ThemePreference) => void] {
  const pref = useSyncExternalStore(subscribe, getPreference, () => 'system' as const);
  const set = useCallback((p: ThemePreference) => setThemePreference(p), []);
  return [pref, set];
}
