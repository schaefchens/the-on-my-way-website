import { describe, expect, it } from '@jest/globals';
import { APP_LIMITS, AppText } from '@omw/contracts/app';
import { FONT_NAMES } from '@omw/contracts/wa';
import {
  argbToHex,
  colorByArgb,
  contrastRatio,
  EMPTY_TEXT_DRAFT,
  fromAppText,
  hexToArgb,
  nextFont,
  normalizeTextBody,
  stepColor,
  TEXT_STATUS_COLORS,
  TEXT_STATUS_FONTS,
  TEXT_STATUS_TEXT_ARGB,
  textRemaining,
  textStatusMetrics,
  textStatusProblem,
  textStatusScale,
  toAppText,
} from '../src/core/text-status';

describe('palette', () => {
  it('has 12 distinct opaque colours, every one ≥ 4.5:1 with white text', () => {
    expect(TEXT_STATUS_COLORS).toHaveLength(12);
    expect(new Set(TEXT_STATUS_COLORS.map((c) => c.argb)).size).toBe(12);
    expect(new Set(TEXT_STATUS_COLORS.map((c) => c.id)).size).toBe(12);
    for (const c of TEXT_STATUS_COLORS) {
      expect(c.argb >>> 24).toBe(0xff);
      expect(argbToHex(c.argb)).toBe(c.hex);
      expect(hexToArgb(c.hex)).toBe(c.argb);
      expect(contrastRatio(c.hex, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('starts with plum, the backend default for plain text statuses', () => {
    expect(TEXT_STATUS_COLORS[0]?.hex).toBe('#3B2341');
    expect(EMPTY_TEXT_DRAFT.colorId).toBe('plum');
    expect(EMPTY_TEXT_DRAFT.font).toBe('SYSTEM');
  });

  it('swipes through the colours in both directions and wraps', () => {
    expect(stepColor('plum', 1).id).toBe('rose');
    expect(stepColor('plum', -1).id).toBe('night');
    expect(stepColor('night', 1).id).toBe('plum');
  });
});

describe('fonts', () => {
  it('offers WhatsApp’s 8 fonts in enum order, Aa steps and wraps', () => {
    expect(TEXT_STATUS_FONTS).toEqual(FONT_NAMES);
    expect(TEXT_STATUS_FONTS).toHaveLength(8);
    expect(nextFont('SYSTEM')).toBe('SYSTEM_TEXT');
    expect(nextFont('COURIERPRIME_BOLD')).toBe('SYSTEM');
    expect(nextFont('SYSTEM', -1)).toBe('COURIERPRIME_BOLD');
  });
});

describe('size scale (the site’s TextSlide)', () => {
  it('uses the same thresholds', () => {
    expect(textStatusScale('x'.repeat(24))).toBe('xl');
    expect(textStatusScale('x'.repeat(25))).toBe('lg');
    expect(textStatusScale('x'.repeat(70))).toBe('lg');
    expect(textStatusScale('x'.repeat(71))).toBe('md');
    expect(textStatusScale('x'.repeat(160))).toBe('md');
    expect(textStatusScale('x'.repeat(161))).toBe('sm');
    // Counts characters (code points), ignoring the outer whitespace.
    expect(textStatusScale(`  ${'🍜'.repeat(24)}  `)).toBe('xl');
  });

  it('turns the scale into pixels for a given width (cqi)', () => {
    expect(textStatusMetrics('Xin chào', 400)).toEqual({
      scale: 'xl',
      fontSize: 42,
      lineHeight: 47,
      paddingHorizontal: 36,
    });
    expect(textStatusMetrics('x'.repeat(200), 400).fontSize).toBeCloseTo(20.8);
  });
});

describe('serialization', () => {
  it('produces exactly the WhatsApp fields, all set, white text', () => {
    const text = toAppText({ body: '  Xin chào\r\nViệt Nam! 🍜  \n\n', colorId: 'ocean', font: 'CALISTOGA_REGULAR' });
    expect(text).toEqual({
      body: 'Xin chào\nViệt Nam! 🍜',
      bgArgb: 0xff1f5c8c,
      textArgb: TEXT_STATUS_TEXT_ARGB,
      font: 'CALISTOGA_REGULAR',
    });
    expect(Object.keys(text).sort()).toEqual(['bgArgb', 'body', 'font', 'textArgb']);
    expect(AppText.safeParse(text).success).toBe(true);
    // JSON round trip keeps the unsigned ARGB numbers.
    expect(JSON.parse(JSON.stringify(text))).toEqual(text);
  });

  it('round-trips through the draft', () => {
    const draft = { body: 'Lanterns', colorId: 'terracotta', font: 'EXO2_EXTRABOLD' as const };
    expect(fromAppText(toAppText(draft))).toEqual(draft);
  });

  it('keeps inner blank lines and the words verbatim (no markup)', () => {
    expect(normalizeTextBody('*Hội An*\n\n\nat night ')).toBe('*Hội An*\n\n\nat night');
  });

  it('rejects empty and too long bodies', () => {
    expect(textStatusProblem({ body: '  \n ' })).toBe('empty');
    expect(textStatusProblem({ body: 'x'.repeat(APP_LIMITS.textChars) })).toBeNull();
    expect(textStatusProblem({ body: 'x'.repeat(APP_LIMITS.textChars + 1) })).toBe('too_long');
    expect(() => toAppText({ ...EMPTY_TEXT_DRAFT, body: '' })).toThrow(RangeError);
  });

  it('counts like the API (UTF-16 units) and shows the counter from 600', () => {
    expect(textRemaining('x'.repeat(599))).toBeNull();
    expect(textRemaining('x'.repeat(612))).toBe(88);
    expect(textRemaining('🍜'.repeat(300))).toBe(100);
  });

  it('maps a foreign background to no palette entry (any ARGB is valid on WhatsApp)', () => {
    expect(colorByArgb(0xff123456)).toBeNull();
    expect(
      fromAppText({ body: 'x', bgArgb: 0xff123456, textArgb: TEXT_STATUS_TEXT_ARGB, font: 'SYSTEM' }).colorId,
    ).toBe('plum');
  });
});
