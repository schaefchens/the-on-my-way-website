/**
 * The gate tree (spec-wave5 §2.1, §5.4; gate mode only): the public files at the web root of the
 * site host, generated into GATE_OUT_DIR (a sibling of OUT_DIR). The publisher uploads it to the
 * target's gateRoot with /.htaccess last (publisher/gate.ts); the content tree (OUT_DIR) goes to
 * /<secret>/.
 *
 *   /.htaccess                root rules (extras.ts rootHtaccess)
 *   /index.html, /_/index.html, /_/n/index.html   the neutral page (same bytes)
 *   /robots.txt, /favicon.svg, /_/403.txt
 *   /_/{join,info,wait,ended,me,panic}/index.html  gate pages with GateBoot
 *   /_/assets/**              the gate bundle (frontend/site/dist/gate/assets/**)
 *
 * Nothing here names the content folder or carries personal data; verify.ts verifyGateTree()
 * checks it (leak test, allowed files, CSP hashes, .htaccess exactness).
 */
import { promises as fsp } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gateCookies, type SiteAccessConfig } from '@omw/contracts/access';
import type { LocaleCode } from '@omw/contracts/i18n';
import { type GateHtaccessConfig, rootHtaccess } from './extras.js';
import {
  FORBIDDEN_TXT,
  GATE_FAVICON_SVG,
  GATE_PAGES,
  GATE_ROBOTS_TXT,
  gateCsp,
  gatePage,
  neutralCsp,
  neutralPage,
} from './gate-pages.js';
import { contentHash } from './hash.js';
import { readIfExists, removeOutput, writeAtomic } from './output.js';
import type { GateBuild } from './site-build.js';

/** What the gate tree depends on (all of it is part of the generator state hash). */
export interface GateTreeContext {
  site: SiteAccessConfig & { storeDir: string };
  /** The content folder ("<secret>"). */
  secret: string;
  locales: readonly LocaleCode[];
  defaultLocale: LocaleCode;
  build: GateBuild;
}

/** The fixed (non-bundle) files of the gate tree, in upload order (§5.6.2). */
export const GATE_FIXED_FILES = [
  '_/n/index.html',
  '_/index.html',
  '_/403.txt',
  ...GATE_PAGES.map((p) => `_/${p}/index.html`),
  'robots.txt',
  'favicon.svg',
  'index.html',
  '.htaccess',
] as const;

/** The .htaccess configuration of a gate-mode site (gate block, cookie section, CSPs). */
export function gateHtaccessConfig(site: SiteAccessConfig, secret: string): GateHtaccessConfig {
  if (!site.storeDir) throw new RangeError('gate mode needs storeDir (ACCESS_STORE_DIR)');
  const cookies = gateCookies(site.siteOrigin, site.cookieMode);
  const origin = new URL(site.siteOrigin);
  return {
    storeDir: site.storeDir,
    secret,
    host: origin.hostname,
    cookieMode: site.cookieMode,
    cookies,
    httpsRedirect: site.httpsRedirect && origin.protocol === 'https:',
    hsts: origin.protocol === 'https:',
    cspNeutral: neutralCsp(cookies),
    cspGate: gateCsp(new URL(site.apiPublicBase).origin),
  };
}

/** GateBoot.cookieDomain / Boot.access.cookieDomain: null in headers mode (host-only cookies). */
export function cookieDomainOf(site: SiteAccessConfig): string | null {
  return site.cookieMode === 'headers' ? null : (site.cookieDomain ?? null);
}

/** Every file of the gate tree: GATE_OUT_DIR-relative path → bytes (bundle files as Buffers). */
export async function renderGateTree(ctx: GateTreeContext): Promise<Map<string, string | Buffer>> {
  const cfg = gateHtaccessConfig(ctx.site, ctx.secret);
  const cookies = gateCookies(ctx.site.siteOrigin, ctx.site.cookieMode);
  const neutral = neutralPage(ctx.defaultLocale, cookies);
  const files = new Map<string, string | Buffer>();
  // The bundle first (pages reference it), then the pages, the root files and /.htaccess last.
  for (const rel of ctx.build.files) files.set(`_/${rel}`, await fsp.readFile(join(ctx.build.dir, rel)));
  files.set('_/n/index.html', neutral);
  files.set('_/index.html', neutral);
  files.set('_/403.txt', FORBIDDEN_TXT);
  const pageCtx = {
    api: ctx.site.apiPublicBase,
    locales: ctx.locales,
    defaultLocale: ctx.defaultLocale,
    cookies,
    cookieMode: ctx.site.cookieMode,
    cookieDomain: cookieDomainOf(ctx.site),
    build: ctx.build,
  };
  for (const page of GATE_PAGES) files.set(`_/${page}/index.html`, gatePage(page, pageCtx));
  files.set('robots.txt', GATE_ROBOTS_TXT);
  files.set('favicon.svg', GATE_FAVICON_SVG);
  files.set('index.html', neutral);
  files.set('.htaccess', rootHtaccess(cfg));
  return files;
}

/** Hash of everything the gate tree depends on (generator state; a change forces a full run). */
export function gateTreeKey(ctx: GateTreeContext): string {
  return contentHash({
    site: ctx.site,
    secret: ctx.secret,
    locales: ctx.locales,
    defaultLocale: ctx.defaultLocale,
    build: ctx.build.hash,
  });
}

async function listTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  await walk(dir);
  return out.sort();
}

export interface GateWriteResult {
  /** GATE_OUT_DIR-relative paths written (bytes changed). */
  changed: string[];
  /** Stray files removed (full runs only). */
  removed: string[];
}

/**
 * Writes the gate tree atomically into GATE_OUT_DIR, skipping files whose bytes are unchanged;
 * on full runs every other file there is removed (the directory belongs to the generator).
 */
export async function writeGateTree(
  gateOutDir: string,
  files: ReadonlyMap<string, string | Buffer>,
  opts: { full: boolean },
): Promise<GateWriteResult> {
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [rel, bytes] of files) {
    const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
    const existing = await readIfExists(gateOutDir, rel);
    if (existing?.equals(buf)) continue;
    await writeAtomic(gateOutDir, rel, buf);
    changed.push(rel);
  }
  if (opts.full) {
    for (const rel of await listTree(gateOutDir)) {
      if (!files.has(rel) && (await removeOutput(gateOutDir, rel))) removed.push(rel);
    }
  }
  return { changed: changed.sort(), removed: removed.sort() };
}
