/**
 * Mirrors the site's design tokens (frontend/shared) into the app as a JSON snapshot:
 * src/theme/tokens.generated.json. A test fails when the snapshot is stale, so a token change on
 * the site shows up here (app-plan §3.5: a snapshot instead of a shared package while waves 4/5
 * edit frontend/shared).
 *
 *   pnpm --filter @omw/app tokens          # write
 *   pnpm --filter @omw/app tokens:check    # exit 1 if stale
 *
 * Sources: styles/theme.css (semantic light-dark() pairs, raw palette, radii, spacing, shadows),
 * motion.ts (SPRINGS, converted to stiffness/damping with mass 1, as Motion does for
 * visualDuration + bounce) and fonts.ts (WA_FONTS -> the app's embedded families).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shared = resolve(here, '../../shared/src');
const outFile = resolve(here, '../src/theme/tokens.generated.json');

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** "rgb(156 58 94 / 0.07)" -> "rgba(156, 58, 94, 0.07)" (React Native's colour parser). */
function rnColor(css: string): string {
  const m = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(css.trim());
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${m[4]})` : css.trim();
}

function parseTheme(css: string) {
  const semantic: Record<'dawn' | 'dusk', Record<string, string>> = { dawn: {}, dusk: {} };
  for (const m of css.matchAll(
    /--omw-([a-z0-9-]+):\s*light-dark\(\s*([^,]+?|rgb\([^)]*\))\s*,\s*([^;]+?|rgb\([^)]*\))\s*\);/g,
  )) {
    const [, name, dawn, dusk] = m;
    if (!name || !dawn || !dusk) continue;
    const key = name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    semantic.dawn[key] = rnColor(dawn);
    semantic.dusk[key] = rnColor(dusk);
  }
  const palette: Record<string, string> = {};
  for (const m of css.matchAll(/--color-([a-z]+(?:-\d+)?):\s*(#[0-9a-f]{6});/g)) {
    if (m[1] && m[2]) palette[m[1]] = m[2];
  }
  const rem = (name: string, group: string): number => {
    const m = new RegExp(`--${group}-${name}:\\s*([\\d.]+)(rem|px);`).exec(css);
    if (!m?.[1]) throw new Error(`--${group}-${name} not found in theme.css`);
    return m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]);
  };
  const radii = Object.fromEntries(['tile', 'card', 'sheet'].map((n) => [n, rem(n, 'radius')]));
  const spacing = Object.fromEntries(
    ['gutter', 'gutter-wide', 'section'].map((n) => [n.replace('-w', 'W'), rem(n, 'spacing')]),
  );
  const shadows: Record<'dawn' | 'dusk', Record<string, string>> = { dawn: {}, dusk: {} };
  for (const m of css.matchAll(/--shadow-([a-z]+):\s*([^;]+);/g)) {
    const [, name, value] = m;
    if (!name || !value) continue;
    for (const theme of ['dawn', 'dusk'] as const) {
      shadows[theme][name] = value
        .replace(/var\(--omw-shadow-near\)/g, semantic[theme].shadowNear ?? '')
        .replace(/var\(--omw-shadow-far\)/g, semantic[theme].shadowFar ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }
  if (Object.keys(semantic.dawn).length < 15) throw new Error('theme.css: semantic tokens not found');
  return { semantic, palette, radii, spacing, shadows };
}

/** Motion's visualDuration + bounce -> spring physics (motion-dom `spring`, mass 1). */
function springPhysics(visualDuration: number, bounce: number) {
  const root = (2 * Math.PI) / (visualDuration * 1.2);
  const stiffness = root * root;
  const dampingRatio = Math.min(1, Math.max(0.05, 1 - bounce));
  const damping = 2 * dampingRatio * Math.sqrt(stiffness);
  const round = (n: number) => Math.round(n * 100) / 100;
  return { stiffness: round(stiffness), damping: round(damping), mass: 1, dampingRatio: round(dampingRatio) };
}

/** The app's embedded families (app.config.ts expo-font) for the site's hosted faces. */
const APP_FAMILY: Record<string, string> = {
  'Playpen Sans Variable': 'PlaypenSans',
  'Nunito Variable': 'Nunito',
  Calistoga: 'Calistoga',
  'Exo 2 Variable': 'Exo2',
  'Courier Prime': 'CourierPrime',
};

export async function buildTokens(): Promise<string> {
  const themeCss = readFileSync(resolve(shared, 'styles/theme.css'), 'utf8');
  const motionSrc = readFileSync(resolve(shared, 'motion.ts'), 'utf8');
  const fontsSrc = readFileSync(resolve(shared, 'fonts.ts'), 'utf8');
  // Runtime imports (tsx): the modules' own values, without the app depending on @omw/ui.
  const motion = (await import(pathToFileURL(resolve(shared, 'motion.ts')).href)) as {
    SPRINGS: Record<string, { visualDuration: number; bounce: number }>;
  };
  const fonts = (await import(pathToFileURL(resolve(shared, 'fonts.ts')).href)) as {
    WA_FONTS: Record<string, { cssVar: string; weight: number; hosted: string | null }>;
  };
  const theme = parseTheme(themeCss);
  const springs = Object.fromEntries(
    Object.entries(motion.SPRINGS).map(([name, s]) => [name, springPhysics(s.visualDuration, s.bounce)]),
  );
  const waFonts = Object.fromEntries(
    Object.entries(fonts.WA_FONTS).map(([name, spec]) => {
      const family = spec.hosted ? APP_FAMILY[spec.hosted] : spec.cssVar === '--font-wa-system-text' ? 'serif' : null;
      if (family === undefined) throw new Error(`No app font for ${spec.hosted}`);
      return [name, { family, weight: spec.weight }];
    }),
  );
  const out = {
    $comment: 'Generated by `pnpm --filter @omw/app tokens` from frontend/shared. Do not edit.',
    sources: { 'theme.css': sha(themeCss), 'motion.ts': sha(motionSrc), 'fonts.ts': sha(fontsSrc) },
    colors: theme.semantic,
    palette: theme.palette,
    radii: { ...theme.radii, pill: 9999 },
    spacing: theme.spacing,
    shadows: theme.shadows,
    springs,
    fonts: { display: 'Fraunces', body: 'Nunito', hand: 'PlaypenSans' },
    waFonts,
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

async function main(): Promise<void> {
  const text = await buildTokens();
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(outFile, 'utf8');
    } catch {
      current = '';
    }
    if (current !== text) {
      console.error('src/theme/tokens.generated.json is stale: run `pnpm --filter @omw/app tokens`.');
      process.exit(1);
    }
    console.log('src/theme/tokens.generated.json is up to date.');
    return;
  }
  writeFileSync(outFile, text);
  console.log('wrote src/theme/tokens.generated.json');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
