/**
 * /_/join/ (spec-wave5 §6.2.1): the personal link (#t=…), the resume by device key (#resume) and
 * the retry after a refused handoff (#handoff-failed). The link secret leaves the address bar at
 * once and lives in memory only. A new device first sees the information screen (D11) and joins
 * only with "Continue" (no pre-ticked box).
 */
import type { JoinCheckResponse, JoinResponse, PublicNotice } from '@omw/contracts/access';
import { parseLinkFragment } from '../access-lite';
import { followAccess, type GateContext, showInvalid, showUnavailable } from '../context';
import { readStored, writeStored } from '../env';
import { HANDOFF_RETRY_KEY } from '../handoff';
import { renderNotice } from '../notice';

/** In-app browsers keep their own cookie jar: each one is a separate device (§2.3.1). */
export const IN_APP_UA_RE = /FBAN|FBAV|Instagram|WhatsApp|Line\/|; wv\)/;
/** Wait before the one automatic handoff retry: a just-written file may not be visible yet (P0b-11). */
export const HANDOFF_RETRY_DELAY_MS = 2000;

export async function joinPage(ctx: GateContext): Promise<void> {
  const { ui, cookies } = ctx;
  const env = ui.env;
  const fragment = parseLinkFragment(env.location.hash);
  env.replaceUrl('/_/join/');

  if (fragment.mode === 'handoff-failed') {
    if (cookies.readTransfer() !== null && readStored(env, 'session', HANDOFF_RETRY_KEY) === null) {
      writeStored(env, 'session', HANDOFF_RETRY_KEY, '1');
      ui.show(() => ui.busy(ui.s.almostThere));
      await env.delay(HANDOFF_RETRY_DELAY_MS);
      env.replace('/_/h/');
    } else {
      env.replace('/');
    }
    return;
  }

  if (fragment.mode === 'resume') {
    const k = cookies.readKey();
    if (!k) {
      showInvalid(ctx);
      return;
    }
    await resume(ctx, k);
    return;
  }

  if (fragment.t) {
    await check(ctx, fragment.t);
    return;
  }
  showInvalid(ctx);
}

async function resume(ctx: GateContext, k: string): Promise<void> {
  const { ui } = ctx;
  ui.show(() => ui.busy());
  let res: JoinResponse;
  try {
    res = await ctx.api.post('join', { resume: true, k, locale: ui.locale });
  } catch (err) {
    ui.show(() => ui.failure(err, () => void resume(ctx, k)));
    return;
  }
  await followAccess(ctx, res, { k, retry: () => void resume(ctx, k) });
}

async function check(ctx: GateContext, t: string): Promise<void> {
  const { ui, cookies } = ctx;
  const env = ui.env;
  ui.show(() => ui.busy());
  const k = cookies.readKey();
  let res: JoinCheckResponse;
  try {
    res = await ctx.api.post('join/check', k ? { t, k } : { t });
  } catch (err) {
    ui.show(() => ui.failure(err, () => void check(ctx, t)));
    return;
  }
  switch (res.status) {
    case 'invalid':
      showInvalid(ctx);
      return;
    case 'unavailable':
      showUnavailable(ctx, res.reason, () => void check(ctx, t));
      return;
    case 'known_device':
      if (res.noticeRequired) env.replace('/_/info/#reconfirm');
      else env.replace('/');
      return;
    case 'pending_device':
      env.replace('/_/wait/');
      return;
    case 'ok':
      showInformation(ctx, t, res.follower.name, res.notice, res.deviceMustWait, false);
      return;
  }
}

/** The information screen (D11, §6.2.1 step 4). */
function showInformation(
  ctx: GateContext,
  t: string,
  name: string,
  notice: PublicNotice,
  deviceMustWait: boolean,
  updated: boolean,
): void {
  const { ui } = ctx;
  const env = ui.env;
  const inApp = IN_APP_UA_RE.test(env.userAgent);
  ui.show(() => {
    const s = ui.s;
    const name_ = ui.el('bdi', { attrs: { 'data-user-text': true } }, name);
    const heading = ui.title('');
    const [before, after = ''] = s.linkFor.split('{name}');
    heading.append(before ?? '', name_, after);
    return [
      heading,
      updated ? ui.para(s.noticeUpdated, 'mt-3 font-semibold text-ink') : null,
      deviceMustWait ? ui.para(s.mustWait, 'mt-3 rounded-tile bg-lilac p-3 font-semibold text-ink') : null,
      inApp ? ui.para(s.inAppHint, 'mt-3 rounded-tile bg-blush p-3 text-ink') : null,
      renderNotice(ui, notice),
      ui.para(s.confirmHint, 'mt-5 text-sm text-muted'),
      ui.el(
        'div',
        { class: 'mt-4 flex flex-wrap gap-3' },
        ui.button(s.continue, () => void confirm(ctx, t, name, notice, deviceMustWait), 'primary', {
          'data-action': 'continue',
        }),
        ui.button(s.cancel, () => env.replace('/'), 'secondary', { 'data-action': 'cancel' }),
      ),
    ];
  });
}

async function confirm(
  ctx: GateContext,
  t: string,
  name: string,
  notice: PublicNotice,
  deviceMustWait: boolean,
): Promise<void> {
  const { ui, cookies } = ctx;
  ui.show(() => ui.busy());
  const k = cookies.readKey();
  let res: JoinResponse;
  try {
    res = await ctx.api.post('join', {
      t,
      ...(k ? { k } : {}),
      consentVersion: notice.version,
      locale: ui.locale,
    });
  } catch (err) {
    ui.show(() => ui.failure(err, () => showInformation(ctx, t, name, notice, deviceMustWait, false)));
    return;
  }
  await followAccess(ctx, res, {
    k,
    onConsentOutdated: (next) => showInformation(ctx, t, name, next, deviceMustWait, true),
    retry: () => showInformation(ctx, t, name, notice, deviceMustWait, false),
  });
}
