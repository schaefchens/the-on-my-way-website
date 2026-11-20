/**
 * Entry. Generated pages contain a pre-rendered first screen inside #omw-root plus the Boot JSON;
 * React mounts with createRoot (no hydration) once the route is ready, replacing the first
 * screen in one step.
 *
 * Startup is one parallel step (L3-01), not a chain of round trips: the message catalog, the
 * manifest, the boot's timeline.json?v=<timelineV>, the route's loaders and, on day/story pages,
 * the player (and story sheet) chunks all start together; React mounts when they have settled.
 * A day page plays from the day inlined in its Boot JSON; its timeline loads behind the player
 * at low priority.
 */
import '@omw/ui/fonts.css';
import './app.css';
import type { LocaleCode } from '@omw/contracts/i18n';
import { applyThemePreference, readThemePreference } from '@omw/ui/theme';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { fallbackBoot, readBoot, type SiteBoot } from './boot';
import { ROOT_ELEMENT_ID } from './config';
import { bootDayFor, startInitialFetches } from './data/queries';
import { activateLocale } from './i18n';
import { isKnownLocale } from './locales';
import { type ParsedRoute, parseRoutePath } from './route-path';
import { createSiteRouter } from './router';
import { preloadJourneyPlayer } from './routes/day';
import { preloadStorySheet } from './routes/story';
import { createSiteContext, type SiteContextValue } from './site';

// Before anything renders: the visitor's dawn/dusk choice (generated pages may also inline
// THEME_BOOT_SCRIPT from @omw/ui/theme to avoid a flash on the pre-rendered first screen).
applyThemePreference(readThemePreference());

/** The catalog to load: the URL's locale (also for /404.html served at any depth), else the boot's. */
function pageLocale(route: ParsedRoute | null, boot: SiteBoot, site: SiteContextValue): LocaleCode {
  if (route && isKnownLocale(route.locale)) return route.locale;
  return boot.locale ?? site.defaultLocale;
}

async function start(): Promise<void> {
  const boot = readBoot() ?? fallbackBoot(window.location.pathname);
  if (import.meta.env.DEV) {
    void import('./data/validate.dev').then((m) => m.validateBoot(boot));
  }
  const site = createSiteContext(boot);
  const route = parseRoutePath(window.location.pathname, boot.basePath);
  const overlayDate = route?.name === 'day' || route?.name === 'story' ? route.params.date : undefined;
  const playsBootDay = overlayDate !== undefined && bootDayFor(site, overlayDate) !== null;

  // All at once: catalog, manifest + speculative timeline, route loaders, overlay chunks.
  const catalog = activateLocale(pageLocale(route, boot, site));
  startInitialFetches(site, playsBootDay ? { timelinePriority: 'low' } : {});
  const router = createSiteRouter(site);
  const ready = Promise.all([
    router.load(),
    overlayDate !== undefined ? preloadJourneyPlayer() : null,
    route?.name === 'story' ? preloadStorySheet() : null,
  ]);
  const [catalogResult, routeResult] = await Promise.allSettled([catalog, ready]);
  if (catalogResult.status === 'rejected') {
    // Without messages there is nothing sensible to render: the pre-rendered first screen (real
    // content with links) stays.
    console.error(catalogResult.reason);
    return;
  }
  // Route errors render the error screen (the router keeps them in its state).
  if (routeResult.status === 'rejected') console.error(routeResult.reason);

  const container = document.getElementById(ROOT_ELEMENT_ID);
  if (!container) throw new Error(`#${ROOT_ELEMENT_ID} not found`);
  createRoot(container).render(
    <StrictMode>
      <App site={site} router={router} />
    </StrictMode>,
  );
}

void start();
