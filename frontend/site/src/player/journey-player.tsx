/**
 * The journey player (plan C): a full-screen dialog above the mounted timeline that plays one
 * day's moments as a stories-like slideshow.
 *
 *   JourneyPlayer   dialog shell: focus trap, scroll lock, prefs, live region, day previews
 *   └ PlayerSession keyed by date: state machine, rAF clock, slides, gestures, keys, media
 *
 * Loaded lazily by routes/day.tsx, so this file and everything it pulls in form the player
 * chunk (budget ≤ 45 kB gzip). markdown-it is NOT imported here (story sheet = own chunk).
 */
import { useLingui } from '@lingui/react/macro';
import type { LocaleCode } from '@omw/contracts/i18n';
import { pickText } from '@omw/contracts/i18n';
import type { DayDetail, DaySummary, EntryKind, ImageSet } from '@omw/contracts/site';
import { countryFlag, dateTimeFormat, formatLocalDate, forwardSign, localDateToUtcDate } from '@omw/ui/locale';
import { SPRINGS } from '@omw/ui/motion';
import { Picture, resolveSiteUrl } from '@omw/ui/picture';
import { useRouterState } from '@tanstack/react-router';
import { AnimatePresence, m, motionValue, useIsPresent, useReducedMotion } from 'motion/react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useTimeline } from '../data/hooks';
import { findDay, prefetchAdjacentDays } from '../data/queries';
import { useSite, useSiteFlags } from '../site';
import {
  CaptionBlock,
  CloseButton,
  OptionsMenu,
  PlayerHeader,
  PlayPauseButton,
  ProgressBars,
  WatchTheDay,
} from './chrome';
import { browserScheduler, ItemClock } from './clock';
import { DayEndCard } from './day-end';
import { mediaDurationMs } from './durations';
import { useFocusTrap } from './focus-trap';
import { type Direction, keyAction, type SwipeAction } from './gestures';
import { ChevronIcon, ChevronUpIcon, SoundOffIcon, SoundOnIcon, Spinner } from './icons';
import { buildItems, firstImage, type PlayerItem } from './items';
import {
  backLeavesDay,
  initialState,
  isRunning,
  type PlayerEvent,
  type PlayerState,
  pauseReasonsAttr,
  pendingTimer,
  reducer,
  statusOf,
  wantsMediaPlaying,
} from './machine';
import { artworkFor, PRELOAD_AHEAD, playerImageSizes, warmEntry } from './media';
import { type PlayerNavigation, usePlayerNavigation } from './navigation';
import { useMediaSession, usePageHidden, useScrollLock, useWakeLock } from './platform';
import { type PlayerPrefs, usePlayerPrefs } from './prefs';
import { NoteSlide, PhotoSlide, type SlideContext, StorySlide, TextSlide, VideoSlide, VoiceSlide } from './slides';
import { useStageGestures } from './use-stage-gestures';
import { createVideoPool, VideoLayer, VideoPoolProvider } from './video-pool';

export interface JourneyPlayerProps {
  day: DayDetail;
  locale: LocaleCode;
  /** The story sheet (child route) is open: playback pauses with reason "sheet". */
  sheetOpen: boolean;
}

function useKindLabels(): Record<EntryKind, string> {
  const { t, i18n } = useLingui();
  // biome-ignore lint/correctness/useExhaustiveDependencies: labels change with the active locale only.
  return useMemo(
    () => ({
      photo: t`Photo`,
      video: t`Video`,
      gif: t`GIF`,
      voice: t`Voice message`,
      text: t`Text status`,
      note: t`Note`,
      story: t`Story`,
    }),
    [i18n.locale],
  );
}

/** The day's title, else its date ("Montag, 16. Nov."). */
function dayTitle(day: DayDetail, locale: LocaleCode): { text: string; owner: boolean } {
  const owner = pickText(day.title, locale, day.orig)?.text;
  if (owner) return { text: owner, owner: true };
  const date = dateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    localDateToUtcDate(day.date),
  );
  return { text: date, owner: false };
}

/** Colour of the ambient glow behind the frame ("day glow from the cover's colour"). */
function glowColor(item: PlayerItem | undefined): string | null {
  if (!item) return null;
  if (item.image) return item.image.color;
  if (item.entry.kind === 'text') return item.entry.text.bg.slice(0, 7);
  return null;
}

// =============================================================================================
// Shell

export function JourneyPlayer({ day, locale, sheetOpen }: JourneyPlayerProps) {
  const { t } = useLingui();
  const site = useSite();
  const reducedMotion = useReducedMotion() === true;
  const [prefs, setPrefs] = usePlayerPrefs();
  const nav = usePlayerNavigation(locale, day.date);
  const { data: timeline } = useTimeline();
  const rootRef = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState('');
  /**
   * The last day change: its direction (for the enter animation), whether to keep playing and
   * whether to start at the day's last moment (back from the first moment of the next day).
   */
  const dayChange = useRef<{ dir: Direction | 0; autoplay: boolean; atEnd: boolean }>({
    dir: 0,
    autoplay: !reducedMotion,
    atEnd: false,
  });

  useScrollLock();
  useFocusTrap(rootRef, { active: !sheetOpen, restoreFocus: false });

  useEffect(() => {
    if (timeline) void prefetchAdjacentDays(site, timeline, day.date).catch(() => undefined);
  }, [site, timeline, day.date]);

  // Filmstrip links point at a moment: /de/day/2026-11-15/#e_abc… starts the player there.
  const hash = useRouterState({ select: (state) => state.location.hash });
  const startIndex = Math.max(0, hash ? day.entries.findIndex((e) => e.id === hash) : 0);

  const prevSummary = day.prev && timeline ? findDay(timeline, day.prev) : undefined;
  const nextSummary = day.next && timeline ? findDay(timeline, day.next) : undefined;
  const { text: title, owner: hasOwnerTitle } = dayTitle(day, locale);
  const headingId = useId();

  const goToDay = useCallback(
    (dir: Direction, autoplay: boolean, atEnd = false) => {
      const target = dir === 1 ? day.next : day.prev;
      if (!target) return false;
      dayChange.current = { dir, autoplay, atEnd };
      nav.goToDay(target);
      return true;
    },
    [day.next, day.prev, nav],
  );

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      tabIndex={-1}
      inert={sheetOpen}
      data-testid="journey-player"
      data-lift-scope
      className="fixed inset-0 z-40 overflow-hidden text-ink outline-none"
    >
      {/* The page behind the player; it fades while the stage is pulled down to close. */}
      <div aria-hidden="true" data-lift-fade className="pointer-events-none absolute inset-0 bg-bg" />
      {/* The page's one h1 while the player is open (the timeline below is inert). */}
      <h1 id={headingId} className="sr-only">
        {t`Journey of ${title}`}
        {hasOwnerTitle && `, ${formatLocalDate(day.date, locale, 'long')}`}
      </h1>
      <PlayerSession
        key={day.date}
        day={day}
        locale={locale}
        title={title}
        hasOwnerTitle={hasOwnerTitle}
        prefs={prefs}
        setPrefs={setPrefs}
        reducedMotion={reducedMotion}
        sheetOpen={sheetOpen}
        nav={nav}
        startIndex={startIndex}
        startAtEnd={dayChange.current.atEnd}
        enterDir={dayChange.current.dir}
        autoplay={dayChange.current.autoplay && !(reducedMotion && dayChange.current.dir === 0)}
        prevSummary={prevSummary}
        nextSummary={nextSummary}
        goToDay={goToDay}
        announce={setAnnouncement}
        basePath={site.basePath}
      />
      <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="player-live">
        {announcement}
      </p>
    </div>
  );
}

// =============================================================================================
// Session (one day)

interface SessionProps {
  day: DayDetail;
  locale: LocaleCode;
  title: string;
  /** False when `title` is just the date (the meta line then omits it). */
  hasOwnerTitle: boolean;
  prefs: PlayerPrefs;
  setPrefs: (patch: Partial<PlayerPrefs>) => void;
  reducedMotion: boolean;
  sheetOpen: boolean;
  nav: PlayerNavigation;
  /** First moment to show (from the URL hash). */
  startIndex: number;
  /** Start at the last moment instead (back from the first moment of the next day). */
  startAtEnd: boolean;
  enterDir: Direction | 0;
  autoplay: boolean;
  prevSummary: DaySummary | undefined;
  nextSummary: DaySummary | undefined;
  goToDay: (dir: Direction, autoplay: boolean, atEnd?: boolean) => boolean;
  announce: (text: string) => void;
  basePath: string;
}

function PlayerSession({
  day,
  locale,
  title,
  hasOwnerTitle,
  prefs,
  setPrefs,
  reducedMotion,
  sheetOpen,
  nav,
  startIndex,
  startAtEnd,
  enterDir,
  autoplay,
  prevSummary,
  nextSummary,
  goToDay,
  announce,
  basePath,
}: SessionProps) {
  const { t } = useLingui();
  const kindLabels = useKindLabels();
  const fwd = forwardSign(locale);
  const { timePrecision } = useSiteFlags();
  const items = useMemo(
    () => buildItems(day, locale, { dataSaver: prefs.dataSaver, timePrecision }),
    [day, locale, prefs.dataSaver, timePrecision],
  );
  const [stored, dispatch] = useReducer(
    reducer,
    {
      count: items.length,
      index: startAtEnd ? items.length - 1 : startIndex,
      paused: autoplay ? [] : (['user'] as const),
    },
    initialState,
  );
  const storedItem: PlayerItem | undefined = stored.ended ? undefined : items[stored.index];
  const sizes = playerImageSizes(prefs.dataSaver);
  const entryIds = useMemo(() => items.map((i) => i.entry.id), [items]);

  // ---- media + clock -------------------------------------------------------------------------
  const pool = useMemo(createVideoPool, []);
  const progress = useMemo(() => motionValue(0), []);
  const clock = useMemo(() => new ItemClock(browserScheduler, progress), [progress]);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [inlinePlaySeq, setInlinePlaySeq] = useState<number | null>(null);
  const [forcedMute, setForcedMute] = useState(false);
  const muted = prefs.muted || forcedMute;

  // A voice note is its sound: while it could only play silently (muted, or autoplay with sound
  // refused) it is held ("needsSound") instead of running its clock (L3-05). The hold is derived
  // here, so this very render already respects it; the effect below stores it in the machine.
  const needsSound = storedItem?.kind === 'voice' && muted;
  const state: PlayerState =
    needsSound === stored.paused.has('needsSound')
      ? stored
      : reducer(stored, { type: needsSound ? 'pause' : 'resume', reason: 'needsSound' });
  useLayoutEffect(() => {
    dispatch({ type: needsSound ? 'pause' : 'resume', reason: 'needsSound' });
  }, [needsSound]);
  const status = statusOf(state);
  const running = isRunning(state);
  const item: PlayerItem | undefined = storedItem;
  /** Playback has run in this session (the "watch the day" button is for the very start only). */
  const [hasPlayed, setHasPlayed] = useState(false);
  if (running && !hasPlayed) setHasPlayed(true);
  const inlinePlay = inlinePlaySeq === state.seq;
  const mediaTimed = !!item && (item.timing.timing === 'media' || (inlinePlay && item.entry.kind === 'video'));
  const durationMs =
    item && inlinePlay && item.entry.kind === 'video'
      ? mediaDurationMs(item.entry.video.duration)
      : (item?.timing.durationMs ?? 0);

  useEffect(() => () => clock.dispose(), [clock]);
  useEffect(() => () => pool.dispose(), [pool]);

  useEffect(() => {
    if (!item) {
      clock.hold(state.ended ? 1 : 0);
      return;
    }
    const seq = state.seq;
    clock.load({
      durationMs,
      source: mediaTimed
        ? () => {
            const el = mediaRef.current;
            return el ? el.currentTime * 1000 : null;
          }
        : undefined,
      onEnd: mediaTimed ? undefined : () => dispatch({ type: 'itemEnd', seq }),
    });
    // The clock restarts only for a new item (seq) or a timing change of this item.
  }, [clock, state.seq, state.ended, mediaTimed, durationMs, item]);

  useEffect(() => {
    clock.setRunning(running);
  }, [clock, running]);

  useEffect(() => {
    pool.setMuted(muted);
  }, [pool, muted]);

  // ---- pause reasons from the outside world ---------------------------------------------------
  useEffect(() => {
    dispatch({ type: sheetOpen ? 'pause' : 'resume', reason: 'sheet' });
  }, [sheetOpen]);

  usePageHidden((hidden) => dispatch({ type: hidden ? 'pause' : 'resume', reason: 'hidden' }));

  // ---- load timeout, stall timeout, error auto-skip (machine.ts pendingTimer) -----------------------
  const timer = pendingTimer(state);
  const timerKey = timer?.key ?? null;
  const timerRef = useRef(timer);
  timerRef.current = timer;
  useEffect(() => {
    const armed = timerRef.current;
    if (!timerKey || !armed) return;
    const id = setTimeout(() => dispatch(armed.event), armed.delayMs);
    return () => clearTimeout(id);
  }, [timerKey]);
  const pausedCount = state.paused.size;

  // ---- announcements ----------------------------------------------------------------------------
  const failureMessage = (kind: EntryKind): string =>
    kind === 'video' || kind === 'gif'
      ? t`The video could not be loaded.`
      : kind === 'voice'
        ? t`The voice message could not be loaded.`
        : t`This moment could not be loaded.`;
  // The countdown only runs while nothing pauses the player (and "Stay here" was not pressed).
  const failure = item && status === 'error' ? failureMessage(item.kind) : null;
  const announcement = state.ended
    ? day.next && state.paused.size === 0
      ? t`End of the day. The next day starts in 3 seconds.`
      : t`End of the day.`
    : failure
      ? pausedCount === 0
        ? `${failure} ${t`Skipping to the next one…`}`
        : failure
      : item
        ? (() => {
            const kind = kindLabels[item.kind];
            const position = state.index + 1;
            const total = state.count;
            const time = item.time;
            return t`${kind} ${position} of ${total}, ${time}`;
          })()
        : '';
  useEffect(() => {
    announce(announcement);
  }, [announce, announcement]);

  // ---- preload the next items ---------------------------------------------------------------------
  useEffect(() => {
    if (state.ended) return;
    let videoPrepared = false;
    for (let i = 1; i <= PRELOAD_AHEAD; i++) {
      const upcoming = items[state.index + i];
      if (!upcoming) break;
      warmEntry(upcoming.entry, { basePath, sizes, locale });
      const e = upcoming.entry;
      // One spare <video> slot: only the first upcoming video is prepared (the posters of both
      // and every other item are still warmed).
      if ((e.kind === 'video' || e.kind === 'gif') && !videoPrepared) {
        videoPrepared = true;
        pool.prepare(e.id, resolveSiteUrl(basePath, e.video.src), prefs.dataSaver ? 'none' : 'metadata');
      }
    }
  }, [items, state.index, state.ended, basePath, sizes, locale, pool, prefs.dataSaver]);

  // ---- navigation ----------------------------------------------------------------------------------
  // A day change keeps playing unless the visitor paused on purpose.
  const nextDay = useCallback(() => goToDay(1, !state.paused.has('user')), [goToDay, state.paused]);
  const prevDay = useCallback(() => goToDay(-1, !state.paused.has('user')), [goToDay, state.paused]);
  /**
   * Back one moment (tap in the back zone, ←, a swipe back, the previous-moment buttons). On the
   * first moment it continues into the previous day at its last moment, so going back feels
   * continuous; without a previous day it restarts the moment.
   */
  const back = useCallback(() => {
    if (backLeavesDay(state) && goToDay(-1, !state.paused.has('user'), true)) return;
    dispatch({ type: 'prev' });
  }, [goToDay, state]);

  // ---- platform ----------------------------------------------------------------------------------
  useWakeLock(status === 'playing' || status === 'buffering');
  const sessionInfo = useMemo(
    () => ({
      title: item ? `${kindLabels[item.kind]} · ${item.time}` : title,
      artist: title,
      album: formatLocalDate(day.date, locale, 'long'),
      artwork: artworkFor(item?.image ?? firstImage(items), basePath),
    }),
    [item, kindLabels, title, day.date, locale, items, basePath],
  );
  useMediaSession(sessionInfo, running, {
    play: () => dispatch({ type: 'resume', reason: 'user' }),
    pause: () => dispatch({ type: 'pause', reason: 'user' }),
    next: () => dispatch({ type: 'next' }),
    previous: back,
  });

  // ---- actions --------------------------------------------------------------------------------------
  const toggleMute = useCallback(() => {
    const next = !muted;
    // Unmute synchronously inside the gesture (iOS only allows sound from a user activation). A
    // voice note held for its sound starts right away (unmuting releases the hold).
    const el = mediaRef.current;
    const releasesHold = state.paused.size === 1 && state.paused.has('needsSound');
    if (el && !next) {
      el.muted = false;
      if (el.paused && (wantsMediaPlaying(state) || releasesHold)) el.play().catch(() => undefined);
    }
    pool.setMuted(next);
    setForcedMute(false);
    setPrefs({ muted: next });
  }, [muted, pool, setPrefs, state]);

  /**
   * "Listen to the voice note" (and "Watch the day"): sound on (remembered) and play, in one
   * gesture. Clears the visitor's own pause too: the button says "play".
   */
  const listen = useCallback(() => {
    const el = mediaRef.current;
    if (needsSound && el) {
      el.muted = false;
      el.play().catch(() => undefined);
      pool.setMuted(false);
      setForcedMute(false);
      setPrefs({ muted: false });
    }
    dispatch({ type: 'resume', reason: 'user' });
  }, [needsSound, pool, setPrefs]);
  const heldForSound = state.paused.has('needsSound') && (status === 'ready' || status === 'paused');

  const [menuOpen, setMenuOpen] = useState(false);
  const [holding, setHolding] = useState(false);

  const onSwipe = useCallback(
    (action: SwipeAction) => {
      switch (action) {
        case 'nextDay':
          nextDay();
          break;
        case 'close':
          nav.close();
          break;
        case 'nextItem':
          dispatch({ type: 'next' });
          break;
        case 'prevItem':
          back();
          break;
      }
    },
    [nextDay, back, nav],
  );

  // ---- gestures ---------------------------------------------------------------------------------------
  const frameRef = useRef<HTMLElement>(null);
  /** How to get around (touch and keys), the frame's accessible description. */
  const helpId = useId();
  useStageGestures(
    frameRef,
    {
      // A tap anywhere on a voice note held for its sound plays it (with sound).
      onTap: (action) => (heldForSound ? listen() : action === 'back' ? back() : dispatch({ type: 'next' })),
      onHoldStart: () => {
        setHolding(true);
        dispatch({ type: 'pause', reason: 'hold' });
      },
      onHoldEnd: () => {
        setHolding(false);
        dispatch({ type: 'resume', reason: 'hold' });
      },
      onSwipe,
    },
    // While the options menu is open, a tap outside only closes it. While the story sheet is open
    // the player is inert: a pull on the sheet closes the sheet, never the player.
    { fwd, hasNextDay: !!day.next, enabled: !sheetOpen && !menuOpen, reducedMotion },
  );

  // ---- keyboard -------------------------------------------------------------------------------------
  useEffect(() => {
    if (sheetOpen || menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const target = e.target instanceof Element ? e.target : null;
      const onControl = !!target?.closest('button, a, input, select, textarea, [role="switch"]');
      const action = keyAction(e, fwd, onControl);
      if (!action) return;
      e.preventDefault();
      switch (action) {
        case 'toggle':
          if (heldForSound) listen();
          else dispatch({ type: 'toggle' });
          break;
        case 'back':
          back();
          break;
        case 'forward':
          dispatch({ type: 'next' });
          break;
        case 'prevDay':
          prevDay();
          break;
        case 'nextDay':
          nextDay();
          break;
        case 'close':
          nav.close();
          break;
        case 'mute':
          toggleMute();
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sheetOpen, menuOpen, fwd, back, prevDay, nextDay, nav, toggleMute, heldForSound, listen]);

  // ---- slide context ------------------------------------------------------------------------------------
  const seq = state.seq;
  const forcedMuteCb = useCallback(() => setForcedMute(true), []);
  const ctx = useMemo<Omit<SlideContext, 'active'>>(
    () => ({
      locale,
      basePath,
      sizes,
      wantsPlay: wantsMediaPlaying(state),
      muted,
      dataSaver: prefs.dataSaver,
      reducedMotion,
      inlinePlay,
      progress,
      loaded: () => dispatch({ type: 'loaded', seq }),
      failed: () => dispatch({ type: 'failed', seq }),
      stall: () => dispatch({ type: 'stall', seq }),
      unstall: () => dispatch({ type: 'unstall', seq }),
      ended: () => dispatch({ type: 'itemEnd', seq }),
      duration: (ms) => clock.setDuration(ms),
      registerMedia: (el) => {
        mediaRef.current = el;
      },
      forcedMute: forcedMuteCb,
      playInline: () => setInlinePlaySeq(seq),
      openStory: (id) => nav.openStory(id),
      heldForSound,
      listen,
    }),
    [
      locale,
      basePath,
      sizes,
      state,
      muted,
      prefs.dataSaver,
      reducedMotion,
      inlinePlay,
      progress,
      seq,
      clock,
      forcedMuteCb,
      nav,
      heldForSound,
      listen,
    ],
  );

  // ---- render --------------------------------------------------------------------------------------------
  const hasAudio =
    !!item &&
    ((item.entry.kind === 'video' && item.entry.video.hasAudio && (!prefs.dataSaver || inlinePlay)) ||
      item.entry.kind === 'voice');
  const showSpinner = useDelayedFlag(status === 'loading' || status === 'buffering', 450);
  // The button reflects the visitor's choice; at day end it controls the countdown. A voice note
  // held for its sound is not playing: the button offers "play" (= listen) there.
  const playing = !state.paused.has('user') && !heldForSound;
  /** The centred play affordance: "listen" on a held voice note, "watch the day" before the start. */
  const centerPlay: 'listen' | 'watch' | null = heldForSound
    ? 'listen'
    : status === 'ready' && state.paused.has('user') && !hasPlayed
      ? 'watch'
      : null;
  const glow = glowColor(item) ?? glowColor(items[items.length - 1]);
  /** Paper slides (notes, story cards) are light by day: the chrome switches to ink. */
  const tone = item && (item.kind === 'note' || item.kind === 'story') ? 'paper' : 'media';
  const avatar: ImageSet | null = firstImage(items);
  // Meta line parts: "date · time · place 🇻🇳". They wrap onto a second line (place last)
  // instead of being cut off when they do not fit (L3-14, long Arabic dates at 390 px).
  const metaParts: ReactNode[] = [];
  if (hasOwnerTitle) metaParts.push(formatLocalDate(day.date, locale, 'day-header'));
  if (item?.time) metaParts.push(item.time);
  if (day.place || day.country) {
    metaParts.push(
      <>
        {day.place && <bdi>{day.place}</bdi>}
        {day.country && `${day.place ? ' ' : ''}${countryFlag(day.country)}`}
      </>,
    );
  }

  return (
    <m.div
      className="group/player absolute inset-0 flex items-center justify-center"
      initial={enterDir === 0 ? { opacity: 0, scale: 0.98 } : { opacity: 0, y: enterDir * 56 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={SPRINGS.soft}
      data-status={status}
      data-index={state.index}
      data-count={state.count}
      data-kind={item?.kind ?? 'dayEnd'}
      data-paused={pauseReasonsAttr(state)}
      data-holding={holding}
      data-tone={tone}
      data-testid="player-session"
    >
      <Backdrop color={glow} />

      {/* Start side (wide screens): previous day + previous moment */}
      <SideRail side="start">
        {day.prev && (
          <DayPreview label={t`Previous day`} date={day.prev} summary={prevSummary} locale={locale} onClick={prevDay} />
        )}
        <RailButton label={t`Previous moment`} onClick={back} disabled={state.count === 0 && !day.prev}>
          <ChevronIcon size={26} className="-scale-x-100 rtl:scale-x-100" />
        </RailButton>
      </SideRail>

      <section
        ref={frameRef}
        className="@container relative isolate h-dvh w-full touch-none overflow-hidden bg-plum-950 text-white select-none [-webkit-touch-callout:none] sm:aspect-[9/16] sm:h-[min(calc(100dvh-3rem),60rem)] sm:w-auto sm:rounded-sheet sm:shadow-float sm:ring-1 sm:ring-black/5"
        data-testid="player-frame"
        aria-roledescription={t`slideshow`}
        aria-label={title}
        aria-describedby={helpId}
      >
        <p id={helpId} hidden>
          {fwd === 1
            ? t`Tap on the right for the next moment, on the left to go back. Swipe up for the next day, swipe down to close.`
            : t`Tap on the left for the next moment, on the right to go back. Swipe up for the next day, swipe down to close.`}{' '}
          {t`Keys: arrows for the moments, Page Up and Page Down for the days, Escape to close.`}
        </p>
        <VideoPoolProvider pool={pool}>
          <div className="absolute inset-0 z-0">
            {state.ended || !item ? (
              <DayEndCard
                locale={locale}
                title={title}
                momentCount={items.length}
                next={day.next ? { date: day.next, summary: nextSummary } : null}
                canCountDown={state.paused.size === 0}
                imageSizes={sizes}
                onNextDay={() => goToDay(1, true)}
                onReplay={() => dispatch({ type: 'replay' })}
                onClose={nav.close}
              />
            ) : (
              <AnimatePresence initial={false}>
                <m.div
                  key={state.seq}
                  className="absolute inset-0"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reducedMotion ? 0 : 0.2 }}
                  role="group"
                  aria-roledescription={t`moment`}
                  aria-label={`${kindLabels[item.kind]} · ${state.index + 1}/${state.count}`}
                >
                  <PresentSlide item={item} ctx={ctx} place={day.place} />
                </m.div>
              </AnimatePresence>
            )}
          </div>
          <div className="pointer-events-none absolute inset-0 z-[1]">
            <VideoLayer pool={pool} />
          </div>
        </VideoPoolProvider>

        {item && <CaptionLayer item={item} locale={locale} />}

        {/* Top chrome */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[3] h-36 bg-linear-to-b from-black/55 via-black/20 to-transparent transition-opacity duration-300 group-data-[tone=paper]/player:opacity-0" />
        <div className="absolute inset-x-0 top-0 z-[4] space-y-2.5 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <ProgressBars ids={entryIds} index={state.index} ended={state.ended} progress={progress} />
          <div className="transition-opacity duration-200 group-data-[holding=true]/player:opacity-0">
            <PlayerHeader title={title} meta={metaParts} avatar={avatar}>
              <PlayPauseButton
                playing={playing}
                onToggle={() => (heldForSound ? listen() : dispatch({ type: 'toggle' }))}
              />
              <OptionsMenu
                muted={muted}
                dataSaver={prefs.dataSaver}
                onMuted={(m) => (m !== muted ? toggleMute() : undefined)}
                onDataSaver={(on) => {
                  setPrefs({ dataSaver: on });
                  dispatch({ type: 'restart' });
                }}
                onOpenChange={setMenuOpen}
              />
              <CloseButton onClose={nav.close} />
            </PlayerHeader>
          </div>
          {hasAudio && !heldForSound && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={toggleMute}
                aria-pressed={!muted}
                data-testid="player-mute"
                className="pointer-events-auto inline-flex items-center gap-2 rounded-pill bg-black/35 px-3.5 py-2 text-sm font-semibold text-white ring-1 ring-white/20 backdrop-blur-md transition-transform duration-150 ease-snappy active:scale-95"
              >
                {muted ? <SoundOffIcon size={18} /> : <SoundOnIcon size={18} />}
                {muted ? t`Tap for sound` : t`Sound on`}
              </button>
            </div>
          )}
        </div>

        {/* Loading / buffering / error */}
        {showSpinner && (
          <div className="pointer-events-none absolute inset-0 z-[2] grid place-items-center" role="status">
            <Spinner className="size-12 text-white drop-shadow" />
            <span className="sr-only">{status === 'buffering' ? t`Buffering…` : t`Loading…`}</span>
          </div>
        )}
        {status === 'error' && (
          <div
            className="absolute inset-x-6 top-1/2 z-[4] -translate-y-1/2 rounded-card bg-plum-900/90 p-5 text-center shadow-float ring-1 ring-white/10 backdrop-blur"
            role="alert"
          >
            <p className="font-semibold">{failure}</p>
            {/* The auto-skip waits while the player is paused (WCAG 2.2.2). */}
            {pausedCount === 0 && <p className="mt-1 text-sm text-white/75">{t`Skipping to the next one…`}</p>}
            <button
              type="button"
              onClick={() => dispatch({ type: 'skip', seq: state.seq })}
              className="mt-3 rounded-pill bg-white/15 px-4 py-2 text-sm font-semibold hover:bg-white/25"
            >
              {t`Skip now`}
            </button>
          </div>
        )}

        {/* "Listen" sits on the voice slide itself, in place of its microphone (slides.tsx). */}
        {centerPlay === 'watch' && <WatchTheDay onPlay={listen} fwd={fwd} reducedMotion={reducedMotion} />}

        {/* Narrow screens: keyboard/screen-reader access to item and day navigation */}
        <div className="sm:hidden">
          <EdgeButton side="start" label={t`Previous moment`} onClick={back} />
          <EdgeButton side="end" label={t`Next moment`} onClick={() => dispatch({ type: 'next' })} />
          {day.prev && <EdgeButton side="top" label={t`Previous day`} onClick={prevDay} />}
          {day.next && <EdgeButton side="bottom" label={t`Next day`} onClick={nextDay} />}
        </div>
      </section>

      {/* End side (wide screens): next moment + next day */}
      <SideRail side="end">
        <RailButton label={t`Next moment`} onClick={() => dispatch({ type: 'next' })} disabled={state.ended}>
          <ChevronIcon size={26} className="rtl:-scale-x-100" />
        </RailButton>
        {day.next && (
          <DayPreview label={t`Next day`} date={day.next} summary={nextSummary} locale={locale} onClick={nextDay} />
        )}
      </SideRail>
    </m.div>
  );
}

// =============================================================================================
// Pieces

/** Renders the slide for an item; exiting slides (AnimatePresence) count as inactive. */
function PresentSlide({
  item,
  ctx,
  place,
}: {
  item: PlayerItem;
  ctx: Omit<SlideContext, 'active'>;
  place?: string | undefined;
}) {
  const present = useIsPresent();
  const full: SlideContext = { ...ctx, active: present };
  const entry = item.entry;
  switch (entry.kind) {
    case 'photo':
      return <PhotoSlide item={{ ...item, entry }} ctx={full} />;
    case 'video':
    case 'gif':
      return <VideoSlide item={{ ...item, entry }} ctx={full} />;
    case 'voice':
      return <VoiceSlide item={{ ...item, entry }} ctx={full} />;
    case 'text':
      return <TextSlide item={{ ...item, entry }} ctx={full} />;
    case 'note':
      return <NoteSlide item={{ ...item, entry }} ctx={full} place={place} />;
    case 'story':
      return <StorySlide item={{ ...item, entry }} ctx={full} />;
  }
}

/** Caption + owner description above the video layer (photo, video, GIF, voice, text). */
function CaptionLayer({ item, locale }: { item: PlayerItem; locale: LocaleCode }) {
  const kind = item.entry.kind;
  if (kind === 'note' || kind === 'story') return null;
  const caption = kind === 'text' ? undefined : item.entry.caption;
  if (!caption && !item.description) return null;
  return (
    <div
      key={item.index}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] bg-linear-to-t from-black/75 via-black/40 to-transparent px-5 pt-28 pb-[max(1.75rem,env(safe-area-inset-bottom))] transition-opacity duration-200 group-data-[holding=true]/player:opacity-0"
    >
      <CaptionBlock caption={caption} description={item.description} locale={locale} />
    </div>
  );
}

function Backdrop({ color }: { color: string | null }) {
  return (
    <div aria-hidden="true" data-lift-fade className="pointer-events-none absolute inset-0 hidden sm:block">
      <div
        className="absolute inset-0 transition-[background] duration-700 ease-soft"
        style={{
          background: `radial-gradient(60% 70% at 50% 45%, color-mix(in oklab, ${color ?? 'var(--omw-accent)'} 42%, transparent), transparent 75%), radial-gradient(40% 50% at 15% 85%, color-mix(in oklab, var(--omw-lilac-strong) 55%, transparent), transparent 70%), radial-gradient(45% 45% at 88% 12%, color-mix(in oklab, var(--omw-blush-strong) 70%, transparent), transparent 70%)`,
        }}
      />
      <div className="paper-grain absolute inset-0" />
    </div>
  );
}

function SideRail({ side, children }: { side: 'start' | 'end'; children: ReactNode }) {
  return (
    <div
      data-lift-fade="rail"
      className={`relative hidden h-full flex-1 items-center gap-6 px-6 sm:flex ${side === 'start' ? 'justify-end' : 'justify-start'}`}
    >
      {children}
    </div>
  );
}

function RailButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-12 shrink-0 place-items-center rounded-pill bg-surface/85 text-ink shadow-lift ring-1 ring-line backdrop-blur transition-[transform,opacity] duration-150 ease-snappy hover:scale-105 active:scale-95 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function DayPreview({
  label,
  date,
  summary,
  locale,
  onClick,
}: {
  label: string;
  date: string;
  summary: DaySummary | undefined;
  locale: LocaleCode;
  onClick: () => void;
}) {
  const title = summary ? pickText(summary.title, locale, summary.orig)?.text : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/day hidden w-36 shrink-0 text-start lg:block"
      aria-label={`${label}: ${formatLocalDate(date, locale, 'long')}`}
    >
      <span className="relative block aspect-[3/4] overflow-hidden rounded-card bg-blush shadow-lift ring-1 ring-line transition-transform duration-200 ease-soft group-hover/day:-translate-y-1 group-hover/day:rotate-[-1deg]">
        {summary?.cover ? (
          <Picture image={summary.cover} alt="" sizes="144px" className="size-full object-cover" />
        ) : (
          <span className="paper-grain block size-full bg-linear-to-br from-blush to-lilac" />
        )}
        <span className="absolute inset-0 bg-linear-to-t from-black/45 to-transparent" />
        <span className="absolute inset-x-3 bottom-2.5 text-xs font-bold tracking-wide text-white uppercase">
          {label}
        </span>
      </span>
      <span className="mt-2 block text-sm font-semibold text-muted">{formatLocalDate(date, locale, 'day-header')}</span>
      {title ? (
        <span className="block truncate font-display text-base font-semibold text-ink" dir="auto" data-user-text>
          {title}
        </span>
      ) : (
        summary?.place && (
          <span className="block truncate font-display text-base font-semibold text-ink">
            <bdi>{summary.place}</bdi>
          </span>
        )
      )}
    </button>
  );
}

/** Invisible until focused: lets keyboard and screen-reader users navigate on small screens. */
function EdgeButton({
  side,
  label,
  onClick,
}: {
  side: 'start' | 'end' | 'top' | 'bottom';
  label: string;
  onClick: () => void;
}) {
  const position = {
    start: 'start-2 top-1/2 -translate-y-1/2',
    end: 'end-2 top-1/2 -translate-y-1/2',
    top: 'top-28 left-1/2 -translate-x-1/2',
    bottom: 'bottom-6 left-1/2 -translate-x-1/2',
  }[side];
  const icon =
    side === 'top' || side === 'bottom' ? (
      <ChevronUpIcon size={22} className={side === 'bottom' ? 'rotate-180' : ''} />
    ) : (
      <ChevronIcon size={22} className={side === 'start' ? '-scale-x-100 rtl:scale-x-100' : 'rtl:-scale-x-100'} />
    );
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`absolute z-[5] grid size-11 place-items-center rounded-pill bg-black/45 text-white opacity-0 ring-1 ring-white/30 backdrop-blur focus-visible:opacity-100 ${position}`}
    >
      {icon}
    </button>
  );
}

/** True once `on` has stayed true for `delayMs` (avoids spinner flashes). */
function useDelayedFlag(on: boolean, delayMs: number): boolean {
  const [flag, setFlag] = useState(false);
  useEffect(() => {
    if (!on) {
      setFlag(false);
      return;
    }
    const timer = setTimeout(() => setFlag(true), delayMs);
    return () => clearTimeout(timer);
  }, [on, delayMs]);
  return flag;
}

export type { PlayerEvent };
