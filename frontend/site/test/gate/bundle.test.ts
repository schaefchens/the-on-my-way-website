/**
 * The built gate bundle (dist/gate, `pnpm --filter @omw/site build`; skipped when absent): the
 * manifest shape the generator reads (spec-wave5 §5.4, §6.1), the ≤ 25 kB gzip budget, no zod,
 * no source maps, and none of the §5.5 words that say someone is away (the bundle is public).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { AWAY_WORDS } from './words';

const DIST = fileURLToPath(new URL('../../dist/gate', import.meta.url));
const MANIFEST = join(DIST, '.vite/manifest.json');

const BUILT = existsSync(MANIFEST);

// Vitest still runs a skipped describe's body to collect its tests, so nothing here may read the
// build when there is none (a fresh checkout, CI before `pnpm build`).
describe.skipIf(!BUILT)('gate bundle (dist/gate)', () => {
  const manifest = (BUILT ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {}) as Record<
    string,
    { file: string; css?: string[]; imports?: string[]; isEntry?: boolean }
  >;
  const entry = manifest['src/gate/main.ts'];
  const files = BUILT ? readdirSync(join(DIST, 'assets')).map((f) => join(DIST, 'assets', f)) : [];

  it('has the entry the generator reads, with its CSS', () => {
    expect(entry?.isEntry).toBe(true);
    expect(entry?.file).toMatch(/^assets\/gate-[A-Za-z0-9_-]+\.js$/);
    expect(entry?.css?.length).toBe(1);
    expect(existsSync(join(DIST, entry?.file ?? 'x'))).toBe(true);
  });

  it('stays within 25 kB gzip for JS and CSS together', () => {
    const total = files
      .filter((f) => /\.(?:js|css)$/.test(f))
      .reduce((sum, f) => sum + gzipSync(readFileSync(f)).length, 0);
    expect(total).toBeLessThanOrEqual(25 * 1024);
  });

  it('contains no zod, no source map and no word that says someone is away', () => {
    expect(files.some((f) => f.endsWith('.map'))).toBe(false);
    for (const f of files) {
      const content = readFileSync(f, 'utf8');
      expect(content.includes('ZodError'), f).toBe(false);
      expect(content.includes('sourceMappingURL'), f).toBe(false);
      expect(content.match(AWAY_WORDS)?.[0] ?? null, f).toBeNull();
      expect(/schaefchens|your-server\.de/.test(content), f).toBe(false);
    }
  });
});
