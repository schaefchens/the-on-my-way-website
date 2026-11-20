import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { LOCALES, type LocaleCode, pickText } from '@omw/contracts/i18n';
import type { DaySummary, ImageSet, TimelineIndex } from '@omw/contracts/site';
import { countryFlag, formatRelative } from '@omw/ui/locale';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from '@tanstack/react-router';
import { type ReactNode, useMemo } from 'react';
import { useTimeline } from '../data/hooks';
import { manifestQueryOptions } from '../data/queries';
import { siteUrl } from '../data/urls';
import { siteLocales } from '../locales';
import { useSite } from '../site';
import { daysNewestFirst, momentCount, monthOf, type ZoomLevel } from '../timeline/model';
import { distinctCovers, Polaroid } from '../timeline/rows-common';
import { isLive } from './decor';
import { PaperPlane, PinIcon } from './icons';
import { useNow } from './now';
import { ThemeToggle } from './theme-toggle';

/** The site's title from the manifest (a neutral default until it is loaded). */
export function siteTitleOf(manifest: { site: { title: string } } | undefined | null): string {
  return manifest?.site.title ?? 'On My Way';
}

/** Same page in another locale: a full page load, so the generated page brings its own boot data. */
export function localeHref(basePath: string, pathname: string, search: string, target: LocaleCode): string {
  const base = basePath.endsWith('/') ? basePath : `${basePath}/`;
  const rel = pathname.startsWith(base) ? pathname.slice(base.length) : pathname.replace(/^\/+/, '');
  const rest = rel.replace(/^[^/]*/, '');
  return siteUrl(basePath, `${target}${rest || '/'}`) + (search && search !== '?' ? search : '');
}

/**
 * The header bar: brand, language switch, theme toggle. `brand` is the link to the timeline
 * (an in-app link inside the router, a plain one on the 404/error screens); `titleTag` makes the
 * site title the page's h1 on the timeline (L3-11) and a plain line where the screen has its own.
 */
function HeaderBar({
  locale,
  title,
  titleTag,
  brand,
  languageHref,
  locales,
}: {
  locale: LocaleCode;
  title: string;
  titleTag: 'h1' | 'p';
  brand: (content: ReactNode, className: string) => ReactNode;
  languageHref: (target: LocaleCode) => string;
  locales: readonly LocaleCode[];
}) {
  const { t } = useLingui();
  const TitleTag = titleTag;
  const content = (
    <>
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-blush text-accent shadow-soft transition-transform duration-300 ease-soft group-hover:-rotate-12 sm:size-10">
        <PaperPlane className="size-5.5 rtl:scale-x-[-1] sm:size-6" />
      </span>
      <span className="truncate font-display text-[1.3rem] font-semibold tracking-tight text-ink soft sm:text-[1.7rem]">
        {title}
      </span>
    </>
  );
  return (
    // Above the content below it: the language links' hit areas reach a little past the bar.
    <header className="relative z-10 mx-auto flex max-w-[68rem] items-center gap-1.5 px-gutter pt-4 sm:px-gutter-wide sm:pt-6">
      <TitleTag className="min-w-0">
        {brand(content, 'group flex min-w-0 items-center gap-2.5 rounded-pill pe-2')}
      </TitleTag>
      <nav aria-label={t`Language`} className="ms-auto flex shrink-0 rounded-pill bg-surface/70 p-0.5 shadow-soft">
        {LOCALES.filter((l) => locales.includes(l.code)).map((l) => (
          <a
            key={l.code}
            href={languageHref(l.code)}
            hrefLang={l.code}
            lang={l.code}
            aria-current={l.code === locale ? 'page' : undefined}
            aria-label={l.label}
            // The pill stays small; its hit area reaches 44 px in height (L3-22).
            className="press relative rounded-pill px-2 py-1.5 text-xs font-extrabold tracking-wider text-muted before:absolute before:inset-x-0 before:-inset-y-2 hover:text-ink aria-[current=page]:bg-blush-strong aria-[current=page]:text-ink sm:px-2.5"
          >
            {l.code.toUpperCase()}
          </a>
        ))}
      </nav>
      <ThemeToggle />
    </header>
  );
}

/** Header of the timeline and its overlays (inside the router). The site title is the h1. */
export function SiteHeader({ locale }: { locale: LocaleCode }) {
  const site = useSite();
  const { pathname, searchStr } = useLocation();
  const { data: manifest } = useQuery(manifestQueryOptions(site.basePath));
  return (
    <HeaderBar
      locale={locale}
      title={siteTitleOf(manifest)}
      titleTag="h1"
      locales={siteLocales(manifest?.site.locales)}
      languageHref={(target) => localeHref(site.basePath, pathname, searchStr, target)}
      brand={(content, className) => (
        <Link to="/$locale/" params={{ locale }} search={{}} replace className={className}>
          {content}
        </Link>
      )}
    />
  );
}

/**
 * The same header for the 404 and error screens (L3-21): works without the router (those
 * screens also render outside a route), links are plain page loads. The screen's own message is
 * its h1.
 */
export function ScreenHeader({ locale }: { locale: LocaleCode }) {
  const site = useSite();
  const { data: manifest } = useQuery(
    { ...manifestQueryOptions(site.basePath), refetchInterval: false },
    site.queryClient,
  );
  const pathname = typeof window === 'undefined' ? `${site.basePath}${locale}/` : window.location.pathname;
  const search = typeof window === 'undefined' ? '' : window.location.search;
  return (
    <HeaderBar
      locale={locale}
      title={siteTitleOf(manifest)}
      titleTag="p"
      locales={siteLocales(manifest?.site.locales)}
      languageHref={(target) => localeHref(site.basePath, pathname, search, target)}
      brand={(content, className) => (
        <a href={siteUrl(site.basePath, `${locale}/`)} className={className}>
          {content}
        </a>
      )}
    />
  );
}

interface Stats {
  days: number;
  countries: number;
  moments: number;
}

export function timelineStats(timeline: TimelineIndex): Stats {
  const countries = new Set<string>();
  let moments = 0;
  for (const d of timeline.days) {
    if (d.country) countries.add(d.country);
    moments += momentCount(d);
  }
  return { days: timeline.days.length, countries: countries.size, moments };
}

/** Key of an image (its first source path); covers are compared by it. */
function imageKey(image: ImageSet | undefined): string | null {
  return image?.sources.webp[0]?.src ?? null;
}

/**
 * Covers for the hero collage that the first screen does not show anyway (L3-19), so no photo
 * appears twice at a glance:
 *   days    not the two newest days' covers, nor their trip's (avatar, filmstrip, trip card)
 *   years   not what the first two cards show (the trip card's collage, the "in between" faces)
 *   months  not the two newest months' days (their tiles)
 * Then: the other days' covers (newest first), then trip covers; distinct, at most `max`.
 * Few days: fewer photos, or none.
 */
export function heroCovers(timeline: TimelineIndex, level: ZoomLevel, max = 3): ImageSet[] {
  const days = daysNewestFirst(timeline);
  const trips = new Map(timeline.trips.map((t) => [t.slug, t]));
  const shown = new Set<string>();
  const show = (images: readonly (ImageSet | undefined)[]) => {
    for (const image of images) {
      const key = imageKey(image);
      if (key) shown.add(key);
    }
  };
  if (level === 'days') {
    const first = days.slice(0, 2);
    show(first.map((d) => d.cover));
    show(first.map((d) => (d.trip ? trips.get(d.trip)?.cover : undefined)));
  } else if (level === 'months') {
    const months = [...new Set(days.map((d) => monthOf(d.date)))].slice(0, 2);
    show(days.filter((d) => months.includes(monthOf(d.date))).map((d) => d.cover));
  } else {
    // The first two cards of the years level: runs of days of one trip, or without a trip.
    const segments: DaySummary[][] = [];
    for (const d of days) {
      const last = segments.at(-1);
      if (last && last[0]?.trip === d.trip) last.push(d);
      else if (segments.length < 2) segments.push([d]);
      else break;
    }
    for (const seg of segments) {
      const trip = seg[0]?.trip ? trips.get(seg[0].trip) : undefined;
      show(trip ? distinctCovers(trip.cover, seg, 3) : distinctCovers(undefined, seg, 6));
    }
  }
  const out: ImageSet[] = [];
  for (const image of [...days.map((d) => d.cover), ...timeline.trips.map((t) => t.cover)]) {
    const key = imageKey(image);
    if (!image || !key || shown.has(key)) continue;
    shown.add(key);
    out.push(image);
    if (out.length === max) break;
  }
  return out;
}

/** Intro under the header: a handwritten line, the latest place and a few numbers. */
export function Hero({ locale, level }: { locale: LocaleCode; level: ZoomLevel }) {
  const { data: timeline } = useTimeline();
  const now = useNow();
  const stats = useMemo(() => (timeline ? timelineStats(timeline) : null), [timeline]);
  const latest = timeline?.days.at(-1);
  const live = latest ? isLive(latest.lastAt, now) : false;
  const latestTitle = latest ? pickText(latest.title, locale, latest.orig)?.text : undefined;
  const covers = useMemo(() => (timeline ? heroCovers(timeline, level) : []), [timeline, level]);
  return (
    <div className="relative mx-auto max-w-[68rem] px-gutter pt-3 pb-6 sm:px-gutter-wide sm:pb-8">
      <p className="font-hand text-lg text-accent sm:text-2xl">
        <Trans>Moments from the road</Trans> ✈︎
      </p>
      {stats && stats.days > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm md:max-w-[calc(100%-18rem)]">
          {latest && (latest.place || latestTitle) && (
            <span
              className={`inline-flex max-w-full items-center gap-1.5 rounded-pill py-1.5 ps-2.5 pe-3 font-bold ${
                live ? 'bg-accent text-on-accent' : 'bg-surface text-ink shadow-soft'
              }`}
            >
              <PinIcon className="size-4 shrink-0" />
              <span className="truncate">
                {live ? <Trans>Now in</Trans> : <Trans>Last in</Trans>} <bdi>{latest.place ?? latestTitle}</bdi>
                {latest.country && ` ${countryFlag(latest.country)}`}
              </span>
              <span className={`shrink-0 font-semibold ${live ? 'opacity-85' : 'text-muted'}`}>
                · {formatRelative(latest.lastAt, locale, now)}
              </span>
            </span>
          )}
          <span className="inline-flex items-center gap-1 rounded-pill bg-surface/70 px-3 py-1.5 font-semibold text-muted">
            <Plural value={stats.days} one="# day" other="# days" /> ·{' '}
            <Plural value={stats.countries} one="# country" other="# countries" /> ·{' '}
            <Plural value={stats.moments} one="# moment" other="# moments" />
          </span>
        </div>
      )}
      {covers.length > 0 && <LatestCollage covers={covers} />}
    </div>
  );
}

/** Wider screens: earlier moments as a little stack of taped instant photos (decorative). */
function LatestCollage({ covers }: { covers: ImageSet[] }) {
  const placements = [
    { className: 'z-[3] end-[5.5rem] top-1 h-[8.5rem] w-[7.25rem]', rotate: -7 },
    { className: 'z-[2] end-1 top-4 h-[7.5rem] w-[6.5rem]', rotate: 6 },
    { className: 'z-[1] end-[11rem] top-7 h-[6.75rem] w-[5.75rem]', rotate: -2 },
  ];
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute end-gutter-wide top-1.5 hidden h-40 w-[17rem] md:block"
    >
      {covers.map((image, i) => {
        const p = placements[i];
        if (!p) return null;
        return (
          <Polaroid
            key={image.sources.webp[0]?.src ?? i}
            image={image}
            sizes="8rem"
            rotate={p.rotate}
            className={p.className}
          />
        );
      })}
      <span className="tape absolute end-[7rem] top-0 z-[4] rotate-[-10deg]" />
    </div>
  );
}
