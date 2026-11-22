/**
 * Verifies a generated OUT_DIR from disk (CLI `check`, tests, and useful before a deploy):
 * - manifest/timeline/day/trip JSON parse with @omw/contracts/site, `v` hashes match both the
 *   index entry and the file content, days ascending and entries chronological;
 * - every referenced media file and every asset referenced by HTML exists;
 * - every expected page exists (each locale x home/day/story/trip, 404.html, index.html);
 * - each HTML page: one CSP <meta> before any script/style, script-src without 'unsafe-inline',
 *   every inline <script> (except JSON data blocks) and <style> hashed in the CSP, no inline
 *   event handler or style attribute, Boot JSON valid (locale/basePath match the page);
 * - no file references a WhatsApp message id (D4) — checked by the caller with `forbidden`;
 * - wave 5 (spec-wave5 §5.5): no day JSON has lat/lng; no HTML has og:image, og:description,
 *   og:url or <meta name="author">; no published post id is ULID-shaped; no trip `end` is later
 *   than its last day; in gate mode (opts.gate) the content .htaccess passes verifyHtaccess(), no
 *   other .htaccess exists, no site bundle file registers a service worker and every page's CSP
 *   has worker-src 'none'.
 *
 * verifyGateTree() checks GATE_OUT_DIR: only the allowed files exist; the public-surface leak test
 * (no author, place, country, trip, date, entry id, media hash or the content folder; none of the
 * words that say "someone is away"); the neutral page's CSP hashes equal its inline bytes and it
 * names no API origin; GateBoot validates; the root .htaccess passes verifyHtaccess().
 */
import { promises as fsp } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { GateBoot } from '@omw/contracts/access';
import { LOCALE_CODES } from '@omw/contracts/i18n';
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
import {
  COOKIE_SECTION_END,
  COOKIE_SECTION_START,
  GATE_BLOCK_END,
  GATE_BLOCK_START,
  type GateHtaccessConfig,
  gateBlock,
  rootCookieSection,
} from './extras.js';
import { GATE_FIXED_FILES } from './gate.js';
import { contentHash, cspHash } from './hash.js';
import { dayMediaPaths, imageSetPaths, timelineMediaPaths } from './media.js';
import { countryName } from './strings.js';

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

/** ULID-shaped post ids (E16: published post ids are hashed, never the ULID publicId). */
const ULID_POST_ID = /^p_[0-9A-HJKMNP-TV-Z]{26}$/;

export async function verifyOutDir(
  outDir: string,
  opts: { forbidden?: readonly string[]; gate?: GateHtaccessConfig | null } = {},
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
    const { trips, days, profile } = timeline;
    if (contentHash({ trips, days, ...(profile ? { profile } : {}) }) !== manifest.timeline.v) {
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
      if ('lat' in day || 'lng' in day) problems.push(`${dayDataPath(s.date)}: has coordinates (lat/lng)`);
      for (const e of day.entries) {
        if (ULID_POST_ID.test(e.id)) problems.push(`${dayDataPath(s.date)}: ULID-shaped post id ${e.id}`);
      }
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
      const lastDay = [...trip.days].sort().at(-1);
      if (lastDay && trip.end > lastDay) problems.push(`${tripDataPath(s.slug)}: end ${trip.end} after its last day`);
      if (lastDay && s.end > lastDay) problems.push(`timeline.json trip ${s.slug}: end ${s.end} after its last day`);
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
    for (const m of page.matchAll(/<meta (?:property="og:(?:image[^"]*|description|url)"|name="author")/g)) {
      problems.push(`${rel}: link-preview leak: ${m[0]}`);
    }
    if (opts.gate) {
      const csp = inspectHtml(page).csp;
      if (csp && cspDirective(csp, 'worker-src')?.join(' ') !== "'none'") {
        problems.push(`${rel}: gate mode needs worker-src 'none'`);
      }
    }
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
  if (opts.gate) {
    for (const rel of all) {
      if (rel === '.htaccess') {
        problems.push(...verifyHtaccess((await readText(join(outDir, rel))) ?? '', 'content', opts.gate));
      } else if (rel.endsWith('/.htaccess') || rel.split('/').at(-1) === '.htaccess') {
        problems.push(`${rel}: no other .htaccess may exist in the content tree`);
      }
      if (rel.startsWith('assets/') && /\.m?js$/.test(rel)) {
        const code = (await readText(join(outDir, rel))) ?? '';
        if (/serviceWorker\s*\.\s*register/.test(code)) problems.push(`${rel}: registers a service worker`);
      }
    }
    if (!all.includes('.htaccess')) problems.push('.htaccess: missing (gate mode)');
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

// ---------------------------------------------------------------------------------------------
// Gate mode (spec-wave5 §5.5)

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lines outside the gate block that could change the gate (case-insensitive, at line start). */
const FORBIDDEN_OUTSIDE = /^\s*(?:Rewrite\w*|Require|Satisfy|Order|Allow|Deny|AuthMerging|SetEnvIf\w*)\b/i;

/** The section between two marker lines (inclusive), or why it cannot be taken. */
function section(text: string, start: string, end: string): { body: string; rest: string } | string {
  const lines = text.split('\n');
  const from = lines.indexOf(start);
  const to = lines.indexOf(end);
  if (from < 0 || to < 0 || to < from) return `missing the "${start}" … "${end}" section`;
  if (lines.lastIndexOf(start) !== from || lines.lastIndexOf(end) !== to) return `"${start}" appears twice`;
  return {
    body: lines.slice(from, to + 1).join('\n'),
    rest: [...lines.slice(0, from), ...lines.slice(to + 1)].join('\n'),
  };
}

/**
 * Checks a generated .htaccess (spec-wave5 §5.5): the gate block is present once and equals
 * gateBlock(cfg); the root file's cookie section equals rootCookieSection(cfg); outside them no
 * line starts with Rewrite*, Require, Satisfy, Order, Allow, Deny, AuthMerging or SetEnvIf*;
 * IgnoreInherit and "RewriteEngine Off" appear nowhere. Returns the problems found.
 */
export function verifyHtaccess(text: string, kind: 'root' | 'content', cfg: GateHtaccessConfig): string[] {
  const label = kind === 'root' ? '/.htaccess' : 'content .htaccess';
  const problems: string[] = [];
  if (/IgnoreInherit/i.test(text)) problems.push(`${label}: contains IgnoreInherit`);
  if (/RewriteEngine\s+Off/i.test(text)) problems.push(`${label}: contains RewriteEngine Off`);
  const block = section(text, GATE_BLOCK_START, GATE_BLOCK_END);
  if (typeof block === 'string') return [...problems, `${label}: ${block}`];
  if (block.body !== gateBlock(cfg)) problems.push(`${label}: the gate block differs from the generated one`);
  let rest = block.rest;
  if (kind === 'root') {
    const cookies = section(rest, COOKIE_SECTION_START, COOKIE_SECTION_END);
    if (typeof cookies === 'string') problems.push(`${label}: ${cookies}`);
    else {
      if (cookies.body !== rootCookieSection(cfg)) problems.push(`${label}: the cookie section differs`);
      rest = cookies.rest;
    }
  } else if (rest.includes(COOKIE_SECTION_START)) {
    problems.push(`${label}: the cookie section belongs to the root file only`);
  }
  for (const line of rest.split('\n')) {
    if (FORBIDDEN_OUTSIDE.test(line)) problems.push(`${label}: forbidden outside the gate block: ${line.trim()}`);
  }
  return problems;
}

/**
 * Generic words that say "someone is away" (whole word, case-insensitive): no gate tree file may
 * contain one, the gate bundle included (spec-wave5 §5.5; German "sie" is deliberately absent).
 */
export const GATE_FORBIDDEN_WORDS = [
  'Reise',
  'reist',
  'Reisen',
  'unterwegs',
  'Urlaub',
  'journey',
  'travel',
  'travels',
  'trip',
  'vacation',
  'she',
  'her',
] as const;

const FORBIDDEN_WORD_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${GATE_FORBIDDEN_WORDS.join('|')})(?![\\p{L}\\p{N}_])`,
  'iu',
);

/** Text files of the gate tree (the leak test reads them); anything else is scanned as latin1. */
const TEXT_FILE = /\.(?:html|js|mjs|css|svg|txt|json|webmanifest)$|(?:^|\/)\.htaccess$/;

/**
 * Strings the gate tree must never contain, from a generated content tree: the author, every
 * place, country (code-free names in every locale), trip title and slug, content date, entry id
 * and media hash, plus the content folder.
 */
export async function contentLeakFacts(outDir: string, secret: string): Promise<string[]> {
  const facts = new Set<string>([secret]);
  const timelineText = await readText(join(outDir, TIMELINE_PATH));
  if (timelineText) {
    const timeline = JSON.parse(timelineText) as z.infer<typeof TimelineIndex>;
    if (timeline.profile?.author) facts.add(timeline.profile.author);
    for (const d of timeline.days) {
      facts.add(d.date);
      if (d.place) facts.add(d.place);
      if (d.country) for (const l of LOCALE_CODES) facts.add(countryName(d.country, l));
      for (const t of Object.values(d.title ?? {})) if (t) facts.add(t);
    }
    for (const t of timeline.trips) {
      facts.add(t.slug);
      for (const title of Object.values(t.title)) if (title) facts.add(title);
    }
    const media = new Set<string>();
    timelineMediaPaths(timeline, media);
    for (const d of timeline.days) {
      const day = await readText(join(outDir, dayDataPath(d.date)));
      if (!day) continue;
      const detail = JSON.parse(day) as z.infer<typeof DayDetail>;
      for (const e of detail.entries) facts.add(e.id);
      dayMediaPaths(detail, media);
    }
    for (const m of media) {
      const hash = /([0-9a-f]{16})_/.exec(m)?.[1];
      if (hash) facts.add(hash);
    }
  }
  return [...facts].filter((f) => f.trim().length >= 3);
}

/**
 * Verifies GATE_OUT_DIR (spec-wave5 §5.5). `facts`: strings no file may contain (contentLeakFacts).
 */
export async function verifyGateTree(
  gateOutDir: string,
  opts: { cfg: GateHtaccessConfig; facts?: readonly string[] },
): Promise<VerifyResult> {
  const problems: string[] = [];
  if (!(await exists(gateOutDir))) {
    return { problems: [`${gateOutDir}: GATE_OUT_DIR does not exist`], files: 0, pages: 0, media: 0 };
  }
  const all = await listFiles(gateOutDir);
  const fixed = new Set<string>(GATE_FIXED_FILES);
  for (const rel of all) {
    if (fixed.has(rel)) continue;
    if (/^_\/assets\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(rel) && !rel.endsWith('.map')) continue;
    problems.push(`${rel}: not an allowed gate tree file`);
  }
  for (const rel of fixed) if (!all.includes(rel)) problems.push(`${rel}: missing`);

  // The neutral page: three identical copies, CSP hashes = its inline bytes, no API origin.
  const neutral = await readText(join(gateOutDir, '_/n/index.html'));
  for (const copy of ['index.html', '_/index.html']) {
    if ((await readText(join(gateOutDir, copy))) !== neutral) problems.push(`${copy}: differs from the neutral page`);
  }
  if (neutral) {
    const info = inspectHtml(neutral);
    const csp = opts.cfg.cspNeutral;
    const scripts = cspDirective(csp, 'script-src') ?? [];
    const styles = cspDirective(csp, 'style-src') ?? [];
    if (info.inlineScripts.length !== 1 || scripts.join(' ') !== cspHash(info.inlineScripts[0] ?? '')) {
      problems.push('neutral page: {{CSP_N}} script hash does not match its inline script');
    }
    if (info.styles.length !== 1 || styles.join(' ') !== cspHash(info.styles[0] ?? '')) {
      problems.push('neutral page: {{CSP_N}} style hash does not match its inline style');
    }
    const api = cspDirective(opts.cfg.cspGate, 'connect-src')?.[0];
    if (api && neutral.includes(api)) problems.push('neutral page: names the API origin');
    if (/https?:\/\//.test(neutral)) problems.push('neutral page: contains an absolute URL');
  }
  let pages = 0;
  // Whole words, case-insensitive ("Lea" must not match "Please" or "Clear-Site-Data").
  const factPatterns = (opts.facts ?? []).map((fact) => ({
    fact,
    re: new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(fact)}(?![\\p{L}\\p{N}_])`, 'iu'),
  }));
  for (const rel of all) {
    const text = TEXT_FILE.test(rel)
      ? ((await readText(join(gateOutDir, rel))) ?? '')
      : (await fsp.readFile(join(gateOutDir, rel))).toString('latin1');
    if (rel.endsWith('.html')) pages++;
    const word = FORBIDDEN_WORD_RE.exec(text);
    if (word) problems.push(`${rel}: contains the word "${word[0]}"`);
    // The root .htaccess must name the content folder and is never served (the dot rule and the
    // server's .ht* deny): it is no public surface, so it is exempt from the facts (not the words).
    if (rel !== '.htaccess') {
      for (const f of factPatterns) if (f.re.test(text)) problems.push(`${rel}: leaks "${f.fact}"`);
    }
    if (/^_\/(?:join|info|wait|ended|me|panic)\/index\.html$/.test(rel)) {
      const boot = inspectHtml(text).dataScripts.find((d) => d.id === 'omw-gate');
      const r = boot ? GateBoot.safeParse(JSON.parse(boot.body)) : null;
      if (!r?.success) problems.push(`${rel}: GateBoot missing or invalid`);
      else if (r.data.page !== rel.split('/')[1]) problems.push(`${rel}: GateBoot page ${r.data.page}`);
    }
    if (rel.split('/').at(-1) === '.htaccess' && rel !== '.htaccess') {
      problems.push(`${rel}: no other .htaccess may exist in the gate tree`);
    }
  }
  const root = await readText(join(gateOutDir, '.htaccess'));
  if (root !== null) problems.push(...verifyHtaccess(root, 'root', opts.cfg));
  return { problems, files: all.length, pages, media: 0 };
}
