/**
 * Row views of the three zoom levels. Each view fills exactly `row.size` pixels (the virtual list
 * positions rows absolutely with the model's prefix sums), so no row may grow with its content:
 * text truncates, strips scroll.
 *
 * Anchors for zoom morphs: [data-anchor=<date>] (tiles, day avatars) and
 * [data-anchor-range=<from>..<to>] (trip and loose cards).
 *
 * The days level (usually the first screen) lives here; the overview levels are a lazy chunk
 * (rows-overview.tsx) that is preloaded on idle and by the home route loader.
 */
import { Plural, Trans } from '@lingui/react/macro';
import { pickText } from '@omw/contracts/i18n';
import { countryFlag, countryName, formatLocalDate, formatLocalDateRange } from '@omw/ui/locale';
import { Picture } from '@omw/ui/picture';
import { Link } from '@tanstack/react-router';
import { lazy, memo, Suspense } from 'react';
import { LatestDayChip, PassportStamp, tilt } from '../components/decor';
import { ArrowIcon, PaperPlane, PlayIcon } from '../components/icons';
import { preloadJourneyPlayer } from '../routes/day';
import { useTimelineContext } from './context';
import { Filmstrip } from './filmstrip';
import {
  type DayRow,
  type DividerRow,
  type EndRow,
  type Metrics,
  momentCount,
  type Row,
  type TripFootRow,
  type TripHeadRow,
} from './model';
import { flags, Polaroid, tripTitle } from './rows-common';
import type { ZoomLevel } from './search';

type OverviewModule = typeof import('./rows-overview');
let overview: OverviewModule | null = null;
let overviewPromise: Promise<OverviewModule> | null = null;

/** Loads the overview level views (idempotent; resolves immediately once loaded). */
export function preloadOverviewRows(): Promise<OverviewModule> {
  overviewPromise ??= import('./rows-overview').then((mod) => {
    overview = mod;
    return mod;
  });
  return overviewPromise;
}

const LazyOverviewRow = lazy(() => preloadOverviewRows().then((mod) => ({ default: mod.OverviewRowView })));

// ---------------------------------------------------------------------------------------------
// Days level

/** Route thread: dotted line in the inline-start gutter (rose inside trips), drawn on scroll. */
function Thread({ inTrip, from = 0, to = 0 }: { inTrip: boolean; from?: number; to?: number }) {
  return (
    <span
      aria-hidden="true"
      className={`thread ${inTrip ? 'thread-trip' : ''}`}
      style={{ insetBlockStart: from, insetBlockEnd: to }}
    />
  );
}

const DividerRowView = memo(function DividerRowView({
  row,
  m,
  first,
}: {
  row: DividerRow;
  m: Metrics;
  first: boolean;
}) {
  const { locale } = useTimelineContext();
  return (
    <div className="relative flex h-full items-center ps-14">
      <Thread inTrip={row.inTrip} from={first ? m.divider / 2 : 0} />
      <span aria-hidden="true" className="absolute start-[17px] size-2.5 rounded-full bg-violet" />
      <h2 className="font-hand text-xl text-violet">{formatLocalDate(`${row.month}-01`, locale, 'month')}</h2>
    </div>
  );
});

const TripHeadRowView = memo(function TripHeadRowView({ row, m }: { row: TripHeadRow; m: Metrics }) {
  const { locale } = useTimelineContext();
  const { trip } = row;
  return (
    <div className="relative h-full ps-14 pt-2 pb-4">
      <Thread inTrip={false} to={m.tripHead / 2} />
      <Thread inTrip from={m.tripHead / 2} />
      <span
        aria-hidden="true"
        className="absolute start-1 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-surface text-accent shadow-soft"
      >
        <PaperPlane className="size-5 -rotate-90 rtl:scale-x-[-1]" />
      </span>
      <Link
        to="/$locale/trip/$slug/"
        params={{ locale, slug: trip.slug }}
        resetScroll={false}
        className="press group relative flex h-full items-center gap-3 overflow-hidden rounded-card bg-gradient-to-br from-blush to-lilac ps-5 pe-3.5 shadow-soft hover:shadow-lift sm:gap-4 sm:ps-7 sm:pe-6"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 text-xs font-extrabold tracking-[0.12em] text-accent-strong uppercase">
            <Trans>Trip</Trans>
            {trip.countries.length > 0 && (
              <span aria-hidden="true" className="truncate text-sm tracking-[0.2em]">
                {flags(trip.countries)}
              </span>
            )}
          </span>
          <span
            dir="auto"
            data-user-text
            className={`mt-0.5 block truncate font-display font-semibold text-ink soft ${
              m.compact ? 'text-2xl' : 'text-3xl'
            }`}
          >
            {tripTitle(trip, locale)}
          </span>
          <span
            className={`mt-1 flex items-center gap-1.5 font-semibold text-muted ${m.compact ? 'text-[0.8125rem]' : 'text-sm'}`}
          >
            <span className="truncate">{formatLocalDateRange(trip.start, trip.end, locale)}</span>
            {/* Phones: the taped photo and the press feedback say "open"; the date gets the room. */}
            {!m.compact && (
              <>
                <span className="shrink-0 text-accent-strong">
                  <span aria-hidden="true">· </span>
                  <Trans>See the trip</Trans>
                </span>
                <ArrowIcon className="size-4 shrink-0 text-accent-strong transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5" />
              </>
            )}
          </span>
        </span>
        {trip.cover ? (
          <span
            aria-hidden="true"
            className={`relative shrink-0 ${m.compact ? 'h-[84px] w-[66px]' : 'h-[110px] w-[132px]'}`}
          >
            <Polaroid
              image={trip.cover}
              sizes={m.compact ? '66px' : '132px'}
              rotate={4 + tilt(trip.slug, 2)}
              className="inset-0"
            />
            <span className="tape absolute start-1/2 -top-1.5 -translate-x-1/2 scale-75 rotate-[-6deg] rtl:translate-x-1/2" />
          </span>
        ) : (
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface text-accent-strong shadow-soft">
            <ArrowIcon className="size-5" />
          </span>
        )}
      </Link>
    </div>
  );
});

const TripFootRowView = memo(function TripFootRowView({ row, m }: { row: TripFootRow; m: Metrics }) {
  const { locale } = useTimelineContext();
  return (
    <div className="relative flex h-full items-center ps-14">
      <Thread inTrip to={m.tripFoot / 2} />
      <Thread inTrip={false} from={m.tripFoot / 2} />
      <span aria-hidden="true" className="plane-trail absolute start-0 top-1/2 -translate-y-1/2">
        <PaperPlane className="size-11 -rotate-[70deg] text-accent rtl:scale-x-[-1]" />
      </span>
      <p className="font-hand text-lg leading-snug text-muted">
        <Trans>The trip began here</Trans>
        <span className="block text-sm">
          {formatLocalDate(row.firstDay.date, locale, 'long')}
          {row.firstDay.place && (
            <>
              {' · '}
              <bdi>{row.firstDay.place}</bdi>
            </>
          )}
        </span>
      </p>
    </div>
  );
});

const DayRowView = memo(function DayRowView({ row, m }: { row: DayRow; m: Metrics }) {
  const { locale } = useTimelineContext();
  const { day } = row;
  const title = pickText(day.title, locale, day.orig);
  const count = momentCount(day);
  const headingId = `day-${day.date}`;
  // Without an owner title the date becomes the title ("Freitag, 20. November") and the meta
  // line keeps the place; with a title the meta line reads "Fr., 20. Nov. · Hội An 🇻🇳 · 12 …".
  const meta = (
    <>
      {title && (
        <>
          <time dateTime={day.date}>{formatLocalDate(day.date, locale, 'day-header')}</time>
          {(day.place || day.country) && <span aria-hidden="true">·</span>}
        </>
      )}
      {day.place && <bdi className="min-w-0 truncate">{day.place}</bdi>}
      {day.country && (
        <span className="shrink-0" title={countryName(day.country, locale)}>
          {countryFlag(day.country)}
        </span>
      )}
      {(title || day.place || day.country) && <span aria-hidden="true">·</span>}
      <span className="shrink-0">
        <Plural value={count} one="# moment" other="# moments" />
      </span>
    </>
  );
  return (
    <article aria-labelledby={headingId} className="day-row relative h-full">
      <Thread inTrip={row.trip !== null} from={row.latest ? m.dayHeader / 2 : 0} />
      {/* The header sticks while the filmstrip scrolls under it and leaves with it, so it never
          covers the row's own "watch" button. */}
      <div className="relative" style={{ height: m.dayHeader + 8 + m.filmstrip }}>
        <header
          data-sticky
          className="day-header sticky top-0 z-[2] flex items-center gap-3"
          style={{ height: m.dayHeader }}
        >
          <Link
            to="/$locale/day/$date/"
            params={{ locale, date: day.date }}
            resetScroll={false}
            tabIndex={-1}
            aria-hidden="true"
            className={`press relative block size-11 shrink-0 overflow-hidden rounded-full bg-blush ring-[3px] ring-bg shadow-soft ${
              row.latest ? 'outline-2 outline-offset-2 outline-accent' : ''
            }`}
          >
            <span data-anchor={day.date} className="block size-full">
              {day.cover && (
                <Picture
                  image={day.cover}
                  alt=""
                  sizes="44px"
                  className="block size-full object-cover"
                  pictureClassName="block size-full"
                />
              )}
            </span>
          </Link>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 overflow-hidden text-[0.8rem] font-bold whitespace-nowrap text-muted">
              {meta}
            </p>
            {/* Larger screens: "here now" right beside the title it belongs to (L3-19). */}
            <div className="flex min-w-0 items-center gap-3">
              <h3
                id={headingId}
                lang={title?.locale}
                dir={title ? 'auto' : undefined}
                data-user-text={title ? '' : undefined}
                className={`min-w-0 truncate font-display leading-tight font-semibold text-ink soft ${
                  m.compact ? 'text-[1.4rem]' : 'text-[1.65rem]'
                }`}
              >
                {title ? title.text : <time dateTime={day.date}>{formatLocalDate(day.date, locale, 'day-title')}</time>}
              </h3>
              {!m.compact && row.latest && <LatestDayChip lastAt={day.lastAt} />}
            </div>
          </div>
          {!m.compact && row.stamp && (
            // Wide screens: the stamp sits in the header's open end, clear of the filmstrip.
            <PassportStamp country={row.stamp} date={day.date} locale={locale} className="me-2 shrink-0" />
          )}
        </header>
        <div className="relative ms-14 -me-gutter mt-2" style={{ height: m.filmstrip }}>
          <Filmstrip summary={day} locale={locale} height={m.filmstrip} mosaic={m.wide} />
        </div>
      </div>
      {m.compact && row.stamp && (
        <PassportStamp
          country={row.stamp}
          date={day.date}
          locale={locale}
          // Phones: beside the "watch" button (free space); on the newest day the "here now" chip
          // takes that place, so the stamp goes onto the filmstrip's bottom corner like a real
          // one. Below the sticky header (z-[2]) in either case.
          className={`absolute z-[1] ${row.latest ? 'end-1' : 'end-2 bottom-5'}`}
          style={row.latest ? { top: m.dayHeader + 8 + m.filmstrip - 46 } : undefined}
        />
      )}
      <div className="ms-14 mt-4 flex h-11 items-center gap-3">
        <Link
          to="/$locale/day/$date/"
          params={{ locale, date: day.date }}
          resetScroll={false}
          data-day-cta
          onPointerEnter={preloadJourneyPlayer}
          onFocus={preloadJourneyPlayer}
          onTouchStart={preloadJourneyPlayer}
          className="press inline-flex h-11 shrink-0 items-center gap-2 rounded-pill bg-accent ps-3.5 pe-4.5 font-bold whitespace-nowrap text-on-accent shadow-soft hover:bg-accent-strong"
        >
          <PlayIcon className="size-4" />
          {/* Every row has this link: its name keeps the visible words and adds the day, hidden
              (WCAG 2.5.3 label in name; no two links share a name, L3-10). */}
          <span>
            <Trans>Watch the day</Trans>
            <span className="sr-only">
              {': '}
              {formatLocalDate(day.date, locale, 'day-header')}
            </span>
          </span>
        </Link>
        {m.compact && row.latest && <LatestDayChip lastAt={day.lastAt} className="min-w-0" />}
      </div>
    </article>
  );
});

// ---------------------------------------------------------------------------------------------
// End of the journey (all levels)

const EndRowView = memo(function EndRowView({ row, m, level }: { row: EndRow; m: Metrics; level: ZoomLevel }) {
  const { locale } = useTimelineContext();
  return (
    <div
      className={`relative flex h-full flex-col items-center justify-center text-center ${level === 'days' ? 'ps-14' : ''}`}
    >
      {level === 'days' && <Thread inTrip={false} to={m.endRow - 40} />}
      <PaperPlane className="size-12 -rotate-12 text-accent rtl:scale-x-[-1]" />
      <p className="mt-3 font-hand text-xl text-ink">
        <Trans>This is where it all began</Trans> ✨
      </p>
      <p className="mt-1 text-sm text-muted">{formatLocalDate(row.first, locale, 'long')}</p>
    </div>
  );
});

// ---------------------------------------------------------------------------------------------

export function RowView({ row, m, level, index }: { row: Row; m: Metrics; level: ZoomLevel; index: number }) {
  switch (row.kind) {
    case 'year':
    case 'trip':
    case 'loose':
    case 'month':
    case 'week':
      return overview ? (
        <overview.OverviewRowView row={row} m={m} />
      ) : (
        <Suspense fallback={null}>
          <LazyOverviewRow row={row} m={m} />
        </Suspense>
      );
    case 'divider':
      return <DividerRowView row={row} m={m} first={index === 0} />;
    case 'trip-head':
      return <TripHeadRowView row={row} m={m} />;
    case 'trip-foot':
      return <TripFootRowView row={row} m={m} />;
    case 'day':
      return <DayRowView row={row} m={m} />;
    case 'end':
      return <EndRowView row={row} m={m} level={level} />;
  }
}
