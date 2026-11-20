/**
 * document.title for client-side navigation. Generated pages carry the right <title> for a first
 * load; once the SPA navigates (overlays open and close, zoom, 404) the title must follow, so the
 * browser history, tabs and screen readers name the view that is shown. Same format as the
 * generator's pageTitle(): "<what> · <site title>".
 */
import { type LocaleCode, pickText } from '@omw/contracts/i18n';
import type { DayDetail, Entry, TripDetail } from '@omw/contracts/site';
import { dateTimeFormat, formatLocalDate, localDateToUtcDate } from '@omw/ui/locale';

type StoryEntry = Extract<Entry, { kind: 'story' }>;

export type TitleView =
  | { name: 'home' }
  | { name: 'day'; day: DayDetail }
  | { name: 'story'; story: StoryEntry; date: string }
  | { name: 'trip'; trip: TripDetail }
  | { name: 'label'; label: string };

/** "a · b · Site": empty parts are skipped. */
export function joinTitle(siteTitle: string, ...parts: Array<string | null | undefined>): string {
  return [...parts.filter((p): p is string => !!p && p.trim().length > 0), siteTitle].join(' · ');
}

/** "15. Nov. 2026" (the generator's short date). */
function shortDate(date: string, locale: LocaleCode): string {
  return dateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    localDateToUtcDate(date),
  );
}

export function documentTitle(view: TitleView, locale: LocaleCode, siteTitle: string): string {
  switch (view.name) {
    case 'home':
      return siteTitle;
    case 'day': {
      const title = pickText(view.day.title, locale, view.day.orig)?.text;
      return title
        ? joinTitle(siteTitle, title, shortDate(view.day.date, locale))
        : joinTitle(siteTitle, formatLocalDate(view.day.date, locale, 'long'));
    }
    case 'story': {
      const content = view.story.story[locale] ?? view.story.story[view.story.orig];
      return joinTitle(siteTitle, content?.title ?? formatLocalDate(view.date, locale, 'long'));
    }
    case 'trip':
      return joinTitle(siteTitle, pickText(view.trip.title, locale, view.trip.orig)?.text ?? view.trip.slug);
    case 'label':
      return joinTitle(siteTitle, view.label);
  }
}

/** Sets document.title (no-op outside a browser or when unchanged). */
export function applyDocumentTitle(title: string | null): void {
  if (title === null || typeof document === 'undefined' || document.title === title) return;
  document.title = title;
}
