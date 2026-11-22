/**
 * What every gate page gets (UI shell, public API, cookies) and the steps the join, resume and
 * wait flows share: following an `active` / `activating` / `pending` answer (spec-wave5 §6.2.1).
 */
import type { DevicePollResponse, JoinResponse, PublicNotice, UnavailableReason } from '@omw/contracts/access';
import type { PublicApi } from './api';
import type { GateCookies } from './cookies';
import type { Child, Ui } from './dom';
import { startHandoff } from './handoff';

export interface GateContext {
  readonly ui: Ui;
  readonly api: PublicApi;
  readonly cookies: GateCookies;
}

/** How long `activating` is polled before "This is taking longer than expected" (§6.2.1). */
export const ACTIVATING_MAX_MS = 120_000;

export function unavailableText(ctx: GateContext, reason: UnavailableReason): string {
  return reason === 'too_many_pending' ? ctx.ui.s.tooManyPending : ctx.ui.s.unavailable;
}

/** A message screen: heading, text, optional actions. */
export function messageView(ctx: GateContext, text: string, ...actions: Child[]): Child[] {
  const { ui } = ctx;
  return [
    ui.title(ui.s.privateTitle),
    ui.para(text, 'mt-3 text-ink'),
    actions.length > 0 ? ui.el('div', { class: 'mt-6 flex flex-wrap gap-3' }, ...actions) : null,
  ];
}

export function showInvalid(ctx: GateContext, text?: string): void {
  ctx.ui.show(() => messageView(ctx, text ?? ctx.ui.s.invalidLink));
}

export function showUnavailable(ctx: GateContext, reason: UnavailableReason, retry: (() => void) | null): void {
  ctx.ui.show(() =>
    messageView(
      ctx,
      unavailableText(ctx, reason),
      retry && reason !== 'too_many_pending' ? ctx.ui.button(ctx.ui.s.retry, retry) : null,
    ),
  );
}

export interface FollowOptions {
  /** The device key the request presented (resume) or that the answer carried. */
  k: string | null;
  /** `consent_outdated` (join only): show the new notice again. */
  onConsentOutdated?: (notice: PublicNotice) => void;
  /** Retry of the request that produced an `unavailable` answer. */
  retry?: () => void;
}

/**
 * Acts on a join or poll answer: write the key cookie, then hand off, wait, poll or end.
 * Never puts the session or the key into a URL.
 */
export async function followAccess(
  ctx: GateContext,
  res: JoinResponse | DevicePollResponse,
  opts: FollowOptions,
  startedAt: number = ctx.ui.env.now(),
): Promise<void> {
  const { ui, cookies } = ctx;
  const env = ui.env;
  if ('deviceKey' in res && res.deviceKey) cookies.writeKey(res.deviceKey);
  const k = ('deviceKey' in res && res.deviceKey) || opts.k;
  switch (res.status) {
    case 'active':
      if (res.handoff === '/_/h/' && res.session) startHandoff(env, cookies, res.session);
      else env.replace('/');
      return;
    case 'pending':
      env.replace('/_/wait/');
      return;
    case 'ended':
      env.replace('/_/ended/');
      return;
    case 'invalid':
      showInvalid(ctx);
      return;
    case 'unavailable':
      showUnavailable(ctx, res.reason, opts.retry ?? null);
      return;
    case 'consent_outdated':
      opts.onConsentOutdated?.(res.notice);
      return;
    case 'activating': {
      if (!k) {
        showInvalid(ctx, ui.s.noKey);
        return;
      }
      if (env.now() - startedAt >= ACTIVATING_MAX_MS) {
        const again = () => {
          ui.show(() => ui.busy(ui.s.almostThere));
          void pollOnce(ctx, k, opts, env.now());
        };
        ui.show(() => messageView(ctx, ui.s.slow, ui.button(ui.s.retry, again)));
        return;
      }
      ui.show(() => ui.busy(ui.s.almostThere));
      await env.delay(res.pollAfterMs);
      await pollOnce(ctx, k, opts, startedAt);
      return;
    }
  }
}

async function pollOnce(ctx: GateContext, k: string, opts: FollowOptions, startedAt: number): Promise<void> {
  let res: DevicePollResponse;
  try {
    res = await ctx.api.post('device/poll', { k });
  } catch (err) {
    ctx.ui.show(() => ctx.ui.failure(err, () => void pollOnce(ctx, k, opts, ctx.ui.env.now())));
    return;
  }
  await followAccess(ctx, res, { ...opts, k }, startedAt);
}
