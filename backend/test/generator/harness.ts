/**
 * Test harness for the generator: temp dirs inside the repo (.cache/tmp), a small fake Vite
 * build (so unit tests never race with concurrent site builds), a fixture-seeded store with a
 * controllable clock, and helpers to snapshot/compare OUT_DIR trees.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { type Config, loadConfig } from '../../src/config.js';
import { type SeedResult, seedFromFixtures } from '../../src/generator/dev/fixtures.js';
import { createGenerator, type Generator } from '../../src/generator/index.js';
import { type PreviewServer, startPreviewServer } from '../../src/generator/serve.js';
import { createLogger } from '../../src/log.js';
import { Store } from '../../src/store/index.js';
import { fakeClock, makeTempDir } from '../helpers.js';

export const NOW = '2026-11-19T12:00:00.000Z';

export interface FakeBuildOptions {
  version?: string;
  /**
   * Also the lazy chunks the generator preloads (locale catalogs, the player, the story sheet)
   * and the Vietnamese/Playpen font subsets, like the real Vite manifest.
   */
  lazy?: boolean;
}

/** Writes a minimal Vite build: entry + static import + CSS + a font + a source map. */
export function writeFakeSiteBuild(dir: string, opts: FakeBuildOptions = {}): void {
  const v = opts.version ?? 'a1';
  const files: Record<string, string> = {
    [`assets/index-${v}x1.js`]: `import './shared-${v}x2.js';console.log('app ${v}');\n`,
    [`assets/index-${v}x1.js.map`]: '{"version":3}\n',
    [`assets/shared-${v}x2.js`]: `export const shared = '${v}';\n`,
    [`assets/index-${v}x3.css`]: `body{color:#3b2341}/*${v}*/\n`,
    [`assets/shared-${v}x4.css`]: `.x{color:red}/*${v}*/\n`,
    'assets/nunito-latin-wght-normal-Zz9.woff2': 'woff2',
    'assets/rubik-hebrew-wght-normal-Yy8.woff2': 'woff2',
    'index.html': '<!doctype html><title>vite preview only</title>',
  };
  const manifest: Record<string, unknown> = {
    'index.html': {
      file: `assets/index-${v}x1.js`,
      name: 'index',
      src: 'index.html',
      isEntry: true,
      imports: ['_shared.js'],
      css: [`assets/index-${v}x3.css`],
      assets: ['assets/nunito-latin-wght-normal-Zz9.woff2', 'assets/rubik-hebrew-wght-normal-Yy8.woff2'],
    },
    '_shared.js': { file: `assets/shared-${v}x2.js`, css: [`assets/shared-${v}x4.css`] },
  };
  if (opts.lazy) {
    Object.assign(files, {
      'assets/messages-de1.js': 'export const messages = {};\n',
      'assets/messages-en1.js': 'export const messages = {};\n',
      'assets/player-p1.js': "import './shared-a1x2.js';import './motion-m1.js';\n",
      'assets/motion-m1.js': 'export const motion = 1;\n',
      'assets/story-sheet-s1.js': "import './motion-m1.js';\n",
      'assets/nunito-vietnamese-wght-normal-Vn1.woff2': 'woff2',
      'assets/fraunces-vietnamese-soft-normal-Vf1.woff2': 'woff2',
      'assets/fraunces-latin-soft-normal-Fl1.woff2': 'woff2',
      'assets/playpen-sans-vietnamese-400-Pv1.woff2': 'woff2',
      'assets/playpen-sans-latin-400-Pl1.woff2': 'woff2',
      'assets/playpen-sans-latin-500-Pl5.woff2': 'woff2',
    });
    const entry = manifest['index.html'] as { assets: string[]; dynamicImports?: string[] };
    entry.assets.push(
      'assets/fraunces-latin-soft-normal-Fl1.woff2',
      'assets/nunito-vietnamese-wght-normal-Vn1.woff2',
      'assets/fraunces-vietnamese-soft-normal-Vf1.woff2',
      'assets/playpen-sans-vietnamese-400-Pv1.woff2',
      'assets/playpen-sans-latin-400-Pl1.woff2',
      'assets/playpen-sans-latin-500-Pl5.woff2',
    );
    entry.dynamicImports = ['src/locales/de/messages.po', 'src/player/index.ts'];
    Object.assign(manifest, {
      'src/locales/de/messages.po': {
        file: 'assets/messages-de1.js',
        src: 'src/locales/de/messages.po',
        isDynamicEntry: true,
      },
      'src/locales/en/messages.po': {
        file: 'assets/messages-en1.js',
        src: 'src/locales/en/messages.po',
        isDynamicEntry: true,
      },
      'src/player/index.ts': {
        file: 'assets/player-p1.js',
        src: 'src/player/index.ts',
        isDynamicEntry: true,
        imports: ['index.html', '_shared.js', '_motion.js'],
      },
      '_motion.js': { file: 'assets/motion-m1.js' },
      'src/player/story-sheet.tsx': {
        file: 'assets/story-sheet-s1.js',
        src: 'src/player/story-sheet.tsx',
        isDynamicEntry: true,
        imports: ['_motion.js', 'index.html'],
      },
    });
  }
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  mkdirSync(join(dir, '.vite'), { recursive: true });
  writeFileSync(join(dir, '.vite', 'manifest.json'), JSON.stringify(manifest, null, 2));
}

export interface Harness {
  dir: string;
  config: Config;
  store: Store;
  clock: ReturnType<typeof fakeClock>;
  generator: Generator;
  seed: SeedResult;
  siteDist: string;
  outDir: string;
  mediaDir: string;
  /** Another generator on the same store writing to a different OUT_DIR. */
  generatorFor(outDir: string): Generator;
  cleanup(): void;
}

export interface HarnessOptions {
  publicUrl?: string | null;
  captions?: Record<string, string>;
  owner?: boolean;
  media?: 'dummy' | 'real';
  mediaDir?: string;
  siteDist?: string;
  outDir?: string;
  htaccess?: boolean;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const tmp = makeTempDir('generator-');
  const dirs = {
    data: join(tmp.dir, 'state'),
    out: opts.outDir ?? join(tmp.dir, 'out'),
    media: opts.mediaDir ?? join(tmp.dir, 'media'),
    dist: opts.siteDist ?? join(tmp.dir, 'dist'),
  };
  if (!opts.siteDist) writeFakeSiteBuild(dirs.dist);
  const publicUrl = opts.publicUrl === undefined ? 'https://example.org/' : opts.publicUrl;
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: dirs.data,
    OUT_DIR: dirs.out,
    MEDIA_DIR: dirs.media,
    ARCHIVE_DIR: join(tmp.dir, 'archive'),
    CONFIG_DIR: join(tmp.dir, 'config'),
    ...(publicUrl ? { SITE_PUBLIC_URL: publicUrl } : {}),
  });
  const clock = fakeClock(NOW);
  const store = Store.memory({ now: clock });
  const seed = await seedFromFixtures({
    store,
    mediaDir: dirs.media,
    media: opts.media ?? 'dummy',
    ...(opts.captions ? { captions: opts.captions } : {}),
    ...(opts.owner === false ? { owner: false } : {}),
  });
  const log = createLogger({ level: 'silent' });
  const make = (outDir: string) =>
    createGenerator({
      config: { ...config, dirs: { ...config.dirs, out: outDir } },
      log,
      store,
      now: clock,
      siteDistDir: dirs.dist,
      validate: true,
      ...(opts.htaccess === undefined ? {} : { htaccess: opts.htaccess }),
    });
  return {
    dir: tmp.dir,
    config,
    store,
    clock,
    generator: make(dirs.out),
    seed,
    siteDist: dirs.dist,
    outDir: dirs.out,
    mediaDir: dirs.media,
    generatorFor: make,
    cleanup: () => {
      store.close();
      tmp.cleanup();
    },
  };
}

/** path -> sha256 of every file below `dir`. */
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else
        out[relative(dir, full).split(sep).join('/')] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function readOut(h: { outDir: string }, rel: string): string {
  return readFileSync(join(h.outDir, rel), 'utf8');
}

export function readJson<T = unknown>(h: { outDir: string }, rel: string): T {
  return JSON.parse(readOut(h, rel)) as T;
}

export function bootOf(page: string): Record<string, unknown> {
  const m = /<script id="omw-boot" type="application\/json">([\s\S]*?)<\/script>/.exec(page);
  if (!m?.[1]) throw new Error('no boot JSON');
  return JSON.parse(m[1]) as Record<string, unknown>;
}

export function copyTree(from: string, to: string): void {
  cpSync(from, to, { recursive: true });
}

/**
 * Starts the preview server on the first free port of `ports` (all inside the backend test port
 * range 19200-19219). Other processes may run the same test files concurrently.
 */
export async function startPreviewInRange(
  ports: readonly number[],
  opts: { dir: string; basePath?: string },
): Promise<PreviewServer & { port: number }> {
  let last: unknown;
  for (const port of ports) {
    try {
      return { ...(await startPreviewServer({ ...opts, port })), port };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      last = err;
    }
  }
  throw last ?? new Error('no port');
}
