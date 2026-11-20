/** Bits shared by the row views of all levels. */
import type { LocaleCode } from '@omw/contracts/i18n';
import { pickText } from '@omw/contracts/i18n';
import type { DaySummary, ImageSet, TripSummary } from '@omw/contracts/site';
import { countryFlag } from '@omw/ui/locale';
import { Picture } from '@omw/ui/picture';
import { Link } from '@tanstack/react-router';
import type { MouseEvent, ReactNode } from 'react';
import { useTimeline } from '../data/hooks';
import { prefetchDay } from '../data/queries';
import { useSite } from '../site';
import { centerOf, useTimelineContext } from './context';
import { homeSearch, type ZoomLevel } from './search';

export function tripTitle(trip: TripSummary, locale: LocaleCode): string {
  return pickText(trip.title, locale, trip.orig)?.text ?? trip.slug;
}

export function flags(countries: readonly string[]): string {
  return countries.map(countryFlag).join(' ');
}

/** Link that zooms the timeline to `level` around `date` (a real link: works without JS too). */
export function ZoomLink({
  level,
  date,
  className,
  label,
  children,
}: {
  level: ZoomLevel;
  date: string;
  className?: string;
  label?: string;
  children: ReactNode;
}) {
  const { locale, zoomTo } = useTimelineContext();
  const site = useSite();
  const { data: timeline } = useTimeline();
  // Prefetch on intent: zooming into a day shows its filmstrip right away.
  const prefetch = () => {
    if (level === 'days' && timeline) void prefetchDay(site, timeline, date);
  };
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    zoomTo(level, { anchorDate: date, origin: centerOf(e.currentTarget), keyboard: e.detail === 0 });
  };
  return (
    <Link
      to="/$locale/"
      params={{ locale }}
      search={homeSearch(level, date)}
      replace
      resetScroll={false}
      preload={false}
      onClick={onClick}
      onPointerEnter={prefetch}
      onFocus={prefetch}
      onTouchStart={prefetch}
      className={className}
      aria-label={label}
    >
      {children}
    </Link>
  );
}

export function Polaroid({
  image,
  sizes,
  className,
  rotate,
}: {
  image: ImageSet;
  sizes: string;
  className: string;
  rotate: number;
}) {
  return (
    <span className={`polaroid absolute ${className}`} style={{ rotate: `${rotate}deg` }}>
      <Picture
        image={image}
        alt=""
        sizes={sizes}
        className="block h-full w-full object-cover"
        pictureClassName="block h-full"
      />
    </span>
  );
}

export function distinctCovers(first: ImageSet | undefined, days: readonly DaySummary[], max: number): ImageSet[] {
  const out: ImageSet[] = [];
  const seen = new Set<string>();
  for (const img of [first, ...days.map((d) => d.cover)]) {
    const key = img?.sources.webp[0]?.src;
    if (!img || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(img);
    if (out.length === max) break;
  }
  return out;
}
