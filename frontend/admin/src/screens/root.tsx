import { Trans, useLingui } from '@lingui/react/macro';
import { useDocumentLocale } from '@omw/ui/locale';
import { type ErrorComponentProps, Link, Outlet } from '@tanstack/react-router';
import { ConflictDialog } from '../components/conflict-dialog';
import { Toaster, UpdatePrompt } from '../components/feedback';
import { CompassIcon, RefreshIcon } from '../components/icons';
import { Button, buttonClass, ErrorDetails } from '../components/ui';
import { friendlyError } from '../lib/errors';
import { useLocale } from '../lib/hooks';

/** Page chrome shared by every route: backdrop, document locale, global dialogs and toasts. */
export function RootLayout() {
  const locale = useLocale();
  const { t } = useLingui();
  useDocumentLocale(locale);
  return (
    <>
      <div className="app-backdrop" aria-hidden="true">
        <div className="paper-grain absolute inset-0 opacity-90 dark:opacity-40" />
      </div>
      <a
        href="#main"
        className="sr-only z-50 rounded-pill bg-accent px-4 py-2 font-bold text-on-accent focus:not-sr-only focus:fixed focus:start-4 focus:top-[max(1rem,env(safe-area-inset-top))] focus:inline-flex focus:min-h-11 focus:items-center"
      >
        {t`Skip to content`}
      </a>
      <Outlet />
      <ConflictDialog />
      <UpdatePrompt />
      <Toaster />
    </>
  );
}

export function NotFoundScreen() {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-[70dvh] max-w-md flex-col items-center justify-center px-6 text-center"
    >
      <span className="mb-4 grid size-16 place-items-center rounded-pill bg-blush text-accent">
        <CompassIcon className="size-8" />
      </span>
      <h1 className="display-soft text-3xl font-semibold">
        <Trans>Wrong turn</Trans>
      </h1>
      <p className="mt-2 text-muted">
        <Trans>This page does not exist. Maybe it moved, like you.</Trans>
      </p>
      <Link to="/" className={buttonClass('secondary', 'md', 'mt-6')}>
        <Trans>Back home</Trans>
      </Link>
    </main>
  );
}

export function ErrorScreen({ error, reset }: ErrorComponentProps) {
  const { i18n } = useLingui();
  const friendly = friendlyError(error);
  return (
    <main
      id="main"
      role="alert"
      className="mx-auto flex min-h-[70dvh] max-w-md flex-col items-center justify-center px-6 text-center"
    >
      <h1 className="display-soft text-3xl font-semibold">
        <Trans>Something went wrong</Trans>
      </h1>
      <p className="mt-2 break-words text-muted">{i18n._(friendly.message)}</p>
      <ErrorDetails detail={friendly.detail} className="mt-2 text-muted" />
      <Button variant="secondary" icon={RefreshIcon} className="mt-6" onClick={reset}>
        <Trans>Try again</Trans>
      </Button>
    </main>
  );
}
