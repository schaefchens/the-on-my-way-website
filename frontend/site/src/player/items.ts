/**
 * The journey player's view of a day: one item per entry (chronological, as in DayDetail), with
 * the texts it shows already picked for the locale. Pure, so it can be tested without a DOM.
 */
import { type LocaleCode, type PickedText, pickText } from '@omw/contracts/i18n';
import type { DayDetail, Entry, EntryKind, ImageSet, TimePrecision } from '@omw/contracts/site';
import { formatTime } from '@omw/ui/locale';
import { partOfDayLabel } from '../components/time-labels';
import { type ItemTiming, itemTiming } from './durations';

export interface PlayerItem {
  index: number;
  entry: Entry;
  kind: EntryKind;
  /** "HH:mm" in the traveler's zone, or the part of the day ("morgens") with part-of-day precision. */
  time: string;
  /** Owner description picked for the locale (photo/video/gif/voice/text). */
  description: PickedText | null;
  /** Alt text: description, else the WhatsApp caption, else "" (plan C). */
  alt: string;
  /** Image that represents the item (photo, video poster) for previews and Media Session. */
  image: ImageSet | null;
  timing: ItemTiming;
}

export function entryImage(entry: Entry): ImageSet | null {
  switch (entry.kind) {
    case 'photo':
      return entry.image;
    case 'video':
    case 'gif':
      return entry.video.poster;
    default:
      return null;
  }
}

export function buildItems(
  day: DayDetail,
  locale: LocaleCode,
  opts: { dataSaver?: boolean; timePrecision?: TimePrecision } = {},
): PlayerItem[] {
  const partOfDay = opts.timePrecision === 'part_of_day';
  return day.entries.map((entry, index) => {
    const description =
      entry.kind === 'note' || entry.kind === 'story'
        ? null
        : pickText(entry.description, locale, entry.descriptionOrig);
    return {
      index,
      entry,
      kind: entry.kind,
      time: partOfDay ? partOfDayLabel(entry.at, entry.tz) : safeTime(entry.at, entry.tz, locale),
      description,
      alt: description?.text ?? entry.caption?.trim() ?? '',
      image: entryImage(entry),
      timing: itemTiming(entry, locale, opts),
    };
  });
}

function safeTime(at: string, tz: string, locale: LocaleCode): string {
  try {
    return formatTime(at, tz, locale);
  } catch {
    return '';
  }
}

/** The day's cover for Media Session artwork and previews: its first image. */
export function firstImage(items: readonly PlayerItem[]): ImageSet | null {
  for (const item of items) if (item.image) return item.image;
  return null;
}

/** Plain-text excerpt of a markdown body for the story card (no markdown parser needed). */
export function markdownExcerpt(markdown: string, maxChars = 160): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+.*$/gm, ' ')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  const cut = chars.slice(0, maxChars).join('');
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.–-]+$/, '')}…`;
}

/** Words of a markdown body (for "n min read"). */
export function wordCount(markdown: string): number {
  const words = markdown.replace(/[#>*_`~[\]()!-]+/g, ' ').match(/[\p{L}\p{N}]+/gu);
  return words ? words.length : 0;
}

export function readingMinutes(markdown: string, wordsPerMinute = 200): number {
  return Math.max(1, Math.round(wordCount(markdown) / wordsPerMinute));
}

/** Font size for a WhatsApp text status: short texts big, long texts smaller (like WhatsApp). */
export function textStatusScale(body: string): 'xl' | 'lg' | 'md' | 'sm' {
  const n = Array.from(body.trim()).length;
  if (n <= 24) return 'xl';
  if (n <= 70) return 'lg';
  if (n <= 160) return 'md';
  return 'sm';
}
