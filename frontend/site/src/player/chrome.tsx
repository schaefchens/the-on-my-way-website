/**
 * Player chrome: progress segments (driven by a MotionValue, no re-render per frame), the
 * header with the always-visible pause button (WCAG 2.2.2), the options menu (sound, data
 * saver) and the caption block.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { LocaleCode, PickedText } from '@omw/contracts/i18n';
import type { ImageSet } from '@omw/contracts/site';
import { languageName } from '@omw/ui/locale';
import { REDUCED_TRANSITION, SPRINGS } from '@omw/ui/motion';
import { Picture } from '@omw/ui/picture';
import { type MotionValue, m } from 'motion/react';
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { CloseIcon, LeafIcon, MoreIcon, PauseIcon, PlayIcon, SoundOffIcon, SoundOnIcon } from './icons';

// ---------------------------------------------------------------------------------------------
// Progress

/** Writes `progress` into the element's transform on every change (no React render). */
export function useProgressStyle<E extends Element>(
  ref: RefObject<E | null>,
  progress: MotionValue<number> | null,
  write: (el: E, value: number) => void,
): void {
  const writeRef = useRef(write);
  writeRef.current = write;
  useEffect(() => {
    const el = ref.current;
    if (!el || !progress) return;
    writeRef.current(el, progress.get());
    return progress.on('change', (v) => writeRef.current(el, v));
  }, [ref, progress]);
}

function ActiveFill({ progress }: { progress: MotionValue<number> }) {
  const ref = useRef<HTMLSpanElement>(null);
  useProgressStyle(ref, progress, (el, v) => {
    el.style.transform = `scaleX(${v.toFixed(4)})`;
  });
  return (
    <span
      ref={ref}
      className="absolute inset-0 origin-left rounded-pill bg-white rtl:origin-right group-data-[tone=paper]/player:bg-ink"
      style={{ transform: 'scaleX(0)' }}
    />
  );
}

/**
 * Above this many moments the segments would get thinner than ~6 px on a 320 px phone and
 * overflow the frame (the current one could end up off-screen): one continuous bar instead.
 */
export const MAX_PROGRESS_SEGMENTS = 30;

/** Share of the whole day that has been watched: (index + item progress) / count, 0..1. */
export function dayProgress(index: number, count: number, itemProgress: number, ended: boolean): number {
  if (ended) return 1;
  if (!(count > 0)) return 0;
  const p = Number.isFinite(itemProgress) ? Math.min(1, Math.max(0, itemProgress)) : 0;
  return Math.min(1, Math.max(0, (index + p) / count));
}

/** Single bar for days with many moments (same look as one long segment). */
function ContinuousProgress({
  count,
  index,
  ended,
  progress,
}: {
  count: number;
  index: number;
  ended: boolean;
  progress: MotionValue<number>;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const write = (el: HTMLSpanElement, v: number) => {
    el.style.transform = `scaleX(${dayProgress(index, count, v, ended).toFixed(5)})`;
  };
  useProgressStyle(ref, progress, write);
  // A new index while the item progress stays at 0 (e.g. paused) emits no change: write directly.
  useEffect(() => {
    if (ref.current) write(ref.current, progress.get());
  });
  return (
    <div className="flex" aria-hidden="true" data-testid="player-progress" data-mode="continuous">
      <span className="relative h-[3px] flex-1 overflow-hidden rounded-pill bg-white/35 group-data-[tone=paper]/player:bg-ink/20">
        <span
          ref={ref}
          className="absolute inset-0 origin-left rounded-pill bg-white rtl:origin-right group-data-[tone=paper]/player:bg-ink"
          style={{ transform: `scaleX(${dayProgress(index, count, 0, ended)})` }}
        />
      </span>
    </div>
  );
}

/**
 * One segment per moment (keyed by entry id); the current one is driven by `progress`. Days with
 * more than MAX_PROGRESS_SEGMENTS moments get one continuous bar.
 */
export function ProgressBars({
  ids,
  index,
  ended,
  progress,
}: {
  ids: readonly string[];
  index: number;
  ended: boolean;
  progress: MotionValue<number>;
}) {
  if (ids.length > MAX_PROGRESS_SEGMENTS) {
    return <ContinuousProgress count={ids.length} index={index} ended={ended} progress={progress} />;
  }
  return (
    <div className="flex gap-1" aria-hidden="true" data-testid="player-progress" data-mode="segments">
      {ids.map((id, i) => {
        const done = ended || i < index;
        return (
          <span
            key={id}
            className="relative h-[3px] min-w-[3px] flex-1 overflow-hidden rounded-pill bg-white/35 group-data-[tone=paper]/player:bg-ink/20"
          >
            {done && <span className="absolute inset-0 rounded-pill bg-white group-data-[tone=paper]/player:bg-ink" />}
            {!done && i === index && <ActiveFill progress={progress} />}
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Buttons

export function ChromeButton({
  label,
  onClick,
  children,
  pressed,
  expanded,
  controls,
  className = '',
  testId,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
  expanded?: boolean;
  controls?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-controls={controls}
      data-testid={testId}
      onClick={onClick}
      className={`grid size-10 shrink-0 place-items-center rounded-pill text-white transition-[transform,background-color,color] duration-150 ease-snappy hover:bg-white/15 active:scale-90 focus-visible:outline-white group-data-[tone=paper]/player:text-ink group-data-[tone=paper]/player:hover:bg-ink/10 group-data-[tone=paper]/player:focus-visible:outline-ring ${className}`}
    >
      {children}
    </button>
  );
}

export function PlayPauseButton({ playing, onToggle }: { playing: boolean; onToggle: () => void }) {
  const { t } = useLingui();
  return (
    <ChromeButton label={playing ? t`Pause` : t`Play`} onClick={onToggle} testId="player-toggle">
      {playing ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
    </ChromeButton>
  );
}

// ---------------------------------------------------------------------------------------------
// Centred play affordance (L3-05, L3-20)

/**
 * The big, labelled play button in the middle of the frame: "Watch the day" before a start
 * without autoplay (reduced motion, a paused day change), "Listen to the voice note" on a voice
 * note held for its sound. One gesture plays (with sound). Light glass on the dark frame, with
 * the theme's surface/ink/accent, so it follows dawn and dusk; it fades in, instantly under
 * reduced motion.
 */
export function CenterPlayButton({
  label,
  icon,
  onPlay,
  reducedMotion,
  testId,
}: {
  label: string;
  icon: 'play' | 'sound';
  onPlay: () => void;
  reducedMotion: boolean;
  testId?: string;
}) {
  return (
    <m.button
      type="button"
      onClick={onPlay}
      data-testid={testId}
      initial={{ opacity: 0, scale: reducedMotion ? 1 : 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={reducedMotion ? REDUCED_TRANSITION : SPRINGS.soft}
      className="pointer-events-auto flex min-h-15 max-w-full items-center gap-3 rounded-pill bg-surface/95 py-2 ps-2 pe-6 text-start text-ink shadow-float ring-1 ring-line/70 backdrop-blur-md transition-[scale,background-color] duration-150 ease-snappy hover:bg-surface active:scale-95 focus-visible:outline-[3px] focus-visible:outline-offset-4 focus-visible:outline-white group-data-[tone=paper]/player:focus-visible:outline-ring"
    >
      <span
        aria-hidden="true"
        className="grid size-11 shrink-0 place-items-center rounded-pill bg-accent text-on-accent shadow-soft"
      >
        {icon === 'play' ? <PlayIcon size={22} /> : <SoundOnIcon size={22} />}
      </span>
      <span className="font-display text-[1.15rem] leading-tight font-semibold [font-variation-settings:'SOFT'_100]">
        {label}
      </span>
    </m.button>
  );
}

/** "Watch the day" in the middle of the frame, with a one-line hint on how to go on. */
export function WatchTheDay({
  onPlay,
  fwd,
  reducedMotion,
}: {
  onPlay: () => void;
  /** Reading direction: 1 = forward is on the right (LTR), -1 = on the left (RTL). */
  fwd: 1 | -1;
  reducedMotion: boolean;
}) {
  const { t } = useLingui();
  return (
    // Above the slide and its captions, below the top chrome (z-[4]), which stays usable.
    <div className="pointer-events-none absolute inset-0 z-[3] flex flex-col items-center justify-center gap-3 px-6">
      {/* A soft scrim: the moment shows through, the button reads clearly over any content. */}
      <m.span
        aria-hidden="true"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={reducedMotion ? REDUCED_TRANSITION : { duration: 0.3 }}
        className="absolute inset-0 -z-10 bg-[radial-gradient(closest-side,rgb(27_19_34/0.55),rgb(27_19_34/0.3))]"
      />
      <CenterPlayButton
        label={t({ message: 'Watch the day', context: 'player start button' })}
        icon="play"
        onPlay={onPlay}
        reducedMotion={reducedMotion}
        testId="player-center-play"
      />
      <m.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={reducedMotion ? REDUCED_TRANSITION : { duration: 0.3, delay: 0.15 }}
        className="rounded-pill bg-black/40 px-3 py-1 text-center text-xs font-semibold text-white ring-1 ring-white/15 backdrop-blur-md"
      >
        {fwd === 1 ? t`Then tap on the right to go on` : t`Then tap on the left to go on`}
      </m.p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Options menu

export function OptionsMenu({
  muted,
  dataSaver,
  onMuted,
  onDataSaver,
  onOpenChange,
}: {
  muted: boolean;
  dataSaver: boolean;
  onMuted: (muted: boolean) => void;
  onDataSaver: (on: boolean) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onOpenChange?.(open);
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        rootRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={rootRef} className="relative">
      <ChromeButton label={t`Player options`} expanded={open} controls={panelId} onClick={() => setOpen((v) => !v)}>
        <MoreIcon size={22} />
      </ChromeButton>
      {open && (
        <div
          id={panelId}
          className="absolute end-0 top-12 z-20 w-64 rounded-card bg-surface p-2 text-ink shadow-float"
          data-no-gesture
        >
          <Switch
            checked={!muted}
            onChange={(on) => onMuted(!on)}
            icon={muted ? <SoundOffIcon size={20} /> : <SoundOnIcon size={20} />}
            label={t`Sound`}
          />
          <Switch
            checked={dataSaver}
            onChange={onDataSaver}
            icon={<LeafIcon size={20} />}
            label={t`Data saver`}
            hint={t`Smaller images, videos only on tap`}
          />
        </div>
      )}
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
  hint,
  icon,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
  hint?: string;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-3 rounded-tile px-3 py-2.5 text-start hover:bg-blush"
    >
      <span className="text-violet">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      <span
        aria-hidden="true"
        className={`relative h-6 w-10 shrink-0 rounded-pill transition-colors ${checked ? 'bg-accent' : 'bg-line'}`}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-pill bg-white shadow-soft transition-[inset-inline-start] duration-200 ease-snappy ${checked ? 'start-[1.125rem]' : 'start-0.5'}`}
        />
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Header

/**
 * Parts separated by " · " that wrap instead of being cut off. A part that starts a line has
 * no separator: each separator sits in its part's leading margin, which the clipping wrapper
 * hides at the start of a line (works in both directions). At most two lines; a single part
 * longer than a line is truncated.
 */
export function MetaParts({ parts, className = '' }: { parts: readonly ReactNode[]; className?: string }) {
  return (
    <span className={`block max-h-[2lh] overflow-hidden ${className}`}>
      <span className="-ms-[0.9em] flex flex-wrap">
        {parts.map((part, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed positional parts.
            key={i}
            className="ms-[0.9em] flex max-w-[calc(100%-0.9em)] min-w-0 before:-ms-[0.9em] before:w-[0.9em] before:shrink-0 before:text-center before:content-['·']"
          >
            <span className="min-w-0 truncate">{part}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

export function PlayerHeader({
  title,
  meta,
  avatar,
  children,
}: {
  title: string;
  meta: readonly ReactNode[];
  avatar: ImageSet | null;
  children: ReactNode;
}) {
  // Top-aligned: when the meta wraps to a second line, the avatar and the buttons stay put.
  return (
    <div className="flex items-start gap-2.5">
      <span className="grid size-10 shrink-0 place-items-center rounded-pill bg-linear-to-br from-rose-300 via-rose-600 to-violet-300 p-[2px] shadow-soft">
        <span className="block size-full overflow-hidden rounded-pill bg-plum-950 p-[2px] group-data-[tone=paper]/player:bg-surface">
          {avatar ? (
            <Picture image={avatar} alt="" sizes="40px" className="size-full rounded-pill object-cover" />
          ) : (
            <span className="block size-full rounded-pill bg-plum-850" />
          )}
        </span>
      </span>
      <div className="flex min-h-10 min-w-0 flex-1 flex-col justify-center leading-tight [text-shadow:0_1px_8px_rgb(0_0_0/0.35)] group-data-[tone=paper]/player:text-ink group-data-[tone=paper]/player:[text-shadow:none]">
        <p
          className="truncate font-display text-[0.98rem] font-semibold [font-variation-settings:'SOFT'_100]"
          dir="auto"
          data-user-text
        >
          {title}
        </p>
        <MetaParts
          parts={meta}
          className="text-xs font-semibold text-white/80 group-data-[tone=paper]/player:text-muted"
        />
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

export function CloseButton({ onClose }: { onClose: () => void }) {
  const { t } = useLingui();
  return (
    <ChromeButton label={t`Close`} onClick={onClose} testId="player-close">
      <CloseIcon size={22} />
    </ChromeButton>
  );
}

// ---------------------------------------------------------------------------------------------
// Captions

/** "Original: Deutsch" under owner text shown in its original language. */
export function OriginalLabel({
  picked,
  locale,
  className = '',
}: {
  picked: PickedText;
  locale: LocaleCode;
  className?: string;
}) {
  if (!picked.fallback) return null;
  const language = languageName(picked.locale, locale);
  return (
    <p className={`text-xs font-semibold opacity-75 ${className}`}>
      <Trans>Original: {language}</Trans>
    </p>
  );
}

/**
 * Caption (WhatsApp) and owner description over the bottom of the slide. Long texts are clamped
 * (6 + 5 lines) so they never cover the picture or reach the header; line-clamp only hides
 * visually, screen readers still get the full text.
 */
export function CaptionBlock({
  caption,
  description,
  locale,
}: {
  caption?: string | undefined;
  description: PickedText | null;
  locale: LocaleCode;
}) {
  if (!caption && !description) return null;
  return (
    <div className="space-y-1.5 [text-shadow:0_1px_10px_rgb(0_0_0/0.45)]">
      {caption && (
        <p
          dir="auto"
          data-user-text
          className="line-clamp-6 text-[1.05rem] leading-snug font-semibold whitespace-pre-line text-white"
        >
          {caption}
        </p>
      )}
      {description && (
        <div>
          <p
            lang={description.locale}
            dir="auto"
            data-user-text
            className="line-clamp-5 text-[0.95rem] leading-snug whitespace-pre-line text-white/90"
          >
            {description.text}
          </p>
          <OriginalLabel picked={description} locale={locale} className="mt-1 text-white/80" />
        </div>
      )}
    </div>
  );
}
