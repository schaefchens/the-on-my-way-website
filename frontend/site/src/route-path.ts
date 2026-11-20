/**
 * Parses a site path into the route it denotes (mirror of the generator's directory layout,
 * plan A4 / C "Routes"). Dependency-free on purpose: also used by the Vite dev plugin.
 *
 *   <basePath><locale>/                              home
 *   <basePath><locale>/day/<date>/                   day (journey player)
 *   <basePath><locale>/day/<date>/story/<id>/        story
 *   <basePath><locale>/trip/<slug>/                  trip
 */

export type RouteNameLike = 'home' | 'day' | 'story' | 'trip';

export interface ParsedRoute {
  locale: string;
  name: RouteNameLike;
  params: Record<string, string>;
}

const LOCALE_SEG = /^[a-z]{2}(?:-[A-Za-z0-9]{2,8})?$/;
const DATE_SEG = /^\d{4}-\d{2}-\d{2}$/;
const POST_ID_SEG = /^p_[A-Za-z0-9_-]{4,64}$/;
const SLUG_SEG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Strips the basePath; returns null when `pathname` is outside it. */
export function stripBasePath(pathname: string, basePath: string): string | null {
  if (basePath === '/') return pathname;
  const base = basePath.endsWith('/') ? basePath : `${basePath}/`;
  if (pathname === base.slice(0, -1)) return '/';
  return pathname.startsWith(base) ? `/${pathname.slice(base.length)}` : null;
}

/** Parses "/de/day/2026-11-18/" (relative to basePath). Trailing slash optional. */
export function parseRoutePath(pathname: string, basePath = '/'): ParsedRoute | null {
  const rel = stripBasePath(pathname.split(/[?#]/)[0] ?? '', basePath);
  if (rel === null) return null;
  const segs = rel.split('/').filter(Boolean).map(safeDecode);
  const [locale, kind, a, b, c] = segs;
  if (!locale || !LOCALE_SEG.test(locale)) return null;
  if (segs.length === 1) return { locale, name: 'home', params: {} };
  if (kind === 'day' && a && DATE_SEG.test(a)) {
    if (segs.length === 3) return { locale, name: 'day', params: { date: a } };
    if (segs.length === 5 && b === 'story' && c && POST_ID_SEG.test(c)) {
      return { locale, name: 'story', params: { date: a, id: c } };
    }
  }
  if (kind === 'trip' && a && SLUG_SEG.test(a) && segs.length === 3) {
    return { locale, name: 'trip', params: { slug: a } };
  }
  return null;
}

function safeDecode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}
