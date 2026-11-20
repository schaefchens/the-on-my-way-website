import { i18n, type Messages } from '@lingui/core';
import type { LocaleCode } from '@omw/contracts/i18n';
import { availableLocales } from '@omw/ui/locale';

const catalogs = import.meta.glob<{ messages: Messages }>('./locales/*/messages.po');
const STORAGE_KEY = 'omw.admin.locale';

export const ADMIN_LOCALES: readonly LocaleCode[] = availableLocales(import.meta.env.DEV);

/** Stored choice, else the browser language, else German. */
export function preferredLocale(): LocaleCode {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // storage blocked: fall through
  }
  const candidates = [stored, ...(typeof navigator !== 'undefined' ? navigator.languages : [])].map((l) =>
    l?.slice(0, 2).toLowerCase(),
  );
  return (candidates.find((l) => ADMIN_LOCALES.includes(l as LocaleCode)) as LocaleCode | undefined) ?? 'de';
}

export async function activateLocale(locale: LocaleCode, remember = false): Promise<void> {
  if (remember) {
    try {
      localStorage.setItem(STORAGE_KEY, locale);
    } catch {
      // ignore
    }
  }
  if (i18n.locale === locale) return;
  const load = catalogs[`./locales/${locale}/messages.po`];
  if (!load) throw new Error(`No message catalog for locale "${locale}"`);
  const { messages } = await load();
  i18n.loadAndActivate({ locale, messages });
}

export { i18n };
