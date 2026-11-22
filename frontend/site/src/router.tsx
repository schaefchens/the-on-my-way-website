/**
 * Code-based routes matching the generated directories (plan C "Routes", A4):
 *
 *   /                                   -> redirect to /<defaultLocale>/ (dev; the generator writes a language picker)
 *   /$locale/                           timeline (search: z = zoom level, d = focused date)
 *   /$locale/day/$date/                 journey player, an overlay above the mounted timeline
 *   /$locale/day/$date/story/$id/       long-form story (sheet above the player)
 *   /$locale/trip/$slug/                trip page (overlay)
 *
 * trailingSlash 'always' matches the static index.html directories; basepath comes from the
 * Boot JSON at runtime. Loaders fill the TanStack Query cache, so links prefetch on intent.
 */
import type { LocaleCode } from '@omw/contracts/i18n';
import type { Entry } from '@omw/contracts/site';
import { isValidLocalDate } from '@omw/contracts/time';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  notFound,
  type RouterHistory,
  redirect,
} from '@tanstack/react-router';
import {
  bootDayFor,
  ensureDay,
  ensureTimeline,
  ensureTrip,
  manifestQueryOptions,
  prefetchNewestDays,
} from './data/queries';
import { activateLocale } from './i18n';
import { isKnownLocale, isServedLocale } from './locales';
import { preloadMotion } from './motion';
import { parseRoutePath } from './route-path';
import { DayRoute } from './routes/day';
import { HomeRoute } from './routes/home';
import { LocaleLayout } from './routes/locale-layout';
import { NotFoundScreen } from './routes/not-found';
import { RootLayout, RouteErrorScreen } from './routes/root';
import { StoryRoute } from './routes/story';
import type { SiteContextValue } from './site';
import { preloadOverviewRows } from './timeline/rows';
import { validateHomeSearch } from './timeline/search';

type StoryEntry = Extract<Entry, { kind: 'story' }>;

/** Days whose filmstrips the top of the days level shows (prefetched with the timeline). */
const FIRST_SCREEN_DAYS = 2;

export interface RouterContext {
  site: SiteContextValue;
}

// Zoom search params live in timeline/search.ts; re-exported for existing importers.
export { type HomeSearch, validateHomeSearch, ZOOM_LEVELS, type ZoomLevel } from './timeline/search';

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFoundScreen,
  // A refused data request (gate mode: access ended or locked) goes to the access layer.
  errorComponent: RouteErrorScreen,
});

const rootIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: ({ context }) => {
    throw redirect({ to: '/$locale/', params: { locale: context.site.defaultLocale }, replace: true });
  },
});

/**
 * Whether the locale may be served: the page's own locale always (no request needed), others
 * when the manifest lists them (runtime decision, Manifest.site.locales: e.g. "en" is 404 on a
 * German-only site).
 */
async function isLocaleServed(site: SiteContextValue, locale: LocaleCode): Promise<boolean> {
  if (locale === site.boot.locale) return true;
  const manifest = await site.queryClient.ensureQueryData(manifestQueryOptions(site.basePath)).catch(() => null);
  return isServedLocale(locale, manifest?.site.locales, site.boot.locale);
}

/** The location is the day inlined in the Boot JSON (or a story of it). */
function isBootDayLocation(site: SiteContextValue, pathname: string): boolean {
  const parsed = parseRoutePath(pathname, site.basePath);
  const date = parsed && (parsed.name === 'day' || parsed.name === 'story') ? parsed.params.date : undefined;
  return date !== undefined && bootDayFor(site, date) !== null;
}

const localeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '$locale',
  params: {
    parse: ({ locale }) => (isKnownLocale(locale) ? { locale } : false),
    stringify: ({ locale }) => ({ locale }),
  },
  // No beforeLoad: it would hold every loader back. Catalog, locale check and timeline all load
  // in parallel with the child routes' loaders (L3-01).
  loader: async ({ context, params, location }) => {
    const { site } = context;
    const timeline = ensureTimeline(site);
    // A deep-linked day starts from its inlined data; the timeline loads behind the player.
    const behindOverlay = isBootDayLocation(site, location.pathname);
    if (behindOverlay) timeline.catch(() => undefined);
    const [served] = await Promise.all([
      isLocaleServed(site, params.locale),
      activateLocale(params.locale),
      behindOverlay ? null : timeline,
    ]);
    if (!served) throw notFound();
  },
  component: LocaleLayout,
});

const homeRoute = createRoute({
  getParentRoute: () => localeRoute,
  path: '/',
  validateSearch: validateHomeSearch,
  loaderDeps: ({ search }) => ({ z: search.z, d: search.d }),
  loader: async ({ context, deps }) => {
    // The overview levels' row views are a lazy chunk: have it before such a level renders.
    if (deps.z === 'trips' || deps.z === 'months') {
      await preloadOverviewRows();
      return;
    }
    // The top of the days level: its first filmstrips' files, as soon as the timeline is known
    // (not after React has rendered the rows).
    if (deps.d === undefined) {
      ensureTimeline(context.site).then(
        (timeline) => prefetchNewestDays(context.site, timeline, FIRST_SCREEN_DAYS),
        () => undefined,
      );
    }
  },
  component: HomeRoute,
});

const dayRoute = createRoute({
  getParentRoute: () => localeRoute,
  path: 'day/$date',
  params: {
    parse: ({ date }) => (isValidLocalDate(date) ? { date } : false),
    stringify: ({ date }) => ({ date }),
  },
  loader: async ({ context, params }) => {
    const [day] = await Promise.all([ensureDay(context.site, params.date), preloadMotion()]);
    if (!day) throw notFound();
    return day;
  },
  component: DayRoute,
});

const storyRoute = createRoute({
  getParentRoute: () => dayRoute,
  path: 'story/$id',
  loader: async ({ context, params }) => {
    const [day] = await Promise.all([ensureDay(context.site, params.date), preloadMotion()]);
    const story = day?.entries.find((e): e is StoryEntry => e.kind === 'story' && e.id === params.id);
    if (!story) throw notFound();
    return story;
  },
  component: StoryRoute,
});

const tripRoute = createRoute({
  getParentRoute: () => localeRoute,
  path: 'trip/$slug',
  loader: async ({ context, params }) => {
    const [trip] = await Promise.all([ensureTrip(context.site, params.slug), preloadMotion()]);
    if (!trip) throw notFound();
    return trip;
  },
  // Lazy: the trip page is rarely the first screen (its loader preloads the chunk on intent).
  component: lazyRouteComponent(() => import('./routes/trip'), 'TripRoute'),
});

export const routeTree = rootRoute.addChildren([
  rootIndexRoute,
  localeRoute.addChildren([homeRoute, dayRoute.addChildren([storyRoute]), tripRoute]),
]);

export function createSiteRouter(site: SiteContextValue, history?: RouterHistory) {
  return createRouter({
    routeTree,
    ...(history ? { history } : {}),
    basepath: site.basePath,
    trailingSlash: 'always',
    context: { site },
    defaultPreload: 'intent',
    // Freshness is TanStack Query's job (hash-keyed, immutable); always run loaders.
    defaultPreloadStaleTime: 0,
    // The timeline owns the window scroll position (zoom anchoring, ?d= focus) and overlays are
    // fixed layers above it, so the router must neither restore nor reset scroll. Returning
    // false also keeps history.scrollRestoration = 'manual'.
    scrollRestoration: () => false,
  });
}

export type SiteRouter = ReturnType<typeof createSiteRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: SiteRouter;
  }
}
