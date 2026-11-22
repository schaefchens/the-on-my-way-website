/**
 * Horizontal filmstrip of one day (days level): photos, video posters, text-status chips, voice
 * cards, washi-tape notes and story cards. Scroll-snap lives only here, never on the virtual
 * list. The strip has a fixed height, so the day row height never depends on its content.
 *
 * Items are placed by strip-layout.ts: one row, or on wide screens a two-row mosaic (a large
 * first moment, then half-height tiles). Each item is a link named "<kind>, <time>: <excerpt>"
 * (the text of a status, note or story title; a photo's description or caption), L3-10.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { type LocaleCode, pickText } from '@omw/contracts/i18n';
import type { DaySummary, Entry, ImageSet } from '@omw/contracts/site';
import { waFontStyle } from '@omw/ui/fonts';
import { formatTime, isRtl } from '@omw/ui/locale';
import { Picture } from '@omw/ui/picture';
import { thumbhashToDataUrl } from '@omw/ui/thumbhash';
import { Link } from '@tanstack/react-router';
import { type CSSProperties, memo, useCallback, useMemo, useRef, useState } from 'react';
import { tilt } from '../components/decor';
import { BookIcon, ChevronIcon, MicIcon, PlayIcon } from '../components/icons';
import { partOfDayLabel } from '../components/time-labels';
import { useDay } from '../data/hooks';
import { useSiteFlags } from '../site';
import { entriesLayout, excerpt, type StripCell, type StripLayout, stripLayout } from './strip-layout';

/** Gap between items (px), in both directions of the mosaic. */
const GAP = 12;
/** Accessible names cut the moment's text after about this many characters. */
const NAME_EXCERPT = 120;

let rem: number | null = null;
/** px per rem (the visitor may have changed the default font size; item heights are px). */
function remPx(): number {
  if (typeof document === 'undefined') return 16;
  rem ??= Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return rem;
}

/** Whole lines of note text that fit `available` px (no line cut in half, L3-09). */
export function noteLines(available: number, lineHeight: number): number {
  return Math.max(1, Math.floor((available + 0.5) / lineHeight));
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function Waveform({ peaks, className }: { peaks: readonly number[]; className?: string }) {
  const n = Math.min(peaks.length, 32);
  const step = peaks.length / Math.max(1, n);
  const bars = Array.from({ length: n }, (_, i) => peaks[Math.floor(i * step)] ?? 0);
  return (
    <svg viewBox={`0 0 ${n * 4} 24`} preserveAspectRatio="none" aria-hidden="true" className={className}>
      {bars.map((p, i) => (
        <rect
          // biome-ignore lint/suspicious/noArrayIndexKey: static decoration
          key={i}
          x={i * 4 + 1}
          y={12 - Math.max(1.5, p * 11)}
          width="2"
          height={Math.max(3, p * 22)}
          rx="1"
          fill="currentColor"
        />
      ))}
    </svg>
  );
}

/** The text a moment's accessible name quotes (L3-10). */
function itemText(entry: Entry, locale: LocaleCode): string | undefined {
  const description = pickText(entry.description, locale, entry.descriptionOrig)?.text;
  switch (entry.kind) {
    case 'text':
      return entry.text.body;
    case 'note':
      return pickText(entry.note, locale, entry.orig)?.text;
    case 'story':
      return (entry.story[locale] ?? entry.story[entry.orig])?.title;
    default:
      return description ?? entry.caption;
  }
}

function StripItem({
  entry,
  date,
  locale,
  cell,
  partOfDay,
}: {
  entry: Entry;
  date: string;
  locale: LocaleCode;
  cell: StripCell;
  /** site.time_precision = part_of_day: "morgens" instead of "08:40". */
  partOfDay: boolean;
}) {
  const { t } = useLingui();
  const time = partOfDay ? partOfDayLabel(entry.at, entry.tz) : formatTime(entry.at, entry.tz, locale);
  const labels: Record<Entry['kind'], string> = {
    photo: t`Photo`,
    video: t`Video`,
    gif: t`GIF`,
    voice: t`Voice message`,
    text: t`Text status`,
    note: t`Note`,
    story: t`Story`,
  };
  const quoted = itemText(entry, locale);
  const label = `${labels[entry.kind]}, ${time}${quoted?.trim() ? `: ${excerpt(quoted, NAME_EXCERPT)}` : ''}`;
  const small = cell.size === 'small';
  const base =
    'press relative block h-full overflow-hidden rounded-tile shadow-soft outline-offset-3 hover:shadow-lift';

  let body: React.ReactNode;
  switch (entry.kind) {
    case 'photo':
      body = (
        <Picture
          image={entry.image}
          alt=""
          sizes={`${cell.w}px`}
          className="block h-full w-full object-cover"
          pictureClassName="block h-full"
        />
      );
      break;
    case 'video':
    case 'gif':
      body = (
        <>
          <Picture
            image={entry.video.poster}
            alt=""
            sizes={`${cell.w}px`}
            className="block h-full w-full object-cover"
            pictureClassName="block h-full"
          />
          <span
            className={`absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/55 to-transparent text-xs font-bold text-white ${
              small ? 'p-2 pt-6' : 'p-2.5 pt-8'
            }`}
          >
            {entry.kind === 'gif' ? (
              <span className="rounded-pill bg-white/25 px-2 py-0.5 tracking-wider backdrop-blur-sm">GIF</span>
            ) : (
              <>
                <span className="grid size-7 place-items-center rounded-full bg-white/30 backdrop-blur-sm">
                  <PlayIcon className="size-3.5" />
                </span>
                <span className="tabular-nums">{formatDuration(entry.video.duration)}</span>
              </>
            )}
          </span>
        </>
      );
      break;
    case 'text': {
      // Whole lines only: the clamp follows the space the card has.
      const pad = small ? 12 : 16;
      const lineHeight = (small ? 0.95 * 1.3 : 1.125 * 1.375) * remPx();
      body = (
        <span
          className="grid h-full place-items-center text-center"
          style={{ backgroundColor: entry.text.bg, color: entry.text.fg, padding: pad }}
        >
          <span
            dir="auto"
            data-user-text
            className={`line-clamp-(--lines) break-words ${small ? 'text-[0.95rem] leading-[1.3]' : 'text-lg leading-snug'}`}
            style={
              { ...waFontStyle(entry.text.font), '--lines': noteLines(cell.h - 2 * pad, lineHeight) } as CSSProperties
            }
          >
            {entry.text.body}
          </span>
        </span>
      );
      break;
    }
    case 'voice':
      body = (
        <span className={`flex h-full flex-col justify-between bg-lilac text-violet ${small ? 'p-3' : 'p-4'}`}>
          <span
            className={`grid place-items-center rounded-full bg-surface shadow-soft ${small ? 'size-8' : 'size-10'}`}
          >
            <MicIcon className={small ? 'size-4' : 'size-5'} />
          </span>
          <Waveform peaks={entry.audio.peaks} className={`w-full ${small ? 'h-8' : 'h-12'}`} />
          <span className="text-sm font-bold tabular-nums">{formatDuration(entry.audio.duration)}</span>
        </span>
      );
      break;
    case 'note': {
      const note = pickText(entry.note, locale, entry.orig);
      // The paper's rules run at the text's line pitch (1lh, on the same box) and the text
      // shows whole lines only (L3-09).
      const padTop = small ? 20 : 24;
      const padBottom = small ? 12 : 16;
      return (
        <li className="absolute snap-start" style={cellStyle(cell, tilt(entry.id, 1.6))}>
          <Link
            to="/$locale/day/$date/"
            params={{ locale, date }}
            hash={entry.id}
            className={`${base} washi-tape overflow-visible`}
            aria-label={label}
          >
            <span
              className="note-paper flex h-full flex-col"
              style={{ paddingInline: small ? 12 : 16, paddingTop: padTop, paddingBottom: padBottom }}
            >
              {/* The ruled area fills the card; the text shows the whole lines that fit. */}
              <span className="note-lines block min-h-0 flex-1 font-hand text-[1.05rem] leading-snug text-ink">
                <span
                  lang={note?.locale}
                  dir="auto"
                  data-user-text
                  className="line-clamp-(--lines)"
                  style={{ '--lines': noteLines(cell.h - padTop - padBottom, 1.05 * 1.375 * remPx()) } as CSSProperties}
                >
                  {note?.text}
                </span>
              </span>
            </span>
          </Link>
        </li>
      );
    }
    case 'story': {
      const content = entry.story[locale] ?? entry.story[entry.orig];
      body = (
        <span className={`flex h-full flex-col justify-between bg-blush ${small ? 'p-3' : 'p-4'}`}>
          <span
            className={`inline-flex items-center gap-1.5 font-extrabold tracking-wider text-accent-strong uppercase ${
              small ? 'text-[0.65rem]' : 'text-xs'
            }`}
          >
            <BookIcon className={small ? 'size-3.5' : 'size-4'} />
            <Trans>Story</Trans>
          </span>
          <span
            dir="auto"
            data-user-text
            className={`font-display leading-tight soft ${small ? 'line-clamp-2 text-base' : 'line-clamp-4 text-xl'}`}
          >
            {content?.title}
          </span>
          <span className={`font-bold text-accent-strong ${small ? 'text-xs' : 'text-sm'}`}>
            <Trans>Read the story</Trans> <span className="inline-block rtl:-scale-x-100">→</span>
          </span>
        </span>
      );
      break;
    }
  }

  return (
    <li className="absolute snap-start" style={cellStyle(cell)}>
      {entry.kind === 'story' ? (
        <Link
          to="/$locale/day/$date/story/$id/"
          params={{ locale, date, id: entry.id }}
          className={base}
          aria-label={label}
        >
          {body}
        </Link>
      ) : (
        <Link to="/$locale/day/$date/" params={{ locale, date }} hash={entry.id} className={base} aria-label={label}>
          {body}
        </Link>
      )}
    </li>
  );
}

/** Absolute placement of a strip item (logical: mirrors in RTL). */
function cellStyle(cell: StripCell, rotate?: number): CSSProperties {
  return {
    insetInlineStart: cell.x,
    top: cell.y,
    width: cell.w,
    height: cell.h,
    rotate: rotate === undefined ? undefined : `${rotate}deg`,
  };
}

/** Colour + ThumbHash of the day's cover: the first placeholder already looks like the photo. */
function coverPlaceholder(cover: ImageSet): React.CSSProperties {
  const thumb = thumbhashToDataUrl(cover.thumbhash);
  return {
    backgroundColor: cover.color,
    ...(thumb ? { backgroundImage: `url("${thumb}")`, backgroundSize: 'cover', backgroundPosition: 'center' } : {}),
  };
}

/** Placeholders laid out like the strip will be (same mode, cover first), so nothing jumps. */
function skeletonLayout(summary: DaySummary, height: number, mosaic: boolean): StripLayout {
  const count = Math.max(
    1,
    Math.min(
      14,
      Object.values(summary.counts).reduce((a, b) => a + b, 0),
    ),
  );
  const cover = summary.cover;
  const coverAspect = cover && cover.w > 0 && cover.h > 0 ? Math.min(1.5, Math.max(0.66, cover.w / cover.h)) : 0.75;
  return stripLayout(
    count,
    (i, size) => (i === 0 ? Math.min(size === 'lead' ? 1.25 : 1.5, coverAspect) : size === 'small' ? 1 : 0.75),
    {
      height,
      gap: GAP,
      mosaic,
    },
  );
}

function StripSkeleton({ summary, layout }: { summary: DaySummary; layout: StripLayout }) {
  const cover = summary.cover;
  return (
    <>
      {layout.cells.map((cell, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
          key={i}
          aria-hidden="true"
          className="skeleton absolute rounded-tile"
          style={{ ...cellStyle(cell), ...(i === 0 && cover ? coverPlaceholder(cover) : {}) }}
        />
      ))}
    </>
  );
}

export const Filmstrip = memo(function Filmstrip({
  summary,
  locale,
  height,
  mosaic,
}: {
  summary: DaySummary;
  locale: LocaleCode;
  height: number;
  /** Wide screens: lay days with many moments out as a two-row mosaic. */
  mosaic: boolean;
}) {
  const { t } = useLingui();
  const { data, error, refetch } = useDay(summary.date);
  const partOfDay = useSiteFlags().timePrecision === 'part_of_day';
  /** The strip pads 0.75rem above and below (room for shadows and washi tape). */
  const itemHeight = height - 24;
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const fwd = isRtl(locale) ? -1 : 1;
  const entries = data?.entries;
  const layout = useMemo(
    () =>
      entries
        ? entriesLayout(entries, { height: itemHeight, gap: GAP, mosaic })
        : skeletonLayout(summary, itemHeight, mosaic),
    [entries, summary, itemHeight, mosaic],
  );

  const updateEdges = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const pos = Math.abs(el.scrollLeft);
    const max = el.scrollWidth - el.clientWidth;
    setEdges((prev) => {
      const next = { start: pos <= 2, end: pos >= max - 2 };
      return prev.start === next.start && prev.end === next.end ? prev : next;
    });
  }, []);

  const page = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * fwd * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  if (error && !data) {
    return (
      <div
        className="flex h-full items-center gap-3 rounded-tile border border-dashed border-line px-4 text-sm text-muted"
        role="alert"
      >
        <Trans>This day could not be loaded.</Trans>
        <button
          type="button"
          onClick={() => void refetch()}
          className="press rounded-pill bg-blush px-3 py-1.5 font-bold text-accent-strong"
        >
          <Trans>Try again</Trans>
        </button>
      </div>
    );
  }

  const glow = summary.cover?.color;
  return (
    <div className="group/strip relative isolate h-full">
      {/* Day glow in the cover's colour, behind the moments only (never past the row, L3-19). */}
      {glow && (
        <span
          aria-hidden="true"
          className="strip-glow"
          style={
            {
              '--glow': glow,
              inlineSize: `min(calc(100% + 0.75rem - var(--spacing-gutter)), ${layout.width + 24}px)`,
            } as CSSProperties
          }
        />
      )}
      <div
        ref={ref}
        data-strip
        data-mosaic={layout.mosaic || undefined}
        onScroll={updateEdges}
        className="strip h-full snap-x snap-mandatory overflow-x-auto overscroll-x-contain"
      >
        <ol
          aria-label={t`Moments of this day`}
          aria-busy={!data}
          className="relative box-content pe-gutter"
          style={{ width: layout.width, height: layout.height }}
        >
          {entries ? (
            entries.map((entry, i) => {
              const cell = layout.cells[i];
              return cell ? (
                <StripItem
                  key={entry.id}
                  entry={entry}
                  date={summary.date}
                  locale={locale}
                  cell={cell}
                  partOfDay={partOfDay}
                />
              ) : null;
            })
          ) : (
            <StripSkeleton summary={summary} layout={layout} />
          )}
        </ol>
      </div>
      {data && data.entries.length > 1 && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            disabled={edges.start}
            onClick={() => page(-1)}
            className="strip-arrow start-2"
          >
            <ChevronIcon className="size-5 -scale-x-100 rtl:scale-x-100" />
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            disabled={edges.end}
            onClick={() => page(1)}
            className="strip-arrow end-4"
          >
            <ChevronIcon className="size-5" />
          </button>
        </>
      )}
    </div>
  );
});
