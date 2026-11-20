/**
 * HTML pages of the static site (plan A4 "Each HTML page is real content, not an empty shell").
 *
 * Document shell (every page):
 *   <html lang dir> · charset · CSP <meta> (first, so it covers everything after it) · viewport ·
 *   colour scheme · robots (noindex unless site.indexable; 404 always) · title · description ·
 *   author (the profile's name, when set) ·
 *   canonical + hreflang alternates + x-default (absolute, only with SITE_PUBLIC_URL) ·
 *   OG/Twitter (og:image = cover OG JPEG) · the theme boot script (THEME_BOOT_SCRIPT, L3-16:
 *   applies a stored dawn/dusk choice before the first paint) · inline critical CSS (hashed in
 *   the CSP) · <noscript><style> hiding the twin · preloads (L3-01: Latin and, for Vietnamese
 *   text, Vietnamese font subsets; the hand font's 400 file where hand-font text is on the first
 *   screen; the first-viewport image, timeline.json) · Vite tags
 *   (stylesheet, modulepreload of the entry's imports, the locale's message catalog and the
 *   route's lazy chunks, module script; absolute basePath-prefixed URLs) · Boot JSON
 *   (<script id="omw-boot" type="application/json">, escaped; day/story pages inline their day
 *   and the profile, whose portrait their player shows before timeline.json has arrived) ·
 *   <div id="omw-root"> holding the
 *   pre-rendered first screen, which React replaces with createRoot (no hydration).
 *
 * First screen (L3-02): a static twin of the SPA's first viewport (twin.ts: the timeline on
 * home/trip pages, the journey player on day/story pages), followed by the readable article for
 * no-JS readers and crawlers inside <noscript> (the twin is hidden for them by a <noscript>
 * style). The page has exactly one h1 in each case.
 *
 * CSP: default-src 'self'; script-src 'self' + hashes of inline scripts (the theme boot script;
 * the language picker's); style-src 'self' + the hashes of the page's <style> elements; img-src 'self' data: blob:;
 * media-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri
 * 'self'; form-action 'self'; manifest-src 'self'; worker-src 'self'. No 'unsafe-inline' and no
 * style attributes anywhere (frame-ancestors cannot be set from a <meta>; see .htaccess).
 *
 * Release stamp: Boot.manifestVersion/timelineV are the release in which the page's content
 * last changed (home and 404 always carry the current release). This keeps day/story/trip
 * pages byte-stable across unrelated releases, so a new status re-uploads only its own day.
 * Each page is therefore returned as parts plus a content hash that excludes the stamp.
 */
import type { LocaleCode } from '@omw/contracts/i18n';
import { pickText, textDirection } from '@omw/contracts/i18n';
import type {
  Boot,
  DayDetail,
  DaySummary,
  Entry,
  ImageSet,
  RouteName,
  RouteRef,
  SiteInfo,
  SiteProfile,
  TripDetail,
  TripSummary,
} from '@omw/contracts/site';
import { BOOT_ELEMENT_ID, routePath } from '@omw/contracts/site';
import { PageStyles } from './css.js';
import { canonicalJson, cspHash, shortSha } from './hash.js';
import { type Html, type HtmlValue, html, inlineCode, jsonForScript, safeHref, trustedHtml } from './html.js';
import { renderMarkdown } from './markdown.js';
import { textFor } from './model.js';
import type { SiteBuild } from './site-build.js';
import {
  countryFlag,
  countryName,
  formatDate,
  formatDateRange,
  formatDuration,
  formatTime,
  languageName,
  localeLabel,
  type PageStrings,
  stringsFor,
} from './strings.js';
import { playerTwin, type TwinContext, type TwinImage, timelineTwin } from './twin.js';

export const ROOT_ELEMENT_ID = 'omw-root';

/**
 * Copy of @omw/ui THEME_BOOT_SCRIPT (frontend/shared/src/theme.ts; the backend does not depend
 * on @omw/ui, a test keeps both identical): applies a stored dawn/dusk choice before first paint.
 */
export const THEME_BOOT_SCRIPT =
  "try{var t=localStorage.getItem('omw-theme');if(t==='dawn'||t==='dusk')document.documentElement.setAttribute('data-theme',t==='dusk'?'night':'dawn')}catch(e){}";

/** No-JS readers get the article: the twin (a frame of controls without its app) is hidden. */
export const NOSCRIPT_CSS = '.omw-twin{display:none!important}';

/** Replaced at render time with the timeline.json preload of the page's release stamp. */
const TIMELINE_PRELOAD_MARK = '\u0000omw-timeline-preload\u0000';

/**
 * Characters of the Vietnamese font subsets (Fontsource unicode-range): pages whose visible text
 * uses them preload those subsets (L3-03).
 */
const VIETNAMESE = /[\u0102\u0103\u0110\u0111\u01A0-\u01B0\u1EA0-\u1EF9]/;
/**
 * Precomposed letters of the hand font's Vietnamese file (frontend/shared/fonts/playpen-sans,
 * subsets.json unicodeRange; its combining marks are in the Latin file too).
 */
const HAND_VIETNAMESE = /[\u0102\u0103\u0110\u0111\u0128\u0129\u0168\u0169\u01A0\u01A1\u01AF\u01B0\u1EA0-\u1EF9\u20AB]/;
/** Cookie the language picker honours (the SPA may set it when the visitor switches language). */
export const LOCALE_COOKIE = 'omw_locale';
/** How many days the home page lists. */
export const HOME_RECENT_DAYS = 10;

export interface ReleaseStamp {
  manifestVersion: number;
  timelineV: string;
}

export type BootBase = Omit<Boot, 'manifestVersion' | 'timelineV'>;

export interface RenderedPage {
  /** OUT_DIR-relative file path, e.g. "de/day/2026-11-15/index.html". */
  path: string;
  route: RouteName | 'picker';
  /** Hash of the page without its release stamp. */
  contentHash: string;
  /** Always carries the current release (home, 404). */
  alwaysCurrent: boolean;
  boot: BootBase | null;
  render(stamp: ReleaseStamp): string;
}

export interface SiteContext {
  site: SiteInfo;
  /** Public base URL ending in "/" (SITE_PUBLIC_URL), or null: no absolute URLs then. */
  publicBase: string | null;
  build: SiteBuild;
  days: ReadonlyMap<string, DayDetail>;
  summaries: readonly DaySummary[];
  summaryByDate: ReadonlyMap<string, DaySummary>;
  trips: ReadonlyMap<string, TripDetail>;
  tripSummaries: readonly TripSummary[];
  /**
   * Whose journey it is (timeline.json `profile`; null when unset). A change of it makes the
   * next run full, so every page that shows it is re-rendered.
   */
  profile?: SiteProfile | null;
}

// ---------------------------------------------------------------------------------------------
// URL helpers

/** Root-relative URL for a site-relative path ("/travel/" + "de/"). */
export function siteUrl(ctx: { site: SiteInfo }, rel: string): string {
  return safeHref(ctx.site.basePath + rel.replace(/^\/+/, ''));
}

function absoluteUrl(ctx: SiteContext, rel: string): string | null {
  return ctx.publicBase ? safeHref(ctx.publicBase + rel.replace(/^\/+/, '')) : null;
}

/** OUT_DIR file path of a route ("de/day/2026-11-15/index.html"). */
export function routeFile(locale: LocaleCode, route: RouteRef): string {
  return `${routePath(locale, route)}index.html`;
}

function bootRoute(route: RouteRef): Boot['route'] {
  switch (route.name) {
    case 'home':
      return { name: 'home', params: {} };
    case 'day':
      return { name: 'day', params: { date: route.date } };
    case 'story':
      return { name: 'story', params: { date: route.date, id: route.id } };
    case 'trip':
      return { name: 'trip', params: { slug: route.slug } };
  }
}

// ---------------------------------------------------------------------------------------------
// Fragments

export function truncate(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  let cut = flat.slice(0, max - 1);
  // Never split a surrogate pair (emoji, flags): a lone surrogate is written as U+FFFD.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function plainFromMarkdown(markdown: string): string {
  return renderMarkdown(markdown)
    .value.replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function origLabel(t: PageStrings, picked: LocaleCode, locale: LocaleCode): Html | null {
  return picked === locale ? null : html`<span class="omw-fs-orig">${t.original(languageName(picked, locale))}</span>`;
}

function placeLine(locale: LocaleCode, place: string | undefined, country: string | undefined): Html | null {
  if (!place && !country) return null;
  const flag = country ? countryFlag(country) : '';
  const countryLabel = country ? countryName(country, locale) : '';
  return html`${place ? html`<bdi>${place}</bdi>` : countryLabel}${flag ? html` <span title="${countryLabel}">${flag}</span>` : ''}`;
}

function pickSource(sources: readonly { w: number; src: string }[], min: number): string {
  const hit = sources.find((s) => s.w >= min) ?? sources.at(-1);
  if (!hit) throw new Error('ImageSet without sources');
  return hit.src;
}

function picture(
  ctx: SiteContext,
  styles: PageStyles,
  image: ImageSet,
  opts: { alt: string; sizes: string; eager?: boolean; high?: boolean; minWidth?: number; className?: string },
): Html {
  const srcset = (list: readonly { w: number; src: string }[]) =>
    list.map((s) => `${siteUrl(ctx, s.src)} ${s.w}w`).join(', ');
  const cls = `omw-fs-img ${styles.imageColor(image.color)}${opts.className ? ` ${opts.className}` : ''}`;
  return html`<picture class="omw-fs-pic"><source type="image/avif" srcset="${srcset(image.sources.avif)}" sizes="${opts.sizes}"><source type="image/webp" srcset="${srcset(image.sources.webp)}" sizes="${opts.sizes}"><img class="${cls}" src="${siteUrl(ctx, pickSource(image.sources.webp, opts.minWidth ?? 640))}" width="${image.w}" height="${image.h}" alt="${opts.alt}" decoding="async" loading="${opts.eager ? 'eager' : 'lazy'}"${opts.high ? html` fetchpriority="high"` : ''}></picture>`;
}

/**
 * Row thumbnail. AVIF first, like the SPA's <Picture>: a WebP-only first screen made browsers
 * download every thumbnail twice (WebP here, AVIF once the SPA mounted). `display:contents` on
 * the <picture> keeps the <img> the grid item of the row.
 */
function thumb(ctx: SiteContext, styles: PageStyles, image: ImageSet | undefined, alt: string, eager: boolean): Html {
  if (!image) return html`<span class="omw-fs-ph" aria-hidden="true"></span>`;
  const cls = `omw-fs-img ${styles.imageColor(image.color)}`;
  const srcset = (list: readonly { w: number; src: string }[]) =>
    list.map((s) => `${siteUrl(ctx, s.src)} ${s.w}w`).join(', ');
  return html`<picture class="omw-fs-tpic"><source type="image/avif" srcset="${srcset(image.sources.avif)}" sizes="88px"><source type="image/webp" srcset="${srcset(image.sources.webp)}" sizes="88px"><img class="${cls}" src="${siteUrl(ctx, pickSource(image.sources.webp, 160))}" width="${image.w}" height="${image.h}" alt="${alt}" decoding="async" loading="${eager ? 'eager' : 'lazy'}"></picture>`;
}

const ENTRY_SIZES = '(min-width: 44rem) 42rem, 100vw';

function entryHtml(
  ctx: SiteContext,
  styles: PageStyles,
  locale: LocaleCode,
  date: string,
  entry: Entry,
  priority: boolean,
): Html {
  const t = stringsFor(locale);
  const time = formatTime(entry.at, entry.tz, locale);
  const description = entry.kind === 'note' || entry.kind === 'story' ? undefined : entry.description;
  const descOrig = entry.kind === 'note' || entry.kind === 'story' ? undefined : entry.descriptionOrig;
  const desc = textFor(description, locale, descOrig);
  const caption = 'caption' in entry ? entry.caption : undefined;
  // The fallback names what the picture is (L3-17): a GIF's or video's poster is not a photo.
  const kindLabel = entry.kind === 'gif' ? t.gif : entry.kind === 'video' ? t.video : t.photo;
  const alt = desc?.text ?? caption ?? `${kindLabel} ${time}`;
  let body: HtmlValue = null;
  switch (entry.kind) {
    case 'photo':
      body = picture(ctx, styles, entry.image, {
        alt: truncate(alt, 250),
        sizes: ENTRY_SIZES,
        eager: priority,
        high: priority,
      });
      break;
    case 'video':
    case 'gif':
      body = html`${picture(ctx, styles, entry.video.poster, {
        alt: truncate(alt, 250),
        sizes: ENTRY_SIZES,
        eager: priority,
        high: priority,
      })}<span class="omw-fs-meta">${entry.kind === 'gif' ? t.gif : t.video} · ${formatDuration(entry.video.duration)}</span>`;
      break;
    case 'voice':
      body = html`<p class="omw-fs-card">🎙️ ${t.voiceMessage(formatDuration(entry.audio.duration))}</p>`;
      break;
    case 'text':
      body = html`<div class="omw-fs-text ${styles.textColors(entry.text.bg, entry.text.fg)} ${styles.waFont(entry.text.font)}"><p class="omw-fs-user" dir="auto">${entry.text.body}</p></div>`;
      break;
    case 'note': {
      const note = textFor(entry.note, locale, entry.orig);
      body = note
        ? html`<div class="omw-fs-note"><p class="omw-fs-user" dir="auto" lang="${note.locale}">${note.text}</p>${origLabel(t, note.locale, locale)}</div>`
        : null;
      break;
    }
    case 'story': {
      const picked = pickStory(entry, locale);
      body = picked
        ? html`<div class="omw-fs-card"><h3 dir="auto" lang="${picked.locale}">${picked.content.title}</h3>${origLabel(t, picked.locale, locale)}<a href="${siteUrl(ctx, routePath(locale, { name: 'story', date, id: entry.id }))}">${t.readStory}</a></div>`
        : null;
      break;
    }
  }
  return html`<li class="omw-fs-entry" id="${entry.id}"><time class="omw-fs-meta" datetime="${entry.at}">${time}</time>${body}${
    caption ? html`<p class="omw-fs-user" dir="auto">${caption}</p>` : ''
  }${
    desc
      ? html`<p class="omw-fs-user omw-fs-desc" dir="auto" lang="${desc.locale}">${desc.text}${origLabel(t, desc.locale, locale)}</p>`
      : ''
  }</li>`;
}

type StoryEntry = Extract<Entry, { kind: 'story' }>;

/** The picture an entry shows (photo, or the poster of a video/GIF). */
function imageOfEntry(entry: Entry): ImageSet | undefined {
  if (entry.kind === 'photo') return entry.image;
  if (entry.kind === 'video' || entry.kind === 'gif') return entry.video.poster;
  return undefined;
}

/** Same picture (media paths are content-addressed by the original). */
function sameImage(a: ImageSet, b: ImageSet | undefined): boolean {
  return !!b && a.sources.webp[0]?.src === b.sources.webp[0]?.src;
}

export function pickStory(entry: StoryEntry, locale: LocaleCode) {
  const titles = Object.fromEntries(Object.entries(entry.story).map(([k, v]) => [k, v?.title ?? '']));
  const picked = textFor(titles, locale, entry.orig);
  const content = picked ? entry.story[picked.locale] : undefined;
  return picked && content ? { locale: picked.locale, content } : null;
}

function header(ctx: SiteContext, locale: LocaleCode, route: RouteRef | null, brand = true): Html {
  const t = stringsFor(locale);
  const langs =
    ctx.site.locales.length > 1
      ? html`<nav aria-label="${t.languages}"><ul class="omw-fs-langs">${ctx.site.locales.map((l) => {
          const href = siteUrl(ctx, route ? routePath(l, route) : routePath(l, { name: 'home' }));
          return l === locale
            ? html`<li><a href="${href}" hreflang="${l}" lang="${l}" aria-current="${route ? 'page' : 'true'}">${localeLabel(l)}</a></li>`
            : html`<li><a href="${href}" hreflang="${l}" lang="${l}">${localeLabel(l)}</a></li>`;
        })}</ul></nav>`
      : null;
  // On the home page the h1 is the site title: no second brand line (L3-02, one h1).
  return html`<header class="omw-fs-top">${brand ? html`<a class="omw-fs-brand" href="${siteUrl(ctx, routePath(locale, { name: 'home' }))}">${ctx.site.title}</a>` : html`<span></span>`}${langs}</header>`;
}

function arrows(locale: LocaleCode): { back: string; forward: string } {
  return textDirection(locale) === 'rtl' ? { back: '→', forward: '←' } : { back: '←', forward: '→' };
}

// ---------------------------------------------------------------------------------------------
// Document shell

interface HeadMeta {
  locale: LocaleCode;
  title: string;
  description: string;
  /** Route of this page (canonical + alternates), null for 404 / picker. */
  route: RouteRef | null;
  ogType: 'website' | 'article';
  ogImage: ImageSet | undefined;
  ogImageAlt: string;
  noindex: boolean;
}

/** <meta name="author"> with the traveler's name (setting site.author), when there is one. */
function authorMeta(ctx: { profile?: SiteProfile | null }): Html | string {
  const author = ctx.profile?.author;
  return author ? html`<meta name="author" content="${author}">\n` : '';
}

function buildCsp(scriptHashes: readonly string[], styleHashes: string | readonly string[]): string {
  const styles = typeof styleHashes === 'string' ? [styleHashes] : styleHashes;
  return [
    "default-src 'self'",
    `script-src 'self'${scriptHashes.map((h) => ` ${h}`).join('')}`,
    `style-src 'self'${styles.map((h) => ` ${h}`).join('')}`,
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
  ].join('; ');
}

export interface HeadOptions {
  app: boolean;
  inlineScripts?: string[];
  /** The twin's first-viewport image (preloaded with high priority, L3-01). */
  image?: TwinImage | null;
  /** Lazy chunks to modulepreload besides the entry's imports (locale catalog, route chunks). */
  chunks?: readonly string[];
  /** The page shows Vietnamese text: preload the Vietnamese font subsets (L3-03). */
  vietnamese?: boolean;
  /**
   * Text in the handwriting face on the first screen (greeting, tagline, month headings, notes):
   * preload its Latin file, and its Vietnamese one when that text needs it, so it does not show
   * in the fallback face first on a slow first visit. Empty: no hand-font preload.
   */
  handText?: string;
  /** Preload data/timeline.json?v=<release timelineV> (pages whose first screen needs it). */
  timeline?: boolean;
  /** Hide the twin for no-JS readers (pages with a twin and a <noscript> article). */
  noscriptCss?: boolean;
}

function headTags(ctx: SiteContext, meta: HeadMeta, css: string, opts: HeadOptions): Html {
  const t = stringsFor(meta.locale);
  const scripts = opts.app ? [THEME_BOOT_SCRIPT, ...(opts.inlineScripts ?? [])] : (opts.inlineScripts ?? []);
  const csp = buildCsp(scripts.map(cspHash), opts.noscriptCss ? [cspHash(css), cspHash(NOSCRIPT_CSS)] : [cspHash(css)]);
  const route = meta.route;
  const canonical = route ? absoluteUrl(ctx, routePath(meta.locale, route)) : null;
  const alternates =
    route && ctx.publicBase
      ? html`${ctx.site.locales.map(
          (l) => html`<link rel="alternate" hreflang="${l}" href="${absoluteUrl(ctx, routePath(l, route))}">\n`,
        )}<link rel="alternate" hreflang="x-default" href="${absoluteUrl(ctx, routePath(ctx.site.defaultLocale, route))}">\n`
      : null;
  const og = meta.ogImage?.og ? absoluteUrl(ctx, meta.ogImage.og) : null;
  const build = ctx.build;
  const ltr = textDirection(meta.locale) === 'ltr';
  const hand = ltr && !!opts.handText?.trim();
  const fonts = [
    ...(ltr ? build.fontPreload : []),
    ...(opts.vietnamese ? build.fontVietnamese : []),
    ...(hand ? build.fontHand.latin : []),
    ...(hand && HAND_VIETNAMESE.test(opts.handText ?? '') ? build.fontHand.vietnamese : []),
  ];
  const appTags = opts.app
    ? html`${fonts.map(
        (f) => html`<link rel="preload" href="${siteUrl(ctx, f)}" as="font" type="font/woff2" crossorigin>\n`,
      )}${
        opts.image
          ? html`<link rel="preload" as="image" type="image/avif" imagesrcset="${opts.image.srcset}" imagesizes="${opts.image.sizes}" fetchpriority="high">\n`
          : ''
      }${opts.timeline ? trustedHtml(TIMELINE_PRELOAD_MARK) : ''}${build.css.map((c) => html`<link rel="stylesheet" href="${siteUrl(ctx, c)}">\n`)}${[
        ...build.modulepreload,
        ...(opts.chunks ?? []).filter((c) => !build.modulepreload.includes(c)),
      ].map(
        (m) => html`<link rel="modulepreload" href="${siteUrl(ctx, m)}" crossorigin>\n`,
      )}<script type="module" src="${siteUrl(ctx, build.script)}" crossorigin></script>\n`
    : null;
  const favicon = build.favicon
    ? html`<link rel="icon" href="${siteUrl(ctx, build.favicon.path)}" type="${build.favicon.type}">\n`
    : html`<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%E2%9C%88%EF%B8%8F%3C/text%3E%3C/svg%3E">\n`;
  return html`<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#fff8f6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1b1322" media="(prefers-color-scheme: dark)">
${meta.noindex ? html`<meta name="robots" content="noindex, nofollow">\n` : ''}<title>${meta.title}</title>
<meta name="description" content="${meta.description}">
${authorMeta(ctx)}${canonical ? html`<link rel="canonical" href="${canonical}">\n` : ''}${alternates}<meta property="og:site_name" content="${ctx.site.title}">
<meta property="og:type" content="${meta.ogType}">
<meta property="og:title" content="${meta.title}">
<meta property="og:description" content="${meta.description}">
<meta property="og:locale" content="${t.ogLocale}">
${canonical ? html`<meta property="og:url" content="${canonical}">\n` : ''}${
  og
    ? html`<meta property="og:image" content="${og}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${meta.ogImageAlt}">
`
    : ''
}<meta name="twitter:card" content="${og ? 'summary_large_image' : 'summary'}">
${scripts.map((s) => html`<script>${inlineCode(s)}</script>\n`)}${favicon}<style>${inlineCode(css)}</style>
${opts.noscriptCss ? html`<noscript><style>${inlineCode(NOSCRIPT_CSS)}</style></noscript>\n` : ''}${appTags}`;
}

function finalizePage(
  path: string,
  route: RenderedPage['route'],
  alwaysCurrent: boolean,
  locale: LocaleCode,
  head: Html,
  boot: BootBase | null,
  body: Html,
): RenderedPage {
  const dir = textDirection(locale);
  const before = `<!doctype html>\n<html lang="${locale}" dir="${dir}">\n<head>\n${head.value}${
    boot ? `<script id="${BOOT_ELEMENT_ID}" type="application/json">` : ''
  }`;
  const after = `${boot ? '</script>\n' : ''}</head>\n<body>\n${body.value}\n</body>\n</html>\n`;
  const contentHash = shortSha(`${before}\u0000${canonicalJson(boot)}\u0000${after}`);
  return {
    path,
    route,
    contentHash,
    alwaysCurrent,
    boot,
    render(stamp) {
      const head = before.replace(
        TIMELINE_PRELOAD_MARK,
        `<link rel="preload" href="${safeHref(`${boot?.basePath ?? '/'}data/timeline.json?v=${stamp.timelineV}`)}" as="fetch" crossorigin>\n`,
      );
      if (!boot) return head + after;
      const { basePath, locale: l, route: r, day, profile } = boot;
      const full: Boot = {
        basePath,
        locale: l,
        route: r,
        manifestVersion: stamp.manifestVersion,
        timelineV: stamp.timelineV,
        ...(day ? { day } : {}),
        ...(profile ? { profile } : {}),
      };
      return head + jsonForScript(full).value + after;
    },
  };
}

interface TwinSpec {
  kind: 'timeline' | 'player';
  /** sr-only h1 of a timeline twin whose page title is not the site title (trip pages). */
  h1?: string;
  day?: DayDetail;
  /** Extra lazy chunks of the route (player, story sheet). */
  chunks?: readonly string[];
}

function twinContext(ctx: SiteContext): TwinContext {
  // "now" of the twin: the newest moment (not the wall clock), so pages stay byte-stable between
  // releases; the SPA shows the live relative time once it mounts.
  const latest =
    ctx.summaries
      .map((d) => d.lastAt)
      .sort()
      .at(-1) ?? '1970-01-01T00:00:00.000Z';
  return {
    site: ctx.site,
    summaries: ctx.summaries,
    days: ctx.days,
    tripSummaries: ctx.tripSummaries,
    now: new Date(latest),
    url: (rel) => siteUrl(ctx, rel),
    profile: ctx.profile ?? null,
  };
}

/**
 * Whether the text a reader sees in `markup` (tags stripped; our escaping never encodes letters)
 * needs the Vietnamese font subsets (L3-03).
 */
export function needsVietnamese(markup: string): boolean {
  return VIETNAMESE.test(
    markup.replace(/<(?:script|style)[^>]*>[\s\S]*?<\/(?:script|style)>/g, ' ').replace(/<[^>]*>/g, ' '),
  );
}

/**
 * Text inside the elements of `markup` that use the handwriting face (class "font-hand"),
 * nested markup included; "" when there are none.
 */
export function handFontText(markup: string): string {
  const out: string[] = [];
  for (const m of markup.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\sclass="(?:[^"]*\s)?font-hand(?:\s[^"]*)?"[^>]*>/g)) {
    const tag = m[1] as string;
    const start = m.index + m[0].length;
    const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g');
    tags.lastIndex = start;
    let depth = 1;
    let end = markup.length;
    for (let t = tags.exec(markup); t; t = tags.exec(markup)) {
      depth += t[1] ? -1 : 1;
      if (depth === 0) {
        end = t.index;
        break;
      }
    }
    out.push(markup.slice(start, end).replace(/<[^>]*>/g, ' '));
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

function appPage(
  ctx: SiteContext,
  path: string,
  routeName: RouteName,
  meta: HeadMeta,
  styles: PageStyles,
  boot: BootBase,
  main: Html,
  alwaysCurrent: boolean,
  twin: TwinSpec,
): RenderedPage {
  const route = meta.route ?? { name: 'home' };
  const tctx = twinContext(ctx);
  const rendered =
    twin.kind === 'player' && twin.day
      ? playerTwin(tctx, styles, meta.locale, twin.day)
      : timelineTwin(tctx, styles, meta.locale, route, twin.h1 ?? null);
  const article = html`<div class="omw-fs">${header(ctx, meta.locale, meta.route, routeName !== 'home')}<main>${main}</main></div>`;
  const body = html`<div id="${ROOT_ELEMENT_ID}">${rendered.html}<noscript>${article}</noscript></div>`;
  const head = headTags(ctx, meta, styles.css(), {
    app: true,
    image: rendered.firstImage,
    chunks: [...new Set([...(ctx.build.localeChunks[meta.locale] ?? []), ...(twin.chunks ?? [])])],
    vietnamese: needsVietnamese(rendered.html.value),
    handText: handFontText(rendered.html.value),
    timeline: true,
    noscriptCss: true,
  });
  return finalizePage(path, routeName, alwaysCurrent, meta.locale, head, boot, body);
}

function pageTitle(ctx: SiteContext, ...parts: (string | null | undefined)[]): string {
  return [...parts.filter((p): p is string => !!p && p.trim().length > 0), ctx.site.title].join(' · ');
}

// ---------------------------------------------------------------------------------------------
// Pages

/**
 * The no-JS article's lead on the home page: who travels and their greeting (in the visitor's
 * language, else in the one it was written in), else the tagline.
 */
function profileArticle(ctx: SiteContext, locale: LocaleCode): Html {
  const t = stringsFor(locale);
  const profile = ctx.profile;
  const greeting = pickText(profile?.intro, locale);
  return html`${profile?.author ? html`<p class="omw-fs-kicker" dir="auto">${profile.author}</p>` : ''}${
    greeting
      ? html`<p class="omw-fs-lead omw-fs-user" dir="auto" lang="${greeting.locale}">${greeting.text}</p>`
      : html`<p class="omw-fs-lead">${t.tagline}</p>`
  }`;
}

/** Boot members of a day/story page: its day, plus the profile (shown before the timeline loads). */
function dayBoot(ctx: SiteContext, day: DayDetail): Pick<BootBase, 'day' | 'profile'> {
  return { day, ...(ctx.profile ? { profile: ctx.profile } : {}) };
}

export function renderHome(ctx: SiteContext, locale: LocaleCode): RenderedPage {
  const t = stringsFor(locale);
  const styles = new PageStyles();
  const route: RouteRef = { name: 'home' };
  const recent = [...ctx.summaries].reverse().slice(0, HOME_RECENT_DAYS);
  let eager = 4;
  const tripRows = ctx.tripSummaries.map((trip) => {
    const title = textFor(trip.title, locale, trip.orig);
    const flags = trip.countries.map(countryFlag).join(' ');
    return html`<li><a class="omw-fs-row" href="${siteUrl(ctx, routePath(locale, { name: 'trip', slug: trip.slug }))}">${thumb(ctx, styles, trip.cover, '', eager-- > 0)}<span><strong dir="auto"${title ? html` lang="${title.locale}"` : ''}>${title?.text ?? trip.slug}</strong><span class="omw-fs-meta">${formatDateRange(trip.start, trip.end, locale)}${flags ? ` · ${flags}` : ''} · ${t.days(trip.dayCount)}</span></span></a></li>`;
  });
  const dayRows = recent.map((day) => {
    const title = textFor(day.title, locale, day.orig);
    const total = Object.values(day.counts).reduce((a, b) => a + b, 0);
    const place = placeLine(locale, day.place, day.country);
    return html`<li><a class="omw-fs-row" href="${siteUrl(ctx, routePath(locale, { name: 'day', date: day.date }))}">${thumb(ctx, styles, day.cover, '', eager-- > 0)}<span><span class="omw-fs-meta"><time datetime="${day.date}">${formatDate(day.date, locale, 'header')}</time>${place ? html` · ${place}` : ''}</span><strong dir="auto"${title ? html` lang="${title.locale}"` : ''}>${title?.text ?? formatDate(day.date, locale, 'long')}</strong><span class="omw-fs-meta">${t.moments(total)}</span></span></a></li>`;
  });
  const main = html`<h1>${ctx.site.title}</h1>${profileArticle(ctx, locale)}${
    tripRows.length > 0 ? html`<h2>${t.trips}</h2><ul class="omw-fs-list">${tripRows}</ul>` : ''
  }<h2>${t.latestDays}</h2>${dayRows.length > 0 ? html`<ul class="omw-fs-list">${dayRows}</ul>` : html`<p>${t.noMoments}</p>`}`;
  const latestWithOg = recent.find((d) => d.cover?.og);
  return appPage(
    ctx,
    routeFile(locale, route),
    'home',
    {
      locale,
      title: ctx.site.title,
      description: t.homeDescription(ctx.site.title),
      route,
      ogType: 'website',
      ogImage: latestWithOg?.cover,
      ogImageAlt: ctx.site.title,
      noindex: !ctx.site.indexable,
    },
    styles,
    { basePath: ctx.site.basePath, locale, route: bootRoute(route) },
    main,
    true,
    { kind: 'timeline' },
  );
}

export function renderDay(ctx: SiteContext, locale: LocaleCode, day: DayDetail): RenderedPage {
  const t = stringsFor(locale);
  const styles = new PageStyles();
  const route: RouteRef = { name: 'day', date: day.date };
  const summary = ctx.summaryByDate.get(day.date);
  const dateLong = formatDate(day.date, locale, 'long');
  const title = textFor(day.title, locale, day.orig);
  const lead = textFor(day.summary, locale, day.orig);
  const place = placeLine(locale, day.place, day.country);
  const trip = day.trip ? ctx.trips.get(day.trip) : undefined;
  const tripTitle = trip ? textFor(trip.title, locale, trip.orig) : null;
  // The cover (always set when the day has an image) is the eager, high-priority first image.
  // It is shown as a separate hero only when it is not already the day's first image entry
  // (usually it is): otherwise the first screen would show the same picture twice in a row.
  // Without a hero, that first image entry is the eager, high-priority (LCP) image instead.
  const cover = summary?.cover;
  const firstImage = day.entries.find((e) => imageOfEntry(e));
  const hero = cover && !(firstImage && sameImage(cover, imageOfEntry(firstImage))) ? cover : undefined;
  const priorityId = hero ? null : (firstImage?.id ?? null);
  const a = arrows(locale);
  const main = html`<p class="omw-fs-kicker"><a href="${siteUrl(ctx, routePath(locale, { name: 'home' }))}">${a.back} ${t.backToTimeline}</a></p><p class="omw-fs-kicker"><time datetime="${day.date}">${dateLong}</time>${place ? html` · ${place}` : ''}</p><h1 dir="auto"${title ? html` lang="${title.locale}"` : ''}>${title?.text ?? dateLong}</h1>${
    lead
      ? html`<p class="omw-fs-lead omw-fs-user" dir="auto" lang="${lead.locale}">${lead.text}${origLabel(t, lead.locale, locale)}</p>`
      : ''
  }<p class="omw-fs-meta">${t.moments(day.entries.length)}${
    trip
      ? html` · ${t.trip}: <a href="${siteUrl(ctx, routePath(locale, { name: 'trip', slug: trip.slug }))}" dir="auto">${tripTitle?.text ?? trip.slug}</a>`
      : ''
  }</p>${
    hero
      ? picture(ctx, styles, hero, {
          alt: title?.text ?? dateLong,
          sizes: ENTRY_SIZES,
          eager: true,
          high: true,
        })
      : ''
  }<ol class="omw-fs-entries">${day.entries.map((e) => entryHtml(ctx, styles, locale, day.date, e, e.id === priorityId))}</ol>${
    day.prev || day.next
      ? html`<nav class="omw-fs-nav" aria-label="${t.previousDay} / ${t.nextDay}">${
          day.prev
            ? html`<a rel="prev" href="${siteUrl(ctx, routePath(locale, { name: 'day', date: day.prev }))}">${a.back} ${t.previousDay}: ${formatDate(day.prev, locale, 'header')}</a>`
            : html`<span></span>`
        }${
          day.next
            ? html`<a rel="next" href="${siteUrl(ctx, routePath(locale, { name: 'day', date: day.next }))}">${t.nextDay}: ${formatDate(day.next, locale, 'header')} ${a.forward}</a>`
            : ''
        }</nav>`
      : ''
  }`;
  const description = lead?.text ?? t.dayDescription(dateLong, day.entries.length);
  return appPage(
    ctx,
    routeFile(locale, route),
    'day',
    {
      locale,
      title: pageTitle(ctx, title?.text, title ? formatDate(day.date, locale, 'short') : dateLong),
      description: truncate(description),
      route,
      ogType: 'article',
      ogImage: cover,
      ogImageAlt: title?.text ?? dateLong,
      noindex: !ctx.site.indexable,
    },
    styles,
    { basePath: ctx.site.basePath, locale, route: bootRoute(route), ...dayBoot(ctx, day) },
    main,
    false,
    { kind: 'player', day, chunks: ctx.build.playerChunks },
  );
}

export function renderStory(ctx: SiteContext, locale: LocaleCode, day: DayDetail, entry: StoryEntry): RenderedPage {
  const t = stringsFor(locale);
  const styles = new PageStyles();
  const route: RouteRef = { name: 'story', date: day.date, id: entry.id };
  const picked = pickStory(entry, locale);
  const dateLong = formatDate(day.date, locale, 'long');
  const a = arrows(locale);
  const title = picked?.content.title ?? dateLong;
  const main = html`<p class="omw-fs-kicker"><a href="${siteUrl(ctx, routePath(locale, { name: 'day', date: day.date }))}">${a.back} ${t.backToDay}</a> · <time datetime="${day.date}">${dateLong}</time></p><article class="omw-fs-story" dir="auto"${picked ? html` lang="${picked.locale}"` : ''}><h1>${title}</h1>${
    picked ? origLabel(t, picked.locale, locale) : ''
  }${picked ? renderMarkdown(picked.content.body) : ''}</article>`;
  return appPage(
    ctx,
    routeFile(locale, route),
    'story',
    {
      locale,
      title: pageTitle(ctx, title),
      description: truncate(picked ? plainFromMarkdown(picked.content.body) || title : title),
      route,
      ogType: 'article',
      ogImage: ctx.summaryByDate.get(day.date)?.cover,
      ogImageAlt: title,
      noindex: !ctx.site.indexable,
    },
    styles,
    { basePath: ctx.site.basePath, locale, route: bootRoute(route), ...dayBoot(ctx, day) },
    main,
    false,
    { kind: 'player', day, chunks: [...ctx.build.playerChunks, ...ctx.build.storySheetChunks] },
  );
}

export function renderTrip(ctx: SiteContext, locale: LocaleCode, trip: TripDetail): RenderedPage {
  const t = stringsFor(locale);
  const styles = new PageStyles();
  const route: RouteRef = { name: 'trip', slug: trip.slug };
  const title = textFor(trip.title, locale, trip.orig);
  const description = textFor(trip.description, locale, trip.orig);
  const range = formatDateRange(trip.start, trip.end, locale);
  const summary = ctx.tripSummaries.find((s) => s.slug === trip.slug);
  const flags = (summary?.countries ?? []).map(countryFlag).join(' ');
  const a = arrows(locale);
  let eager = 3;
  const rows = trip.days.map((date) => {
    const day = ctx.summaryByDate.get(date);
    const dayTitle = day ? textFor(day.title, locale, day.orig) : null;
    const total = day ? Object.values(day.counts).reduce((x, y) => x + y, 0) : 0;
    const place = day ? placeLine(locale, day.place, day.country) : null;
    return html`<li><a class="omw-fs-row" href="${siteUrl(ctx, routePath(locale, { name: 'day', date }))}">${thumb(ctx, styles, day?.cover, '', eager-- > 0)}<span><span class="omw-fs-meta"><time datetime="${date}">${formatDate(date, locale, 'header')}</time>${place ? html` · ${place}` : ''}</span><strong dir="auto"${dayTitle ? html` lang="${dayTitle.locale}"` : ''}>${dayTitle?.text ?? formatDate(date, locale, 'long')}</strong><span class="omw-fs-meta">${t.moments(total)}</span></span></a></li>`;
  });
  const main = html`<p class="omw-fs-kicker"><a href="${siteUrl(ctx, routePath(locale, { name: 'home' }))}">${a.back} ${t.backToTimeline}</a></p><p class="omw-fs-kicker">${range}${flags ? ` · ${flags}` : ''} · ${t.days(trip.days.length)}</p><h1 dir="auto"${title ? html` lang="${title.locale}"` : ''}>${title?.text ?? trip.slug}</h1>${
    description
      ? html`<p class="omw-fs-lead omw-fs-user" dir="auto" lang="${description.locale}">${description.text}${origLabel(t, description.locale, locale)}</p>`
      : ''
  }${trip.cover ? picture(ctx, styles, trip.cover, { alt: title?.text ?? trip.slug, sizes: ENTRY_SIZES, eager: true, high: true }) : ''}${
    rows.length > 0 ? html`<ul class="omw-fs-list">${rows}</ul>` : html`<p>${t.noMoments}</p>`
  }`;
  return appPage(
    ctx,
    routeFile(locale, route),
    'trip',
    {
      locale,
      title: pageTitle(ctx, title?.text ?? trip.slug),
      description: truncate(description?.text ?? t.tripDescription(title?.text ?? trip.slug, range)),
      route,
      ogType: 'article',
      ogImage: trip.cover,
      ogImageAlt: title?.text ?? trip.slug,
      noindex: !ctx.site.indexable,
    },
    styles,
    { basePath: ctx.site.basePath, locale, route: bootRoute(route) },
    main,
    // The first screen (timeline twin) shows the newest days: always current, like home.
    true,
    { kind: 'timeline', h1: title?.text ?? trip.slug },
  );
}

/** /404.html: served by hosts at any URL depth, so every URL in it is absolute. */
export function renderNotFound(ctx: SiteContext): RenderedPage {
  const locale = ctx.site.defaultLocale;
  const t = stringsFor(locale);
  const styles = new PageStyles();
  const main = html`<h1>${t.notFoundTitle}</h1><p>${t.notFoundText}</p><p><a href="${siteUrl(ctx, routePath(locale, { name: 'home' }))}">${t.toHome}</a></p>`;
  const body = html`<div id="${ROOT_ELEMENT_ID}"><div class="omw-fs">${header(ctx, locale, null)}<main>${main}</main></div></div>`;
  const head = headTags(
    ctx,
    {
      locale,
      title: pageTitle(ctx, t.notFoundTitle),
      description: t.notFoundText,
      route: null,
      ogType: 'website',
      ogImage: undefined,
      ogImageAlt: '',
      noindex: true,
    },
    styles.css(),
    { app: true },
  );
  return finalizePage(
    '404.html',
    'notFound',
    true,
    locale,
    head,
    { basePath: ctx.site.basePath, locale, route: { name: 'notFound', params: {} } },
    body,
  );
}

/** Inline script of the language picker (hashed into its CSP). */
export function pickerScript(ctx: { site: SiteInfo }): string {
  const config = { locales: ctx.site.locales, fallback: ctx.site.defaultLocale, base: ctx.site.basePath };
  return [
    '(function(){',
    `var c=${jsonForScript(config).value};`,
    `var m=document.cookie.match(/(?:^|;\\s*)${LOCALE_COOKIE}=([A-Za-z-]+)/);`,
    'var pick=m&&c.locales.indexOf(m[1])>=0?m[1]:null;',
    'var langs=navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language||""];',
    'for(var i=0;!pick&&i<langs.length;i++){var l=String(langs[i]).toLowerCase().split("-")[0];if(c.locales.indexOf(l)>=0)pick=l;}',
    'location.replace(c.base+(pick||c.fallback)+"/"+location.search+location.hash);',
    '})();',
  ].join('');
}

/** /index.html: language picker (JS: cookie, navigator.languages; no JS: meta refresh + links). */
export function renderPicker(ctx: SiteContext): RenderedPage {
  const locale = ctx.site.defaultLocale;
  const t = stringsFor(locale);
  const fallbackUrl = siteUrl(ctx, routePath(locale, { name: 'home' }));
  const script = pickerScript(ctx);
  const styles = new PageStyles();
  const links = ctx.site.locales.map(
    (l) =>
      html`<li><a class="omw-fs-card" href="${siteUrl(ctx, routePath(l, { name: 'home' }))}" hreflang="${l}" lang="${l}">${localeLabel(l)}</a></li>`,
  );
  const prompts = [...new Set(ctx.site.locales.map((l) => stringsFor(l).chooseLanguage))].join(' · ');
  const body = html`<div class="omw-fs"><main><h1>${ctx.site.title}</h1><p class="omw-fs-lead">${prompts}</p><ul class="omw-fs-list">${links}</ul></main></div>`;
  const alternates = ctx.publicBase
    ? html`${ctx.site.locales.map(
        (l) =>
          html`<link rel="alternate" hreflang="${l}" href="${absoluteUrl(ctx, routePath(l, { name: 'home' }))}">\n`,
      )}<link rel="alternate" hreflang="x-default" href="${absoluteUrl(ctx, '')}">\n`
    : null;
  // The picker loads no app stylesheet, so it paints its own page background (dawn/dusk).
  const css = `${styles.css()}html{background:var(--fs-bg);color-scheme:light dark}body{margin:0}`;
  const csp = buildCsp([cspHash(script)], cspHash(css));
  const head = html`<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
${ctx.site.indexable ? '' : html`<meta name="robots" content="noindex, nofollow">\n`}<title>${ctx.site.title}</title>
<meta name="description" content="${t.homeDescription(ctx.site.title)}">
${authorMeta(ctx)}${alternates}<noscript><meta http-equiv="refresh" content="0; url=${fallbackUrl}"></noscript>
<style>${inlineCode(css)}</style>
<script>${inlineCode(script)}</script>
`;
  return finalizePage('index.html', 'picker', true, locale, head, null, body);
}
