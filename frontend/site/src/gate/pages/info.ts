/**
 * /_/info/ (spec-wave5 §6.2.4): the privacy notice for a device that already joined.
 * `#reconfirm[&return=<path>]`: the notice changed (D11, §1.7) → show it with "The privacy
 * information has changed." and "Continue" → `me/consent` → back to `return` (a same-origin path
 * validated by parseLinkFragment) or "/". `#view`: the same notice, read only, with "Back".
 */
import type { MeHelloResponse, MeNoticeResponse, PublicNotice } from '@omw/contracts/access';
import { parseLinkFragment } from '../access-lite';
import { type GateContext, messageView, showUnavailable } from '../context';
import { renderNotice } from '../notice';

export async function infoPage(ctx: GateContext): Promise<void> {
  const { ui, cookies } = ctx;
  const env = ui.env;
  const fragment = parseLinkFragment(env.location.hash);
  const reconfirm = fragment.mode === 'reconfirm';
  const returnPath = fragment.returnPath ?? '/';
  const k = cookies.readKey();
  if (!k) {
    env.replace('/_/ended/');
    return;
  }
  await load(ctx, k, reconfirm, returnPath);
}

async function load(ctx: GateContext, k: string, reconfirm: boolean, returnPath: string): Promise<void> {
  const { ui } = ctx;
  const env = ui.env;
  ui.show(() => ui.busy());
  let res: MeNoticeResponse;
  try {
    res = await ctx.api.post('me/notice', { k });
  } catch (err) {
    ui.show(() => ui.failure(err, () => void load(ctx, k, reconfirm, returnPath)));
    return;
  }
  if (res.status === 'ended') {
    env.replace('/_/ended/');
    return;
  }
  if (res.status === 'unavailable') {
    showUnavailable(ctx, res.reason, () => void load(ctx, k, reconfirm, returnPath));
    return;
  }
  const { notice, confirmedVersion } = res;
  if (reconfirm && confirmedVersion !== null && confirmedVersion >= notice.version) {
    env.replace(returnPath);
    return;
  }
  if (!reconfirm) {
    ui.show(() => [
      ui.title(ui.s.privateTitle),
      renderNotice(ui, notice),
      ui.el('p', { class: 'mt-6' }, ui.link(ui.s.back, '/_/me/', 'secondary')),
    ]);
    return;
  }
  ui.show(() => [
    ui.title(ui.s.noticeChanged),
    renderNotice(ui, notice),
    ui.para(ui.s.confirmHint, 'mt-5 text-sm text-muted'),
    ui.el(
      'div',
      { class: 'mt-4 flex flex-wrap items-center gap-3' },
      ui.button(ui.s.continue, () => void consent(ctx, k, notice, returnPath), 'primary', {
        'data-action': 'continue',
      }),
      ui.link(ui.s.yourData, '/_/me/'),
    ),
  ]);
}

async function consent(ctx: GateContext, k: string, notice: PublicNotice, returnPath: string): Promise<void> {
  const { ui } = ctx;
  const env = ui.env;
  ui.show(() => ui.busy());
  let res: MeHelloResponse;
  try {
    res = await ctx.api.post('me/consent', { k, version: notice.version, locale: ui.locale });
  } catch (err) {
    ui.show(() => ui.failure(err, () => void load(ctx, k, true, returnPath)));
    return;
  }
  switch (res.status) {
    case 'active':
      // A newer version was published meanwhile: show that one.
      if (res.notice?.required) await load(ctx, k, true, returnPath);
      else env.replace(returnPath);
      return;
    case 'pending':
      // A device still waiting for the owner's OK: back to waiting (it has no page to return to).
      if (res.notice?.required) await load(ctx, k, true, returnPath);
      else env.replace('/_/wait/');
      return;
    case 'ended':
      env.replace('/_/ended/');
      return;
    case 'unavailable':
      ui.show(() =>
        messageView(
          ctx,
          ui.s.unavailable,
          ui.button(ui.s.retry, () => void load(ctx, k, true, returnPath)),
        ),
      );
      return;
  }
}
