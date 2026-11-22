/**
 * Boot JSON reader (D3). Every generated page carries
 *   <script id="omw-boot" type="application/json">{basePath, locale, route, manifestVersion, timelineV, day?, profile?, access?}</script>
 * The runtime basePath ("/" or "/travel/") comes from here, never from the build.
 *
 * Parsing is structural and dependency-free (no zod in the production bundle); in dev the full
 * schema check runs too (data/validate.dev.ts).
 */
import type { LocaleCode } from '@omw/contracts/i18n';
import type { AvatarImage, BootAccess, DayDetail, RouteName, SiteProfile } from '@omw/contracts/site';
import { BOOT_ELEMENT_ID } from './config';
import { PUBLIC_API_BASE_RE } from './gate/access-lite';
import { isKnownLocale } from './locales';
import { parseRoutePath } from './route-path';

export interface SiteBoot {
  basePath: string;
  locale: LocaleCode | null;
  route: { name: RouteName; params: Record<string, string> } | null;
  manifestVersion: number | null;
  timelineV: string | null;
  /** Inlined day data for day/story pages. */
  day: DayDetail | null;
  /** The owner's profile, inlined on day/story pages (shown until the timeline has loaded). */
  profile: SiteProfile | null;
  /** Gate mode (spec-wave5 §5.4): how the SPA talks to the API about its device; null = open mode. */
  access: BootAccess | null;
  /** "document": read from the page; "fallback": derived from the URL (dev without boot JSON). */
  source: 'document' | 'fallback';
  /** The raw JSON value, for dev validation. */
  raw?: unknown;
}

const BASE_PATH_RE = /^\/(?:[A-Za-z0-9._~-]+\/)*$/;
const HASH_RE = /^[A-Za-z0-9_-]{4,64}$/;
/** "notFound" = /404.html, which hosts serve at any URL depth (it still carries basePath). */
const ROUTE_NAMES: ReadonlySet<string> = new Set(['home', 'day', 'story', 'trip', 'notFound']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/;
const MEDIA_PATH_RE = /^media\/[A-Za-z0-9._/-]+$/;

function isSourceList(value: unknown): value is { w: number; src: string }[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (s) =>
        isRecord(s) &&
        typeof s.w === 'number' &&
        s.w > 0 &&
        typeof s.src === 'string' &&
        MEDIA_PATH_RE.test(s.src) &&
        !s.src.includes('..'),
    )
  );
}

function parseAvatar(value: unknown): AvatarImage | null {
  if (!isRecord(value) || !isRecord(value.sources)) return null;
  const { w, h, color, thumbhash, focus } = value;
  if (typeof w !== 'number' || typeof h !== 'number' || w <= 0 || h <= 0) return null;
  if (typeof color !== 'string' || !HEX_COLOR_RE.test(color) || typeof thumbhash !== 'string') return null;
  const { avif, webp } = value.sources;
  if (!isSourceList(avif) || !isSourceList(webp)) return null;
  const inUnit = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;
  const point = isRecord(focus) && inUnit(focus.x) && inUnit(focus.y) ? { x: focus.x, y: focus.y } : null;
  return { w, h, color, thumbhash, sources: { avif, webp }, ...(point ? { focus: point } : {}) };
}

/**
 * The inlined profile, structurally checked (the generator validated it; a malformed part is
 * dropped, never shown). Null when nothing usable is left.
 */
export function parseBootProfile(value: unknown): SiteProfile | null {
  if (!isRecord(value)) return null;
  const profile: SiteProfile = {};
  // At most 60 characters (code points, like the contract, the API and the admin: an emoji
  // counts once, not as its two UTF-16 units).
  if (typeof value.author === 'string' && value.author.trim() !== '' && [...value.author].length <= 60) {
    profile.author = value.author;
  }
  if (isRecord(value.intro)) {
    const intro: Partial<Record<LocaleCode, string>> = {};
    for (const [k, v] of Object.entries(value.intro)) {
      if (isKnownLocale(k) && typeof v === 'string' && v.trim() !== '') intro[k] = v;
    }
    if (Object.keys(intro).length > 0) profile.intro = intro;
  }
  const avatar = parseAvatar(value.avatar);
  if (avatar) profile.avatar = avatar;
  return Object.keys(profile).length > 0 ? profile : null;
}

const COOKIE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COOKIE_DOMAIN_RE = /^[a-z0-9.-]+$/;
const COOKIE_MODES: ReadonlySet<string> = new Set(['headers', 'co', 'parent']);

/** Boot.access, structurally checked; null when absent or malformed (then the SPA is in open mode). */
export function parseBootAccess(value: unknown): BootAccess | null {
  if (!isRecord(value) || !isRecord(value.cookies)) return null;
  const { api, cookieMode, cookieDomain } = value;
  const { key, transfer, handoff } = value.cookies;
  if (typeof api !== 'string' || !PUBLIC_API_BASE_RE.test(api)) return null;
  if (typeof cookieMode !== 'string' || !COOKIE_MODES.has(cookieMode)) return null;
  if (cookieDomain !== null && (typeof cookieDomain !== 'string' || !COOKIE_DOMAIN_RE.test(cookieDomain))) return null;
  const names = [key, transfer, handoff];
  if (!names.every((n) => typeof n === 'string' && COOKIE_NAME_RE.test(n))) return null;
  return {
    api,
    cookies: { key: key as string, transfer: transfer as string, handoff: handoff as string },
    cookieMode: cookieMode as BootAccess['cookieMode'],
    cookieDomain,
  };
}

/** Parses the boot JSON text; null when it is missing or structurally invalid. */
export function parseBootJson(text: string | null | undefined): SiteBoot | null {
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const { basePath, locale, route, manifestVersion, timelineV, day, profile, access } = raw;
  if (typeof basePath !== 'string' || !BASE_PATH_RE.test(basePath)) return null;
  if (!isKnownLocale(locale)) return null;

  let parsedRoute: SiteBoot['route'] = null;
  if (isRecord(route) && typeof route.name === 'string' && ROUTE_NAMES.has(route.name)) {
    const params: Record<string, string> = {};
    if (isRecord(route.params)) {
      for (const [k, v] of Object.entries(route.params)) if (typeof v === 'string') params[k] = v;
    }
    parsedRoute = { name: route.name as RouteName, params };
  }

  return {
    basePath,
    locale,
    route: parsedRoute,
    manifestVersion:
      Number.isInteger(manifestVersion) && (manifestVersion as number) >= 1 ? (manifestVersion as number) : null,
    timelineV: typeof timelineV === 'string' && HASH_RE.test(timelineV) ? timelineV : null,
    day: isRecord(day) && typeof day.date === 'string' && Array.isArray(day.entries) ? (day as DayDetail) : null,
    profile: parseBootProfile(profile),
    access: parseBootAccess(access),
    source: 'document',
    raw,
  };
}

/** Boot derived from the URL when the page has no boot JSON (Vite dev server without plugin). */
export function fallbackBoot(pathname: string, basePath = '/'): SiteBoot {
  const parsed = parseRoutePath(pathname, basePath);
  const locale = parsed && isKnownLocale(parsed.locale) ? parsed.locale : null;
  return {
    basePath,
    locale,
    route: parsed && locale ? { name: parsed.name, params: parsed.params } : null,
    manifestVersion: null,
    timelineV: null,
    day: null,
    profile: null,
    access: null,
    source: 'fallback',
  };
}

interface DocumentLike {
  getElementById(id: string): { textContent: string | null } | null;
}

/** Reads the boot JSON from the document; null when absent or invalid. */
export function readBoot(doc: DocumentLike = document): SiteBoot | null {
  return parseBootJson(doc.getElementById(BOOT_ELEMENT_ID)?.textContent);
}
