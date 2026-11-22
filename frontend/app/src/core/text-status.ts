/**
 * Text statuses, WhatsApp-compatible (owner decision A2): exactly the InboxText fields
 * {body, bgArgb, textArgb, font}, all set. 12 opaque backgrounds from the dawn/dusk world (every
 * one ≥ 4.5:1 against the white text, styling.md §3.4), WhatsApp's 8 fonts in enum order, and the
 * site's size scale (frontend/site/src/player: textStatusScale + TEXT_SIZES), so the preview is
 * what the site shows.
 *
 * Framework-free (no React Native imports): unit-tested with jest-expo and Vitest.
 */
import { APP_LIMITS, AppText } from '@omw/contracts/app';
import { FONT_NAMES, type FontName } from '@omw/contracts/wa';

export interface TextStatusColor {
  /** Stable id (also the TalkBack name key). */
  id: string;
  /** "#RRGGBB" */
  hex: string;
  /** Opaque ARGB uint32, as WhatsApp sends backgroundArgb. */
  argb: number;
}

/** Order = the swipe order. Plum first: the backend's DEFAULT_TEXT_STYLE background. */
export const TEXT_STATUS_COLORS: readonly TextStatusColor[] = [
  { id: 'plum', hex: '#3B2341', argb: 0xff3b2341 },
  { id: 'rose', hex: '#BE4A74', argb: 0xffbe4a74 },
  { id: 'deep-rose', hex: '#9C3A5E', argb: 0xff9c3a5e },
  { id: 'berry', hex: '#7A2E5C', argb: 0xff7a2e5c },
  { id: 'mauve', hex: '#8A4F7D', argb: 0xff8a4f7d },
  { id: 'violet', hex: '#5D3FA0', argb: 0xff5d3fa0 },
  { id: 'lavender-dusk', hex: '#7353B8', argb: 0xff7353b8 },
  { id: 'ocean', hex: '#1F5C8C', argb: 0xff1f5c8c },
  { id: 'lagoon', hex: '#1E6B6E', argb: 0xff1e6b6e },
  { id: 'forest', hex: '#2E6B45', argb: 0xff2e6b45 },
  { id: 'terracotta', hex: '#A8482E', argb: 0xffa8482e },
  { id: 'night', hex: '#1B1322', argb: 0xff1b1322 },
];

/** White, like WhatsApp's own text statuses. */
export const TEXT_STATUS_TEXT_ARGB = 0xffffffff;
export const DEFAULT_TEXT_COLOR_ID = 'plum';
export const DEFAULT_TEXT_FONT: FontName = 'SYSTEM';

/** WhatsApp's FontType order (the "Aa" button steps through it). */
export const TEXT_STATUS_FONTS: readonly FontName[] = FONT_NAMES;

/** SYSTEM* fonts render in each viewer's own system font (site and WhatsApp alike). */
export function isSystemFont(font: FontName): boolean {
  return font === 'SYSTEM' || font === 'SYSTEM_BOLD' || font === 'SYSTEM_TEXT';
}

// ---- size scale (the site's TextSlide)

export type TextStatusScale = 'xl' | 'lg' | 'md' | 'sm';

/** Same thresholds as the site's textStatusScale(): short texts big, long texts smaller. */
export function textStatusScale(body: string): TextStatusScale {
  const n = Array.from(body.trim()).length;
  if (n <= 24) return 'xl';
  if (n <= 70) return 'lg';
  if (n <= 160) return 'md';
  return 'sm';
}

/** The site's TEXT_SIZES in container-inline units (1 cqi = 1 % of the slide width). */
export const TEXT_STATUS_SIZES: Readonly<Record<TextStatusScale, { cqi: number; lineHeight: number }>> = {
  xl: { cqi: 10.5, lineHeight: 1.12 },
  lg: { cqi: 8, lineHeight: 1.18 },
  md: { cqi: 6.4, lineHeight: 1.25 },
  sm: { cqi: 5.2, lineHeight: 1.32 },
};

/** The site's horizontal padding: px-[9cqi]. */
export const TEXT_STATUS_PADDING_CQI = 9;

/** Pixel metrics of the text for a slide (or preview) of the given width. */
export function textStatusMetrics(body: string, width: number) {
  const scale = textStatusScale(body);
  const { cqi, lineHeight } = TEXT_STATUS_SIZES[scale];
  const fontSize = Math.round(((width * cqi) / 100) * 10) / 10;
  return {
    scale,
    fontSize,
    lineHeight: Math.round(fontSize * lineHeight * 10) / 10,
    paddingHorizontal: Math.round((width * TEXT_STATUS_PADDING_CQI) / 100),
  };
}

// ---- limits

/** Characters as zod counts them (UTF-16 code units), so the counter never disagrees with the API. */
export function textLength(body: string): number {
  return body.length;
}

export const TEXT_COUNTER_FROM = 600;

/** null while the counter stays hidden (below 600 of 700). */
export function textRemaining(body: string): number | null {
  const n = textLength(body);
  return n >= TEXT_COUNTER_FROM ? APP_LIMITS.textChars - n : null;
}

// ---- colours

/** 0xAARRGGBB -> "#RRGGBB" (alpha dropped). */
export function argbToHex(argb: number): string {
  if (!Number.isInteger(argb) || argb < 0 || argb > 0xffffffff) throw new RangeError(`Not an ARGB uint32: ${argb}`);
  return `#${(argb & 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`;
}

/** "#RRGGBB" -> opaque 0xFFRRGGBB (unsigned). */
export function hexToArgb(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) throw new RangeError(`Not a #RRGGBB colour: ${hex}`);
  return (0xff000000 | Number.parseInt(m[1], 16)) >>> 0;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const v = Number.parseInt(hex.replace('#', ''), 16);
  return 0.2126 * channel((v >> 16) & 255) + 0.7152 * channel((v >> 8) & 255) + 0.0722 * channel(v & 255);
}

/** WCAG contrast ratio of two "#RRGGBB" colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export function colorById(id: string): TextStatusColor {
  return TEXT_STATUS_COLORS.find((c) => c.id === id) ?? (TEXT_STATUS_COLORS[0] as TextStatusColor);
}

/** The palette entry with this ARGB, or null for a colour from elsewhere (any ARGB is valid). */
export function colorByArgb(argb: number): TextStatusColor | null {
  return TEXT_STATUS_COLORS.find((c) => c.argb === argb >>> 0) ?? null;
}

/** Next/previous colour in swipe order (wraps around). */
export function stepColor(id: string, step: 1 | -1): TextStatusColor {
  const i = TEXT_STATUS_COLORS.findIndex((c) => c.id === id);
  const n = TEXT_STATUS_COLORS.length;
  return TEXT_STATUS_COLORS[(((Math.max(i, 0) + step) % n) + n) % n] as TextStatusColor;
}

/** Next font in WhatsApp's enum order (wraps around). */
export function nextFont(font: FontName, step: 1 | -1 = 1): FontName {
  const i = TEXT_STATUS_FONTS.indexOf(font);
  const n = TEXT_STATUS_FONTS.length;
  return TEXT_STATUS_FONTS[(((Math.max(i, 0) + step) % n) + n) % n] as FontName;
}

// ---- serialization

/** What the maker edits. */
export interface TextStatusDraft {
  body: string;
  colorId: string;
  font: FontName;
}

export const EMPTY_TEXT_DRAFT: Readonly<TextStatusDraft> = Object.freeze({
  body: '',
  colorId: DEFAULT_TEXT_COLOR_ID,
  font: DEFAULT_TEXT_FONT,
});

/**
 * The published body: CRLF/CR -> LF, trailing spaces of each line and blank lines at both ends
 * removed. Inner blank lines and the text itself stay verbatim (no WhatsApp *bold* markup).
 */
export function normalizeTextBody(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+$/u, ''))
    .join('\n')
    .trim();
}

export type TextStatusProblem = 'empty' | 'too_long';

export function textStatusProblem(draft: Pick<TextStatusDraft, 'body'>): TextStatusProblem | null {
  const body = normalizeTextBody(draft.body);
  if (body.length === 0) return 'empty';
  if (textLength(body) > APP_LIMITS.textChars) return 'too_long';
  return null;
}

/** Draft -> the contract's AppText (validated; throws a RangeError naming the problem). */
export function toAppText(draft: TextStatusDraft): AppText {
  const problem = textStatusProblem(draft);
  if (problem) throw new RangeError(`Text status ${problem}`);
  return AppText.parse({
    body: normalizeTextBody(draft.body),
    bgArgb: colorById(draft.colorId).argb,
    textArgb: TEXT_STATUS_TEXT_ARGB,
    font: draft.font,
  });
}

/** AppText -> draft (a foreign background keeps the nearest default: plum). */
export function fromAppText(text: AppText): TextStatusDraft {
  return {
    body: text.body,
    colorId: colorByArgb(text.bgArgb)?.id ?? DEFAULT_TEXT_COLOR_ID,
    font: text.font,
  };
}
