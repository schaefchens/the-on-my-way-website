/** Form helpers: dirty patches for PATCH writes and localized text cleanup. */
import type { I18nText, LocaleCode } from '@omw/contracts/i18n';
import { sameValue } from '../api/conflicts';

/**
 * Fields of `edited` that differ from `original` (blank strings, null and absent count as
 * equal). Returns the PATCH body plus the original values of exactly those fields.
 */
export function dirtyPatch<T extends Record<string, unknown>>(
  original: T,
  edited: T,
): { patch: Partial<T>; original: Partial<T>; dirty: boolean } {
  const patch: Partial<T> = {};
  const before: Partial<T> = {};
  for (const key of Object.keys(edited) as Array<keyof T>) {
    if (sameValue(edited[key], original[key])) continue;
    patch[key] = edited[key];
    before[key] = original[key];
  }
  return { patch, original: before, dirty: Object.keys(patch).length > 0 };
}

/** I18nText without blank entries (null when nothing is left). */
export function cleanText(text: Partial<Record<LocaleCode, string>> | null | undefined): I18nText | null {
  if (!text) return null;
  const out: I18nText = {};
  for (const [locale, value] of Object.entries(text) as Array<[LocaleCode, string | undefined]>) {
    const trimmed = value?.trim();
    if (trimmed) out[locale] = trimmed;
  }
  return Object.keys(out).length ? out : null;
}

/** Locales of a localized value that have non-blank text. */
export function filledLocales(text: Partial<Record<string, unknown>> | null | undefined): string[] {
  if (!text) return [];
  return Object.entries(text)
    .filter(([, v]) => (typeof v === 'string' ? v.trim() !== '' : v !== null && v !== undefined))
    .map(([k]) => k);
}

/** "Vietnam 2026!" -> "vietnam-2026" (matches the contracts' Slug). */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/** Parses a coordinate input ("15,88" or "15.88"); undefined for invalid, null for empty. */
export function parseCoordinate(input: string, limit: 90 | 180): number | null | undefined {
  const trimmed = input.trim().replace(',', '.');
  if (trimmed === '') return null;
  if (!/^-?\d{1,3}(?:\.\d+)?$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Math.abs(value) <= limit ? Math.round(value * 1e6) / 1e6 : undefined;
}
