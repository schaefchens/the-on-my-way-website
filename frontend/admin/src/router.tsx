/**
 * Admin routes (plan C "Admin PWA" screens), base /admin/:
 *   /login                       login (public)
 *   /                            home: site status, WhatsApp, backend heartbeat, alerts, today
 *   /inbox?show=                 captured statuses (filter: public | pending | hidden)
 *   /inbox/$sourceKey?focus=     item sheet (caption, description per locale, visibility, day)
 *   /days, /days/$date           day list and day editor
 *   /compose?kind=&post=&date=&draft=   composer (new note/story, edit post p_…, for a day, a stored draft)
 *   /trips, /trips/new, /trips/$slug
 *   /settings
 * Everything except /login sits below the "authed" layout route, whose beforeLoad is the auth guard.
 */
import { isPostPublicId } from '@omw/contracts/ids';
import { isValidLocalDate } from '@omw/contracts/time';
import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type RouterHistory,
} from '@tanstack/react-router';
import { authGuard } from './auth';
import { HomeScreen } from './screens/home';
import { type InboxFilter, InboxScreen } from './screens/inbox';
import { AdminLayout } from './screens/layout';
import { LoginScreen } from './screens/login';
import { ErrorScreen, NotFoundScreen, RootLayout } from './screens/root';

// Home, inbox and login load with the app; the editors load on first use (all of them are
// precached by the service worker, so they also open offline).
const loadDays = () => import('./screens/days');
const loadTrips = () => import('./screens/trips');
const ItemSheetScreen = lazyRouteComponent(() => import('./screens/item'), 'ItemSheetScreen');
const DaysScreen = lazyRouteComponent(loadDays, 'DaysScreen');
const DayEditorScreen = lazyRouteComponent(loadDays, 'DayEditorScreen');
const ComposerScreen = lazyRouteComponent(() => import('./screens/composer'), 'ComposerScreen');
const TripsScreen = lazyRouteComponent(loadTrips, 'TripsScreen');
const TripNewScreen = lazyRouteComponent(loadTrips, 'TripNewScreen');
const TripEditScreen = lazyRouteComponent(loadTrips, 'TripEditScreen');
const SettingsScreen = lazyRouteComponent(() => import('./screens/settings'), 'SettingsScreen');

export interface AdminRouterContext {
  queryClient: QueryClient;
}

export const ADMIN_BASEPATH = '/admin/';

const rootRoute = createRootRouteWithContext<AdminRouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFoundScreen,
  errorComponent: ErrorScreen,
});

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'login',
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  component: LoginScreen,
});

const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'authed',
  beforeLoad: authGuard,
  component: AdminLayout,
});

const homeRoute = createRoute({ getParentRoute: () => authedRoute, path: '/', component: HomeScreen });

const INBOX_FILTERS: readonly InboxFilter[] = ['public', 'pending', 'hidden'];
const inboxRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: 'inbox',
  validateSearch: (search: Record<string, unknown>): { show?: InboxFilter } =>
    INBOX_FILTERS.includes(search.show as InboxFilter) ? { show: search.show as InboxFilter } : {},
  component: InboxScreen,
});
const itemRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: 'inbox/$sourceKey',
  // ?focus=description: opened via "Describe" (inbox pencil), the description field gets the cursor.
  validateSearch: (search: Record<string, unknown>): { focus?: 'description' } =>
    search.focus === 'description' ? { focus: 'description' } : {},
  component: ItemSheetScreen,
});
const daysRoute = createRoute({ getParentRoute: () => authedRoute, path: 'days', component: DaysScreen });
const dayEditorRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: 'days/$date',
  params: {
    parse: ({ date }) => (isValidLocalDate(date) ? { date } : false),
    stringify: ({ date }) => ({ date }),
  },
  component: DayEditorScreen,
});

export interface ComposeSearch {
  kind: 'note' | 'story';
  /** Edit an existing post. */
  post?: string;
  /** New post placed on this local date (noon in the current zone). */
  date?: string;
  /** Open this stored draft of a new post (drafts list, a rejected post put back). */
  draft?: string;
}

const DRAFT_ID_RE = /^new:(?:note|story)[A-Za-z0-9:~_-]{0,120}$/;

const composeRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: 'compose',
  validateSearch: (search: Record<string, unknown>): ComposeSearch => ({
    kind: search.kind === 'story' ? 'story' : 'note',
    ...(isPostPublicId(search.post) ? { post: search.post } : {}),
    ...(isValidLocalDate(search.date) ? { date: search.date } : {}),
    ...(typeof search.draft === 'string' && DRAFT_ID_RE.test(search.draft) ? { draft: search.draft } : {}),
  }),
  component: ComposerScreen,
});
const tripsRoute = createRoute({ getParentRoute: () => authedRoute, path: 'trips', component: TripsScreen });
const tripNewRoute = createRoute({ getParentRoute: () => authedRoute, path: 'trips/new', component: TripNewScreen });
const tripEditRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: 'trips/$slug',
  component: TripEditScreen,
});
const settingsRoute = createRoute({ getParentRoute: () => authedRoute, path: 'settings', component: SettingsScreen });

export const routeTree = rootRoute.addChildren([
  loginRoute,
  authedRoute.addChildren([
    homeRoute,
    inboxRoute,
    itemRoute,
    daysRoute,
    dayEditorRoute,
    composeRoute,
    tripsRoute,
    tripNewRoute,
    tripEditRoute,
    settingsRoute,
  ]),
]);

export function createAdminRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    basepath: ADMIN_BASEPATH,
    context: { queryClient },
    ...(history ? { history } : {}),
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
  });
}

export type AdminRouter = ReturnType<typeof createAdminRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AdminRouter;
  }
}
