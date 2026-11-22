/**
 * Design tokens for React Native, mirrored from frontend/shared (tokens.generated.json, see
 * scripts/sync-tokens.mts). Themes: dawn (light) and dusk (night), following the system.
 */

import type { FontName } from '@omw/contracts/wa';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { Platform, type TextStyle, useColorScheme } from 'react-native';
import tokens from './tokens.generated.json';

export type ThemeName = 'dawn' | 'dusk';
export type ColorTokens = (typeof tokens.colors)['dawn'];
export type ShadowTokens = (typeof tokens.shadows)['dawn'];

export interface Theme {
  name: ThemeName;
  colors: ColorTokens;
  shadows: ShadowTokens;
  radii: typeof tokens.radii;
  spacing: typeof tokens.spacing;
  palette: typeof tokens.palette;
  springs: typeof tokens.springs;
  fonts: typeof tokens.fonts;
}

export function themeFor(name: ThemeName): Theme {
  return {
    name,
    colors: tokens.colors[name],
    shadows: tokens.shadows[name],
    radii: tokens.radii,
    spacing: tokens.spacing,
    palette: tokens.palette,
    springs: tokens.springs,
    fonts: tokens.fonts,
  };
}

const ThemeContext = createContext<Theme>(themeFor('dawn'));

/** Follows the system scheme (a stored preference comes with Settings). */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  const theme = useMemo(() => themeFor(scheme === 'dark' ? 'dusk' : 'dawn'), [scheme]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/** The phone's own UI font (WhatsApp's SYSTEM* fonts render in it, as on the site). */
export const SYSTEM_FONT_FAMILY = Platform.select({ android: 'sans-serif', default: 'System' });

/**
 * Text style of a WhatsApp text-status font (the same substitutes as the site, D10). The system
 * fonts name their family explicitly: an Android TextInput keeps its previous typeface when the
 * fontFamily prop merely disappears (Script -> Bold would stay in Playpen).
 */
export function waFontStyle(font: FontName): Pick<TextStyle, 'fontFamily' | 'fontWeight'> {
  const spec = tokens.waFonts[font];
  const weight = String(spec.weight) as NonNullable<TextStyle['fontWeight']>;
  return { fontFamily: spec.family ?? SYSTEM_FONT_FAMILY, fontWeight: weight };
}

/** The three UI roles: Fraunces SOFT 600 titles, Nunito UI text, Playpen for dates and greetings. */
export const type = {
  title: { fontFamily: tokens.fonts.display, fontWeight: '600' },
  body: { fontFamily: tokens.fonts.body, fontWeight: '400' },
  bodyBold: { fontFamily: tokens.fonts.body, fontWeight: '700' },
  label: { fontFamily: tokens.fonts.body, fontWeight: '800' },
  hand: { fontFamily: tokens.fonts.hand, fontWeight: '400' },
} as const satisfies Record<string, TextStyle>;
