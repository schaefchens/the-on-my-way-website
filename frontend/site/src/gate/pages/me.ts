/**
 * /_/me/ "Your data" (D12, spec-wave5 §6.2.5–6.2.6). What the page may show depends on the
 * device's D12 rights (§3.3), which the API decides:
 * - `ok` (full rights): the person's name, all devices, confirmed notice versions, stored
 *   categories, export, delete me (with a deliberate confirmation); sign out and the notice link
 *   only while this device and its person are active (a device that ended together with its
 *   person keeps export and delete, §3.3);
 * - `limited` (a waiting, declined or separately removed device): only this device, plus
 *   "Withdraw request" while it waits; no name, no other device, no export, no delete;
 * - `ended`: nothing is stored for this device.
 * `#signout` opens the sign-out (or withdraw) confirmation directly.
 */
import type {
  DataCategoryKey,
  DataDevice,
  DeviceState,
  FollowerDataView,
  MeDataResponse,
  MeSimpleResponse,
} from '@omw/contracts/access';
import { DELETE_ME_CONFIRMATION } from '../access-lite';
import { type GateContext, messageView } from '../context';
import type { Child } from '../dom';
import { clearSiteStorage } from '../env';
import { fmt, type StringKey } from '../strings';

const STATE_KEYS: Readonly<Record<DeviceState, StringKey>> = {
  active: 'stateActive',
  pending: 'statePending',
  revoked: 'stateRevoked',
  declined: 'stateDeclined',
};

const CATEGORY_KEYS: Readonly<Record<DataCategoryKey, StringKey>> = {
  devices: 'catDevices',
  consents: 'catConsents',
  visits: 'catVisits',
  views: 'catViews',
  reactions: 'catReactions',
  messages: 'catMessages',
  email: 'catEmail',
};

export async function mePage(ctx: GateContext): Promise<void> {
  const k = ctx.cookies.readKey();
  if (!k) {
    showNoData(ctx);
    return;
  }
  await load(ctx, k, ctx.ui.env.location.hash === '#signout');
}

function showNoData(ctx: GateContext): void {
  ctx.ui.show(() => messageView(ctx, ctx.ui.s.noData));
}

async function load(ctx: GateContext, k: string, signoutFirst: boolean): Promise<void> {
  const { ui } = ctx;
  ui.show(() => ui.busy());
  let res: MeDataResponse;
  try {
    res = await ctx.api.post('me/data', { k });
  } catch (err) {
    ui.show(() => ui.failure(err, () => void load(ctx, k, signoutFirst)));
    return;
  }
  switch (res.status) {
    case 'ended':
      showNoData(ctx);
      return;
    case 'limited': {
      const page = limitedPage(ctx, k, res.device);
      if (signoutFirst && res.device.state === 'pending') page.confirmWithdraw();
      else page.show();
      return;
    }
    case 'ok': {
      const page = dataPage(ctx, k, res.data);
      if (signoutFirst && page.canSignOut) page.confirmSignout();
      else page.show();
      return;
    }
  }
}

function chip(ctx: GateContext, state: DeviceState): HTMLElement {
  const tone =
    state === 'active'
      ? 'bg-blush-strong text-ink'
      : state === 'pending'
        ? 'bg-lilac text-violet'
        : 'bg-surface-2 text-muted';
  return ctx.ui.el(
    'span',
    { class: `rounded-pill px-2 py-0.5 text-xs font-bold ${tone}` },
    ctx.ui.s[STATE_KEYS[state]],
  );
}

function section(ctx: GateContext, heading: string, ...children: Child[]): HTMLElement {
  return ctx.ui.el(
    'section',
    { class: 'mt-6' },
    ctx.ui.el('h2', { class: 'font-bold text-ink' }, heading),
    ...children,
  );
}

/** Signs this device out (active) or withdraws its request (pending), then clears what it kept. */
async function signout(ctx: GateContext, k: string, doneText: string, back: () => void): Promise<void> {
  const { ui, cookies } = ctx;
  ui.show(() => ui.busy());
  let res: MeSimpleResponse;
  try {
    res = await ctx.api.post('me/signout', { k });
  } catch (err) {
    ui.show(() => ui.failure(err, back));
    return;
  }
  if (res.status === 'ended') {
    showNoData(ctx);
    return;
  }
  cookies.deleteKey();
  clearSiteStorage(ui.env);
  ui.show(() => messageView(ctx, doneText));
}

function confirmView(
  ctx: GateContext,
  title: string,
  text: string,
  confirmLabel: string,
  onConfirm: () => void,
  onCancel: () => void,
): void {
  const { ui } = ctx;
  ui.show(() => [
    ui.title(title),
    ui.para(text, 'mt-3 text-ink'),
    ui.el(
      'div',
      { class: 'mt-6 flex flex-wrap gap-3' },
      ui.button(ui.s.cancel, onCancel, 'secondary', { 'data-autofocus': true, 'data-action': 'cancel' }),
      ui.button(confirmLabel, onConfirm, 'primary', { 'data-action': 'confirm' }),
    ),
  ]);
}

function limitedPage(ctx: GateContext, k: string, device: Extract<MeDataResponse, { status: 'limited' }>['device']) {
  const { ui } = ctx;
  const show = () =>
    ui.show(() => {
      const s = ui.s;
      return [
        ui.title(s.yourData),
        ui.para(
          fmt(s.thisDeviceLine, {
            label: device.label,
            state: s[STATE_KEYS[device.state]],
            date: ui.date(device.createdAt),
          }),
          'mt-3 text-ink',
        ),
        ui.para(s.limitedHint),
        device.state === 'pending'
          ? ui.el(
              'div',
              { class: 'mt-6' },
              ui.button(s.withdraw, confirmWithdraw, 'secondary', { 'data-action': 'withdraw' }),
            )
          : null,
      ];
    });
  const confirmWithdraw = () =>
    confirmView(
      ctx,
      ui.s.withdraw,
      ui.s.withdrawText,
      ui.s.withdraw,
      () => void signout(ctx, k, ui.s.withdrawn, show),
      show,
    );
  return { show, confirmWithdraw };
}

function dataPage(ctx: GateContext, k: string, data: FollowerDataView) {
  const { ui, cookies } = ctx;
  const env = ui.env;
  let status: string | null = null;
  let exporting = false;
  const thisDevice = data.devices.find((d) => d.thisDevice) ?? null;
  const others = data.devices.filter((d) => !d.thisDevice);
  const active = data.follower.state === 'active' && thisDevice?.state === 'active';

  const deviceItem = (d: DataDevice) =>
    ui.el(
      'li',
      { class: 'flex flex-wrap items-center gap-x-2 gap-y-1 py-2', attrs: { 'data-device': d.id } },
      ui.el('span', { class: 'font-semibold text-ink' }, d.label),
      chip(ctx, d.state),
      ui.el('span', { class: 'text-sm text-muted' }, fmt(ui.s.since, { date: ui.date(d.createdAt) })),
      d.lastSeenAt
        ? ui.el('span', { class: 'text-sm text-muted' }, fmt(ui.s.lastSeen, { date: ui.date(d.lastSeenAt, true) }))
        : null,
    );

  const view = () => {
    const s = ui.s;
    const shared = ui.para('', 'mt-3 text-ink');
    const [before, after = ''] = fmt(s.sharedWith, { date: ui.date(data.follower.since) }).split('{name}');
    shared.append(before ?? '', ui.el('bdi', { attrs: { 'data-user-text': true } }, data.follower.name), after);
    return [
      ui.title(s.yourData),
      shared,
      section(ctx, s.thisDevice, thisDevice ? ui.el('ul', { class: 'mt-1' }, deviceItem(thisDevice)) : null),
      section(
        ctx,
        s.otherDevices,
        others.length > 0
          ? ui.el('ul', { class: 'mt-1 divide-y divide-line' }, ...others.map(deviceItem))
          : ui.para(s.noOtherDevices, 'mt-1 text-muted'),
      ),
      section(
        ctx,
        s.confirmedNotices,
        ui.el(
          'ul',
          { class: 'mt-1' },
          ...data.consents.map((c) =>
            ui.el(
              'li',
              { class: 'py-1 text-muted' },
              // With the time: each joined device confirms on its own, so one version can appear twice.
              fmt(s.consentLine, { n: c.version, date: ui.date(c.confirmedAt, true) }),
            ),
          ),
        ),
        // me/notice serves active devices only; a device that ended with its person keeps the
        // texts in the export instead.
        active
          ? ui.el('p', null, ui.link(s.viewNotice, '/_/info/#view'))
          : ui.para(s.noticeInExport, 'mt-1 text-sm text-muted'),
      ),
      section(
        ctx,
        s.stored,
        ui.el(
          'ul',
          { class: 'mt-1' },
          ui.el('li', { class: 'py-1 text-muted' }, s.catName),
          ...data.categories.map((c) =>
            ui.el(
              'li',
              { class: 'py-1 text-muted', attrs: { 'data-category': c.key } },
              `${s[CATEGORY_KEYS[c.key]]}: ${c.count}`,
            ),
          ),
        ),
      ),
      status ? ui.para(status, 'mt-5 font-semibold text-ink') : null,
      ui.el(
        'div',
        { class: 'mt-6 flex flex-col items-start gap-3' },
        ui.button(s.exportData, () => void runExport(), 'primary', { 'data-action': 'export', disabled: exporting }),
        // Signing out needs an active device of an active person (§3.4); after the person's access
        // ended there is nothing to sign out of, and the API would answer `ended`.
        active ? ui.button(s.signout, confirmSignout, 'secondary', { 'data-action': 'signout' }) : null,
        ui.button(s.deleteAll, confirmDelete, 'dangerQuiet', { 'data-action': 'delete' }),
      ),
      active ? ui.el('p', { class: 'mt-6' }, ui.link(s.toPage, '/')) : null,
    ];
  };

  const show = () => ui.show(view);

  async function runExport(): Promise<void> {
    if (exporting) return;
    exporting = true;
    status = null;
    ui.refresh();
    try {
      const result = await ctx.api.exportData({ k });
      if (result.kind === 'ended') {
        showNoData(ctx);
        return;
      }
      env.download(result.blob, result.filename);
      status = ui.s.exportStarted;
    } catch (err) {
      status =
        err instanceof Error && err.name === 'PublicApiError' && (err as { kind?: string }).kind === 'rate_limited'
          ? ui.s.rateLimited
          : ui.s.offline;
    } finally {
      exporting = false;
    }
    ui.refresh();
  }

  function confirmSignout(): void {
    confirmView(
      ctx,
      ui.s.signout,
      ui.s.signoutText,
      ui.s.signoutConfirm,
      () => void signout(ctx, k, ui.s.signedOut, show),
      show,
    );
  }

  function confirmDelete(): void {
    let understood = false;
    ui.show(() => {
      const s = ui.s;
      const button = ui.button(s.deleteNow, () => void erase(), 'danger', {
        'data-action': 'erase',
        disabled: !understood,
      });
      const box = ui.el('input', {
        class: 'mt-1 size-5 shrink-0 accent-danger',
        attrs: { type: 'checkbox', id: 'omw-understood' },
        onChange: (event) => {
          understood = (event.target as HTMLInputElement).checked;
          button.disabled = !understood;
        },
      });
      box.checked = understood;
      return [
        ui.title(s.deleteTitle),
        ui.para(s.deleteWhat, 'mt-3 text-ink'),
        ui.el(
          'ul',
          { class: 'mt-2 list-disc ps-6 text-ink' },
          ui.el('li', null, s.catName),
          ...data.categories
            .filter((c) => c.count > 0)
            .map((c) => ui.el('li', null, `${s[CATEGORY_KEYS[c.key]]}: ${c.count}`)),
        ),
        ui.para(s.deleteWarning, 'mt-4 font-semibold text-danger'),
        ui.el(
          'label',
          { class: 'mt-5 flex items-start gap-3 text-ink', attrs: { for: 'omw-understood' } },
          box,
          ui.el('span', null, s.deleteCheck),
        ),
        ui.el(
          'div',
          { class: 'mt-6 flex flex-wrap gap-3' },
          ui.button(s.cancel, show, 'secondary', { 'data-autofocus': true, 'data-action': 'cancel' }),
          button,
        ),
      ];
    });

    async function erase(): Promise<void> {
      if (!understood) return;
      ui.show(() => ui.busy());
      let res: MeSimpleResponse;
      try {
        res = await ctx.api.post('me/delete', { k, confirm: DELETE_ME_CONFIRMATION });
      } catch (err) {
        ui.show(() => ui.failure(err, confirmDelete));
        return;
      }
      if (res.status !== 'deleted') {
        showNoData(ctx);
        return;
      }
      cookies.deleteKey();
      clearSiteStorage(env);
      env.replace('/_/ended/#deleted');
    }
  }

  return { show, confirmSignout, canSignOut: active };
}
