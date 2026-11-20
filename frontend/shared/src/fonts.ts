/**
 * Font roles and the WhatsApp text-status font map (D10).
 *
 * The @font-face rules live in styles/fonts.css (generated) and the family stacks in
 * styles/theme.css (`--font-*`). This module gives JS the same names, e.g. for inline styles
 * of text statuses and for preloading fonts before the player shows an item.
 */
import type { FontName } from '@omw/contracts/wa';

/** CSS variables of the three UI font roles. */
export const FONT_ROLES = {
  display: 'var(--font-display)',
  body: 'var(--font-body)',
  hand: 'var(--font-hand)',
} as const;
export type FontRole = keyof typeof FONT_ROLES;

export interface WaFontSpec {
  /** CSS variable holding the family stack (defined in theme.css). */
  cssVar: `--font-wa-${string}`;
  weight: number;
  /** First family of the stack that we self-host (null = system font, nothing to preload). */
  hosted: string | null;
}

/**
 * WhatsApp FontType -> our substitute. Calistoga, Exo 2 and Courier Prime are the real
 * families; SYSTEM* map to the platform fonts; FB_SCRIPT (Norican) gets the handwriting font
 * and MORNINGBREEZE the rounded body font.
 */
export const WA_FONTS: Readonly<Record<FontName, WaFontSpec>> = {
  SYSTEM: { cssVar: '--font-wa-system', weight: 400, hosted: null },
  SYSTEM_TEXT: { cssVar: '--font-wa-system-text', weight: 400, hosted: null },
  FB_SCRIPT: { cssVar: '--font-wa-script', weight: 500, hosted: 'Playpen Sans Variable' },
  SYSTEM_BOLD: { cssVar: '--font-wa-system', weight: 700, hosted: null },
  MORNINGBREEZE_REGULAR: { cssVar: '--font-wa-morningbreeze', weight: 800, hosted: 'Nunito Variable' },
  CALISTOGA_REGULAR: { cssVar: '--font-wa-calistoga', weight: 400, hosted: 'Calistoga' },
  EXO2_EXTRABOLD: { cssVar: '--font-wa-exo2', weight: 800, hosted: 'Exo 2 Variable' },
  COURIERPRIME_BOLD: { cssVar: '--font-wa-courierprime', weight: 700, hosted: 'Courier Prime' },
};

/** Inline style for a text status in the given WhatsApp font. */
export function waFontStyle(font: FontName): { fontFamily: string; fontWeight: number } {
  const spec = WA_FONTS[font];
  return { fontFamily: `var(${spec.cssVar})`, fontWeight: spec.weight };
}

/**
 * Starts loading the self-hosted face for `font` (no-op for system fonts or without the
 * CSS Font Loading API). Pass the text so the right unicode-range subset is fetched.
 */
export async function preloadWaFont(font: FontName, sampleText = 'Aa'): Promise<void> {
  const spec = WA_FONTS[font];
  if (!spec.hosted || typeof document === 'undefined' || !('fonts' in document)) return;
  try {
    await document.fonts.load(`${spec.weight} 1em "${spec.hosted}"`, sampleText);
  } catch {
    // Font loading is best effort; the fallback stack still renders.
  }
}
