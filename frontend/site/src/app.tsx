import { I18nProvider } from '@lingui/react';
import { MediaBaseProvider } from '@omw/ui/picture';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { i18n } from './i18n';
import type { SiteRouter } from './router';
import { type SiteContextValue, SiteProvider } from './site';

export function App({ site, router }: { site: SiteContextValue; router: SiteRouter }) {
  return (
    <SiteProvider value={site}>
      <QueryClientProvider client={site.queryClient}>
        <I18nProvider i18n={i18n}>
          <MediaBaseProvider basePath={site.basePath}>
            {/* Motion providers wrap only the overlay routes (see routes/locale-layout.tsx). */}
            <RouterProvider router={router} />
          </MediaBaseProvider>
        </I18nProvider>
      </QueryClientProvider>
    </SiteProvider>
  );
}
