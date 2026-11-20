/**
 * Lingui runtime: catalogs are src/locales/<locale>/messages.po, compiled on import by
 * @lingui/vite-plugin and code-split per locale. Components use the macros
 * (`Trans`, `useLingui` from '@lingui/react/macro'), compiled by the plugin's native transform
 * (see vite.config.ts).
 *
 * main.tsx loads the page's catalog in parallel with the route data (L3-01); the locale route
 * activates its locale too (same catalog, same request). When two different locales are
 * requested concurrently, the one requested last wins, whatever order the chunks arrive in.
 */
import { i18n, type Messages } from '@lingui/core';
import type { LocaleCode } from '@omw/contracts/i18n';

const catalogs = import.meta.glob<{ messages: Messages }>('./locales/*/messages.po');

let requested: LocaleCode | null = null;

export async function activateLocale(locale: LocaleCode): Promise<void> {
  requested = locale;
  if (i18n.locale === locale) return;
  const load = catalogs[`./locales/${locale}/messages.po`];
  if (!load) throw new Error(`No message catalog for locale "${locale}"`);
  const { messages } = await load();
  // A later request for another locale superseded this one.
  if (requested !== locale) return;
  i18n.loadAndActivate({ locale, messages });
}

export { i18n };
