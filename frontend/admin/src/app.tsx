import { I18nProvider } from '@lingui/react';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { type Persister, PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { RouterProvider } from '@tanstack/react-router';
import { persistOptions } from './api/persist';
import { i18n } from './i18n';
import { MotionRoot } from './motion';
import type { AdminRouter } from './router';

/**
 * Providers. With a persister (the browser app) the Query cache is restored from IndexedDB
 * first and paused owner writes resume afterwards; tests render without one.
 */
export function App({
  router,
  queryClient,
  persister,
}: {
  router: AdminRouter;
  queryClient: QueryClient;
  persister?: Persister;
}) {
  const tree = (
    <I18nProvider i18n={i18n}>
      <MotionRoot>
        <RouterProvider router={router} />
      </MotionRoot>
    </I18nProvider>
  );
  if (!persister) return <QueryClientProvider client={queryClient}>{tree}</QueryClientProvider>;
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={persistOptions(persister)}
      onSuccess={() => void queryClient.resumePausedMutations()}
    >
      {tree}
    </PersistQueryClientProvider>
  );
}
