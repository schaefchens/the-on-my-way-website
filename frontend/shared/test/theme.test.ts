import { describe, expect, it } from 'vitest';
import {
  isThemePreference,
  nextThemePreference,
  readThemePreference,
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
  themeAttribute,
  writeThemePreference,
} from '../src/theme';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

describe('theme preference', () => {
  it('cycles system -> dawn -> dusk -> system', () => {
    expect(nextThemePreference('system')).toBe('dawn');
    expect(nextThemePreference('dawn')).toBe('dusk');
    expect(nextThemePreference('dusk')).toBe('system');
  });

  it('maps to the data-theme attribute of theme.css', () => {
    expect(themeAttribute('dawn')).toBe('dawn');
    expect(themeAttribute('dusk')).toBe('night');
    expect(themeAttribute('system')).toBeNull();
    expect(isThemePreference('dusk')).toBe(true);
    expect(isThemePreference('night')).toBe(false);
  });

  it('persists explicit choices and forgets "system"', () => {
    const store = memoryStorage();
    writeThemePreference('dusk', store);
    expect(store.data.get(THEME_STORAGE_KEY)).toBe('dusk');
    expect(readThemePreference(store)).toBe('dusk');
    writeThemePreference('system', store);
    expect(store.data.has(THEME_STORAGE_KEY)).toBe(false);
    expect(readThemePreference(store)).toBe('system');
  });

  it('survives broken or blocked storage', () => {
    expect(readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: 'neon' }))).toBe('system');
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readThemePreference(throwing)).toBe('system');
    expect(() => writeThemePreference('dawn', throwing)).not.toThrow();
    expect(readThemePreference(null)).toBe('system');
  });

  it('ships a boot script that sets the same attribute', () => {
    const attrs = new Map<string, string>();
    const doc = { documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v) } };
    const localStorage = memoryStorage({ [THEME_STORAGE_KEY]: 'dusk' });
    new Function('document', 'localStorage', THEME_BOOT_SCRIPT)(doc, localStorage);
    expect(attrs.get('data-theme')).toBe('night');
  });
});
