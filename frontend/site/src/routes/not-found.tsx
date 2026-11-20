import { useLingui } from '@lingui/react';
import { Trans, useLingui as useLinguiMacro } from '@lingui/react/macro';
import type { LocaleCode } from '@omw/contracts/i18n';
import { useDocumentLocale } from '@omw/ui/locale';
import { useQuery } from '@tanstack/react-query';
import { type ErrorComponentProps, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { PaperPlane } from '../components/icons';
import { ScreenHeader, siteTitleOf } from '../components/site-header';
import { manifestQueryOptions } from '../data/queries';
import { siteUrl } from '../data/urls';
import { applyDocumentTitle, joinTitle } from '../document-title';
import { isKnownLocale } from '../locales';
import { useSite } from '../site';

/** The locale the screen is shown in: the active catalog (works outside a route context too). */
function useScreenLocale(): LocaleCode {
  const site = useSite();
  const { i18n } = useLingui();
  return isKnownLocale(i18n.locale) ? i18n.locale : site.defaultLocale;
}

/** Lost paper plane: a dotted route that ends, and the plane drifting off. */
function LostPlane() {
  return (
    <div className="relative mx-auto h-36 w-64" aria-hidden="true">
      <svg viewBox="0 0 256 144" aria-hidden="true" className="absolute inset-0 size-full text-lilac-strong">
        <path
          d="M8 120c40 10 64-40 104-34s40 44 76 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="2 10"
        />
        <circle cx="8" cy="120" r="6" fill="var(--omw-accent)" />
        <path d="M196 92l10-10M198 76l-8 8" stroke="var(--omw-muted)" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <PaperPlane className="float-gently absolute end-0 top-0 size-16 rotate-[-28deg] text-accent rtl:scale-x-[-1]" />
    </div>
  );
}

/** "<label> · <site title>" while the screen is shown. */
function useScreenTitle(label: string): void {
  const site = useSite();
  // The site's own client: these screens also render outside the app's providers.
  const { data: manifest } = useQuery(
    { ...manifestQueryOptions(site.basePath), refetchInterval: false },
    site.queryClient,
  );
  const title = joinTitle(siteTitleOf(manifest), label);
  useEffect(() => applyDocumentTitle(title), [title]);
}

/** The site header (brand, language, theme) above a centred illustration and message (L3-21). */
function Screen({ children, role, locale }: { children: React.ReactNode; role?: 'alert'; locale: LocaleCode }) {
  return (
    <div className="relative flex min-h-dvh flex-col">
      <div aria-hidden="true" className="page-grain pointer-events-none fixed inset-0" />
      <div className="relative">
        <ScreenHeader locale={locale} />
      </div>
      <main className="relative grid flex-1 place-items-center px-gutter pt-8 pb-section">
        <div className="max-w-md text-center" role={role}>
          {children}
        </div>
      </main>
    </div>
  );
}

export function NotFoundScreen() {
  const site = useSite();
  const locale = useScreenLocale();
  const { t } = useLinguiMacro();
  useDocumentLocale(locale);
  useScreenTitle(t`Nothing here`);
  return (
    <Screen locale={locale}>
      <LostPlane />
      <p className="mt-2 font-display text-7xl font-semibold text-accent soft">404</p>
      <h1 className="mt-2 font-display text-3xl font-semibold text-ink soft">
        <Trans>Nothing here</Trans>
      </h1>
      <p className="mt-3 text-muted">
        <Trans>This page does not exist (any more).</Trans>
      </p>
      <a
        href={siteUrl(site.basePath, `${locale}/`)}
        className="press mt-7 inline-flex h-11 items-center rounded-pill bg-accent px-6 font-bold text-on-accent shadow-soft hover:bg-accent-strong"
      >
        <Trans>To the timeline</Trans>
      </a>
    </Screen>
  );
}

export function ErrorScreen({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const locale = useScreenLocale();
  const { t } = useLinguiMacro();
  useDocumentLocale(locale);
  useScreenTitle(t`Something went wrong`);
  return (
    <Screen role="alert" locale={locale}>
      <LostPlane />
      <h1 className="mt-4 font-display text-3xl font-semibold text-ink soft">
        <Trans>Something went wrong</Trans>
      </h1>
      <p className="mt-3 text-muted">
        <Trans>Please try again in a moment.</Trans>
      </p>
      <details className="mt-3 text-xs text-muted">
        <summary className="cursor-pointer rounded-pill px-2 py-1 font-semibold hover:text-ink">
          <Trans>Details</Trans>
        </summary>
        <p className="mt-1 break-words">{error instanceof Error ? error.message : String(error)}</p>
      </details>
      <button
        type="button"
        onClick={() => {
          // A failed loader stays failed until the router reloads the route; render errors only
          // need the boundary reset.
          reset();
          void router.invalidate();
        }}
        className="press mt-7 inline-flex h-11 items-center rounded-pill bg-accent px-6 font-bold text-on-accent shadow-soft hover:bg-accent-strong"
      >
        <Trans>Try again</Trans>
      </button>
    </Screen>
  );
}
