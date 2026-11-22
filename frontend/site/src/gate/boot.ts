/**
 * Boot data of a gate page: `<script type="application/json" id="omw-gate">` with the contract
 * GateBoot (spec-wave5 §2.6, §4.1), written by the generator (WP2, gate-pages.ts). Checked
 * structurally here (no zod in the public bundle); dev builds also run the full schema.
 */
import type { CookieMode, GateBoot, GatePage } from '@omw/contracts/access';
import { isLocaleCode, type LocaleCode } from '@omw/contracts/i18n';
import { GATE_BOOT_ELEMENT_ID, PUBLIC_API_BASE_RE } from './access-lite';

const PAGES: readonly GatePage[] = ['join', 'info', 'wait', 'ended', 'me', 'panic'];
const COOKIE_MODES: readonly CookieMode[] = ['headers', 'co', 'parent'];
const COOKIE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COOKIE_DOMAIN_RE = /^[a-z0-9.-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cookieName(value: unknown): string | null {
  return typeof value === 'string' && COOKIE_NAME_RE.test(value) ? value : null;
}

/** The boot data, or null when it is missing or malformed. */
export function parseGateBoot(text: string | null | undefined): GateBoot | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isRecord(raw.cookies)) return null;
  const { page, api, locales, defaultLocale, cookieMode, cookieDomain, build } = raw;
  if (typeof page !== 'string' || !PAGES.includes(page as GatePage)) return null;
  if (typeof api !== 'string' || !PUBLIC_API_BASE_RE.test(api)) return null;
  if (!Array.isArray(locales) || locales.length === 0 || !locales.every(isLocaleCode)) return null;
  if (!isLocaleCode(defaultLocale)) return null;
  if (typeof cookieMode !== 'string' || !COOKIE_MODES.includes(cookieMode as CookieMode)) return null;
  if (cookieDomain !== null && (typeof cookieDomain !== 'string' || !COOKIE_DOMAIN_RE.test(cookieDomain))) return null;
  if (typeof build !== 'string' || build.length === 0 || build.length > 64) return null;
  const c = raw.cookies;
  const names = {
    session: cookieName(c.session),
    key: cookieName(c.key),
    transfer: cookieName(c.transfer),
    handoff: cookieName(c.handoff),
    resume: cookieName(c.resume),
  };
  if (Object.values(names).some((n) => n === null) || typeof c.secure !== 'boolean') return null;
  return {
    page: page as GatePage,
    api,
    locales: locales as LocaleCode[],
    defaultLocale,
    cookies: {
      session: names.session as string,
      key: names.key as string,
      transfer: names.transfer as string,
      handoff: names.handoff as string,
      resume: names.resume as string,
      secure: c.secure,
    },
    cookieMode: cookieMode as CookieMode,
    cookieDomain,
    build,
  };
}

/** Reads the boot data of the page; null when absent or invalid. */
export function readGateBoot(doc: Pick<Document, 'getElementById'>): GateBoot | null {
  const boot = parseGateBoot(doc.getElementById(GATE_BOOT_ELEMENT_ID)?.textContent);
  if (import.meta.env.DEV && boot) {
    void import('@omw/contracts/access').then(({ GateBoot }) => {
      const result = GateBoot.safeParse(JSON.parse(doc.getElementById(GATE_BOOT_ELEMENT_ID)?.textContent ?? '{}'));
      if (!result.success) console.error('GateBoot does not match @omw/contracts/access', result.error.issues);
    });
  }
  return boot;
}
