/**
 * Row views of the overview levels (years & trips, months). A separate chunk: the first screen
 * is usually the days level, so these load on idle (or before a deep link to z=trips|months
 * renders, via the home route loader) — see preloadOverviewRows() in rows.tsx.
 */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { countryFlag, countryName, formatLocalDate, formatLocalDateRange } from '@omw/ui/locale';
import { Picture } from '@omw/ui/picture';
import { Link } from '@tanstack/react-router';
import { memo } from 'react';
import { tilt } from '../components/decor';
import { ArrowIcon } from '../components/icons';
import { useTimelineContext } from './context';
import {
  type LooseRow,
  type Metrics,
  type MonthRow,
  momentCount,
  type TripRow,
  type WeekRow,
  type YearRow,
} from './model';
import { distinctCovers, flags, Polaroid, tripTitle, ZoomLink } from './rows-common';
import { weekdayLabels } from './weekdays';

// ---------------------------------------------------------------------------------------------
// Trips level

const YearRowView = memo(function YearRowView({ row }: { row: YearRow; m: Metrics }) {
  return (
    <div className="flex h-full flex-col justify-end pb-5">
      <h2 className="font-display text-6xl leading-none font-semibold text-ink soft sm:text-7xl">
        <span className="sr-only">
          <Trans>Year</Trans>{' '}
        </span>
        {row.year}
      </h2>
      <p className="mt-2 flex flex-wrap items-center gap-x-2 font-hand text-base text-muted">
        <span>
          <Plural value={row.tripCount} _0="no trips" one="# trip" other="# trips" />
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <Plural value={row.dayCount} one="# day" other="# days" />
        </span>
        {row.countries.length > 0 && (
          <span className="tracking-widest" aria-hidden="true">
            {flags(row.countries)}
          </span>
        )}
      </p>
    </div>
  );
});

const TripRowView = memo(function TripRowView({ row, m }: { row: TripRow; m: Metrics }) {
  const { locale } = useTimelineContext();
  const { trip } = row;
  const title = tripTitle(trip, locale);
  const covers = distinctCovers(trip.cover, row.days, 3);
  const [main, second, third] = covers;
  const from = row.dates.at(-1) ?? trip.start;
  const to = row.dates[0] ?? trip.end;
  const collage = (
    <span
      data-anchor-range={`${from}..${to}`}
      className={`relative block overflow-hidden bg-gradient-to-br from-blush to-lilac ${
        m.compact ? 'h-[236px]' : 'h-full'
      }`}
    >
      {main ? (
        <Polaroid
          image={main}
          sizes="(min-width: 40rem) 18rem, 70vw"
          rotate={-3 + tilt(trip.slug, 1.5)}
          className={m.compact ? 'start-[8%] top-5 h-[190px] w-[58%]' : 'start-[9%] top-7 h-[74%] w-[56%]'}
        />
      ) : (
        <span aria-hidden="true" className="absolute inset-0 grid place-items-center text-7xl">
          {flags(trip.countries.slice(0, 1)) || '✈︎'}
        </span>
      )}
      {second && (
        <Polaroid
          image={second}
          sizes="10rem"
          rotate={6 + tilt(`${trip.slug}2`, 2)}
          className={m.compact ? 'end-[6%] top-6 h-[112px] w-[36%]' : 'end-[7%] top-8 h-[40%] w-[34%]'}
        />
      )}
      {third && (
        <Polaroid
          image={third}
          sizes="10rem"
          rotate={-5 + tilt(`${trip.slug}3`, 2)}
          className={m.compact ? 'end-[10%] bottom-4 h-[96px] w-[32%]' : 'end-[12%] bottom-7 h-[36%] w-[30%]'}
        />
      )}
      <span aria-hidden="true" className="tape absolute start-[30%] top-2.5 rotate-[-4deg]" />
    </span>
  );
  return (
    <div className={m.compact ? 'h-full pb-6' : 'h-full pb-7'}>
      <Link
        to="/$locale/trip/$slug/"
        params={{ locale, slug: trip.slug }}
        resetScroll={false}
        className={`press group block h-full overflow-hidden rounded-card bg-surface shadow-soft hover:shadow-lift ${
          m.compact ? 'flex flex-col' : 'grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]'
        }`}
      >
        {collage}
        <span className={`flex min-w-0 flex-1 flex-col ${m.compact ? 'p-5' : 'p-7 ps-8'}`}>
          <span className="text-xs font-extrabold tracking-[0.12em] text-accent uppercase">
            {formatLocalDateRange(trip.start, trip.end, locale)}
          </span>
          <span
            dir="auto"
            data-user-text
            className={`mt-1 line-clamp-2 font-display leading-[1.1] font-semibold text-ink soft ${
              m.compact ? 'text-[1.75rem]' : 'text-4xl'
            }`}
          >
            {title}
          </span>
          {trip.countries.length > 0 && (
            <span className={`truncate text-sm text-muted ${m.compact ? 'mt-1.5' : 'mt-3'}`}>
              {trip.countries.map((c) => `${countryFlag(c)} ${countryName(c, locale)}`).join(' · ')}
            </span>
          )}
          <span className="mt-auto flex items-center justify-between gap-3 pt-3 text-sm font-semibold text-muted">
            <span className="truncate">
              <Plural value={row.days.length} one="# day" other="# days" /> ·{' '}
              <Plural value={row.moments} one="# moment" other="# moments" />
            </span>
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-blush text-accent-strong transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5">
              <ArrowIcon className="size-4.5" />
            </span>
          </span>
        </span>
      </Link>
    </div>
  );
});

const LooseRowView = memo(function LooseRowView({ row, m }: { row: LooseRow; m: Metrics }) {
  const { locale } = useTimelineContext();
  const { t } = useLingui();
  const newest = row.dates[0] as string;
  const oldest = row.dates.at(-1) as string;
  const covers = distinctCovers(undefined, row.days, m.compact ? 4 : 6);
  const range =
    newest === oldest ? formatLocalDate(newest, locale, 'long') : formatLocalDateRange(oldest, newest, locale);
  return (
    <div className={m.compact ? 'h-full pb-6' : 'h-full pb-7'}>
      <ZoomLink
        level="days"
        date={newest}
        label={t`In between: ${range}`}
        className="press group flex h-full items-center gap-4 rounded-card border-2 border-dashed border-line bg-surface/60 px-5 hover:border-blush-strong hover:bg-surface"
      >
        <span data-anchor-range={`${oldest}..${newest}`} className="flex shrink-0 -space-x-3 rtl:space-x-reverse">
          {covers.length > 0 ? (
            covers.map((img, i) => (
              <span
                key={img.sources.webp[0]?.src ?? i}
                className="polaroid relative block size-14 rounded-full! p-0.5!"
                style={{ rotate: `${tilt(`${newest}${i}`, 8)}deg`, zIndex: covers.length - i }}
              >
                <Picture
                  image={img}
                  alt=""
                  sizes="56px"
                  className="block size-full rounded-full object-cover"
                  pictureClassName="block size-full"
                />
              </span>
            ))
          ) : (
            <span className="grid size-14 place-items-center rounded-full bg-blush text-2xl">🏡</span>
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-hand text-lg text-accent">
            <Trans>In between</Trans>
          </span>
          <span className="truncate font-semibold text-ink">{range}</span>
          <span className="text-sm text-muted">
            <Plural value={row.days.length} one="# day" other="# days" /> ·{' '}
            <Plural value={row.moments} one="# moment" other="# moments" />
          </span>
        </span>
      </ZoomLink>
    </div>
  );
});

// ---------------------------------------------------------------------------------------------
// Months level

const MonthRowView = memo(function MonthRowView({ row, m }: { row: MonthRow; m: Metrics }) {
  const { locale } = useTimelineContext();
  const labels = weekdayLabels(locale, 1, m.tile);
  return (
    <div className="flex h-full flex-col justify-end">
      <div className="flex items-end justify-between gap-3" style={{ paddingInline: m.gridStart }}>
        <h2 className="shrink-0 font-display text-2xl leading-none font-semibold text-ink soft sm:text-4xl">
          {formatLocalDate(`${row.month}-01`, locale, 'month')}
        </h2>
        <span className="flex min-w-0 shrink items-center justify-end gap-1.5 pb-0.5">
          {row.trips.slice(0, 2).map((trip) => (
            <Link
              key={trip.slug}
              to="/$locale/trip/$slug/"
              params={{ locale, slug: trip.slug }}
              resetScroll={false}
              className="press truncate rounded-pill bg-blush px-2.5 py-1 text-xs font-bold text-accent-strong hover:bg-blush-strong"
            >
              {flags(trip.countries.slice(0, 2))} <bdi>{tripTitle(trip, locale)}</bdi>
            </Link>
          ))}
          {row.trips.length === 0 && (
            <span className="text-xs font-semibold text-muted">
              <Plural value={row.dayCount} one="# day" other="# days" />
            </span>
          )}
        </span>
      </div>
      <div
        aria-hidden="true"
        className="mt-3 mb-2 grid text-center text-[0.7rem] font-bold tracking-wider text-muted uppercase"
        style={{
          gridTemplateColumns: `repeat(7, ${m.tile}px)`,
          columnGap: m.cellGap,
          marginInlineStart: m.gridStart,
        }}
      >
        {labels.map((l, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed seven columns (narrow labels repeat)
          <span key={i} className="truncate">
            {l}
          </span>
        ))}
      </div>
    </div>
  );
});

/**
 * A week of day tiles. Days without moments are compact cells (a dotted ring around the number:
 * "empty" is in the cell, the number itself keeps full text contrast, L3-12). On larger screens
 * a week without any moments collapses into a slim row of numbers (L3-19, model.ts slimWeek).
 */
const WeekRowView = memo(function WeekRowView({ row, m }: { row: WeekRow; m: Metrics }) {
  const { locale, latestDate } = useTimelineContext();
  if (row.collapsed) {
    return (
      <div
        aria-hidden="true"
        className="grid items-center text-center text-xs font-semibold text-muted tabular-nums"
        style={{
          gridTemplateColumns: `repeat(7, ${m.tile}px)`,
          gridAutoRows: `${m.slimWeek - 8}px`,
          columnGap: m.cellGap,
          marginInlineStart: m.gridStart,
        }}
      >
        {row.cells.map((cell) =>
          cell.inMonth ? (
            <span key={cell.date} data-anchor={cell.date}>
              {Number(cell.date.slice(8))}
            </span>
          ) : (
            <span key={cell.date} />
          ),
        )}
      </div>
    );
  }
  const ring = Math.max(24, Math.min(40, m.tile - 12));
  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: `repeat(7, ${m.tile}px)`,
        gridAutoRows: `${m.tile}px`,
        columnGap: m.cellGap,
        marginInlineStart: m.gridStart,
      }}
    >
      {row.cells.map((cell) => {
        const dayNum = Number(cell.date.slice(8));
        if (!cell.inMonth) return <span key={cell.date} aria-hidden="true" />;
        if (!cell.day) {
          return (
            <span key={cell.date} aria-hidden="true" className="grid place-items-center">
              <span
                data-anchor={cell.date}
                className="grid place-items-center rounded-full border-2 border-dotted border-lilac-strong text-xs font-semibold text-muted tabular-nums"
                style={{ width: ring, height: ring }}
              >
                {dayNum}
              </span>
            </span>
          );
        }
        const day = cell.day;
        const count = momentCount(day);
        const latest = day.date === latestDate;
        return (
          <ZoomLink
            key={cell.date}
            level="days"
            date={day.date}
            className={`tile press group relative block overflow-hidden rounded-tile bg-blush shadow-soft hover:shadow-lift ${
              latest ? 'ring-2 ring-accent ring-offset-2 ring-offset-bg' : ''
            }`}
          >
            <span className="sr-only">
              {formatLocalDate(day.date, locale, 'day-header')}
              {day.place ? ` · ${day.place}` : ''} · <Plural value={count} one="# moment" other="# moments" />
            </span>
            <span data-anchor={day.date} className="block size-full">
              {day.cover ? (
                <Picture
                  image={day.cover}
                  alt=""
                  sizes={`${m.tile}px`}
                  className="block size-full object-cover transition-transform duration-500 ease-soft group-hover:scale-105"
                  pictureClassName="block size-full"
                />
              ) : (
                <span className="grid size-full place-items-center bg-gradient-to-br from-blush to-lilac font-display text-lg text-accent-strong">
                  {count}
                </span>
              )}
            </span>
            <span
              className={`absolute start-1 top-1 rounded-pill bg-surface/90 font-extrabold text-ink tabular-nums shadow-sm ${
                m.tile < 56 ? 'px-1 text-[0.6rem] leading-[1.1rem]' : 'px-1.5 text-xs leading-5'
              }`}
            >
              {dayNum}
            </span>
            {m.tile >= 72 && day.country && (
              <span aria-hidden="true" className="absolute end-1.5 bottom-1 text-sm drop-shadow">
                {countryFlag(day.country)}
              </span>
            )}
          </ZoomLink>
        );
      })}
    </div>
  );
});

// ---------------------------------------------------------------------------------------------

export type OverviewRow = YearRow | TripRow | LooseRow | MonthRow | WeekRow;

export function OverviewRowView({ row, m }: { row: OverviewRow; m: Metrics }) {
  switch (row.kind) {
    case 'year':
      return <YearRowView row={row} m={m} />;
    case 'trip':
      return <TripRowView row={row} m={m} />;
    case 'loose':
      return <LooseRowView row={row} m={m} />;
    case 'month':
      return <MonthRowView row={row} m={m} />;
    case 'week':
      return <WeekRowView row={row} m={m} />;
  }
}
