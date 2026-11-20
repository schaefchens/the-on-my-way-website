/**
 * Trip page (/$locale/trip/$slug/): an overlay above the mounted timeline. Lazy-loaded route
 * chunk. Close = back to the timeline entry it was opened from (or replace on a deep link).
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { type LocaleCode, pickText } from '@omw/contracts/i18n';
import type { DaySummary, TripDetail } from '@omw/contracts/site';
import { countryFlag, countryName, formatLocalDate, formatLocalDateRange, languageName } from '@omw/ui/locale';
import { SPRINGS } from '@omw/ui/motion';
import { Picture } from '@omw/ui/picture';
import { getRouteApi, Link, useRouter } from '@tanstack/react-router';
import { m } from 'motion/react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { ArrowIcon, CloseIcon, PaperPlane, PlayIcon } from '../components/icons';
import { useTimeline } from '../data/hooks';
import { useRestoreFocus } from '../player/restore-focus';
import { requestDayFocus } from '../timeline/focus-request';
import { momentCount } from '../timeline/model';
import { type HomeSearch, homeSearch } from '../timeline/search';

const tripApi = getRouteApi('/$locale/trip/$slug');
const HOME_ROUTE_ID = '/$locale/';

/**
 * Leaves an overlay: back to the in-app entry it was opened from, optionally replacing the
 * timeline's focus afterwards; on a deep link (nothing to go back to) replace it with the home.
 */
export function useCloseOverlay(locale: LocaleCode) {
  const router = useRouter();
  return (focus?: HomeSearch) => {
    if (router.history.canGoBack()) {
      if (focus) {
        const unsubscribe = router.subscribe('onResolved', () => {
          unsubscribe();
          const leaf = router.state.matches.at(-1);
          if (leaf?.routeId !== HOME_ROUTE_ID) return;
          void router.navigate({
            to: '/$locale/',
            params: { locale },
            search: focus,
            replace: true,
            resetScroll: false,
          });
        });
      }
      router.history.back();
      return;
    }
    void router.navigate({ to: '/$locale/', params: { locale }, search: focus ?? {}, replace: true });
  };
}

function DayCard({ day, locale }: { day: DaySummary; locale: LocaleCode }) {
  const title = pickText(day.title, locale, day.orig)?.text;
  return (
    <li>
      <Link
        to="/$locale/day/$date/"
        params={{ locale, date: day.date }}
        resetScroll={false}
        className="press group block overflow-hidden rounded-card bg-surface shadow-soft hover:shadow-lift"
      >
        <span className="relative block aspect-[4/3] overflow-hidden bg-blush">
          {day.cover && (
            <Picture
              image={day.cover}
              alt=""
              sizes="(min-width: 64rem) 18rem, (min-width: 40rem) 45vw, 100vw"
              className="block size-full object-cover transition-transform duration-700 ease-soft group-hover:scale-[1.04]"
              pictureClassName="block size-full"
            />
          )}
          <span className="absolute start-3 top-3 rounded-pill bg-surface/90 px-2.5 py-1 text-xs font-extrabold text-ink shadow-sm">
            {formatLocalDate(day.date, locale, 'day-header')}
          </span>
          <span className="absolute end-3 bottom-3 grid size-10 place-items-center rounded-full bg-accent text-on-accent opacity-0 shadow-soft transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
            <PlayIcon className="size-4" />
          </span>
        </span>
        <span className="block p-4">
          {/* The date is on the photo already: an untitled day is named after its place. */}
          <span dir="auto" data-user-text className="block truncate font-display text-xl font-semibold text-ink soft">
            {title ?? day.place ?? formatLocalDate(day.date, locale, 'day-title')}
          </span>
          <span className="mt-0.5 block truncate text-sm text-muted">
            {title && day.place && <bdi>{day.place}</bdi>}
            {day.country && `${title && day.place ? ' ' : ''}${countryFlag(day.country)}`}
            {((title && day.place) || day.country) && ' · '}
            <Plural value={momentCount(day)} one="# moment" other="# moments" />
          </span>
        </span>
      </Link>
    </li>
  );
}

function tripDays(trip: TripDetail, all: readonly DaySummary[] | undefined): DaySummary[] {
  if (!all) return [];
  const wanted = new Set(trip.days);
  return all.filter((d) => wanted.has(d.date));
}

export function TripRoute() {
  const trip = tripApi.useLoaderData();
  const { locale } = tripApi.useParams() as { locale: LocaleCode };
  const { t } = useLingui();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const close = useCloseOverlay(locale);
  // Focus returns to the opener (the trip card or chip) when the overlay closes. The opener is
  // kept in a ref from the first layout pass: a re-run (StrictMode, dev) would already see the
  // heading focused below.
  const openerRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!openerRef.current && active instanceof HTMLElement && active !== document.body) openerRef.current = active;
  }, []);
  /** "Show in the timeline": the timeline focuses that day once it shows it (W2-22). */
  const focusInTimeline = useRef(false);
  useRestoreFocus({ preferred: () => openerRef.current, skip: () => focusInTimeline.current });
  const { data: timeline } = useTimeline();
  const days = useMemo(() => tripDays(trip, timeline?.days), [trip, timeline]);
  const summary = timeline?.trips.find((s) => s.slug === trip.slug);
  const title = pickText(trip.title, locale, trip.orig);
  const description = pickText(trip.description, locale, trip.orig);
  const moments = days.reduce((n, d) => n + momentCount(d), 0);
  const countries = summary?.countries ?? [];
  const cover = trip.cover ?? days.find((d) => d.cover)?.cover;
  const newest = days.at(-1)?.date ?? trip.end;

  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="fixed inset-0 z-20 overflow-y-auto overscroll-contain bg-plum-950/30 backdrop-blur-[2px]">
      <m.article
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        initial={{ opacity: 0, y: 28 }}
        animate={{ opacity: 1, y: 0 }}
        transition={SPRINGS.soft}
        className="relative mx-auto min-h-full max-w-4xl bg-bg shadow-float sm:my-10 sm:min-h-0 sm:overflow-hidden sm:rounded-sheet"
      >
        <div aria-hidden="true" className="page-grain pointer-events-none absolute inset-0" />
        <header className="relative">
          <div className="relative h-[19rem] overflow-hidden bg-gradient-to-br from-blush to-lilac sm:h-[24rem]">
            {cover ? (
              <Picture
                image={cover}
                alt=""
                sizes="(min-width: 56rem) 56rem, 100vw"
                loading="eager"
                className="block size-full object-cover"
                pictureClassName="block size-full"
              />
            ) : (
              <span aria-hidden="true" className="grid size-full place-items-center text-8xl">
                {countries[0] ? countryFlag(countries[0]) : '✈︎'}
              </span>
            )}
            <span
              aria-hidden="true"
              className="absolute inset-0 bg-gradient-to-t from-plum-950/80 via-plum-950/20 to-transparent"
            />
          </div>
          <button
            type="button"
            onClick={() => close()}
            aria-label={t`Close`}
            className="press absolute end-4 top-4 grid size-11 place-items-center rounded-full bg-surface/90 text-ink shadow-soft backdrop-blur-sm hover:bg-surface"
          >
            <CloseIcon className="size-5" />
          </button>
          <div className="absolute inset-x-0 bottom-0 px-gutter pb-6 text-white sm:px-gutter-wide">
            <p className="text-xs font-extrabold tracking-[0.14em] uppercase opacity-90">
              <Trans>Trip</Trans> · {formatLocalDateRange(trip.start, trip.end, locale)}
            </p>
            <h1
              id={headingId}
              ref={headingRef}
              tabIndex={-1}
              lang={title?.locale}
              dir="auto"
              data-user-text
              className="mt-1 font-display text-4xl leading-tight font-semibold soft outline-none sm:text-5xl"
            >
              {title?.text ?? trip.slug}
            </h1>
          </div>
        </header>

        <div className="relative px-gutter pt-6 pb-12 sm:px-gutter-wide">
          <div className="flex flex-wrap items-center gap-2">
            {countries.map((c) => (
              <span key={c} className="rounded-pill bg-surface px-3 py-1.5 text-sm font-bold text-ink shadow-soft">
                {countryFlag(c)} {countryName(c, locale)}
              </span>
            ))}
            <span className="rounded-pill bg-blush px-3 py-1.5 text-sm font-bold text-accent-strong">
              <Plural value={days.length} one="# day" other="# days" /> ·{' '}
              <Plural value={moments} one="# moment" other="# moments" />
            </span>
          </div>

          {description && (
            <div className="mt-6 max-w-prose">
              <p
                lang={description.locale}
                dir="auto"
                data-user-text
                className="text-lg leading-relaxed whitespace-pre-line text-ink"
              >
                {description.text}
              </p>
              {description.fallback && (
                <p className="mt-1 text-sm text-muted">
                  <Trans>Original: {languageName(description.locale, locale)}</Trans>
                </p>
              )}
            </div>
          )}

          <div className="mt-7 flex flex-wrap gap-3">
            {days.length > 0 && (
              <Link
                to="/$locale/day/$date/"
                params={{ locale, date: days[0]?.date ?? trip.start }}
                resetScroll={false}
                className="press inline-flex h-11 items-center gap-2 rounded-pill bg-accent ps-4 pe-5 font-bold text-on-accent shadow-soft hover:bg-accent-strong"
              >
                <PlayIcon className="size-4" />
                <Trans>Watch from the first day</Trans>
              </Link>
            )}
            <button
              type="button"
              onClick={() => {
                focusInTimeline.current = true;
                requestDayFocus(newest);
                close(homeSearch('days', newest));
              }}
              className="press inline-flex h-11 items-center gap-2 rounded-pill bg-surface px-5 font-bold text-ink shadow-soft hover:bg-blush"
            >
              <Trans>Show in the timeline</Trans>
              <ArrowIcon className="size-4" />
            </button>
          </div>

          <h2 className="mt-10 mb-4 flex items-center gap-2 font-display text-2xl font-semibold text-ink soft">
            <PaperPlane className="size-6 text-accent rtl:scale-x-[-1]" />
            <Trans>Days</Trans>
          </h2>
          {days.length > 0 ? (
            <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {days.map((day) => (
                <DayCard key={day.date} day={day} locale={locale} />
              ))}
            </ol>
          ) : (
            <p className="text-muted">
              <Trans>No moments yet.</Trans>
            </p>
          )}
        </div>
      </m.article>
    </div>
  );
}
