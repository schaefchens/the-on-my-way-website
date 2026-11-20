import '@omw/ui/fonts.css';
import './app.css';
import { applyThemePreference, readThemePreference } from '@omw/ui/theme';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { adminApi, setClientHooks, setCsrfToken } from './api/client';
import { handleConflict } from './api/conflicts';
import { installOnlineManager, markApiReachable, markApiUnreachable } from './api/online';
import { addToOutbox } from './api/outbox';
import { createIdbPersister } from './api/persist';
import { createAdminQueryClient } from './api/query-client';
import { App } from './app';
import { authQueryKey, refreshCsrf, safeRedirect } from './auth';
import { activateLocale, preferredLocale } from './i18n';
import { draftSearch } from './lib/drafts';
import { createPostRescue } from './lib/rescue';
import { listenForInstallPrompt, registerServiceWorker } from './pwa';
import { createAdminRouter } from './router';
import { setSessionPersister } from './session';

async function start(): Promise<void> {
  applyThemePreference(readThemePreference());
  listenForInstallPrompt();
  const queryClient = createAdminQueryClient({
    onConflict: (qc, name, vars) => void handleConflict(qc, name, vars),
    // The session expired while the write was queued: keep it and replay it after the next login.
    onUnauthorizedWrite: (_qc, name, vars) => addToOutbox(name, vars),
    // A post the API rejected for good goes back into a draft instead of vanishing.
    onFailedWrite: createPostRescue((draft) => void router.navigate({ to: '/compose', search: draftSearch(draft) })),
  });
  const persister = createIdbPersister();
  setSessionPersister(persister);
  installOnlineManager(() => adminApi.health());

  const router = createAdminRouter(queryClient);
  setClientHooks({
    onUnauthorized: () => {
      setCsrfToken(null);
      queryClient.setQueryData(authQueryKey, { me: null, error: null });
      const here = router.state.location.href;
      if (!router.state.location.pathname.endsWith('/login')) {
        void router.navigate({ to: '/login', search: { redirect: safeRedirect(here) } });
      }
    },
    refreshCsrf: () => refreshCsrf(queryClient),
    onNetworkError: markApiUnreachable,
    onReachable: markApiReachable,
  });

  await activateLocale(preferredLocale());
  const container = document.getElementById('omw-admin');
  if (!container) throw new Error('#omw-admin not found');
  createRoot(container).render(
    <StrictMode>
      <App router={router} queryClient={queryClient} persister={persister} />
    </StrictMode>,
  );
  void registerServiceWorker();
}

void start();
