/**
 * Generates src/styles/fonts.css from the installed @fontsource packages and the committed
 * Playpen Sans subsets.
 *
 * Why not just `@import "@fontsource-variable/…/wght.css"`?
 * - The upstream files declare every subset (cyrillic, greek, math, …) and, for Playpen Sans,
 *   monochrome emoji subsets that would override colour emoji in notes.
 * - We only ship the subsets the site needs: latin, latin-ext, vietnamese (Vietnam trips!)
 *   and the arabic/hebrew cuts for RTL locales.
 *
 * The output keeps the upstream @font-face blocks (unicode-range, weights, axes), drops the
 * legacy .woff fallbacks (every supported browser has WOFF2) and rewrites url(./files/x.woff2) to
 * a path relative to src/styles/, so Vite resolves and hashes the files at build time.
 *
 * The Latin handwriting font is the exception: fonts/playpen-sans holds static, feature-trimmed
 * subsets of @fontsource-variable/playpen-sans (scripts/fonts/subset-playpen.sh, about 31 KiB
 * instead of 241 KiB on a German page with Vietnamese place names). Their faces come from that
 * folder's subsets.json, and this script refuses to run when the installed package is not the
 * one the subsets were built from. Re-run after bumping a @fontsource package:
 *
 *   scripts/fonts/subset-playpen.sh      # only when @fontsource-variable/playpen-sans changed
 *   pnpm --filter @omw/ui fonts
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = join(PKG_ROOT, 'src/styles/fonts.css');

interface FontSource {
  /** Package name under node_modules. */
  pkg: string;
  /** CSS file inside the package. */
  file: string;
  /** Subset names to keep (matched against the fontsource block comment). */
  subsets: readonly string[];
  /** Why it is here (written into the output). */
  role: string;
}

/** Faces from a folder written by scripts/fonts/subset-playpen.sh (subsets.json). */
interface LocalSubsets {
  /** Folder relative to the package root. */
  dir: string;
  role: string;
}

const LATIN = ['latin', 'latin-ext', 'vietnamese'] as const;

const SOURCES: readonly (FontSource | LocalSubsets)[] = [
  {
    pkg: '@fontsource-variable/fraunces',
    file: 'soft.css',
    subsets: LATIN,
    role: 'display (wght + SOFT axes)',
  },
  { pkg: '@fontsource-variable/nunito', file: 'wght.css', subsets: LATIN, role: 'body' },
  { pkg: '@fontsource-variable/nunito', file: 'wght-italic.css', subsets: LATIN, role: 'body italic (stories)' },
  { dir: 'fonts/playpen-sans', role: 'hand (notes): static 400/500 subsets, no calt' },
  {
    pkg: '@fontsource-variable/playpen-sans-arabic',
    file: 'wght.css',
    subsets: ['arabic'],
    role: 'hand, Arabic script',
  },
  {
    pkg: '@fontsource-variable/playpen-sans-hebrew',
    file: 'wght.css',
    subsets: ['hebrew'],
    role: 'hand, Hebrew script',
  },
  { pkg: '@fontsource-variable/vazirmatn', file: 'wght.css', subsets: ['arabic'], role: 'RTL UI: Arabic/Persian' },
  { pkg: '@fontsource-variable/rubik', file: 'wght.css', subsets: ['hebrew'], role: 'RTL UI: Hebrew' },
  { pkg: '@fontsource/calistoga', file: 'index.css', subsets: LATIN, role: 'WhatsApp CALISTOGA_REGULAR' },
  { pkg: '@fontsource-variable/exo-2', file: 'wght.css', subsets: LATIN, role: 'WhatsApp EXO2_EXTRABOLD' },
  {
    pkg: '@fontsource/courier-prime',
    file: '700.css',
    subsets: ['latin', 'latin-ext'],
    role: 'WhatsApp COURIERPRIME_BOLD',
  },
];

const BLOCK_RE = /\/\*\s*([^*]+?)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g;

function subsetOf(blockName: string, pkgId: string): string | null {
  // Block names look like "<id>-<subset>-<axis|weight>-<style>", e.g. "fraunces-latin-ext-soft-normal".
  if (!blockName.startsWith(`${pkgId}-`)) return null;
  const rest = blockName.slice(pkgId.length + 1).split('-');
  rest.pop(); // style
  rest.pop(); // axis or weight
  return rest.join('-');
}

function renderFontsource(source: FontSource, outDir: string): string[] {
  const pkgDir = join(PKG_ROOT, 'node_modules', source.pkg);
  const css = readFileSync(join(pkgDir, source.file), 'utf8');
  const pkgId = source.pkg.split('/')[1] ?? source.pkg;
  const kept: string[] = [];
  const found = new Set<string>();
  for (const match of css.matchAll(BLOCK_RE)) {
    const [, name = '', block = ''] = match;
    const subset = subsetOf(name, pkgId);
    if (subset === null) continue;
    found.add(subset);
    if (!source.subsets.includes(subset)) continue;
    const rel = relative(outDir, pkgDir).split('\\').join('/');
    const woff2Only = block.replace(/,\s*url\([^)]*\.woff\)\s*format\('woff'\)/g, '');
    kept.push(`/* ${name} */\n${woff2Only.replace(/url\(\.\/files\//g, `url(${rel}/files/`)}`);
  }
  const missing = source.subsets.filter((s) => !found.has(s));
  if (missing.length > 0) {
    throw new Error(`${source.pkg}/${source.file}: missing subsets ${missing.join(', ')}`);
  }
  return ['', `/* ---- ${source.pkg}/${source.file}: ${source.role} ---- */`, '', kept.join('\n\n')];
}

/** The subsets.json written by scripts/fonts/subset-playpen.py. */
interface SubsetManifest {
  family: string;
  source: { package: string; version: string; files: Record<string, string> };
  files: { file: string; subset: string; weight: number; sha256: string; unicodeRange: string }[];
}

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function readManifest(dir: string): SubsetManifest {
  const manifest = JSON.parse(readFileSync(join(dir, 'subsets.json'), 'utf8')) as SubsetManifest;
  const ok =
    typeof manifest.family === 'string' &&
    typeof manifest.source?.package === 'string' &&
    Array.isArray(manifest.files) &&
    manifest.files.every(
      (f) =>
        /^[a-z0-9-]+\.woff2$/.test(f.file) &&
        Number.isInteger(f.weight) &&
        /^U\+[0-9A-F]{4,6}(?:-[0-9A-F]{4,6})?(?:,U\+[0-9A-F]{4,6}(?:-[0-9A-F]{4,6})?)*$/.test(f.unicodeRange),
    );
  if (!ok) throw new Error(`${dir}/subsets.json: unexpected shape`);
  return manifest;
}

function renderLocal(source: LocalSubsets, outDir: string): string[] {
  const dir = join(PKG_ROOT, source.dir);
  const manifest = readManifest(dir);
  // The subsets must come from the installed package: a bump needs scripts/fonts/subset-playpen.sh.
  const pkgDir = join(PKG_ROOT, 'node_modules', manifest.source.package);
  for (const [file, hash] of Object.entries(manifest.source.files)) {
    if (sha256(join(pkgDir, 'files', file)) !== hash) {
      throw new Error(
        `${source.dir} was built from another ${manifest.source.package} (${file} changed): run scripts/fonts/subset-playpen.sh`,
      );
    }
  }
  const rel = relative(outDir, dir).split('\\').join('/');
  const blocks = manifest.files.map((f) => {
    if (sha256(join(dir, f.file)) !== f.sha256) {
      throw new Error(`${source.dir}/${f.file} does not match subsets.json: run scripts/fonts/subset-playpen.sh`);
    }
    return [
      `/* ${f.file.replace(/\.woff2$/, '')} */`,
      '@font-face {',
      `  font-family: '${manifest.family}';`,
      '  font-style: normal;',
      '  font-display: swap;',
      `  font-weight: ${f.weight};`,
      `  src: url(${rel}/${f.file}) format('woff2');`,
      `  unicode-range: ${f.unicodeRange};`,
      '}',
    ].join('\n');
  });
  return [
    '',
    `/* ---- ${source.dir} (${manifest.source.package} ${manifest.source.version}, scripts/fonts/subset-playpen.sh): ${source.role} ---- */`,
    '',
    blocks.join('\n\n'),
  ];
}

function render(): string {
  const outDir = dirname(OUT_FILE);
  const parts: string[] = [
    '/*',
    ' * GENERATED by scripts/build-fonts-css.ts from the installed @fontsource packages and the',
    ' * Playpen Sans subsets in fonts/playpen-sans. Do not edit.',
    ' * Only the subsets the site needs are declared; browsers download a file only when a',
    ' * character in its unicode-range is rendered with that family and weight.',
    ' */',
  ];
  for (const source of SOURCES) {
    parts.push(...('dir' in source ? renderLocal(source, outDir) : renderFontsource(source, outDir)));
  }
  return `${parts.join('\n')}\n`;
}

const output = render();
if (process.argv.includes('--check')) {
  const current = readFileSync(OUT_FILE, 'utf8');
  if (current !== output) {
    console.error('src/styles/fonts.css is out of date: run `pnpm --filter @omw/ui fonts`.');
    process.exit(1);
  }
  console.log('src/styles/fonts.css is up to date.');
} else {
  writeFileSync(OUT_FILE, output);
  console.log(`Wrote ${relative(process.cwd(), OUT_FILE)} (${output.length} bytes).`);
}
