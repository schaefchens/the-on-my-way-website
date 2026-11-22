/**
 * The built public SPA (frontend/site/dist, Vite base './'): reads dist/.vite/manifest.json
 * (entry "index.html") for the tags every page needs, and copies the hashed build files to
 * OUT_DIR/assets (D3: the generator writes absolute, basePath-prefixed URLs).
 *
 * - script: the entry chunk; css: CSS of the entry and its static imports; modulepreload: the
 *   entry's static imports (recursively). Lazy chunks and fonts are referenced relative to the
 *   importing file and need nothing.
 * - Copied: dist/assets/** except source maps, plus a few well-known top-level icons
 *   (favicon.svg/.ico, apple-touch-icon.png). dist/index.html is never used (it only works at /).
 * - `hash` identifies the build (sha of the Vite manifest); a new build triggers a full run.
 */
import { promises as fsp, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { shortSha } from './hash.js';

export class SiteBuildError extends Error {
  override name = 'SiteBuildError';
}

const Chunk = z.object({
  file: z.string().regex(/^[A-Za-z0-9._~\-/]+$/),
  name: z.string().optional(),
  src: z.string().optional(),
  isEntry: z.boolean().optional(),
  isDynamicEntry: z.boolean().optional(),
  imports: z.array(z.string()).optional(),
  dynamicImports: z.array(z.string()).optional(),
  css: z.array(z.string()).optional(),
  assets: z.array(z.string()).optional(),
});
const ViteManifest = z.record(z.string(), Chunk);

const TOP_LEVEL_ICONS = ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png'] as const;

export interface SiteBuild {
  dir: string;
  hash: string;
  /** Site-relative paths ("assets/index-abc.js"). */
  script: string;
  css: string[];
  modulepreload: string[];
  /** Latin body/display fonts worth preloading for LTR pages. */
  fontPreload: string[];
  /** Vietnamese subsets of the body/display fonts (preloaded only on pages with Vietnamese text). */
  fontVietnamese: string[];
  /**
   * The handwriting face (Playpen Sans, weight 400): its Latin and its Vietnamese subset,
   * preloaded only where hand-font text is on the first screen (pages.ts handFontText).
   */
  fontHand: { latin: string[]; vietnamese: string[] };
  /**
   * Lazy chunks a page knows it needs right away (L3-01), each with its static imports minus what
   * the entry already loads: the Lingui catalog per locale ("de" -> [messages-….js]), the journey
   * player (day and story pages) and the story sheet (story pages).
   */
  localeChunks: Record<string, string[]>;
  playerChunks: string[];
  storySheetChunks: string[];
  /** Site-relative paths of every file to copy into OUT_DIR. */
  files: string[];
  favicon: { path: string; type: string } | null;
}

export const DEFAULT_ENTRY = 'index.html';

function checkRel(path: string): string {
  if (path.startsWith('/') || path.includes('..') || !/^[A-Za-z0-9._~\-/]+$/.test(path)) {
    throw new SiteBuildError(`Unexpected path in Vite manifest: ${path}`);
  }
  return path;
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, root, out);
    else if (e.isFile()) out.push(relative(root, full).split(sep).join('/'));
  }
}

export async function readSiteBuild(dir: string, entryKey = DEFAULT_ENTRY): Promise<SiteBuild> {
  const manifestPath = join(dir, '.vite', 'manifest.json');
  let bytes: Buffer;
  try {
    bytes = readFileSync(manifestPath);
  } catch {
    throw new SiteBuildError(
      `Site build not found (${manifestPath}). Build it with: pnpm --filter @omw/site build (or pass siteDistDir)`,
    );
  }
  const parsed = ViteManifest.safeParse(JSON.parse(bytes.toString('utf8')));
  if (!parsed.success) throw new SiteBuildError(`Invalid Vite manifest: ${z.prettifyError(parsed.error)}`);
  const manifest = parsed.data;
  const entry = manifest[entryKey];
  if (!entry?.isEntry) throw new SiteBuildError(`Vite manifest has no entry "${entryKey}"`);

  const css: string[] = [];
  const preload: string[] = [];
  const seen = new Set<string>();
  const visit = (key: string, isEntry: boolean) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new SiteBuildError(`Vite manifest references missing chunk "${key}"`);
    if (!isEntry) preload.push(checkRel(chunk.file));
    for (const c of chunk.css ?? []) if (!css.includes(c)) css.push(checkRel(c));
    for (const imp of chunk.imports ?? []) visit(imp, false);
  };
  visit(entryKey, true);

  const files: string[] = [];
  await walk(join(dir, 'assets'), dir, files);
  const assetFiles = files.filter((f) => !f.endsWith('.map')).sort();
  for (const f of [entry.file, ...css, ...preload]) {
    if (!assetFiles.includes(f)) throw new SiteBuildError(`Build file missing in ${dir}: ${f}`);
  }
  let favicon: SiteBuild['favicon'] = null;
  for (const icon of TOP_LEVEL_ICONS) {
    try {
      await fsp.access(join(dir, icon));
      assetFiles.push(icon);
      if (!favicon && icon !== 'apple-touch-icon.png') {
        favicon = { path: icon, type: icon.endsWith('.svg') ? 'image/svg+xml' : 'image/x-icon' };
      }
    } catch {
      // not part of this build
    }
  }
  const fontPreload = (entry.assets ?? [])
    .filter((a) => /^assets\/(?:nunito-latin-wght-normal|fraunces-latin-soft-normal)-[\w-]+\.woff2$/.test(a))
    .map(checkRel)
    .sort();
  const fontVietnamese = (entry.assets ?? [])
    .filter((a) => /^assets\/(?:nunito-vietnamese-wght-normal|fraunces-vietnamese-soft-normal)-[\w-]+\.woff2$/.test(a))
    .map(checkRel)
    .sort();
  const fontHand = {
    latin: (entry.assets ?? [])
      .filter((a) => /^assets\/playpen-sans-latin-400-[\w-]+\.woff2$/.test(a))
      .map(checkRel)
      .sort(),
    vietnamese: (entry.assets ?? [])
      .filter((a) => /^assets\/playpen-sans-vietnamese-400-[\w-]+\.woff2$/.test(a))
      .map(checkRel)
      .sort(),
  };
  // A lazy chunk plus its static imports, without what the entry loads anyway.
  const loaded = new Set([entry.file, ...preload]);
  const lazyChunk = (key: string): string[] => {
    const out: string[] = [];
    const seenLazy = new Set<string>([entryKey]);
    const walkLazy = (k: string) => {
      if (seenLazy.has(k)) return;
      seenLazy.add(k);
      const chunk = manifest[k];
      if (!chunk) return;
      if (!loaded.has(chunk.file)) out.push(checkRel(chunk.file));
      for (const imp of chunk.imports ?? []) walkLazy(imp);
    };
    walkLazy(key);
    return out;
  };
  const localeChunks: Record<string, string[]> = {};
  for (const key of Object.keys(manifest)) {
    const m = /^src\/locales\/([a-z]{2,3})\/messages\.[a-z]+$/.exec(key);
    if (m?.[1]) localeChunks[m[1]] = lazyChunk(key);
  }

  return {
    dir,
    hash: shortSha(bytes),
    script: checkRel(entry.file),
    css,
    modulepreload: preload,
    fontPreload,
    fontVietnamese,
    fontHand,
    localeChunks,
    playerChunks: manifest['src/player/index.ts'] ? lazyChunk('src/player/index.ts') : [],
    storySheetChunks: manifest['src/player/story-sheet.tsx'] ? lazyChunk('src/player/story-sheet.tsx') : [],
    files: assetFiles.sort(),
    favicon,
  };
}

/** Files below OUT_DIR/assets (site-relative) plus top-level icons that exist. */
export async function scanAssets(outDir: string): Promise<Set<string>> {
  const files: string[] = [];
  await walk(join(outDir, 'assets'), outDir, files);
  // Leftover temp files of a crashed run are included, so full runs remove them (runs are
  // serialised, so no temp file of a live write can be here).
  const out = new Set(files);
  for (const icon of TOP_LEVEL_ICONS) {
    try {
      await fsp.access(join(outDir, icon));
      out.add(icon);
    } catch {
      // absent
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Gate bundle (spec-wave5 §5.4, §6.1)

/** Vite manifest entry of the gate bundle (frontend/site/vite.gate.config.ts). */
export const GATE_ENTRY = 'src/gate/main.ts';

/** The built gate bundle (frontend/site/dist/gate) the gate pages load from /_/assets/. */
export interface GateBuild {
  dir: string;
  /** Short sha of the Vite manifest (GateBoot.build; part of the generator state hash). */
  hash: string;
  /** Build-relative paths ("assets/gate-abc.js"). */
  script: string;
  css: string[];
  /** Static imports of the entry (modulepreload). */
  modulepreload: string[];
  /** Every file to copy to /_/assets/ (build-relative "assets/…", no source maps). */
  files: string[];
}

/**
 * Reads <siteDistDir>/gate/.vite/manifest.json (entry "src/gate/main.ts": file, css[], imported
 * chunks). SiteBuildError when it is missing or inconsistent (gate mode cannot generate without
 * it; WP3's `pnpm --filter @omw/site build` produces it).
 */
export async function readGateBuild(siteDistDir: string): Promise<GateBuild> {
  const dir = join(siteDistDir, 'gate');
  const manifestPath = join(dir, '.vite', 'manifest.json');
  let bytes: Buffer;
  try {
    bytes = readFileSync(manifestPath);
  } catch {
    throw new SiteBuildError(
      `Gate bundle not found (${manifestPath}). Build it with: pnpm --filter @omw/site build (ACCESS_MODE=gate needs it)`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new SiteBuildError(`Invalid gate Vite manifest (${manifestPath}): not JSON`);
  }
  const parsed = ViteManifest.safeParse(raw);
  if (!parsed.success) throw new SiteBuildError(`Invalid gate Vite manifest: ${z.prettifyError(parsed.error)}`);
  const manifest = parsed.data;
  const entry = manifest[GATE_ENTRY];
  if (!entry?.isEntry) throw new SiteBuildError(`Gate Vite manifest has no entry "${GATE_ENTRY}"`);
  const css: string[] = [];
  const preload: string[] = [];
  const seen = new Set<string>();
  const visit = (key: string, isEntry: boolean) => {
    if (seen.has(key)) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new SiteBuildError(`Gate Vite manifest references missing chunk "${key}"`);
    if (!isEntry) preload.push(checkRel(chunk.file));
    for (const c of chunk.css ?? []) if (!css.includes(c)) css.push(checkRel(c));
    for (const imp of chunk.imports ?? []) visit(imp, false);
  };
  visit(GATE_ENTRY, true);
  const all: string[] = [];
  await walk(join(dir, 'assets'), dir, all);
  const files = all.filter((f) => !f.endsWith('.map')).sort();
  for (const f of [entry.file, ...css, ...preload]) {
    if (!files.includes(f)) throw new SiteBuildError(`Gate build file missing in ${dir}: ${f}`);
  }
  for (const f of files) checkRel(f);
  return { dir, hash: shortSha(bytes), script: checkRel(entry.file), css, modulepreload: preload, files };
}
