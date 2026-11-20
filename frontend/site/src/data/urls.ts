/**
 * URLs of the static data files (D3, plan A4 "Caching that works on any host"):
 *   manifest  <base>data/manifest.json?t=<now>   fetched with cache: 'no-store'
 *   timeline  <base>data/timeline.json?v=<hash>  immutable per hash
 *   day       <base>data/days/<date>.json?v=<hash>
 *   trip      <base>data/trips/<slug>.json?v=<hash>
 * All data paths are relative to the site root; basePath comes from the Boot JSON.
 */
import { resolveSiteUrl } from '@omw/ui/picture';
import { DATA_PATHS } from '../config';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH_RE = /^[A-Za-z0-9_-]{4,64}$/;

function checked(value: string, re: RegExp, what: string): string {
  if (!re.test(value)) throw new RangeError(`Invalid ${what}: ${value}`);
  return value;
}

/** "<basePath><relPath>" — re-exported for media and links. */
export const siteUrl = resolveSiteUrl;

export function withVersion(url: string, v: string): string {
  return `${url}?v=${encodeURIComponent(checked(v, HASH_RE, 'version hash'))}`;
}

export function manifestUrl(basePath: string, now: number = Date.now()): string {
  return `${siteUrl(basePath, DATA_PATHS.manifest)}?t=${Math.floor(now)}`;
}

export function timelineUrl(basePath: string, v: string): string {
  return withVersion(siteUrl(basePath, DATA_PATHS.timeline), v);
}

export function dayDataRelPath(date: string): string {
  return `${DATA_PATHS.dayDir}${checked(date, DATE_RE, 'date')}.json`;
}

export function tripDataRelPath(slug: string): string {
  return `${DATA_PATHS.tripDir}${checked(slug, SLUG_RE, 'trip slug')}.json`;
}

export function dayUrl(basePath: string, date: string, v: string): string {
  return withVersion(siteUrl(basePath, dayDataRelPath(date)), v);
}

export function tripUrl(basePath: string, slug: string, v: string): string {
  return withVersion(siteUrl(basePath, tripDataRelPath(slug)), v);
}
