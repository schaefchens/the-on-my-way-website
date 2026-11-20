import type { LocaleCode } from '@omw/contracts/i18n';
import type { DayDetail, Entry, TripDetail } from '@omw/contracts/site';
import { useDocumentLocale } from '@omw/ui/locale';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Outlet, useChildMatches, useNavigate } from '@tanstack/react-router';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { NewMomentsToast } from '../components/new-moments';
import { Hero, SiteHeader, siteTitleOf } from '../components/site-header';
import { manifestQueryOptions } from '../data/queries';
import { applyDocumentTitle, documentTitle, type TitleView } from '../document-title';
import { MotionBoundary, preloadMotion } from '../motion';
import { useSite } from '../site';
import { HomeTimeline } from '../timeline/home-timeline';
import { DEFAULT_ZOOM, type HomeSearch, homeSearch, sameHomeSearch, validateHomeSearch } from '../timeline/search';

const localeApi = getRouteApi('/$locale');
const HOME_ROUTE_ID = '/$locale/';
const DAY_ROUTE_ID = '/$locale/day/$date';
const STORY_ROUTE_ID = '/$locale/day/$date/story/$id';
const TRIP_ROUTE_ID = '/$locale/trip/$slug';

/** document.title of the view on top (the leaf route), once its data is loaded. */
function useDocumentTitle(locale: LocaleCode): void {
  const site = useSite();
  const { data: manifest } = useQuery(manifestQueryOptions(site.basePath));
  const siteTitle = siteTitleOf(manifest);
  const title = useChildMatches({
    select: (matches) => {
      const leaf = matches.at(-1);
      if (leaf?.status !== 'success') return null;
      let view: TitleView | null = null;
      const data = leaf.loaderData as unknown;
      if (leaf.routeId === HOME_ROUTE_ID) view = { name: 'home' };
      else if (leaf.routeId === DAY_ROUTE_ID && data) view = { name: 'day', day: data as DayDetail };
      else if (leaf.routeId === TRIP_ROUTE_ID && data) view = { name: 'trip', trip: data as TripDetail };
      else if (leaf.routeId === STORY_ROUTE_ID && data) {
        const date = (leaf.params as { date?: string }).date ?? '';
        view = { name: 'story', story: data as Extract<Entry, { kind: 'story' }>, date };
      }
      return view ? documentTitle(view, locale, siteTitle) : null;
    },
  });
  useEffect(() => applyDocumentTitle(title), [title]);
}

interface ChildState {
  /** Search of the home route when it is the active child, else null (an overlay is open). */
  home: HomeSearch | null;
  /** `date` param of an open day/story overlay. */
  overlayDate: string | null;
}

function parseChildKey(key: string): ChildState {
  const [kind, z, d, date] = key.split('|');
  const home = kind === 'home' ? validateHomeSearch({ z: z || undefined, d: d || undefined }) : null;
  return { home, overlayDate: date || null };
}

/** Locks page scrolling under an overlay (the timeline keeps its scroll position). */
function useScrollLock(locked: boolean): void {
  useLayoutEffect(() => {
    if (!locked) return;
    const root = document.documentElement;
    root.classList.add('omw-scroll-lock');
    return () => root.classList.remove('omw-scroll-lock');
  }, [locked]);
}

/**
 * Timeline stays mounted; day/story/trip routes render as overlays above it (plan C).
 * While an overlay is open the timeline keeps the zoom/focus it had (the overlay URLs carry no
 * z/d). Closing an overlay by navigating to "/$locale/" without search params restores them.
 */
export function LocaleLayout() {
  const { locale } = localeApi.useParams() as { locale: LocaleCode };
  useDocumentLocale(locale);
  useDocumentTitle(locale);
  const navigate = useNavigate();
  // A primitive selection (re-renders only when it changes): "<overlay>|<z>|<d>|<overlay date>".
  const key = useChildMatches({
    select: (matches) => {
      const home = matches.find((m) => m.routeId === HOME_ROUTE_ID);
      const overlay = matches.find((m) => m.routeId !== HOME_ROUTE_ID);
      const s = home && !overlay ? validateHomeSearch(home.search as Record<string, unknown>) : null;
      const date = (overlay?.params as { date?: string } | undefined)?.date ?? '';
      return `${s ? 'home' : 'overlay'}|${s?.z ?? ''}|${s?.d ?? ''}|${date}`;
    },
  });
  const child = parseChildKey(key);
  const overlayOpen = child.home === null;
  useScrollLock(overlayOpen);

  const lastHome = useRef<HomeSearch>(child.home ?? {});
  const lastOverlayDate = useRef<string | null>(null);
  const wasOverlay = useRef(overlayOpen);

  // Effective search for the timeline: frozen while an overlay is open; restored when an overlay
  // was closed by a plain navigation to the home route.
  let search: HomeSearch = lastHome.current;
  let restore: HomeSearch | null = null;
  if (child.home) {
    const closedPlainly = wasOverlay.current && child.home.z === undefined && child.home.d === undefined;
    if (closedPlainly) {
      const previous = lastHome.current;
      restore =
        previous.z !== undefined || previous.d !== undefined
          ? previous
          : lastOverlayDate.current
            ? { d: lastOverlayDate.current }
            : null;
    }
    search = restore ?? child.home;
  }
  if (child.overlayDate) lastOverlayDate.current = child.overlayDate;

  // Motion is only needed by overlays: fetch it once the first screen is idle.
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const id = idle(() => void preloadMotion(), { timeout: 5000 });
    return () => cancel(id);
  }, []);

  useEffect(() => {
    wasOverlay.current = overlayOpen;
    if (!overlayOpen) {
      lastHome.current = search;
      // The day of a closed overlay is used once (above); a later overlay without a day (a trip)
      // must not bring it back.
      lastOverlayDate.current = null;
    }
    if (restore && child.home && !sameHomeSearch(restore, child.home)) {
      void navigate({ to: '/$locale/', params: { locale }, search: restore, replace: true, resetScroll: false });
    }
  });

  return (
    // overflow-x: clip (not on <body>: that would propagate to the viewport) keeps bleeding
    // filmstrips from widening the page, without creating a scroll container for sticky headers.
    <div className="relative min-h-dvh overflow-x-clip">
      <div aria-hidden="true" className="page-grain pointer-events-none fixed inset-0" />
      <div className="relative" inert={overlayOpen}>
        <SiteHeader locale={locale} />
        <main>
          <Hero locale={locale} level={search.z ?? DEFAULT_ZOOM} />
          <HomeTimeline locale={locale} search={search} active={!overlayOpen} />
        </main>
      </div>
      <MotionBoundary>
        <Outlet />
      </MotionBoundary>
      <NewMomentsToast
        onAccepted={() => {
          // To the top of the new timeline (an open overlay stays where it is).
          if (overlayOpen) return;
          if (search.d === undefined) window.scrollTo({ top: 0, behavior: 'instant' });
          else
            void navigate({
              to: '/$locale/',
              params: { locale },
              search: homeSearch(search.z ?? DEFAULT_ZOOM, null),
              replace: true,
              resetScroll: false,
            });
        }}
      />
    </div>
  );
}
