/**
 * Day-end card (plan C): a 3 s countdown to the next day, cancelable; replay; back to the
 * timeline. The countdown only runs while nothing pauses the player. When the owner set a name
 * (profile), the card ends the day with a handwritten sign-off from them.
 */
import { Plural, Trans } from '@lingui/react/macro';
import type { LocaleCode } from '@omw/contracts/i18n';
import { pickText } from '@omw/contracts/i18n';
import type { DaySummary } from '@omw/contracts/site';
import { countryFlag, formatLocalDate } from '@omw/ui/locale';
import { Picture } from '@omw/ui/picture';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useProfile } from '../profile';
import { MetaParts } from './chrome';
import { DURATIONS } from './durations';
import { ChevronIcon, ReplayIcon } from './icons';

export interface DayEndProps {
  locale: LocaleCode;
  title: string;
  momentCount: number;
  next: { date: string; summary: DaySummary | undefined } | null;
  /** The countdown may run (player not paused by anything). */
  canCountDown: boolean;
  imageSizes: string;
  onNextDay(): void;
  onReplay(): void;
  onClose(): void;
}

/** Remaining ms of a pausable countdown; calls onDone once at 0. */
export function useCountdown(totalMs: number, running: boolean, onDone: () => void): number {
  const [remaining, setRemaining] = useState(totalMs);
  const remainingRef = useRef(totalMs);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useEffect(() => {
    if (!running || remainingRef.current <= 0) return;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      remainingRef.current = Math.max(0, remainingRef.current - (now - last));
      last = now;
      setRemaining(Math.ceil(remainingRef.current / 100) * 100);
      if (remainingRef.current <= 0) {
        doneRef.current();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running]);
  return remaining;
}

const RING = 2 * Math.PI * 21;

/** A warm handwritten line from the traveler, signed with their name ("— Lea"). */
export function SignOff({ author }: { author: string }) {
  return (
    <p
      data-testid="day-end-signoff"
      className="mt-[4cqi] w-fit -rotate-2 font-hand text-[4.6cqi] leading-snug text-rose-200"
    >
      <Trans>Thanks for coming along!</Trans>
      <span className="mt-[0.6cqi] block ps-[12cqi] text-[5.2cqi] text-rose-300">
        —{' '}
        <bdi dir="auto" data-user-text>
          {author}
        </bdi>
      </span>
    </p>
  );
}

export function DayEndCard({
  locale,
  title,
  momentCount,
  next,
  canCountDown,
  imageSizes,
  onNextDay,
  onReplay,
  onClose,
}: DayEndProps) {
  const [cancelled, setCancelled] = useState(false);
  const author = useProfile()?.author;
  const counting = next !== null && canCountDown && !cancelled;
  const remaining = useCountdown(DURATIONS.dayEndCountdownMs, counting, onNextDay);
  const seconds = Math.max(1, Math.ceil(remaining / 1000));
  const nextTitle = next?.summary ? pickText(next.summary.title, locale, next.summary.orig)?.text : undefined;
  const nextPlace = next?.summary?.place;
  const nextCountry = next?.summary?.country;
  const nextCount = next?.summary ? Object.values(next.summary.counts).reduce((a, b) => a + b, 0) : 0;
  const nextMeta: ReactNode[] = [];
  if (next && nextTitle) nextMeta.push(formatLocalDate(next.date, locale, 'day-header'));
  if (nextPlace || nextCountry) {
    nextMeta.push(
      <>
        {nextPlace && <bdi>{nextPlace}</bdi>}
        {nextCountry && `${nextPlace ? ' ' : ''}${countryFlag(nextCountry)}`}
      </>,
    );
  }
  if (!nextTitle && !nextPlace && nextCount > 0) {
    nextMeta.push(<Plural value={nextCount} one="# moment" other="# moments" />);
  }

  return (
    <div className="absolute inset-0 overflow-hidden bg-linear-to-b from-plum-900 via-plum-950 to-plum-950 text-white">
      <div
        aria-hidden="true"
        className="absolute -top-24 left-1/2 size-[130cqi] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(244_163_188/0.35),transparent)]"
      />
      <div aria-hidden="true" className="paper-grain absolute inset-0 opacity-50 mix-blend-overlay" />
      <div className="relative flex h-full flex-col justify-center gap-[6cqi] px-[8cqi] pt-20 pb-10">
        <div>
          <p className="text-[3.4cqi] font-bold tracking-[0.16em] text-rose-300 uppercase">
            <Trans>End of the day</Trans>
          </p>
          <h2
            className="mt-2 font-display text-[8.8cqi] leading-[1.06] font-semibold text-balance [font-variation-settings:'SOFT'_100]"
            dir="auto"
            data-user-text
          >
            {title}
          </h2>
          <p className="mt-2 text-[3.9cqi] text-white/75">
            <Plural value={momentCount} one="# moment" other="# moments" />
          </p>
          {author && <SignOff author={author} />}
        </div>

        {next ? (
          <div className="rounded-sheet bg-white/10 p-[4.5cqi] ring-1 ring-white/15 backdrop-blur-md">
            <div className="flex items-center gap-[4cqi]">
              <div className="relative size-[19cqi] shrink-0 overflow-hidden rounded-card bg-plum-850">
                {next.summary?.cover && (
                  <Picture
                    image={next.summary.cover}
                    alt=""
                    sizes={imageSizes === '320px' ? '120px' : '160px'}
                    className="size-full object-cover"
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[3.3cqi] font-bold tracking-[0.12em] text-white/70 uppercase">
                  <Trans>Next day</Trans>
                </p>
                {/* Two lines for long titles and dates (Arabic weekdays), never cut mid-word. */}
                <p
                  className="line-clamp-2 font-display text-[5.2cqi] leading-tight font-semibold text-balance"
                  dir="auto"
                  data-user-text
                >
                  {nextTitle ?? formatLocalDate(next.date, locale, 'day-header')}
                </p>
                <MetaParts parts={nextMeta} className="mt-0.5 text-[3.6cqi] text-white/75" />
              </div>
              {counting && (
                <div className="relative grid size-12 shrink-0 place-items-center" aria-hidden="true">
                  <svg viewBox="0 0 48 48" className="absolute inset-0 -rotate-90" aria-hidden="true">
                    <circle cx="24" cy="24" r="21" fill="none" stroke="rgb(255 255 255 / 0.2)" strokeWidth="3" />
                    <circle
                      cx="24"
                      cy="24"
                      r="21"
                      fill="none"
                      stroke="#f4a3bc"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeDasharray={RING}
                      strokeDashoffset={RING * (1 - remaining / DURATIONS.dayEndCountdownMs)}
                    />
                  </svg>
                  <span className="text-lg font-bold tabular-nums">{seconds}</span>
                </div>
              )}
            </div>
            <div className="mt-[4.5cqi] flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onNextDay}
                data-testid="player-next-day"
                className="inline-flex items-center gap-1.5 rounded-pill bg-rose-300 px-5 py-2.5 font-semibold text-plum-950 shadow-lift transition-transform duration-150 ease-snappy active:scale-95"
              >
                <Trans>Watch next day</Trans>
                <ChevronIcon size={18} className="rtl:-scale-x-100" />
              </button>
              {counting && (
                <button
                  type="button"
                  onClick={() => setCancelled(true)}
                  data-testid="player-stay"
                  className="rounded-pill px-4 py-2.5 font-semibold text-white/85 hover:bg-white/10"
                >
                  <Trans>Stay here</Trans>
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-sheet bg-white/10 p-[5cqi] ring-1 ring-white/15">
            <p className="font-hand text-[5cqi] leading-snug">
              <Trans>That’s all for now. New moments will appear here as the journey continues ✨</Trans>
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onReplay}
            className="inline-flex items-center gap-2 rounded-pill bg-white/10 px-4 py-2.5 font-semibold ring-1 ring-white/20 hover:bg-white/15 active:scale-95"
          >
            <ReplayIcon size={18} />
            <Trans>Replay day</Trans>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-2 rounded-pill px-4 py-2.5 font-semibold text-white/85 hover:bg-white/10"
          >
            <Trans>Back to the timeline</Trans>
          </button>
        </div>
      </div>
    </div>
  );
}
