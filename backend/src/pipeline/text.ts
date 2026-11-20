/**
 * WhatsApp text statuses: the store keeps the InboxText verbatim (body, ARGB colours, font enum);
 * this maps it to the rendered TextStyle of the contracts (site entries and the API mirror).
 *
 * Plain "Conversation" statuses carry no colours or font; they get DEFAULT_TEXT_STYLE (the plum
 * ink of the design palette with white text in the system font).
 */
import type { TextStyle } from '@omw/contracts/site';
import { argbToRgbaHex, type FontName, type InboxText } from '@omw/contracts/wa';

export const DEFAULT_TEXT_STYLE: Readonly<Omit<TextStyle, 'body'>> = Object.freeze({
  bg: '#3b2341ff',
  fg: '#ffffffff',
  font: 'SYSTEM' as FontName,
});

function colour(argb: number | null, fallback: string): string {
  if (argb === null) return fallback;
  try {
    return argbToRgbaHex(argb);
  } catch {
    return fallback;
  }
}

export function textStyleFromInbox(text: InboxText): TextStyle {
  return {
    body: text.body,
    bg: colour(text.bgArgb, DEFAULT_TEXT_STYLE.bg),
    fg: colour(text.textArgb, DEFAULT_TEXT_STYLE.fg),
    font: text.font ?? DEFAULT_TEXT_STYLE.font,
  };
}
