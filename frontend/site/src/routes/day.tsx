/**
 * /$locale/day/$date/ — the journey player (plan C), an overlay above the mounted timeline.
 * The player itself is a lazy chunk (src/player, budget ≤ 45 kB gzip); until it has loaded,
 * <PlayerFallback> shows the same frame with the day's title and first picture, so there is no
 * layout jump. The story sheet (child route) renders through <Outlet /> above the player and
 * pauses it (reason "sheet").
 */
import { useLingui } from '@lingui/react/macro';
import type { LocaleCode } from '@omw/contracts/i18n';
import { pickText } from '@omw/contracts/i18n';
import type { DayDetail, ImageSet } from '@omw/contracts/site';
import { countryFlag, dateTimeFormat, formatLocalDate, localDateToUtcDate } from '@omw/ui/locale';
import { Picture } from '@omw/ui/picture';
import { getRouteApi, Link, Outlet, useChildMatches } from '@tanstack/react-router';
import { lazy, Suspense, useRef } from 'react';
import { useRestoreFocus } from '../player/restore-focus';

const dayApi = getRouteApi('/$locale/day/$date');
const STORY_ROUTE_ID = '/$locale/day/$date/story/$id';

let playerChunk: Promise<typeof import('../player')> | null = null;
const loadPlayer = () => {
  playerChunk ??= import('../player').catch((err: unknown) => {
    playerChunk = null; // a failed load is retried next time
    throw err;
  });
  return playerChunk;
};
const JourneyPlayer = lazy(() => loadPlayer().then((mod) => ({ default: mod.JourneyPlayer })));

/**
 * Starts loading the player chunk early: when a "watch the day" link is hovered/focused, or at
 * startup on a day page (main.tsx mounts once it is there). Never rejects.
 */
export function preloadJourneyPlayer(): Promise<void> {
  return loadPlayer().then(
    () => undefined,
    () => undefined,
  );
}

export function DayRoute() {
  const day = dayApi.useLoaderData();
  const { locale } = dayApi.useParams();
  const storyOpen = useChildMatches({ select: (matches) => matches.some((m) => m.routeId === STORY_ROUTE_ID) });
  useDayFocusReturn(day.date);

  return (
    <>
      <Suspense fallback={<PlayerFallback day={day} locale={locale} />}>
        <JourneyPlayer day={day} locale={locale} sheetOpen={storyOpen} />
      </Suspense>
      <Outlet />
    </>
  );
}

/**
 * Focus goes back to the timeline when the player closes (the player chunk mounts too late to
 * record its opener). After moving to other days it prefers a link to the day watched last,
 * which the timeline focuses (?d=), over the original opener.
 */
function useDayFocusReturn(date: string): void {
  const openedDate = useRef(date);
  const watchedDate = useRef(date);
  watchedDate.current = date;
  useRestoreFocus({
    preferred: () =>
      watchedDate.current === openedDate.current
        ? null
        : document.querySelector<HTMLElement>(`a[href$="/day/${watchedDate.current}/"]`),
  });
}

function firstImage(day: DayDetail): ImageSet | null {
  for (const e of day.entries) {
    if (e.kind === 'photo') return e.image;
    if (e.kind === 'video' || e.kind === 'gif') return e.video.poster;
  }
  return null;
}

/** Loading state of the player (same frame and header), also the server-rendered fallback. */
function PlayerFallback({ day, locale }: { day: DayDetail; locale: LocaleCode }) {
  const { t } = useLingui();
  const ownerTitle = pickText(day.title, locale, day.orig)?.text;
  const title =
    ownerTitle ??
    dateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
      localDateToUtcDate(day.date),
    );
  const first = day.entries[0];
  const poster =
    first && (first.kind === 'photo' || first.kind === 'video' || first.kind === 'gif') ? firstImage(day) : null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t`Journey of ${title}`}
      aria-busy="true"
      className="fixed inset-0 z-40 flex items-center justify-center overflow-hidden bg-bg"
    >
      <div
        className="relative isolate h-dvh w-full overflow-hidden bg-plum-950 text-white sm:aspect-[9/16] sm:h-[min(calc(100dvh-3rem),60rem)] sm:w-auto sm:rounded-sheet sm:shadow-float"
        style={poster ? { backgroundColor: poster.color } : undefined}
      >
        {poster && (
          <Picture
            image={poster}
            alt=""
            sizes="(min-width: 40rem) 36rem, 100vw"
            loading="eager"
            fetchPriority="high"
            pictureClassName="contents"
            className={`absolute inset-0 size-full ${poster.h / poster.w >= 1.6 ? 'object-cover' : 'object-contain'}`}
          />
        )}
        <div className="absolute inset-x-0 top-0 h-36 bg-linear-to-b from-black/55 to-transparent" />
        <div className="absolute inset-x-0 top-0 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="flex gap-1" aria-hidden="true">
            {/* Same rule as the player's ProgressBars: one bar above 30 moments. */}
            {day.entries.length > 30 ? (
              <span className="h-[3px] flex-1 rounded-pill bg-white/35" />
            ) : (
              day.entries.map((e) => (
                <span key={e.id} className="h-[3px] min-w-[3px] flex-1 rounded-pill bg-white/35" />
              ))
            )}
          </div>
          <div className="mt-2.5 flex items-center gap-2.5">
            <span className="size-10 shrink-0 rounded-pill bg-linear-to-br from-rose-300 to-violet-300" />
            <div className="min-w-0 flex-1 leading-tight">
              <h1 className="truncate font-display text-[0.98rem] font-semibold" dir="auto" data-user-text>
                {title}
              </h1>
              <p className="truncate text-xs font-semibold text-white/80">
                {ownerTitle && formatLocalDate(day.date, locale, 'day-header')}
                {ownerTitle && day.place && ' · '}
                {day.place && <bdi>{day.place}</bdi>}
                {day.country && ` ${countryFlag(day.country)}`}
              </p>
            </div>
            <Link
              to="/$locale/"
              params={{ locale }}
              aria-label={t`Close`}
              className="grid size-10 shrink-0 place-items-center rounded-pill text-2xl leading-none text-white"
            >
              ×
            </Link>
          </div>
        </div>
        <div className="absolute inset-0 grid place-items-center" role="status">
          <span className="size-12 animate-spin rounded-pill border-4 border-white/25 border-t-white" />
          <span className="sr-only">{t`Loading…`}</span>
        </div>
      </div>
    </div>
  );
}
