/**
 * Picks the language of a story (plan C "i18n"): the visitor's locale, else the original
 * ("Original: Deutsch"), else the contracts' fallback order. Uses pickText from
 * @omw/contracts/i18n so stories, notes and descriptions follow the same rules.
 */
import { type LocaleCode, pickText } from '@omw/contracts/i18n';
import type { Entry, StoryContent } from '@omw/contracts/site';

export type StoryEntry = Extract<Entry, { kind: 'story' }>;

export interface PickedStory {
  content: StoryContent;
  /** Locale of `content`. */
  locale: LocaleCode;
  /** True when `content` is not in the visitor's locale (show "Original: …"). */
  fallback: boolean;
}

function hasText(c: StoryContent | undefined): c is StoryContent {
  return !!c && (c.title.trim().length > 0 || c.body.trim().length > 0);
}

/** Best story text for `locale`; null if the story has no text at all. */
export function pickStory(story: StoryEntry, locale: LocaleCode): PickedStory | null {
  const flat: Partial<Record<LocaleCode, string>> = {};
  for (const [code, content] of Object.entries(story.story) as [LocaleCode, StoryContent | undefined][]) {
    if (hasText(content)) flat[code] = `${content.title}\n${content.body}`;
  }
  const picked = pickText(flat, locale, story.orig);
  if (!picked) return null;
  const content = story.story[picked.locale];
  if (!content) return null;
  return { content, locale: picked.locale, fallback: picked.fallback };
}

/**
 * The language the visitor can switch to: the original when a translation is shown, or the
 * translation when the original is shown on purpose. null when there is nothing to switch to.
 */
export function storyAlternative(story: StoryEntry, shown: LocaleCode, locale: LocaleCode): LocaleCode | null {
  const orig = story.orig;
  if (shown !== orig && hasText(story.story[orig])) return orig;
  if (shown === orig && shown !== locale && hasText(story.story[locale])) return locale;
  return null;
}
