/**
 * /_/wait/ (spec-wave5 §6.2.2): a device waits for the owner's approval (Q3 c). Polls
 * `device/poll {k}` every 10 s for 2 minutes, then every 30 s up to 30 minutes, then stops with
 * "Check again". No polling while the page is hidden; becoming visible polls at once and starts
 * a fresh window. Loading this page already made Apache re-set the key cookie server-side.
 * A poll the API rate-limits (429: reopening the link or reloading this page several times within
 * a few seconds uses up the poll burst) is not an error for the visitor: the page keeps waiting
 * and polls again after Retry-After (at least 3 s, at most 60 s).
 */
import type { DevicePollResponse } from '@omw/contracts/access';
import { PublicApiError } from '../api';
import { followAccess, type GateContext, showInvalid, unavailableText } from '../context';

export const WAIT_SCHEDULE = {
  fastMs: 10_000,
  fastForMs: 120_000,
  slowMs: 30_000,
  stopAfterMs: 30 * 60_000,
} as const;

/** Delay before polling again after a 429 (Retry-After in seconds, or null when absent). */
export function rateLimitedDelay(retryAfter: number | null): number {
  return Math.min(Math.max((retryAfter ?? 10) * 1000, 3_000), 60_000);
}

/** Delay before the next poll of a pending device, or null when the window is over. */
export function nextPollDelay(elapsedMs: number): number | null {
  if (elapsedMs >= WAIT_SCHEDULE.stopAfterMs) return null;
  return elapsedMs < WAIT_SCHEDULE.fastForMs ? WAIT_SCHEDULE.fastMs : WAIT_SCHEDULE.slowMs;
}

type Line = 'none' | 'stopped' | 'unavailable';

export async function waitPage(ctx: GateContext): Promise<void> {
  const k = ctx.cookies.readKey();
  if (!k) {
    showInvalid(ctx, ctx.ui.s.noKey);
    return;
  }
  const poller = createWaitPoller(ctx, k);
  poller.start();
}

export interface WaitPoller {
  start(): void;
  stop(): void;
}

export function createWaitPoller(ctx: GateContext, k: string): WaitPoller {
  const { ui } = ctx;
  const env = ui.env;
  let startedAt = env.now();
  let cancelTimer: (() => void) | null = null;
  let inFlight = false;
  let done = false;
  let line: Line = 'none';
  let unavailableReason: Extract<DevicePollResponse, { status: 'unavailable' }>['reason'] = 'store';

  const view = () => {
    const s = ui.s;
    return [
      ui.title(s.waitTitle),
      ui.para(s.waitText, 'mt-3 text-ink'),
      line === 'unavailable' ? ui.para(unavailableText(ctx, unavailableReason), 'mt-3 font-semibold text-ink') : null,
      line === 'stopped' ? ui.para(s.waitStopped, 'mt-3 font-semibold text-ink') : null,
      line === 'stopped'
        ? ui.el(
            'div',
            { class: 'mt-5' },
            ui.button(s.checkAgain, () => restart(), 'primary', { 'data-action': 'check' }),
          )
        : line === 'none'
          ? ui.el('div', { class: 'mt-5' }, ...ui.busy())
          : null,
      ui.el('p', { class: 'mt-6' }, ui.link(s.withdraw, '/_/me/#signout')),
    ];
  };

  function setLine(next: Line, redraw: boolean): void {
    const changed = next !== line;
    line = next;
    if (changed || redraw) ui.refresh();
  }

  function clearTimer(): void {
    cancelTimer?.();
    cancelTimer = null;
  }

  function finish(): void {
    done = true;
    clearTimer();
    unsubscribe();
  }

  function scheduleNext(delayMs: number | null): void {
    clearTimer();
    if (done) return;
    if (delayMs === null) {
      setLine('stopped', false);
      return;
    }
    cancelTimer = env.schedule(() => {
      cancelTimer = null;
      void pollNow();
    }, delayMs);
  }

  async function pollNow(): Promise<void> {
    if (done || inFlight || env.isHidden()) return;
    clearTimer();
    inFlight = true;
    let res: DevicePollResponse;
    try {
      res = await ctx.api.post('device/poll', { k });
    } catch (err) {
      inFlight = false;
      if (done) return;
      if (err instanceof PublicApiError && err.kind === 'rate_limited') {
        scheduleNext(rateLimitedDelay(err.retryAfter));
        return;
      }
      finish();
      ui.show(() => ui.failure(err, () => restart()));
      return;
    }
    inFlight = false;
    if (done) return;
    switch (res.status) {
      case 'pending':
        if (line === 'unavailable') setLine('none', false);
        scheduleNext(nextPollDelay(env.now() - startedAt));
        return;
      case 'activating':
        scheduleNext(res.pollAfterMs);
        return;
      case 'unavailable':
        unavailableReason = res.reason;
        setLine('unavailable', true);
        scheduleNext(nextPollDelay(env.now() - startedAt));
        return;
      default:
        finish();
        await followAccess(ctx, res, { k });
    }
  }

  function restart(): void {
    if (done) {
      done = false;
      unsubscribe = env.onVisibilityChange(onVisibility);
    }
    startedAt = env.now();
    line = 'none';
    ui.show(view);
    void pollNow();
  }

  function onVisibility(): void {
    if (done) return;
    if (env.isHidden()) {
      clearTimer();
      return;
    }
    startedAt = env.now();
    if (line === 'stopped') setLine('none', false);
    void pollNow();
  }

  let unsubscribe = env.onVisibilityChange(onVisibility);

  return {
    start() {
      startedAt = env.now();
      ui.show(view);
      void pollNow();
    },
    stop: finish,
  };
}
