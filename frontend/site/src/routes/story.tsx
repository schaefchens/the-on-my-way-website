/**
 * /$locale/day/$date/story/$id/ — the story sheet above the (paused) journey player (plan C).
 * The sheet with markdown-it is its own lazy chunk; until it has loaded, a sheet with the
 * title is shown (also the server-rendered fallback).
 */
import { useLingui } from '@lingui/react/macro';
import { getRouteApi } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { useStoryClose } from '../player/navigation';
import { useRestoreFocus } from '../player/restore-focus';
import { pickStory } from '../player/story-content';

const storyApi = getRouteApi('/$locale/day/$date/story/$id');
const dayApi = getRouteApi('/$locale/day/$date');

let sheetChunk: Promise<typeof import('../player/story-sheet')> | null = null;
const loadSheet = () => {
  sheetChunk ??= import('../player/story-sheet').catch((err: unknown) => {
    sheetChunk = null; // a failed load is retried next time
    throw err;
  });
  return sheetChunk;
};
const StorySheet = lazy(loadSheet);

/** Starts loading the story sheet chunk (at startup on a story page). Never rejects. */
export function preloadStorySheet(): Promise<void> {
  return loadSheet().then(
    () => undefined,
    () => undefined,
  );
}

export function StoryRoute() {
  const story = storyApi.useLoaderData();
  const day = dayApi.useLoaderData();
  const { locale, date, id } = storyApi.useParams();
  const onClose = useStoryClose(locale, date, id);
  // Back to "Read the story" (or the player itself) when the sheet closes.
  useRestoreFocus({ fallback: () => document.querySelector<HTMLElement>('[data-testid="journey-player"]') });
  const { t } = useLingui();
  const picked = pickStory(story, locale);

  return (
    <Suspense
      fallback={
        <div className="fixed inset-0 z-50">
          <div className="absolute inset-0 bg-plum-950/55" />
          <article
            role="dialog"
            aria-modal="true"
            aria-label={picked?.content.title ?? t`Story`}
            aria-busy="true"
            className="absolute inset-x-0 top-10 bottom-0 mx-auto max-w-3xl rounded-t-sheet bg-surface px-6 pt-14 text-ink shadow-float sm:top-8 sm:bottom-8 sm:rounded-sheet"
          >
            <h1
              lang={picked?.locale}
              dir="auto"
              data-user-text
              className="mx-auto max-w-[38rem] font-display text-[clamp(2.1rem,7vw,3.1rem)] leading-[1.05] font-semibold"
            >
              {picked?.content.title}
            </h1>
          </article>
        </div>
      }
    >
      <StorySheet story={story} locale={locale} day={day} onClose={onClose} />
    </Suspense>
  );
}
