import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildTokens } from '../scripts/sync-tokens.mts';

describe('design tokens', () => {
  it('src/theme/tokens.generated.json mirrors frontend/shared (run `pnpm --filter @omw/app tokens`)', async () => {
    const committed = readFileSync(new URL('../src/theme/tokens.generated.json', import.meta.url), 'utf8');
    expect(committed).toBe(await buildTokens());
  });

  it('has the same semantic tokens in dawn and dusk, and the plan’s spring numbers', async () => {
    const tokens = JSON.parse(await buildTokens());
    expect(Object.keys(tokens.colors.dusk)).toEqual(Object.keys(tokens.colors.dawn));
    expect(tokens.colors.dawn.accent).toBe('#be4a74');
    expect(tokens.colors.dusk.bg).toBe('#1b1322');
    // app-plan §5.2: soft 223.8 / 25.43, snappy 685.4 / 52.36, float 42.8 / 11.78 (mass 1).
    expect(tokens.springs.soft).toMatchObject({ stiffness: 223.8, damping: 25.43, mass: 1 });
    expect(tokens.springs.snappy.stiffness).toBeCloseTo(685.4, 0);
    expect(tokens.springs.float.damping).toBeCloseTo(11.78, 2);
  });

  it('maps every WhatsApp font to an embedded family or the system font', async () => {
    const tokens = JSON.parse(await buildTokens());
    const fonts = JSON.parse(readFileSync(new URL('../assets/fonts/fonts.json', import.meta.url), 'utf8')) as Record<
      string,
      { family: string; weight: number }
    >;
    const embedded = new Set(Object.values(fonts).map((f) => `${f.family.replace(/\s/g, '')}/${f.weight}`));
    for (const [name, spec] of Object.entries(tokens.waFonts) as [
      string,
      { family: string | null; weight: number },
    ][]) {
      if (spec.family === null || spec.family === 'serif') continue;
      expect(embedded.has(`${spec.family}/${spec.weight}`), name).toBe(true);
    }
  });
});
