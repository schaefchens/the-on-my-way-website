/**
 * One slide per entry kind. Slides report their loading (loaded/failed) and media events to the
 * session through `SlideContext`; the session owns the state machine and the clock.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { LocaleCode } from '@omw/contracts/i18n';
import { pickText } from '@omw/contracts/i18n';
import type { Entry, ImageSet } from '@omw/contracts/site';
import { waFontStyle } from '@omw/ui/fonts';
import { Picture, resolveSiteUrl } from '@omw/ui/picture';
import { thumbhashToDataUrl } from '@omw/ui/thumbhash';
import type { MotionValue } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CenterPlayButton, OriginalLabel, useProgressStyle } from './chrome';
import { BookIcon, ChevronIcon, PlayIcon } from './icons';
import { markdownExcerpt, type PlayerItem, readingMinutes, textStatusScale } from './items';
import { formatClock, preloadFonts } from './media';
import { pickStory } from './story-content';
import { useVideoPool } from './video-pool';

export interface SlideContext {
  locale: LocaleCode;
  basePath: string;
  /** `sizes` for <picture> (smaller in data-saver mode). */
  sizes: string;
  /** This slide is the current one (exiting slides keep their last props). */
  active: boolean;
  /** Media should play (playing or buffering). */
  wantsPlay: boolean;
  muted: boolean;
  dataSaver: boolean;
  reducedMotion: boolean;
  /** The visitor started this video by hand (data-saver mode). */
  inlinePlay: boolean;
  progress: MotionValue<number>;
  loaded(): void;
  failed(): void;
  stall(): void;
  unstall(): void;
  ended(): void;
  duration(ms: number): void;
  /** The element whose currentTime drives the clock (null = timer). */
  registerMedia(el: HTMLMediaElement | null): void;
  /** Autoplay with sound was refused: the slide fell back to muted playback. */
  forcedMute(): void;
  playInline(): void;
  openStory(id: string): void;
  /** The voice note is held until the visitor asks for sound ("needsSound"). */
  heldForSound: boolean;
  /** Sound on and play, in one gesture. */
  listen(): void;
}

/** Fill the frame only for tall images (~9:16 phone shots); others are contained over their blur. */
const PORTRAIT_RATIO = 1.6;

function isPortrait(w: number, h: number): boolean {
  return h / w >= PORTRAIT_RATIO;
}

/** Plays a media element; if autoplay with sound is refused, retries muted. */
export function playSafely(el: HTMLMediaElement, onForcedMute: () => void): void {
  const attempt = el.play();
  if (!attempt) return;
  attempt.catch((err: unknown) => {
    const name = err instanceof DOMException ? err.name : '';
    if (name === 'NotAllowedError' && !el.muted) {
      el.muted = true;
      onForcedMute();
      el.play().catch(() => undefined);
    }
    // AbortError: paused or source changed before playback started — expected.
  });
}

// ---------------------------------------------------------------------------------------------
// Image backdrop + Ken Burns

const KEN_BURNS = [
  { s: 0.07, x: -1.6, y: -1.2, out: false },
  { s: 0.06, x: 1.4, y: 1, out: true },
  { s: 0.07, x: 1.2, y: -1.4, out: false },
  { s: 0.06, x: -1.2, y: 1.2, out: true },
] as const;

function ImageStage({
  image,
  alt,
  index,
  ctx,
  onLoad,
  onError,
}: {
  image: ImageSet;
  alt: string;
  index: number;
  ctx: SlideContext;
  onLoad: () => void;
  onError: () => void;
}) {
  const portrait = isPortrait(image.w, image.h);
  const backdrop = useMemo(() => (portrait ? null : thumbhashToDataUrl(image.thumbhash)), [portrait, image.thumbhash]);
  const kbRef = useRef<HTMLDivElement>(null);
  const preset = KEN_BURNS[index % KEN_BURNS.length] ?? KEN_BURNS[0];
  const kenBurns = ctx.active && !ctx.reducedMotion;

  useProgressStyle(kbRef, kenBurns ? ctx.progress : null, (el, v) => {
    const p = preset.out ? 1 - v : v;
    el.style.transform = `scale(${(1 + preset.s * p).toFixed(4)}) translate(${(preset.x * p).toFixed(3)}%, ${(preset.y * p).toFixed(3)}%)`;
  });

  // A cached image may be complete before listeners matter; report it once mounted.
  const wrapRef = useRef<HTMLDivElement>(null);
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;
  useEffect(() => {
    const img = wrapRef.current?.querySelector('img');
    if (img?.complete && img.naturalWidth > 0) onLoadRef.current();
  }, []);

  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden" style={{ backgroundColor: image.color }}>
      {backdrop && (
        <img
          src={backdrop}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 size-full scale-125 object-cover opacity-90 blur-2xl"
        />
      )}
      {!portrait && <div className="absolute inset-0 bg-plum-950/25" />}
      <div ref={kbRef} className="absolute inset-0 origin-center will-change-transform" data-testid="kenburns">
        <Picture
          image={image}
          alt={alt}
          sizes={ctx.sizes}
          loading="eager"
          fetchPriority={ctx.active ? 'high' : 'auto'}
          draggable={false}
          pictureClassName="contents"
          className={`size-full select-none ${portrait ? 'object-cover' : 'object-contain'}`}
          onLoad={(e) => {
            const img = e.currentTarget;
            img.decode().then(onLoad, onLoad);
          }}
          onError={onError}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Photo

export function PhotoSlide({
  item,
  ctx,
}: {
  item: PlayerItem & { entry: Extract<Entry, { kind: 'photo' }> };
  ctx: SlideContext;
}) {
  return (
    <ImageStage
      image={item.entry.image}
      alt={item.alt}
      index={item.index}
      ctx={ctx}
      onLoad={ctx.loaded}
      onError={ctx.failed}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Video and GIF (pooled <video> elements)

export function VideoSlide({
  item,
  ctx,
}: {
  item: PlayerItem & { entry: Extract<Entry, { kind: 'video' | 'gif' }> };
  ctx: SlideContext;
}) {
  const { t } = useLingui();
  const pool = useVideoPool();
  const entry = item.entry;
  const isGif = entry.kind === 'gif';
  const portrait = isPortrait(entry.video.w, entry.video.h);
  const src = resolveSiteUrl(ctx.basePath, entry.video.src);
  const posterOnly = ctx.dataSaver && !ctx.inlinePlay;
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  useEffect(() => {
    if (!ctx.active || posterOnly) return;
    const c = () => ctxRef.current;
    const el = pool.activate(entry.id, src, {
      loop: isGif,
      muted: isGif || c().muted,
      fit: portrait ? 'cover' : 'contain',
    });
    if (!el) {
      c().failed();
      return;
    }
    setVideoEl(el);
    if (!isGif) c().registerMedia(el);
    let ready = false;
    const markReady = () => {
      el.dataset.ready = 'true';
      if (!ready) {
        ready = true;
        c().loaded();
      }
    };
    const handlers: [keyof HTMLMediaElementEventMap, () => void][] = [
      ['loadedmetadata', () => !isGif && c().duration(el.duration * 1000)],
      ['durationchange', () => !isGif && Number.isFinite(el.duration) && c().duration(el.duration * 1000)],
      ['loadeddata', markReady],
      ['canplay', markReady],
      ['waiting', () => ready && c().stall()],
      ['stalled', () => ready && el.readyState < 3 && c().stall()],
      [
        'playing',
        () => {
          markReady();
          c().unstall();
        },
      ],
      ['ended', () => !isGif && c().ended()],
      ['error', () => c().failed()],
    ];
    for (const [type, fn] of handlers) el.addEventListener(type, fn);
    if (el.readyState >= 2) markReady();
    return () => {
      for (const [type, fn] of handlers) el.removeEventListener(type, fn);
      if (!isGif) c().registerMedia(null);
      pool.deactivate(entry.id);
      setVideoEl(null);
    };
  }, [ctx.active, posterOnly, pool, entry.id, src, isGif, portrait]);

  useEffect(() => {
    if (!videoEl) return;
    videoEl.muted = isGif || ctx.muted;
    if (ctx.active && ctx.wantsPlay) playSafely(videoEl, ctx.forcedMute);
    else videoEl.pause();
  }, [videoEl, ctx.active, ctx.wantsPlay, ctx.muted, ctx.forcedMute, isGif]);

  return (
    <>
      <ImageStage
        image={entry.video.poster}
        alt={item.alt}
        index={item.index}
        ctx={{ ...ctx, reducedMotion: true }}
        onLoad={posterOnly ? ctx.loaded : noop}
        onError={posterOnly ? ctx.failed : noop}
      />
      {posterOnly && (
        <div className="absolute inset-0 grid place-items-center">
          <button
            type="button"
            onClick={ctx.playInline}
            className="flex items-center gap-2 rounded-pill bg-white/90 px-5 py-3 font-semibold text-plum-800 shadow-float backdrop-blur transition-transform duration-150 ease-snappy active:scale-95"
          >
            <PlayIcon size={20} />
            {isGif ? t`Play animation` : t`Play video`}
          </button>
        </div>
      )}
    </>
  );
}

function noop() {}

// ---------------------------------------------------------------------------------------------
// Voice

function waveformBars(peaks: readonly number[]): { x: number; y: number; h: number }[] {
  const n = Math.max(1, peaks.length);
  return peaks.map((p, i) => {
    const h = Math.max(2.5, Math.min(1, Math.max(0, p)) * 30);
    return { x: (i + 0.5) * (100 / n), y: 16 - h / 2, h };
  });
}

export function VoiceSlide({
  item,
  ctx,
}: {
  item: PlayerItem & { entry: Extract<Entry, { kind: 'voice' }> };
  ctx: SlideContext;
}) {
  const { t } = useLingui();
  const audio = item.entry.audio;
  const audioRef = useRef<HTMLAudioElement>(null);
  const clipRef = useRef<SVGRectElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const bars = useMemo(() => waveformBars(audio.peaks.length ? audio.peaks : [0.3, 0.5, 0.3]), [audio.peaks]);
  const barWidth = Math.max(0.6, (100 / Math.max(1, bars.length)) * 0.55);
  const total = formatClock(audio.duration);

  useProgressStyle(clipRef, ctx.progress, (el, v) => {
    el.setAttribute('width', (v * 100).toFixed(2));
  });
  useProgressStyle(timeRef, ctx.progress, (el, v) => {
    el.textContent = formatClock(v * audio.duration);
  });

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !ctx.active) return;
    const c = () => ctxRef.current;
    c().registerMedia(el);
    let ready = false;
    const markReady = () => {
      if (!ready) {
        ready = true;
        c().loaded();
      }
    };
    const handlers: [keyof HTMLMediaElementEventMap, () => void][] = [
      ['loadedmetadata', () => c().duration(el.duration * 1000)],
      ['canplay', markReady],
      ['loadeddata', markReady],
      ['waiting', () => ready && c().stall()],
      [
        'playing',
        () => {
          markReady();
          c().unstall();
        },
      ],
      ['ended', () => c().ended()],
      ['error', () => c().failed()],
    ];
    for (const [type, fn] of handlers) el.addEventListener(type, fn);
    if (el.readyState >= 2) markReady();
    return () => {
      for (const [type, fn] of handlers) el.removeEventListener(type, fn);
      el.pause();
      c().registerMedia(null);
    };
  }, [ctx.active]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.muted = ctx.muted;
    if (ctx.active && ctx.wantsPlay) playSafely(el, ctx.forcedMute);
    else el.pause();
  }, [ctx.active, ctx.wantsPlay, ctx.muted, ctx.forcedMute]);

  const playing = ctx.active && ctx.wantsPlay;
  const held = ctx.active && ctx.heldForSound;
  return (
    <div className="absolute inset-0 overflow-hidden bg-[radial-gradient(120%_80%_at_50%_0%,#8e6bd6_0%,#5d3fa0_45%,#30243b_100%)]">
      <div aria-hidden="true" className="paper-grain absolute inset-0 opacity-60 mix-blend-overlay" />
      {/* biome-ignore lint/a11y/useMediaCaption: voice statuses have no transcript (yet). */}
      <audio ref={audioRef} src={resolveSiteUrl(ctx.basePath, audio.src)} preload="auto" />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-10 px-6">
        {/* Held for its sound: the microphone makes way for "Listen to the voice note" (same
            height, so nothing below moves when it starts). */}
        <div className="grid h-36 w-full place-items-center">
          {held ? (
            <CenterPlayButton
              label={t`Listen to the voice note`}
              icon="sound"
              onPlay={ctx.listen}
              reducedMotion={ctx.reducedMotion}
              testId="player-listen"
            />
          ) : (
            <div className="relative grid size-36 place-items-center">
              {playing && !ctx.reducedMotion && (
                <>
                  <span className="absolute inset-0 animate-ping rounded-pill bg-rose-300/25 [animation-duration:2.2s]" />
                  <span className="absolute inset-3 animate-ping rounded-pill bg-lilac-300/25 [animation-delay:0.6s] [animation-duration:2.2s]" />
                </>
              )}
              <span className="relative grid size-28 place-items-center rounded-pill bg-linear-to-br from-rose-300 to-violet-300 text-plum-950 shadow-float">
                <svg viewBox="0 0 24 24" className="size-12" aria-hidden="true">
                  <rect x="9" y="3" width="6" height="11.5" rx="3" fill="currentColor" />
                  <path
                    d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            </div>
          )}
        </div>
        <div className="w-full max-w-sm">
          <p className="mb-3 text-center text-sm font-semibold tracking-wide text-white/80 uppercase">{t`Voice message`}</p>
          <svg
            viewBox="0 0 100 32"
            preserveAspectRatio="none"
            className="h-16 w-full rtl:-scale-x-100"
            aria-hidden="true"
          >
            <defs>
              <clipPath id={`played-${item.entry.id}`}>
                <rect ref={clipRef} x="0" y="0" width="0" height="32" />
              </clipPath>
            </defs>
            {bars.map((b) => (
              <rect
                key={b.x}
                x={b.x - barWidth / 2}
                y={b.y}
                width={barWidth}
                height={b.h}
                rx={barWidth / 2}
                fill="rgb(255 255 255 / 0.35)"
              />
            ))}
            <g clipPath={`url(#played-${item.entry.id})`}>
              {bars.map((b) => (
                <rect
                  key={b.x}
                  x={b.x - barWidth / 2}
                  y={b.y}
                  width={barWidth}
                  height={b.h}
                  rx={barWidth / 2}
                  fill="#fff"
                />
              ))}
            </g>
          </svg>
          <p className="mt-2 flex justify-between text-sm font-semibold text-white/80 tabular-nums" dir="ltr">
            <span ref={timeRef} data-testid="voice-time">
              0:00
            </span>
            <span>{total}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Text status

const TEXT_SIZES = {
  xl: 'text-[10.5cqi] leading-[1.12]',
  lg: 'text-[8cqi] leading-[1.18]',
  md: 'text-[6.4cqi] leading-[1.25]',
  sm: 'text-[5.2cqi] leading-[1.32]',
} as const;

function useFontsReady(entry: Entry, locale: LocaleCode, onReady: () => void, timeoutMs = 1200): void {
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  useEffect(() => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      readyRef.current();
    };
    const timer = setTimeout(finish, timeoutMs);
    preloadFonts(entry, locale).then(finish, finish);
    return () => {
      done = true;
      clearTimeout(timer);
    };
  }, [entry, locale, timeoutMs]);
}

export function TextSlide({
  item,
  ctx,
}: {
  item: PlayerItem & { entry: Extract<Entry, { kind: 'text' }> };
  ctx: SlideContext;
}) {
  const { text } = item.entry;
  useFontsReady(item.entry, ctx.locale, ctx.loaded);
  return (
    <div
      className="absolute inset-0 grid place-items-center px-[9cqi]"
      style={{ backgroundColor: text.bg, color: text.fg }}
    >
      <p
        dir="auto"
        data-user-text
        className={`max-w-full text-center break-words whitespace-pre-line ${TEXT_SIZES[textStatusScale(text.body)]}`}
        style={waFontStyle(text.font)}
      >
        {text.body}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Note (washi-tape card)

export function NoteSlide({
  item,
  ctx,
  place,
}: {
  item: PlayerItem & { entry: Extract<Entry, { kind: 'note' }> };
  ctx: SlideContext;
  place?: string | undefined;
}) {
  const picked = pickText(item.entry.note, ctx.locale, item.entry.orig);
  useFontsReady(item.entry, ctx.locale, ctx.loaded);
  return (
    <div className="absolute inset-0 overflow-hidden bg-linear-to-b from-blush via-bg to-lilac">
      <div aria-hidden="true" className="paper-grain absolute inset-0" />
      <div className="absolute inset-0 flex flex-col items-center justify-center px-[8cqi]">
        <figure className="washi-tape relative w-full max-w-md -rotate-[1.4deg] rounded-card bg-surface px-[7cqi] pt-[9cqi] pb-[7cqi] text-ink shadow-float">
          <blockquote
            lang={picked?.locale}
            dir="auto"
            data-user-text
            className="font-hand text-[6.3cqi] leading-[1.45] whitespace-pre-line"
          >
            {picked?.text}
          </blockquote>
          <figcaption className="mt-[5cqi] flex items-center justify-between gap-3 font-hand text-[3.8cqi] text-muted">
            <span>
              {item.time}
              {place && (
                <>
                  {' · '}
                  <bdi>{place}</bdi>
                </>
              )}
            </span>
            <span aria-hidden="true" className="text-accent">
              ♡
            </span>
          </figcaption>
          {picked && <OriginalLabel picked={picked} locale={ctx.locale} className="mt-2 text-muted" />}
        </figure>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Story card

export function StorySlide({
  item,
  ctx,
}: {
  item: PlayerItem & { entry: Extract<Entry, { kind: 'story' }> };
  ctx: SlideContext;
}) {
  const picked = pickStory(item.entry, ctx.locale);
  useFontsReady(item.entry, ctx.locale, ctx.loaded);
  const excerpt = picked ? markdownExcerpt(picked.content.body, 150) : '';
  const minutes = picked ? readingMinutes(picked.content.body) : 1;
  return (
    <div className="absolute inset-0 overflow-hidden bg-linear-to-br from-lilac via-blush to-bg">
      <div aria-hidden="true" className="paper-grain absolute inset-0" />
      <div className="absolute inset-0 flex flex-col justify-center px-[8cqi]">
        <article className="relative rounded-sheet bg-surface/90 px-[7cqi] py-[8cqi] text-ink shadow-float backdrop-blur-sm">
          <p className="flex items-center gap-2 text-[3.4cqi] font-bold tracking-[0.14em] text-accent uppercase">
            <BookIcon size={18} />
            <Trans>Story</Trans>
            <span aria-hidden="true" className="text-muted">
              ·
            </span>
            <span className="font-semibold tracking-normal text-muted normal-case">
              <Trans>{minutes} min read</Trans>
            </span>
          </p>
          <h3
            lang={picked?.locale}
            dir="auto"
            data-user-text
            className="mt-[4cqi] font-display text-[8.4cqi] leading-[1.08] font-semibold text-balance [font-variation-settings:'SOFT'_100]"
          >
            {picked?.content.title}
          </h3>
          {excerpt && (
            <p
              lang={picked?.locale}
              dir="auto"
              data-user-text
              className="mt-[3.5cqi] text-[4.1cqi] leading-relaxed text-muted"
            >
              {excerpt}
            </p>
          )}
          {picked && (
            <OriginalLabel
              picked={{ text: '', locale: picked.locale, fallback: picked.fallback }}
              locale={ctx.locale}
              className="mt-2 text-muted"
            />
          )}
          {/* A story without text in any language has nothing to open. */}
          {picked && (
            <button
              type="button"
              onClick={() => ctx.openStory(item.entry.id)}
              data-testid="player-read-story"
              className="group/cta mt-[6cqi] inline-flex items-center gap-2 rounded-pill bg-accent px-5 py-3 font-semibold text-on-accent shadow-lift transition-[transform,background-color] duration-150 ease-snappy hover:bg-accent-strong active:scale-95"
            >
              <Trans>Read the story</Trans>
              <ChevronIcon
                size={18}
                className="transition-transform group-hover/cta:translate-x-0.5 rtl:-scale-x-100 rtl:group-hover/cta:-translate-x-0.5"
              />
            </button>
          )}
        </article>
      </div>
    </div>
  );
}
