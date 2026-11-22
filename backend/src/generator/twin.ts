/**
 * First-screen twin (L3-02): a static copy of what the SPA paints first, so React's mount
 * (createRoot replaces #omw-root) is visually invisible and the first image can be the largest
 * paint.
 *
 * - Home and trip pages: the timeline as the SPA shows it on a phone and a desktop: SiteHeader
 *   (paper-plane brand, language pill, theme button), the Hero (the owner's profile: portrait,
 *   name and greeting, else the tagline; place and stats chips, collage) and the first rows of
 *   the days level (month divider, trip head, two day rows with their filmstrips), plus the
 *   floating zoom pill.
 * - Day and story pages: the journey player frame (dark stage with the first slide's picture,
 *   progress bars, the top bar with avatar (the owner's portrait, else the day's first picture),
 *   title and meta, the buttons). No spinner.
 *
 * Markup and Tailwind classes are copied from frontend/site/src (components/site-header.tsx,
 * profile.tsx, timeline/rows.tsx, timeline/filmstrip.tsx, timeline/strip-layout.ts,
 * player/journey-player.tsx, player/chrome.tsx, player/slides.tsx); the site's app.css @source's this directory, and the
 * classes are the SPA's own, so they exist in its stylesheet. What the SPA sets with inline
 * styles (row heights, strip cells, rotations, colours) becomes hashed per-page CSS (PageStyles),
 * with media queries at the viewport widths where the SPA's metrics switch (compact < 704 px <=
 * regular < 1024 px <= wide). Keep this file in step with those components.
 */
import { LOCALES, type LocaleCode, pickText } from '@omw/contracts/i18n';
import type {
  AvatarImage,
  DayDetail,
  DaySummary,
  Entry,
  HereNow,
  ImageSet,
  RouteRef,
  SiteProfile,
  TimePrecision,
  TripSummary,
} from '@omw/contracts/site';
import { routePath } from '@omw/contracts/site';
import { thumbHashToDataURL } from 'thumbhash';
import { BREAKPOINTS, type PageStyles } from './css.js';
import { type Html, html, trustedHtml } from './html.js';
import {
  countryFlag,
  countryName,
  formatClock,
  formatDate,
  formatDateRange,
  formatEntryTime,
  formatRelative,
  stringsFor,
} from './strings.js';

/** What a page's twin needs from the generator (a subset of pages.ts SiteContext). */
export interface TwinContext {
  site: {
    title: string;
    locales: readonly LocaleCode[];
    basePath: string;
    /** site.here_now (absent = city_badge): the "Now in"/"Here now" badge only with city_badge. */
    hereNow?: HereNow | undefined;
    /** site.time_precision (absent = exact): part_of_day shows the part of the day, not a time. */
    timePrecision?: TimePrecision | undefined;
  };
  summaries: readonly DaySummary[];
  days: ReadonlyMap<string, DayDetail>;
  tripSummaries: readonly TripSummary[];
  /** Generation time (relative times, "here now"). */
  now: Date;
  url(rel: string): string;
  /** Whose journey it is (timeline.json `profile`), null when the owner set none. */
  profile?: SiteProfile | null;
}

/** The first-viewport image: the twin's <picture> AVIF source, mirrored by a preload (L3-01). */
export interface TwinImage {
  srcset: string;
  sizes: string;
}

export interface TwinResult {
  html: Html;
  firstImage: TwinImage | null;
}

// ---------------------------------------------------------------------------------------------
// Shared pieces

type Metrics = { dayHeader: number; filmstrip: number; divider: number; tripHead: number; dayRow: number };
const COMPACT: Metrics = metrics(76, 216, 64, 152);
const REGULAR: Metrics = metrics(84, 264, 72, 160);
const WIDE: Metrics = metrics(84, 312, 72, 160);
function metrics(dayHeader: number, filmstrip: number, divider: number, tripHead: number): Metrics {
  return { dayHeader, filmstrip, divider, tripHead, dayRow: dayHeader + 8 + filmstrip + 16 + 44 + 36 };
}
/** Gap between strip items (filmstrip.tsx GAP). */
const GAP = 12;
/** Strip items the twin renders per day (enough for a 1440 px mosaic). */
const MAX_STRIP_ITEMS = 10;

/** Deterministic small rotation per key (components/decor.tsx tilt). */
export function tilt(key: string, max = 6): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return ((Math.abs(h) % 1000) / 1000) * 2 * max - max;
}

/** "…/a_w320.avif 320w, …/a_w640.avif 640w" (ascending), as @omw/ui buildSrcSet. */
function srcset(ctx: TwinContext, sources: readonly { w: number; src: string }[]): string {
  return [...sources]
    .sort((a, b) => a.w - b.w)
    .map((s) => `${ctx.url(s.src)} ${s.w}w`)
    .join(', ');
}

function fallback(ctx: TwinContext, image: ImageSet, min: number): string {
  const sorted = [...image.sources.webp].sort((a, b) => a.w - b.w);
  const hit = sorted.find((s) => s.w >= min) ?? sorted.at(-1);
  if (!hit) throw new Error('ImageSet without sources');
  return ctx.url(hit.src);
}

/** @omw/ui <Picture> (placeholder colour as a class instead of an inline style). */
function picture(
  ctx: TwinContext,
  styles: PageStyles,
  image: ImageSet,
  o: {
    sizes: string;
    pictureClass: string;
    imgClass: string;
    alt?: string;
    eager?: boolean;
    high?: boolean;
    /** Width the <img src> fallback should have at least (<Picture fallbackWidth>, default 640). */
    fallbackWidth?: number;
  },
): Html {
  const imgClass = `${o.imgClass} ${styles.imageColor(image.color)}`;
  return html`<picture class="${o.pictureClass}"><source type="image/avif" srcset="${srcset(ctx, image.sources.avif)}" sizes="${o.sizes}"><source type="image/webp" srcset="${srcset(ctx, image.sources.webp)}" sizes="${o.sizes}"><img src="${fallback(ctx, image, o.fallbackWidth ?? 640)}" width="${image.w}" height="${image.h}" alt="${o.alt ?? ''}" loading="${o.eager ? 'eager' : 'lazy'}" decoding="async"${o.high ? html` fetchpriority="high"` : ''} class="${imgClass}"></picture>`;
}

/**
 * profile.tsx <Portrait>: the owner's portrait as a round crop at its focus point, with the
 * ThumbHash placeholder behind it (the SPA sets both as inline styles; here they are classes).
 */
function portrait(ctx: TwinContext, styles: PageStyles, image: AvatarImage, sizes: string): Html {
  const thumb = thumbDataUrl(image.thumbhash);
  const extra = [image.focus ? styles.objectPosition(image.focus) : '', thumb ? styles.backgroundData(thumb) : '']
    .filter(Boolean)
    .join(' ');
  return picture(ctx, styles, image, {
    sizes,
    pictureClass: '',
    imgClass: `size-full rounded-full object-cover${extra ? ` ${extra}` : ''}`,
    eager: true,
    fallbackWidth: 320,
  });
}

/** profile.tsx HERO_PORTRAIT_SIZES. */
export const HERO_PORTRAIT_SIZES = '(min-width: 40rem) 96px, 72px';

const ICON_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

function icon(name: 'play' | 'arrow' | 'pin' | 'system' | 'mic' | 'book', cls: string): Html {
  const paths: Record<typeof name, string> = {
    play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" fill="currentColor"></path>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"></path>',
    pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z"></path><circle cx="12" cy="10" r="2.3"></circle>',
    system:
      '<circle cx="12" cy="12" r="8.5"></circle><path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor"></path>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"></path>',
    book: '<path d="M12 6.5C10 5 7 4.5 4 5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5Z"></path><path d="M12 6.5v13"></path>',
  };
  const flip = name === 'arrow' ? 'rtl:-scale-x-100 ' : '';
  return html`<svg ${trusted(ICON_ATTRS)} class="${flip}${cls}">${trusted(paths[name])}</svg>`;
}

/** Static SVG markup from this source file (never user data). */
function trusted(markup: string): Html {
  return trustedHtml(markup);
}

function paperPlane(cls: string): Html {
  return html`<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false" class="${cls}"><path d="M3.5 15.2 28 4.5l-5.6 22.3-7-6.1-3.7 4.6-.6-7.3Z" fill="var(--omw-surface)"></path><path d="M3.5 15.2 28 4.5l-5.6 22.3-7-6.1M28 4.5 11.1 18l.6 7.3 3.7-4.6M11.1 18 3.5 15.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"></path></svg>`;
}

/** Switches markup between the SPA's compact and regular metrics (display: contents wrappers). */
function compactOnly(styles: PageStyles, inner: Html | string): Html {
  styles.fixed(
    'omw-tw-c',
    `.omw-tw-c{display:contents}@media (min-width:${BREAKPOINTS.regular}px){.omw-tw-c{display:none}}`,
  );
  return html`<span class="omw-tw-c">${inner}</span>`;
}

function regularOnly(styles: PageStyles, inner: Html | string): Html {
  styles.fixed(
    'omw-tw-r',
    `.omw-tw-r{display:none}@media (min-width:${BREAKPOINTS.regular}px){.omw-tw-r{display:contents}}`,
  );
  return html`<span class="omw-tw-r">${inner}</span>`;
}

function isLive(lastAt: string, now: Date): boolean {
  const t = Date.parse(lastAt);
  return Number.isFinite(t) && now.getTime() - t < 48 * 3600_000 && now.getTime() - t > -3600_000;
}

function momentCount(day: DaySummary): number {
  return Object.values(day.counts).reduce((a, b) => a + b, 0);
}

function sameRoute(ctx: TwinContext, locale: LocaleCode, route: RouteRef): string {
  return ctx.url(routePath(locale, route));
}

// ---------------------------------------------------------------------------------------------
// Header + hero (components/site-header.tsx)

function headerBar(ctx: TwinContext, locale: LocaleCode, route: RouteRef, titleTag: 'h1' | 'p'): Html {
  const t = stringsFor(locale).spa;
  const brand = html`<a href="${sameRoute(ctx, locale, { name: 'home' })}" class="group flex min-w-0 items-center gap-2.5 rounded-pill pe-2"><span class="grid size-9 shrink-0 place-items-center rounded-full bg-blush text-accent shadow-soft transition-transform duration-300 ease-soft group-hover:-rotate-12 sm:size-10">${paperPlane('size-5.5 rtl:scale-x-[-1] sm:size-6')}</span><span class="truncate font-display text-[1.3rem] font-semibold tracking-tight text-ink soft sm:text-[1.7rem]">${ctx.site.title}</span></a>`;
  const title = titleTag === 'h1' ? html`<h1 class="min-w-0">${brand}</h1>` : html`<p class="min-w-0">${brand}</p>`;
  const langs = LOCALES.filter((l) => ctx.site.locales.includes(l.code)).map(
    (l) =>
      html`<a href="${sameRoute(ctx, l.code, route)}" hreflang="${l.code}" lang="${l.code}"${l.code === locale ? html` aria-current="page"` : ''} aria-label="${l.label}" class="press relative rounded-pill px-2 py-1.5 text-xs font-extrabold tracking-wider text-muted before:absolute before:inset-x-0 before:-inset-y-2 hover:text-ink aria-[current=page]:bg-blush-strong aria-[current=page]:text-ink sm:px-2.5">${l.code.toUpperCase()}</a>`,
  );
  return html`<header class="mx-auto flex max-w-[68rem] items-center gap-1.5 px-gutter pt-4 sm:px-gutter-wide sm:pt-6">${title}<nav aria-label="${t.language}" class="ms-auto flex shrink-0 rounded-pill bg-surface/70 p-0.5 shadow-soft">${langs}</nav><button type="button" aria-label="${t.themeSystem}" title="${t.themeSystem}" class="press grid size-10 place-items-center rounded-full text-muted hover:bg-blush hover:text-ink">${icon('system', 'size-5')}</button></header>`;
}

/** components/site-header.tsx heroCovers for the days level. */
function heroCovers(ctx: TwinContext, max = 3): ImageSet[] {
  const days = [...ctx.summaries].reverse();
  const trips = new Map(ctx.tripSummaries.map((t) => [t.slug, t]));
  // By original (the "media/aa/<sha16>" before the variant name): the portrait's round crop is
  // its own file, but the same photo.
  const key = (image: ImageSet | undefined) => image?.sources.webp[0]?.src.split('_')[0] ?? null;
  const shown = new Set<string>();
  const portraitKey = key(ctx.profile?.avatar);
  if (portraitKey) shown.add(portraitKey);
  for (const d of days.slice(0, 2)) {
    for (const image of [d.cover, d.trip ? trips.get(d.trip)?.cover : undefined]) {
      const k = key(image);
      if (k) shown.add(k);
    }
  }
  const out: ImageSet[] = [];
  for (const image of [...days.map((d) => d.cover), ...ctx.tripSummaries.map((t) => t.cover)]) {
    const k = key(image);
    if (!image || !k || shown.has(k)) continue;
    shown.add(k);
    out.push(image);
    if (out.length === max) break;
  }
  return out;
}

function polaroid(ctx: TwinContext, styles: PageStyles, image: ImageSet, sizes: string, rotate: number, cls: string) {
  const r = styles.geometry('rot', { rotate: `${Math.round(rotate * 1000) / 1000}deg` });
  return html`<span class="polaroid absolute ${cls} ${r}">${picture(ctx, styles, image, { sizes, pictureClass: 'block h-full', imgClass: 'block h-full w-full object-cover' })}</span>`;
}

function hero(ctx: TwinContext, styles: PageStyles, locale: LocaleCode): Html {
  const t = stringsFor(locale).spa;
  const latest = ctx.summaries.at(-1);
  const countries = new Set(ctx.summaries.map((d) => d.country).filter(Boolean));
  const moments = ctx.summaries.reduce((a, d) => a + momentCount(d), 0);
  let chips: Html | string = '';
  if (latest) {
    // site.here_now other than city_badge: no "Now in"/"Here now" wording and no live accent.
    const badge = (ctx.site.hereNow ?? 'city_badge') === 'city_badge';
    const live = badge && isLive(latest.lastAt, ctx.now);
    const latestTitle = pickText(latest.title, locale, latest.orig)?.text;
    const place =
      latest.place || latestTitle
        ? html`<span class="inline-flex max-w-full items-center gap-1.5 rounded-pill py-1.5 ps-2.5 pe-3 font-bold ${live ? 'bg-accent text-on-accent' : 'bg-surface text-ink shadow-soft'}">${icon('pin', 'size-4 shrink-0')}<span class="truncate">${badge ? `${live ? t.nowIn : t.lastIn} ` : ''}<bdi>${latest.place ?? latestTitle}</bdi>${latest.country ? ` ${countryFlag(latest.country)}` : ''}</span><span class="shrink-0 font-semibold ${live ? 'opacity-85' : 'text-muted'}">· ${formatRelative(latest.lastAt, locale, ctx.now)}</span></span>`
        : '';
    chips = html`<div class="mt-3 flex flex-wrap items-center gap-2 text-sm md:max-w-[calc(100%-18rem)]">${place}<span class="inline-flex items-center gap-1 rounded-pill bg-surface/70 px-3 py-1.5 font-semibold text-muted">${t.days(ctx.summaries.length)} · ${t.countries(countries.size)} · ${t.moments(moments)}</span></div>`;
  }
  const covers = heroCovers(ctx);
  const placements = [
    { cls: 'z-[3] end-[5.5rem] top-1 h-[8.5rem] w-[7.25rem]', rotate: -7 },
    { cls: 'z-[2] end-1 top-4 h-[7.5rem] w-[6.5rem]', rotate: 6 },
    { cls: 'z-[1] end-[11rem] top-7 h-[6.75rem] w-[5.75rem]', rotate: -2 },
  ];
  const collage =
    covers.length > 0
      ? html`<div aria-hidden="true" class="pointer-events-none absolute end-gutter-wide top-1.5 hidden h-40 w-[17rem] md:block">${covers.map(
          (image, i) => {
            const p = placements[i];
            return p ? polaroid(ctx, styles, image, '8rem', p.rotate, p.cls) : '';
          },
        )}<span class="tape absolute end-[7rem] top-0 z-[4] rotate-[-10deg]"></span></div>`
      : '';
  const tagline = html`<p class="font-hand text-lg text-accent sm:text-2xl">${t.tagline} ✈︎</p>`;
  const intro = ctx.profile ? profileIntro(ctx, styles, locale, ctx.profile, tagline) : tagline;
  return html`<div class="relative mx-auto max-w-[68rem] px-gutter pt-3 pb-6 sm:px-gutter-wide sm:pb-8">${intro}${chips}${collage}</div>`;
}

/** components/site-header.tsx ProfileIntro + profile.tsx HeroPortrait. */
function profileIntro(
  ctx: TwinContext,
  styles: PageStyles,
  locale: LocaleCode,
  profile: SiteProfile,
  tagline: Html,
): Html {
  const greeting = pickText(profile.intro, locale);
  const ring = profile.avatar
    ? html`<span aria-hidden="true" data-testid="hero-portrait" class="grid size-[4.5rem] shrink-0 place-items-center rounded-full bg-linear-to-br from-rose-300 via-lilac-300 to-violet-300 p-[3px] shadow-soft sm:size-24"><span class="block size-full overflow-hidden rounded-full bg-bg p-[3px]">${portrait(ctx, styles, profile.avatar, HERO_PORTRAIT_SIZES)}</span></span>`
    : '';
  const name = profile.author
    ? html`<p dir="auto" data-user-text class="line-clamp-2 font-display text-[1.6rem] leading-tight font-semibold tracking-tight break-words text-ink soft sm:text-[2rem]">${profile.author}</p>`
    : '';
  const line = greeting
    ? html`<p lang="${greeting.locale}" dir="auto" data-user-text class="mt-0.5 font-hand text-[1.05rem] leading-snug break-words whitespace-pre-line text-accent sm:text-xl">${greeting.text}</p>`
    : tagline;
  return html`<div data-testid="profile-intro" class="flex items-center gap-3.5 sm:gap-5 md:max-w-[calc(100%-18rem)]">${ring}<div class="min-w-0">${name}${line}</div></div>`;
}

// ---------------------------------------------------------------------------------------------
// Days level rows (timeline/rows.tsx)

function thread(styles: PageStyles, inTrip: boolean) {
  const g = styles.geometry('th', { 'inset-block-start': 0, 'inset-block-end': 0 });
  return html`<span aria-hidden="true" class="thread ${inTrip ? 'thread-trip' : ''} ${g}"></span>`;
}

function rowBox(styles: PageStyles, kind: string, size: (m: Metrics) => number, inner: Html, date?: string): Html {
  const g = styles.geometry('row', { height: size(COMPACT) }, { height: size(REGULAR) }, { height: size(WIDE) });
  return html`<div data-row="${kind}"${date ? html` data-row-date="${date}"` : ''} class="relative ${g}">${inner}</div>`;
}

function dividerRow(styles: PageStyles, locale: LocaleCode, month: string, first: boolean, inTrip: boolean) {
  // The thread starts at the first row's middle (rows.tsx Thread from = m.divider / 2).
  const threadHtml = first
    ? html`<span aria-hidden="true" class="thread ${inTrip ? 'thread-trip' : ''} ${styles.geometry('th', { 'inset-block-start': COMPACT.divider / 2, 'inset-block-end': 0 }, { 'inset-block-start': REGULAR.divider / 2 })}"></span>`
    : thread(styles, inTrip);
  return rowBox(
    styles,
    'divider',
    (m) => m.divider,
    html`<div class="relative flex h-full items-center ps-14">${threadHtml}<span aria-hidden="true" class="absolute start-[17px] size-2.5 rounded-full bg-violet"></span><h2 class="font-hand text-xl text-violet">${formatDate(`${month}-01`, locale, 'month')}</h2></div>`,
  );
}

function tripHeadRow(ctx: TwinContext, styles: PageStyles, locale: LocaleCode, trip: TripSummary): Html {
  const t = stringsFor(locale).spa;
  const title = pickText(trip.title, locale, trip.orig)?.text ?? trip.slug;
  const half = (m: Metrics) => m.tripHead / 2;
  const toHalf = styles.geometry(
    'th',
    { 'inset-block-start': 0, 'inset-block-end': half(COMPACT) },
    { 'inset-block-end': half(REGULAR) },
  );
  const fromHalf = styles.geometry(
    'th',
    { 'inset-block-start': half(COMPACT), 'inset-block-end': 0 },
    { 'inset-block-start': half(REGULAR) },
  );
  const flags = trip.countries.map(countryFlag).join(' ');
  const range = formatDateRange(trip.start, trip.end, locale);
  const cover = (box: string, sizes: string) =>
    trip.cover
      ? html`<span aria-hidden="true" class="relative shrink-0 ${box}">${polaroid(ctx, styles, trip.cover, sizes, 4 + tilt(trip.slug, 2), 'inset-0')}<span class="tape absolute start-1/2 -top-1.5 -translate-x-1/2 scale-75 rotate-[-6deg] rtl:translate-x-1/2"></span></span>`
      : html`<span class="grid size-10 shrink-0 place-items-center rounded-full bg-surface text-accent-strong shadow-soft">${icon('arrow', 'size-5')}</span>`;
  const text = (compact: boolean) =>
    html`<span class="min-w-0 flex-1"><span class="flex items-center gap-2 text-xs font-extrabold tracking-[0.12em] text-accent-strong uppercase">${t.trip}${flags ? html`<span aria-hidden="true" class="truncate text-sm tracking-[0.2em]">${flags}</span>` : ''}</span><span dir="auto" data-user-text class="mt-0.5 block truncate font-display font-semibold text-ink soft ${compact ? 'text-2xl' : 'text-3xl'}">${title}</span><span class="mt-1 flex items-center gap-1.5 font-semibold text-muted ${compact ? 'text-[0.8125rem]' : 'text-sm'}"><span class="truncate">${range}</span>${
      compact
        ? ''
        : html`<span class="shrink-0 text-accent-strong"><span aria-hidden="true">· </span>${t.seeTrip}</span>${icon('arrow', 'size-4 shrink-0 text-accent-strong transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5')}`
    }</span></span>`;
  return rowBox(
    styles,
    'trip-head',
    (m) => m.tripHead,
    html`<div class="relative h-full ps-14 pt-2 pb-4"><span aria-hidden="true" class="thread ${toHalf}"></span><span aria-hidden="true" class="thread thread-trip ${fromHalf}"></span><span aria-hidden="true" class="absolute start-1 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-full bg-surface text-accent shadow-soft">${paperPlane('size-5 -rotate-90 rtl:scale-x-[-1]')}</span><a href="${sameRoute(ctx, locale, { name: 'trip', slug: trip.slug })}" class="press group relative flex h-full items-center gap-3 overflow-hidden rounded-card bg-gradient-to-br from-blush to-lilac ps-5 pe-3.5 shadow-soft hover:shadow-lift sm:gap-4 sm:ps-7 sm:pe-6">${compactOnly(styles, html`${text(true)}${cover('h-[84px] w-[66px]', '66px')}`)}${regularOnly(styles, html`${text(false)}${cover('h-[110px] w-[132px]', '132px')}`)}</a></div>`,
  );
}

/** timeline/strip-layout.ts (the same deterministic geometry). */
interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
  size: 'large' | 'small';
}

const STRIP_ASPECT = { min: 0.62, max: 1.5 };
const MOSAIC_ASPECT = { lead: { min: 0.62, max: 1.25 }, small: { min: 0.75, max: 1 } };
const CARD_ASPECT = {
  large: { text: 0.78, voice: 0.86, note: 0.82, story: 0.86 },
  small: { text: 1.2, voice: 1.1, note: 1.2, story: 1.2 },
} as const;

function stripAspect(entry: Entry, size: 'large' | 'lead' | 'small'): number {
  const img =
    entry.kind === 'photo' ? entry.image : entry.kind === 'video' || entry.kind === 'gif' ? entry.video : null;
  if (img) {
    const bounds = size === 'large' ? STRIP_ASPECT : MOSAIC_ASPECT[size];
    if (img.w <= 0 || img.h <= 0) return Math.max(bounds.min, Math.min(bounds.max, 0.75));
    return Math.min(bounds.max, Math.max(bounds.min, img.w / img.h));
  }
  return CARD_ASPECT[size === 'small' ? 'small' : 'large'][entry.kind as 'text' | 'voice' | 'note' | 'story'];
}

export function stripCells(
  entries: readonly Entry[],
  height: number,
  allowMosaic: boolean,
): {
  cells: Cell[];
  width: number;
} {
  const cells: Cell[] = [];
  if (!(allowMosaic && entries.length >= 4)) {
    let x = 0;
    for (const e of entries) {
      const w = Math.round(height * stripAspect(e, 'large'));
      cells.push({ x, y: 0, w, h: height, size: 'large' });
      x += w + GAP;
    }
    return { cells, width: Math.max(0, x - GAP) };
  }
  const small = Math.floor((height - GAP) / 2);
  const leadW = Math.round(height * stripAspect(entries[0] as Entry, 'lead'));
  cells.push({ x: 0, y: 0, w: leadW, h: height, size: 'large' });
  const ends: [number, number] = [leadW + GAP, leadW + GAP];
  for (let i = 1; i < entries.length; i++) {
    const row = ends[0] <= ends[1] ? 0 : 1;
    const w = Math.round(small * stripAspect(entries[i] as Entry, 'small'));
    cells.push({ x: ends[row], y: row === 0 ? 0 : height - small, w, h: small, size: 'small' });
    ends[row] += w + GAP;
  }
  return { cells, width: Math.max(ends[0], ends[1]) - GAP };
}

function waveform(peaks: readonly number[], cls: string): Html {
  const n = Math.min(peaks.length, 32);
  const step = peaks.length / Math.max(1, n);
  const bars = Array.from({ length: n }, (_, i) => peaks[Math.floor(i * step)] ?? 0);
  return html`<svg viewBox="0 0 ${n * 4} 24" preserveAspectRatio="none" aria-hidden="true" class="${cls}">${bars.map(
    (p, i) =>
      html`<rect x="${i * 4 + 1}" y="${round3(12 - Math.max(1.5, p * 11))}" width="2" height="${round3(Math.max(3, p * 22))}" rx="1" fill="currentColor"></rect>`,
  )}</svg>`;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function stripItem(
  ctx: TwinContext,
  styles: PageStyles,
  locale: LocaleCode,
  date: string,
  entry: Entry,
  cells: [Cell, Cell, Cell],
  first: boolean,
): { html: Html; image: TwinImage | null } {
  const [c, r, w] = cells;
  const geo = (cell: Cell) => ({ 'inset-inline-start': cell.x, top: cell.y, width: cell.w, height: cell.h });
  const g = styles.geometry('cell', geo(c), geo(r), geo(w));
  const sizes = `(min-width: ${BREAKPOINTS.wide}px) ${w.w}px, (min-width: ${BREAKPOINTS.regular}px) ${r.w}px, ${c.w}px`;
  const base =
    'press relative block h-full overflow-hidden rounded-tile shadow-soft outline-offset-3 hover:shadow-lift';
  const href = `${sameRoute(ctx, locale, { name: 'day', date })}#${entry.id}`;
  const pic = (image: ImageSet) =>
    picture(ctx, styles, image, {
      sizes,
      pictureClass: 'block h-full',
      imgClass: 'block h-full w-full object-cover',
      eager: first,
      high: first,
    });
  let image: ImageSet | null = null;
  let body: Html;
  switch (entry.kind) {
    case 'photo':
      image = entry.image;
      body = pic(entry.image);
      break;
    case 'video':
    case 'gif':
      image = entry.video.poster;
      body = html`${pic(entry.video.poster)}<span class="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/55 to-transparent text-xs font-bold text-white p-2.5 pt-8">${
        entry.kind === 'gif'
          ? html`<span class="rounded-pill bg-white/25 px-2 py-0.5 tracking-wider backdrop-blur-sm">GIF</span>`
          : html`<span class="grid size-7 place-items-center rounded-full bg-white/30 backdrop-blur-sm">${icon('play', 'size-3.5')}</span><span class="tabular-nums">${formatClock(entry.video.duration)}</span>`
      }</span>`;
      break;
    case 'text':
      body = html`<span class="grid h-full place-items-center text-center p-4 ${styles.textColors(entry.text.bg, entry.text.fg)}"><span dir="auto" data-user-text class="line-clamp-6 break-words text-lg leading-snug ${styles.waFont(entry.text.font)}">${entry.text.body}</span></span>`;
      break;
    case 'voice':
      body = html`<span class="flex h-full flex-col justify-between bg-lilac text-violet p-4"><span class="grid place-items-center rounded-full bg-surface shadow-soft size-10">${icon('mic', 'size-5')}</span>${waveform(entry.audio.peaks, 'w-full h-12')}<span class="text-sm font-bold tabular-nums">${formatClock(entry.audio.duration)}</span></span>`;
      break;
    case 'note': {
      const note = pickText(entry.note, locale, entry.orig);
      const rot = styles.geometry('rot', { rotate: `${Math.round(tilt(entry.id, 1.6) * 1000) / 1000}deg` });
      return {
        html: html`<li class="absolute snap-start ${g} ${rot}"><a href="${href}" class="${base} washi-tape overflow-visible"><span class="note-paper flex h-full flex-col px-4 pt-6 pb-4"><span class="note-lines block min-h-0 flex-1 font-hand text-[1.05rem] leading-snug text-ink"><span${note ? html` lang="${note.locale}"` : ''} dir="auto" data-user-text class="line-clamp-6">${note?.text ?? ''}</span></span></span></a></li>`,
        image: null,
      };
    }
    case 'story': {
      const content = entry.story[locale] ?? entry.story[entry.orig];
      const spa = stringsFor(locale).spa;
      body = html`<span class="flex h-full flex-col justify-between bg-blush p-4"><span class="inline-flex items-center gap-1.5 font-extrabold tracking-wider text-accent-strong uppercase text-xs">${icon('book', 'size-4')}${spa.story}</span><span dir="auto" data-user-text class="font-display leading-tight soft line-clamp-4 text-xl">${content?.title ?? ''}</span><span class="font-bold text-accent-strong text-sm">${stringsFor(locale).readStory} <span class="inline-block rtl:-scale-x-100">→</span></span></span>`;
      const storyHref = sameRoute(ctx, locale, { name: 'story', date, id: entry.id });
      return {
        html: html`<li class="absolute snap-start ${g}"><a href="${storyHref}" class="${base}">${body}</a></li>`,
        image: null,
      };
    }
  }
  return {
    html: html`<li class="absolute snap-start ${g}"><a href="${href}" class="${base}">${body}</a></li>`,
    image: image && first ? { srcset: srcset(ctx, image.sources.avif), sizes } : null,
  };
}

function filmstrip(
  ctx: TwinContext,
  styles: PageStyles,
  locale: LocaleCode,
  summary: DaySummary,
  day: DayDetail,
  firstRow: boolean,
): { html: Html; image: TwinImage | null } {
  const entries = day.entries.slice(0, MAX_STRIP_ITEMS);
  const c = stripCells(entries, COMPACT.filmstrip - 24, false);
  const r = stripCells(entries, REGULAR.filmstrip - 24, false);
  const w = stripCells(entries, WIDE.filmstrip - 24, true);
  let firstImage: TwinImage | null = null;
  const items = entries.map((entry, i) => {
    const item = stripItem(
      ctx,
      styles,
      locale,
      summary.date,
      entry,
      [c.cells[i] as Cell, r.cells[i] as Cell, w.cells[i] as Cell],
      firstRow && i === 0,
    );
    if (item.image) firstImage = item.image;
    return item.html;
  });
  const ol = styles.geometry(
    'ol',
    { width: c.width, height: COMPACT.filmstrip - 24 },
    { width: r.width, height: REGULAR.filmstrip - 24 },
    { width: w.width, height: WIDE.filmstrip - 24 },
  );
  const glowSize = (width: number) => `min(calc(100% + 0.75rem - var(--spacing-gutter)), ${width + 24}px)`;
  const glow = summary.cover
    ? html`<span aria-hidden="true" class="strip-glow ${styles.glow(summary.cover.color)} ${styles.geometry('glow', { 'inline-size': glowSize(c.width) }, { 'inline-size': glowSize(r.width) }, { 'inline-size': glowSize(w.width) })}"></span>`
    : '';
  return {
    html: html`<div class="group/strip relative isolate h-full">${glow}<div data-strip class="strip h-full snap-x snap-mandatory overflow-x-auto overscroll-x-contain"><ol aria-label="${stringsFor(locale).spa.momentsOfDay}" class="relative box-content pe-gutter ${ol}">${items}</ol></div></div>`,
    image: firstImage,
  };
}

/** The "Here now" badge exists only with site.here_now = city_badge (absent = city_badge). */
function hereNowBadge(ctx: TwinContext): boolean {
  return (ctx.site.hereNow ?? 'city_badge') === 'city_badge';
}

function hereNowChip(locale: LocaleCode, lastAt: string, now: Date, cls = ''): Html {
  const t = stringsFor(locale).spa;
  const live = isLive(lastAt, now);
  return html`<span class="inline-flex shrink-0 items-center gap-1.5 rounded-pill px-2.5 py-1 text-xs font-bold ${live ? 'bg-accent text-on-accent motion-safe:animate-here-now' : 'bg-lilac text-violet'} ${cls}"><span aria-hidden="true" class="size-2 rounded-full ${live ? 'bg-on-accent' : 'bg-violet'}"></span><span class="truncate">${live ? t.hereNow : t.lastSeenHere}</span></span>`;
}

function passportStamp(styles: PageStyles, locale: LocaleCode, country: string, date: string, cls: string): Html {
  const rot = styles.geometry('rot', { rotate: `${Math.round((-8 + tilt(`${country}${date}`, 5)) * 1000) / 1000}deg` });
  return html`<div aria-hidden="true" class="passport-stamp pointer-events-none select-none ${cls} ${rot}"><span class="text-lg leading-none">${countryFlag(country)}</span><span class="max-w-[7.5rem] truncate text-[0.7rem] leading-tight font-extrabold tracking-[0.14em] uppercase">${countryName(country, locale)}</span><span class="text-[0.6rem] leading-none font-bold tracking-[0.1em] uppercase opacity-80">${formatDate(date, locale, 'numeric')}</span></div>`;
}

function dayRow(
  ctx: TwinContext,
  styles: PageStyles,
  locale: LocaleCode,
  summary: DaySummary,
  opts: { latest: boolean; inTrip: boolean; stamp: string | null },
): { html: Html; image: TwinImage | null } {
  const t = stringsFor(locale).spa;
  const day = ctx.days.get(summary.date);
  const title = pickText(summary.title, locale, summary.orig);
  const count = momentCount(summary);
  const headingId = `day-${summary.date}`;
  const dayHref = sameRoute(ctx, locale, { name: 'day', date: summary.date });
  const meta = html`${
    title
      ? html`<time datetime="${summary.date}">${formatDate(summary.date, locale, 'header')}</time>${summary.place || summary.country ? html`<span aria-hidden="true">·</span>` : ''}`
      : ''
  }${summary.place ? html`<bdi class="min-w-0 truncate">${summary.place}</bdi>` : ''}${
    summary.country
      ? html`<span class="shrink-0" title="${countryName(summary.country, locale)}">${countryFlag(summary.country)}</span>`
      : ''
  }${title || summary.place || summary.country ? html`<span aria-hidden="true">·</span>` : ''}<span class="shrink-0">${t.moments(count)}</span>`;
  const heading = (compact: boolean) =>
    html`<h3 id="${compact ? headingId : `${headingId}-r`}"${title ? html` lang="${title.locale}" dir="auto" data-user-text` : ''} class="min-w-0 truncate font-display leading-tight font-semibold text-ink soft ${compact ? 'text-[1.4rem]' : 'text-[1.65rem]'}">${title ? title.text : html`<time datetime="${summary.date}">${formatDate(summary.date, locale, 'title')}</time>`}</h3>`;
  const header = styles.geometry(
    'hdr',
    { height: COMPACT.dayHeader },
    { height: REGULAR.dayHeader },
    { height: WIDE.dayHeader },
  );
  const upper = styles.geometry(
    'upr',
    { height: COMPACT.dayHeader + 8 + COMPACT.filmstrip },
    { height: REGULAR.dayHeader + 8 + REGULAR.filmstrip },
    { height: WIDE.dayHeader + 8 + WIDE.filmstrip },
  );
  const stripBox = styles.geometry(
    'sbx',
    { height: COMPACT.filmstrip },
    { height: REGULAR.filmstrip },
    { height: WIDE.filmstrip },
  );
  const threadFrom = opts.latest
    ? styles.geometry(
        'th',
        { 'inset-block-start': COMPACT.dayHeader / 2, 'inset-block-end': 0 },
        { 'inset-block-start': REGULAR.dayHeader / 2 },
      )
    : styles.geometry('th', { 'inset-block-start': 0, 'inset-block-end': 0 });
  const strip = day ? filmstrip(ctx, styles, locale, summary, day, opts.latest) : { html: html``, image: null };
  const avatar = summary.cover
    ? picture(ctx, styles, summary.cover, {
        sizes: '44px',
        pictureClass: 'block size-full',
        imgClass: 'block size-full object-cover',
      })
    : '';
  const stampCompactTop = styles.geometry('stp', { top: COMPACT.dayHeader + 8 + COMPACT.filmstrip - 46 });
  const html_ = html`<article aria-labelledby="${headingId}" class="day-row relative h-full"><span aria-hidden="true" class="thread ${opts.inTrip ? 'thread-trip' : ''} ${threadFrom}"></span><div class="relative ${upper}"><header data-sticky class="day-header sticky top-0 z-[2] flex items-center gap-3 ${header}"><a href="${dayHref}" tabindex="-1" aria-hidden="true" class="press relative block size-11 shrink-0 overflow-hidden rounded-full bg-blush ring-[3px] ring-bg shadow-soft ${opts.latest ? 'outline-2 outline-offset-2 outline-accent' : ''}"><span data-anchor="${summary.date}" class="block size-full">${avatar}</span></a><div class="min-w-0 flex-1"><p class="flex items-center gap-1.5 overflow-hidden text-[0.8rem] font-bold whitespace-nowrap text-muted">${meta}</p><div class="flex min-w-0 items-center gap-3">${compactOnly(styles, heading(true))}${regularOnly(styles, html`${heading(false)}${opts.latest && hereNowBadge(ctx) ? hereNowChip(locale, summary.lastAt, ctx.now) : ''}`)}</div></div>${
    opts.stamp ? regularOnly(styles, passportStamp(styles, locale, opts.stamp, summary.date, 'me-2 shrink-0')) : ''
  }</header><div class="relative ms-14 -me-gutter mt-2 ${stripBox}">${strip.html}</div></div>${
    opts.stamp
      ? compactOnly(
          styles,
          passportStamp(
            styles,
            locale,
            opts.stamp,
            summary.date,
            `absolute z-[1] ${opts.latest ? `end-1 ${stampCompactTop}` : 'end-2 bottom-5'}`,
          ),
        )
      : ''
  }<div class="ms-14 mt-4 flex h-11 items-center gap-3"><a href="${dayHref}" data-day-cta class="press inline-flex h-11 shrink-0 items-center gap-2 rounded-pill bg-accent ps-3.5 pe-4.5 font-bold whitespace-nowrap text-on-accent shadow-soft hover:bg-accent-strong">${icon('play', 'size-4')}<span>${t.watchDay}<span class="sr-only">: ${formatDate(summary.date, locale, 'header')}</span></span></a>${opts.latest && hereNowBadge(ctx) ? compactOnly(styles, hereNowChip(locale, summary.lastAt, ctx.now, 'min-w-0')) : ''}</div></article>`;
  return { html: rowBox(styles, 'day', (m) => m.dayRow, html_, summary.date), image: strip.image };
}

function zoomPill(locale: LocaleCode): Html {
  const t = stringsFor(locale).spa;
  const labels = [t.zoomYears, t.zoomMonths, t.zoomDays];
  return html`<div class="zoom-pill-dock pointer-events-none fixed inset-x-0 bottom-0 z-10 flex justify-center px-gutter"><fieldset aria-label="${t.zoomLabel}" class="omw-tw-zoom pointer-events-auto relative grid grid-cols-3 rounded-pill border border-line/70 bg-surface/85 p-1 shadow-float backdrop-blur-md"><span aria-hidden="true" class="zoom-pill-thumb absolute inset-y-1 rounded-pill bg-accent shadow-soft"></span>${labels.map(
    (label, i) =>
      html`<button type="button" aria-pressed="${i === 2 ? 'true' : 'false'}" aria-keyshortcuts="${i + 1}" class="press relative z-[1] min-w-[5.25rem] rounded-pill px-3 py-2 text-sm font-bold text-muted hover:text-ink aria-pressed:text-on-accent sm:min-w-24">${label}</button>`,
  )}</fieldset></div>`;
}

/**
 * Home and trip pages: the timeline's first screen. `titleTag` "h1" makes the site title the
 * page's h1 (home); trip pages pass their own sr-only h1.
 */
export function timelineTwin(
  ctx: TwinContext,
  styles: PageStyles,
  locale: LocaleCode,
  route: RouteRef,
  h1: string | null,
): TwinResult {
  // The zoom pill's thumb sits on "Days" (--i: 2 in the SPA's inline style).
  styles.fixed('omw-tw-zoom', '.omw-tw-zoom{--i:2}');
  const days = [...ctx.summaries].reverse();
  const trips = ctx.tripSummaries;
  const tripOf = (d: DaySummary) => (d.trip ? trips.find((t) => t.slug === d.trip) : undefined);
  const rows: Html[] = [];
  let firstImage: TwinImage | null = null;
  let month: string | null = null;
  let open: string | null = null;
  // Passport stamp: the first day in a country after a day elsewhere (or the very first day).
  const olderCountry = days.map((_, i) => days.slice(i + 1).find((d) => d.country)?.country);
  let dayRows = 0;
  for (let i = 0; i < days.length && dayRows < 2; i++) {
    const day = days[i] as DaySummary;
    const trip = tripOf(day);
    if (open && trip?.slug !== open) open = null;
    const m = day.date.slice(0, 7);
    if (m !== month) {
      month = m;
      rows.push(dividerRow(styles, locale, m, rows.length === 0, open !== null));
    }
    if (trip && open !== trip.slug) {
      rows.push(tripHeadRow(ctx, styles, locale, trip));
      open = trip.slug;
    }
    const stamp = day.country && day.country !== olderCountry[i] ? day.country : null;
    const row = dayRow(ctx, styles, locale, day, { latest: i === 0, inTrip: trip !== undefined, stamp });
    firstImage ??= row.image;
    rows.push(row.html);
    dayRows++;
  }
  const t = stringsFor(locale).spa;
  const body = html`<div class="omw-twin relative min-h-dvh overflow-x-clip"><div aria-hidden="true" class="page-grain pointer-events-none fixed inset-0"></div><div class="relative">${h1 ? html`<h1 class="sr-only">${h1}</h1>` : ''}${headerBar(ctx, locale, route, h1 ? 'p' : 'h1')}<main>${hero(ctx, styles, locale)}<section aria-label="${t.timelineDays}" class="mx-auto max-w-[68rem] px-gutter sm:px-gutter-wide"><div class="pb-[calc(4.5rem+env(safe-area-inset-bottom))]"><div class="zoom-stage"><div data-level="days" class="relative">${rows}</div></div></div></section></main></div>${zoomPill(locale)}</div>`;
  return { html: body, firstImage };
}

// ---------------------------------------------------------------------------------------------
// Journey player frame (player/journey-player.tsx, chrome.tsx, slides.tsx)

/** The player's slide image sizes (player/media.ts playerImageSizes without data saver). */
export const PLAYER_IMAGE_SIZES = '(min-width: 40rem) 36rem, 100vw';
const MAX_PROGRESS_SEGMENTS = 30;

function entryImage(entry: Entry | undefined): ImageSet | null {
  if (!entry) return null;
  if (entry.kind === 'photo') return entry.image;
  if (entry.kind === 'video' || entry.kind === 'gif') return entry.video.poster;
  return null;
}

function thumbDataUrl(b64: string): string | null {
  try {
    return thumbHashToDataURL(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
}

function chevron(cls: string): Html {
  return html`<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" class="${cls}"><path d="m9.5 5.5 6.5 6.5-6.5 6.5"></path></svg>`;
}

function railButton(label: string, icon_: Html): Html {
  return html`<button type="button" aria-label="${label}" title="${label}" class="grid size-12 shrink-0 place-items-center rounded-pill bg-surface/85 text-ink shadow-lift ring-1 ring-line backdrop-blur transition-[transform,opacity] duration-150 ease-snappy hover:scale-105 active:scale-95 disabled:opacity-40">${icon_}</button>`;
}

/** journey-player.tsx DayPreview (wide screens): the neighbouring day as a small card link. */
function dayPreview(ctx: TwinContext, styles: PageStyles, locale: LocaleCode, label: string, date: string): Html {
  const summary = ctx.summaries.find((d) => d.date === date);
  const title = summary ? pickText(summary.title, locale, summary.orig)?.text : undefined;
  const cover = summary?.cover
    ? picture(ctx, styles, summary.cover, { sizes: '144px', pictureClass: '', imgClass: 'size-full object-cover' })
    : html`<span class="paper-grain block size-full bg-linear-to-br from-blush to-lilac"></span>`;
  return html`<a href="${sameRoute(ctx, locale, { name: 'day', date })}" class="group/day hidden w-36 shrink-0 text-start lg:block" aria-label="${label}: ${formatDate(date, locale, 'long')}"><span class="relative block aspect-[3/4] overflow-hidden rounded-card bg-blush shadow-lift ring-1 ring-line transition-transform duration-200 ease-soft group-hover/day:-translate-y-1 group-hover/day:rotate-[-1deg]">${cover}<span class="absolute inset-0 bg-linear-to-t from-black/45 to-transparent"></span><span class="absolute inset-x-3 bottom-2.5 text-xs font-bold tracking-wide text-white uppercase">${label}</span></span><span class="mt-2 block text-sm font-semibold text-muted">${formatDate(date, locale, 'header')}</span>${
    title
      ? html`<span class="block truncate font-display text-base font-semibold text-ink" dir="auto" data-user-text>${title}</span>`
      : summary?.place
        ? html`<span class="block truncate font-display text-base font-semibold text-ink"><bdi>${summary.place}</bdi></span>`
        : ''
  }</a>`;
}

/** journey-player.tsx CaptionLayer + chrome.tsx CaptionBlock for the first slide. */
function captionLayer(locale: LocaleCode, entry: Entry | undefined): Html | string {
  if (!entry || entry.kind === 'note' || entry.kind === 'story') return '';
  const caption = entry.kind === 'text' ? undefined : entry.caption;
  const description = pickText(entry.description, locale, entry.descriptionOrig);
  if (!caption && !description) return '';
  return html`<div class="pointer-events-none absolute inset-x-0 bottom-0 z-[2] bg-linear-to-t from-black/75 via-black/40 to-transparent px-5 pt-28 pb-[max(1.75rem,env(safe-area-inset-bottom))] transition-opacity duration-200"><div class="space-y-1.5 [text-shadow:0_1px_10px_rgb(0_0_0/0.45)]">${
    caption
      ? html`<p dir="auto" data-user-text class="line-clamp-6 text-[1.05rem] leading-snug font-semibold whitespace-pre-line text-white">${caption}</p>`
      : ''
  }${
    description
      ? html`<div><p lang="${description.locale}" dir="auto" data-user-text class="line-clamp-5 text-[0.95rem] leading-snug whitespace-pre-line text-white/90">${description.text}</p></div>`
      : ''
  }</div></div>`;
}

/** Day and story pages: the journey player as it opens on the day's first moment. */
export function playerTwin(ctx: TwinContext, styles: PageStyles, locale: LocaleCode, day: DayDetail): TwinResult {
  const t = stringsFor(locale).spa;
  const ownerTitle = pickText(day.title, locale, day.orig)?.text;
  const title = ownerTitle ?? formatDate(day.date, locale, 'player');
  const h1 = `${t.journeyOf(title)}${ownerTitle ? `, ${formatDate(day.date, locale, 'long')}` : ''}`;
  const first = day.entries[0];
  const image = entryImage(first);
  const avatarImage = day.entries.map(entryImage).find((i): i is ImageSet => i !== null) ?? null;
  const glowColor =
    image?.color ??
    (first?.kind === 'text' ? first.text.bg.slice(0, 7) : null) ??
    entryImage(day.entries.at(-1))?.color ??
    null;
  const backdrop = styles.fixed(
    `omw-tw-bd-${(glowColor ?? '#accent').replace('#', '')}`,
    `.omw-tw-bd-${(glowColor ?? '#accent').replace('#', '')}{background:radial-gradient(60% 70% at 50% 45%, color-mix(in oklab, ${glowColor && /^#[0-9a-f]{6}$/.test(glowColor) ? glowColor : 'var(--omw-accent)'} 42%, transparent), transparent 75%), radial-gradient(40% 50% at 15% 85%, color-mix(in oklab, var(--omw-lilac-strong) 55%, transparent), transparent 70%), radial-gradient(45% 45% at 88% 12%, color-mix(in oklab, var(--omw-blush-strong) 70%, transparent), transparent 70%)}`,
  );
  let slide: Html | string = '';
  let firstImage: TwinImage | null = null;
  if (image) {
    const portrait = image.h / image.w >= 1.6;
    const thumb = portrait ? null : thumbDataUrl(image.thumbhash);
    slide = html`<div class="absolute inset-0 overflow-hidden ${styles.imageColor(image.color)}">${
      thumb
        ? html`<span aria-hidden="true" class="absolute inset-0 size-full scale-125 opacity-90 blur-2xl ${styles.backgroundData(thumb)}"></span>`
        : ''
    }${portrait ? '' : html`<div class="absolute inset-0 bg-plum-950/25"></div>`}<div class="absolute inset-0 origin-center">${picture(
      ctx,
      styles,
      image,
      {
        sizes: PLAYER_IMAGE_SIZES,
        pictureClass: 'contents',
        imgClass: `size-full select-none ${portrait ? 'object-cover' : 'object-contain'}`,
        eager: true,
        high: true,
      },
    )}</div></div>`;
    firstImage = { srcset: srcset(ctx, image.sources.avif), sizes: PLAYER_IMAGE_SIZES };
  } else if (first?.kind === 'text') {
    slide = html`<div class="absolute inset-0 grid place-items-center p-8 text-center ${styles.textColors(first.text.bg, first.text.fg)}"><p dir="auto" data-user-text class="text-2xl leading-snug ${styles.waFont(first.text.font)}">${first.text.body}</p></div>`;
  }
  const ids = day.entries.map((e) => e.id);
  const progress =
    ids.length > MAX_PROGRESS_SEGMENTS
      ? html`<div class="relative h-[3px] overflow-hidden rounded-pill bg-white/35" aria-hidden="true"></div>`
      : html`<div class="flex gap-1" aria-hidden="true">${ids.map(
          () =>
            html`<span class="relative h-[3px] min-w-[3px] flex-1 overflow-hidden rounded-pill bg-white/35 group-data-[tone=paper]/player:bg-ink/20"></span>`,
        )}</div>`;
  const meta: (Html | string)[] = [];
  if (ownerTitle) meta.push(formatDate(day.date, locale, 'header'));
  if (first) meta.push(formatEntryTime(first.at, first.tz, locale, ctx.site.timePrecision));
  if (day.place || day.country) {
    meta.push(
      html`${day.place ? html`<bdi>${day.place}</bdi>` : ''}${day.country ? `${day.place ? ' ' : ''}${countryFlag(day.country)}` : ''}`,
    );
  }
  // chrome.tsx PlayerHeader: the owner's portrait, else the day's first picture.
  const avatar = ctx.profile?.avatar
    ? portrait(ctx, styles, ctx.profile.avatar, '40px')
    : avatarImage
      ? picture(ctx, styles, avatarImage, {
          sizes: '40px',
          pictureClass: '',
          imgClass: 'size-full rounded-pill object-cover',
        })
      : html`<span class="block size-full rounded-pill bg-plum-850"></span>`;
  const button = (label: string, svg: string) =>
    html`<button type="button" aria-label="${label}" title="${label}" class="grid size-10 shrink-0 place-items-center rounded-pill text-white transition-[transform,background-color,color] duration-150 ease-snappy hover:bg-white/15 active:scale-90 focus-visible:outline-white group-data-[tone=paper]/player:text-ink group-data-[tone=paper]/player:hover:bg-ink/10 group-data-[tone=paper]/player:focus-visible:outline-ring"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${trusted(svg)}</svg></button>`;
  const tone = first && (first.kind === 'note' || first.kind === 'story') ? 'paper' : 'media';
  const body = html`<div class="omw-twin fixed inset-0 z-40 overflow-hidden bg-bg text-ink"><h1 class="sr-only">${h1}</h1><div class="group/player absolute inset-0 flex items-center justify-center" data-tone="${tone}"><div aria-hidden="true" class="pointer-events-none absolute inset-0 hidden sm:block"><div class="absolute inset-0 ${backdrop}"></div><div class="paper-grain absolute inset-0"></div></div><div class="relative hidden h-full flex-1 items-center gap-6 px-6 sm:flex justify-end">${day.prev ? dayPreview(ctx, styles, locale, t.previousDay, day.prev) : ''}${railButton(t.previousMoment, chevron('-scale-x-100 rtl:scale-x-100'))}</div><section aria-roledescription="${t.slideshow}" aria-label="${title}" class="@container relative isolate h-dvh w-full touch-none overflow-hidden bg-plum-950 text-white select-none [-webkit-touch-callout:none] sm:aspect-[9/16] sm:h-[min(calc(100dvh-3rem),60rem)] sm:w-auto sm:rounded-sheet sm:shadow-float sm:ring-1 sm:ring-black/5" data-twin-frame><div class="absolute inset-0 z-0"><div class="absolute inset-0">${slide}</div></div>${captionLayer(locale, first)}<div class="pointer-events-none absolute inset-x-0 top-0 z-[3] h-36 bg-linear-to-b from-black/55 via-black/20 to-transparent transition-opacity duration-300 group-data-[tone=paper]/player:opacity-0"></div><div class="absolute inset-x-0 top-0 z-[4] space-y-2.5 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">${progress}<div class="transition-opacity duration-200"><div class="flex items-start gap-2.5"><span class="grid size-10 shrink-0 place-items-center rounded-pill bg-linear-to-br from-rose-300 via-rose-600 to-violet-300 p-[2px] shadow-soft"><span class="block size-full overflow-hidden rounded-pill bg-plum-950 p-[2px] group-data-[tone=paper]/player:bg-surface">${avatar}</span></span><div class="flex min-h-10 min-w-0 flex-1 flex-col justify-center leading-tight [text-shadow:0_1px_8px_rgb(0_0_0/0.35)] group-data-[tone=paper]/player:text-ink group-data-[tone=paper]/player:[text-shadow:none]"><p class="truncate font-display text-[0.98rem] font-semibold [font-variation-settings:'SOFT'_100]" dir="auto" data-user-text>${title}</p><span class="block max-h-[2lh] overflow-hidden text-xs font-semibold text-white/80 group-data-[tone=paper]/player:text-muted"><span class="-ms-[0.9em] flex flex-wrap">${meta.map(
    (part) =>
      html`<span class="ms-[0.9em] flex max-w-[calc(100%-0.9em)] min-w-0 before:-ms-[0.9em] before:w-[0.9em] before:shrink-0 before:text-center before:content-['·']"><span class="min-w-0 truncate">${part}</span></span>`,
  )}</span></span></div><div class="flex shrink-0 items-center">${button(t.pause, '<rect x="6.5" y="5" width="3.5" height="14" rx="1.2" fill="currentColor" stroke="none"></rect><rect x="14" y="5" width="3.5" height="14" rx="1.2" fill="currentColor" stroke="none"></rect>')}<div class="relative">${button(t.options, '<circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none"></circle>')}</div>${button(t.close, '<path d="M6 6l12 12M18 6 6 18"></path>')}</div></div></div></div></section><div class="relative hidden h-full flex-1 items-center gap-6 px-6 sm:flex justify-start">${railButton(t.nextMoment, chevron('rtl:-scale-x-100'))}${day.next ? dayPreview(ctx, styles, locale, t.nextDay, day.next) : ''}</div></div></div>`;
  return { html: body, firstImage };
}
