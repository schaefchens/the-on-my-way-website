/**
 * Verifies a generated OUT_DIR from disk (CLI `check`, tests, and useful before a deploy):
 * - manifest/timeline/day/trip JSON parse with @omw/contracts/site, `v` hashes match both the
 *   index entry and the file content, days ascending and entries chronological;
 * - every referenced media file and every asset referenced by HTML exists;
 * - every expected page exists (each locale x home/day/story/trip, 404.html, index.html);
 * - each HTML page: one CSP <meta> before any script/style, script-src without 'unsafe-inline',
 *   every inline <script> (except JSON data blocks) and <style> hashed in the CSP, no inline
 *   event handler or style attribute, Boot JSON valid (locale/basePath match the page);
 * - no file references a WhatsApp message id (D4) — checked by the caller with `forbidden`.
 */
import { promises as fsp } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  Boot,
  DayDetail,
  dayDataPath,
  MANIFEST_PATH,
  Manifest,
  routePath,
  TIMELINE_PATH,
  TimelineIndex,
  TripDetail,
  tripDataPath,
} from '@omw/contracts/site';
import { z } from 'zod';
import { contentHash, cspHash } from './hash.js';
import { dayMediaPaths, imageSetPaths, timelineMediaPaths } from './media.js';

export interface VerifyResult {
  problems: string[];
  files: number;
  pages: number;
  media: number;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await fsp.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir: string, root = dir, out: string[] = []): Promise<string[]> {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await listFiles(full, root, out);
    else out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

/** Inline <script>/<style> bodies, CSP and attributes of a generated page. */
export function inspectHtml(page: string): {
  csp: string | null;
  cspIndex: number;
  inlineScripts: string[];
  dataScripts: { id: string | null; type: string; body: string }[];
  styles: string[];
  firstScriptOrStyle: number;
  externalRefs: string[];
} {
  const cspMatch = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(page);
  const inlineScripts: string[] = [];
  const dataScripts: { id: string | null; type: string; body: string }[] = [];
  const styles: string[] = [];
  let firstScriptOrStyle = Number.POSITIVE_INFINITY;
  for (const m of page.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    firstScriptOrStyle = Math.min(firstScriptOrStyle, m.index);
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const type = /\btype="([^"]*)"/.exec(attrs)?.[1] ?? '';
    if (/\bsrc="/.test(attrs)) continue;
    if (type === 'application/json') dataScripts.push({ id: /\bid="([^"]*)"/.exec(attrs)?.[1] ?? null, type, body });
    else inlineScripts.push(body);
  }
  for (const m of page.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    firstScriptOrStyle = Math.min(firstScriptOrStyle, m.index);
    styles.push(m[1] ?? '');
  }
  const externalRefs: string[] = [];
  for (const m of page.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
    if (m[1]) externalRefs.push(m[1]);
  }
  return {
    csp:
      cspMatch?.[1]
        ?.replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&') ?? null,
    cspIndex: cspMatch?.index ?? -1,
    inlineScripts,
    dataScripts,
    styles,
    firstScriptOrStyle,
    externalRefs,
  };
}

function cspDirective(csp: string, name: string): string[] | null {
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/);
    if (tokens[0] === name) return tokens.slice(1);
  }
  return null;
}

/** CSP checks of one page; returns problems. */
export function checkPageCsp(path: string, page: string): string[] {
  const problems: string[] = [];
  const info = inspectHtml(page);
  if (!info.csp) return [`${path}: no CSP meta`];
  if (info.cspIndex > info.firstScriptOrStyle) problems.push(`${path}: CSP meta after a script/style`);
  const scriptSrc = cspDirective(info.csp, 'script-src');
  const styleSrc = cspDirective(info.csp, 'style-src');
  if (!scriptSrc) problems.push(`${path}: CSP without script-src`);
  else {
    if (scriptSrc.includes("'unsafe-inline'") || scriptSrc.includes("'unsafe-eval'")) {
      problems.push(`${path}: script-src allows unsafe-inline/eval`);
    }
    for (const s of info.inlineScripts) {
      if (!scriptSrc.includes(cspHash(s))) problems.push(`${path}: inline script not hashed in CSP`);
    }
  }
  if (!styleSrc) problems.push(`${path}: CSP without style-src`);
  else
    for (const s of info.styles)
      if (!styleSrc.includes(cspHash(s))) problems.push(`${path}: <style> not hashed in CSP`);
  if (cspDirective(info.csp, 'object-src')?.join(' ') !== "'none'") problems.push(`${path}: object-src not 'none'`);
  // Inline handlers / style attributes would need 'unsafe-inline' (or 'unsafe-hashes').
  const tags = page.replace(/<script[^>]*>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');
  for (const m of tags.matchAll(/<[a-zA-Z][^>]*>/g)) {
    // Attribute values are always double-quoted and escaped, so blank them before looking at names.
    const names = m[0].replace(/"[^"]*"/g, '""');
    if (/\s(?:on[a-z]+|style)\s*=/i.test(names))
      problems.push(`${path}: inline handler/style attribute: ${m[0].slice(0, 80)}`);
  }
  return problems;
}

export async function verifyOutDir(
  outDir: string,
  opts: { forbidden?: readonly string[] } = {},
): Promise<VerifyResult> {
  const problems: string[] = [];
  if (!(await exists(outDir))) return { problems: [`${outDir}: OUT_DIR does not exist`], files: 0, pages: 0, media: 0 };
  const parseFile = async <T>(rel: string, schema: z.ZodType<T>): Promise<T | null> => {
    const text = await readText(join(outDir, rel));
    if (text === null) {
      problems.push(`${rel}: missing`);
      return null;
    }
    const r = schema.safeParse(JSON.parse(text));
    if (!r.success) {
      problems.push(`${rel}: ${z.prettifyError(r.error)}`);
      return null;
    }
    return r.data;
  };
  const manifest = await parseFile(MANIFEST_PATH, Manifest);
  const timeline = await parseFile(TIMELINE_PATH, TimelineIndex);
  const media = new Set<string>();
  const expectedPages: string[] = ['index.html', '404.html'];
  if (manifest && timeline) {
    if (contentHash({ trips: timeline.trips, days: timeline.days }) !== manifest.timeline.v) {
      problems.push('manifest.timeline.v does not match timeline.json');
    }
    const dates = timeline.days.map((d) => d.date);
    if (dates.join() !== [...dates].sort().join()) problems.push('timeline.days not ascending');
    timelineMediaPaths(timeline, media);
    for (const locale of manifest.site.locales) expectedPages.push(`${routePath(locale, { name: 'home' })}index.html`);
    for (const s of timeline.days) {
      const day = await parseFile(dayDataPath(s.date), DayDetail);
      if (!day) continue;
      const { v, ...body } = day;
      if (v !== s.v || contentHash(body) !== v) problems.push(`${dayDataPath(s.date)}: v mismatch`);
      const ats = day.entries.map((e) => Date.parse(e.at));
      if (ats.some((t, i) => i > 0 && t < (ats[i - 1] ?? t)))
        problems.push(`${dayDataPath(s.date)}: not chronological`);
      dayMediaPaths(day, media);
      for (const locale of manifest.site.locales) {
        expectedPages.push(`${routePath(locale, { name: 'day', date: s.date })}index.html`);
        for (const e of day.entries) {
          if (e.kind === 'story')
            expectedPages.push(`${routePath(locale, { name: 'story', date: s.date, id: e.id })}index.html`);
        }
      }
    }
    for (const s of timeline.trips) {
      const trip = await parseFile(tripDataPath(s.slug), TripDetail);
      if (!trip) continue;
      const { v, ...body } = trip;
      if (v !== s.v || contentHash(body) !== v) problems.push(`${tripDataPath(s.slug)}: v mismatch`);
      imageSetPaths(trip.cover, media);
      for (const locale of manifest.site.locales) {
        expectedPages.push(`${routePath(locale, { name: 'trip', slug: s.slug })}index.html`);
      }
    }
  }
  for (const rel of media) if (!(await exists(join(outDir, rel)))) problems.push(`${rel}: referenced but missing`);

  const all = await listFiles(outDir);
  const htmlFiles = all.filter((f) => f.endsWith('.html'));
  for (const rel of expectedPages) if (!htmlFiles.includes(rel)) problems.push(`${rel}: expected page missing`);
  const basePath = manifest?.site.basePath ?? '/';
  for (const rel of htmlFiles) {
    const page = (await readText(join(outDir, rel))) ?? '';
    problems.push(...checkPageCsp(rel, page));
    const info = inspectHtml(page);
    for (const ref of info.externalRefs) {
      if (!ref.startsWith(basePath)) continue;
      const target = ref.slice(basePath.length).split(/[?#]/)[0] ?? '';
      if (target.startsWith('assets/') && !(await exists(join(outDir, target))))
        problems.push(`${rel}: missing ${ref}`);
    }
    const boot = info.dataScripts.find((s) => s.id === 'omw-boot');
    if (rel !== 'index.html') {
      if (!boot) problems.push(`${rel}: no boot JSON`);
      else {
        const r = Boot.safeParse(JSON.parse(boot.body));
        if (!r.success) problems.push(`${rel}: boot: ${z.prettifyError(r.error)}`);
        else {
          if (r.data.basePath !== basePath) problems.push(`${rel}: boot basePath ${r.data.basePath}`);
          const lang = /<html lang="([^"]+)"/.exec(page)?.[1];
          if (lang !== r.data.locale) problems.push(`${rel}: <html lang> ${lang} != boot locale ${r.data.locale}`);
        }
        if (/[<>&\u2028\u2029]/.test(boot.body)) problems.push(`${rel}: boot JSON not escaped`);
      }
      if (!page.includes('<div id="omw-root">')) problems.push(`${rel}: no #omw-root`);
    }
  }
  if (opts.forbidden && opts.forbidden.length > 0) {
    for (const rel of all) {
      if (rel.startsWith('media/') || rel.startsWith('assets/')) continue;
      const text = (await readText(join(outDir, rel))) ?? '';
      for (const f of opts.forbidden) if (text.includes(f)) problems.push(`${rel}: contains forbidden "${f}"`);
    }
  }
  return { problems, files: all.length, pages: htmlFiles.length, media: media.size };
}
