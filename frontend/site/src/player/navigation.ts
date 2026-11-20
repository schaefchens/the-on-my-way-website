/**
 * History-aware navigation of the player (plan C "Routes": opening the player pushes; zoom and
 * focus changes replace).
 *
 * - Day to day inside the player REPLACES the entry, so Back/close always returns to where the
 *   player was opened from.
 * - Close: if there is an in-app entry before (TanStack's __TSR_index > 0) it goes back to it;
 *   when that is the timeline and the visitor moved to another day meanwhile, the timeline's
 *   focus (?d=) is replaced with the day being watched. Without an in-app entry (deep link) it
 *   replaces the player with the timeline focused on that day.
 * - The story sheet PUSHES; closing it goes back when the player opened it, else replaces.
 */
import type { LocaleCode } from '@omw/contracts/i18n';
import { useRouter } from '@tanstack/react-router';
import { useMemo, useRef } from 'react';

const HOME_ROUTE_ID = '/$locale/';

/** Story id the player pushed most recently (module state: one player per page). */
let storyPushedFromPlayer: string | null = null;

export interface PlayerNavigation {
  close(): void;
  goToDay(date: string): void;
  openStory(id: string): void;
}

export function usePlayerNavigation(locale: LocaleCode, date: string): PlayerNavigation {
  const router = useRouter();
  const openedAt = useRef(date);
  const current = useRef(date);
  current.current = date;

  return useMemo<PlayerNavigation>(
    () => ({
      close() {
        const watched = current.current;
        if (router.history.canGoBack()) {
          if (watched !== openedAt.current) {
            const unsubscribe = router.subscribe('onResolved', () => {
              unsubscribe();
              const leaf = router.state.matches.at(-1);
              if (leaf?.routeId !== HOME_ROUTE_ID) return;
              void router.navigate({
                to: '/$locale/',
                params: { locale },
                search: { ...(leaf.search as Record<string, unknown>), d: watched },
                replace: true,
                resetScroll: false,
              });
            });
          }
          router.history.back();
          return;
        }
        void router.navigate({ to: '/$locale/', params: { locale }, search: { d: watched }, replace: true });
      },
      goToDay(target) {
        void router.navigate({
          to: '/$locale/day/$date/',
          params: { locale, date: target },
          replace: true,
          resetScroll: false,
        });
      },
      openStory(id) {
        storyPushedFromPlayer = id;
        void router.navigate({
          to: '/$locale/day/$date/story/$id/',
          params: { locale, date: current.current, id },
          resetScroll: false,
        });
      },
    }),
    [router, locale],
  );
}

/** Close action of the story sheet (used by routes/story.tsx). */
export function useStoryClose(locale: LocaleCode, date: string, id: string): () => void {
  const router = useRouter();
  return useMemo(
    () => () => {
      const pushedByPlayer = storyPushedFromPlayer === id;
      storyPushedFromPlayer = null;
      if (pushedByPlayer && router.history.canGoBack()) {
        router.history.back();
        return;
      }
      void router.navigate({ to: '/$locale/day/$date/', params: { locale, date }, replace: true, resetScroll: false });
    },
    [router, locale, date, id],
  );
}
