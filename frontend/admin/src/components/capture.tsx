/**
 * Visual of a captured status: private preview (photo, video poster), the WhatsApp text status in
 * its own colours and font, a voice "waveform", or a placeholder. While the preview loads (or
 * offline, where the API's previews are never cached) the thumbhash or dominant colour shows.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { CaptureListItem } from '@omw/contracts/api';
import { waFontStyle } from '@omw/ui/fonts';
import { thumbhashToDataUrl } from '@omw/ui/thumbhash';
import { type CSSProperties, useMemo, useState } from 'react';
import { AlertIcon, InfoIcon, MicIcon, PlayIcon, TextIcon } from './icons';
import { cx, Spinner } from './ui';

export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Deterministic pseudo-waveform (the mirror carries no peaks). */
function bars(seed: string, n = 28): number[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Array.from({ length: n }, (_, i) => {
    h = Math.imul(h ^ (i + 7), 2654435761);
    return 0.25 + (((h >>> 0) % 1000) / 1000) * 0.75;
  });
}

/** Faded look of a hidden status: the picture only, never the labels on it (contrast). */
const DIM = 'opacity-55 grayscale';

export function CaptureVisual({
  capture,
  className,
  rounded = 'rounded-tile',
  compact = false,
  dimmed = false,
  style,
}: {
  capture: CaptureListItem;
  className?: string;
  style?: CSSProperties;
  rounded?: string;
  /** Small thumbnails: no text, smaller badges. */
  compact?: boolean;
  /** Hidden from the site: the picture fades, labels ("Processing…", "Not supported") stay legible. */
  dimmed?: boolean;
}) {
  const { t } = useLingui();
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const src = capture.kind === 'photo' ? capture.previewUrl : (capture.posterUrl ?? capture.previewUrl);
  const placeholder = useMemo(() => {
    const hash = capture.media?.thumbhash;
    return hash ? thumbhashToDataUrl(hash) : null;
  }, [capture.media?.thumbhash]);
  const base = cx('relative isolate overflow-hidden ring-1 ring-ink/6 ring-inset', rounded, className);

  if (capture.kind === 'text' && capture.text) {
    const text = capture.text;
    return (
      <div
        className={cx(base, '@container grid place-items-center p-[9%] text-center', dimmed && DIM)}
        style={{ ...style, backgroundColor: text.bg, color: text.fg }}
      >
        <p
          data-user-text
          dir="auto"
          className={cx(
            'line-clamp-6 leading-snug break-words',
            compact ? 'text-[clamp(0.4rem,10cqi,0.75rem)]' : 'text-[clamp(0.7rem,10.5cqi,1.6rem)]',
          )}
          style={waFontStyle(text.font)}
        >
          {text.body}
        </p>
      </div>
    );
  }

  if (capture.kind === 'voice') {
    return (
      <div
        style={style}
        className={cx(
          base,
          'flex flex-col items-center justify-center gap-3 bg-lilac p-4 text-violet',
          dimmed && 'grayscale',
        )}
      >
        <span className="grid size-11 place-items-center rounded-pill bg-surface shadow-soft">
          <MicIcon className="size-5" />
        </span>
        {!compact && (
          <span className="flex h-10 items-center gap-[3px]" aria-hidden="true">
            {bars(capture.sourceKey).map((v, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static decorative bars
              <span key={i} className="w-[3px] rounded-pill bg-violet/70" style={{ height: `${v * 100}%` }} />
            ))}
          </span>
        )}
        {!compact && capture.media?.duration !== undefined && (
          <span className="text-sm font-bold tabular-nums">{formatDuration(capture.media.duration)}</span>
        )}
      </div>
    );
  }

  if (capture.kind === 'unsupported' || (capture.kind === 'text' && !capture.text)) {
    return (
      <div
        style={style}
        className={cx(
          base,
          // The label is the content here: it keeps full contrast, a hidden one gets a dashed edge.
          'grid place-items-center bg-surface-2 p-3 text-center text-xs font-semibold text-ink',
          dimmed && 'outline-2 -outline-offset-4 outline-dashed outline-line',
        )}
      >
        {compact ? (
          // A thumbnail is too small for the words: an icon, the words for screen readers.
          <>
            {capture.kind === 'unsupported' ? <InfoIcon className="size-5" /> : <TextIcon className="size-5" />}
            <span className="sr-only">
              {capture.kind === 'unsupported' ? <Trans>Not supported</Trans> : <Trans>Text status</Trans>}
            </span>
          </>
        ) : capture.kind === 'unsupported' ? (
          <Trans>Not supported</Trans>
        ) : (
          <Trans>Text status</Trans>
        )}
      </div>
    );
  }

  const showImage = src && !failed;
  return (
    <div className={cx(base, 'bg-blush')} style={style}>
      <div
        aria-hidden="true"
        className={cx('absolute inset-0', dimmed && DIM)}
        style={{
          backgroundColor: capture.media?.color ?? undefined,
          backgroundImage: placeholder && !loaded ? `url(${placeholder})` : undefined,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      >
        {showImage && (
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
            className={cx(
              'absolute inset-0 size-full object-cover transition-opacity duration-500 ease-soft',
              loaded ? 'opacity-100' : 'opacity-0',
            )}
          />
        )}
      </div>
      {(capture.kind === 'video' || capture.kind === 'gif') && capture.mediaState === 'ok' && (
        <span
          className={cx(
            'absolute bottom-2 start-2 inline-flex items-center gap-1 rounded-pill bg-black/60 font-bold text-white backdrop-blur-sm',
            compact ? 'px-1.5 py-0.5 text-[0.6rem]' : 'px-2.5 py-1 text-xs',
          )}
        >
          {capture.kind === 'gif' ? 'GIF' : <PlayIcon className={compact ? 'size-2.5' : 'size-3'} />}
          {!compact && capture.kind === 'video' && formatDuration(capture.media?.duration)}
        </span>
      )}
      {capture.mediaState === 'pending' && (
        <span className="absolute inset-0 grid place-items-center bg-surface/55 backdrop-blur-[2px]">
          <span className="inline-flex max-w-[92%] items-center gap-1.5 rounded-pill bg-surface px-2.5 py-1 text-[0.7rem] font-bold whitespace-nowrap shadow-soft">
            <Spinner className="size-3.5" />
            {!compact && (
              <span className="truncate">
                <Trans>Processing…</Trans>
              </span>
            )}
          </span>
        </span>
      )}
      {capture.mediaState === 'lost' && (
        <span
          className="absolute inset-0 grid place-items-center bg-surface-2/80 p-2 text-center text-xs font-bold text-danger"
          title={t`The media could not be downloaded from WhatsApp.`}
        >
          <span className="inline-flex items-center gap-1">
            <AlertIcon className="size-4" />
            {!compact && <Trans>Media lost</Trans>}
          </span>
        </span>
      )}
    </div>
  );
}
