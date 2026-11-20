/// <reference lib="webworker" />
/**
 * Admin service worker (vite-plugin-pwa injectManifest, scope /admin/).
 * - precaches the app shell (JS/CSS/HTML/icons) and serves index.html for /admin/* navigations;
 * - fonts are cached on first use (cache-first, hashed file names), but only real font
 *   responses: a 404 or an HTML fallback for a missing asset is never stored;
 * - /api/ is never cached or intercepted (plan C: "The admin API is never cached").
 */
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';

declare let self: ServiceWorkerGlobalScope;

self.addEventListener('message', (event) => {
  if (event.data && (event.data as { type?: string }).type === 'SKIP_WAITING') void self.skipWaiting();
});

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
clientsClaim();

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    allowlist: [/^\/admin(?:\/|$)/],
    denylist: [/^\/api\//],
  }),
);

/** Workbox plugin: cache only 200 responses that are not HTML (e.g. a misrouted SPA fallback). */
const onlyRealAssets = {
  cacheWillUpdate: async ({ response }: { response: Response }) =>
    response.status === 200 && !(response.headers.get('content-type') ?? '').includes('text/html') ? response : null,
};

registerRoute(
  ({ request, url }) => request.destination === 'font' && url.pathname.startsWith('/admin/assets/'),
  new CacheFirst({ cacheName: 'omw-admin-fonts', plugins: [onlyRealAssets] }),
);
