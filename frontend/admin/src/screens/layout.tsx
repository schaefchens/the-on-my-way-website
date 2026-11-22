/**
 * App shell of the signed-in admin: a floating tab bar on phones (Home · Inbox · Write · Days ·
 * Settings; Trips live next to Days, People inside Settings), a side navigation from 1024 px
 * (with People and the number of waiting devices), the offline banner and a "sending…" pill for
 * queued writes.
 */
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { SPRINGS } from '@omw/ui/motion';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouteContext, useRouterState } from '@tanstack/react-router';
import * as m from 'motion/react-m';
import { useState } from 'react';
import { capturesQuery, statusQuery } from '../api/queries';
import { OfflineBanner, SyncPill } from '../components/feedback';
import {
  CalendarIcon,
  FeatherIcon,
  HomeIcon,
  InboxIcon,
  InfoIcon,
  LogOutIcon,
  MoreIcon,
  PeopleIcon,
  PlaneIcon,
  PlusIcon,
  SettingsIcon,
  ShieldIcon,
  SuitcaseIcon,
} from '../components/icons';
import { Button, buttonClass, cx, Dialog, type Icon } from '../components/ui';
import { usePendingWrites, useTypingState } from '../lib/hooks';
import { inboxSeenStore, isNew } from '../lib/seen';
import { useStore } from '../lib/store';
import { logout } from '../session';
import { SiteStatusMini } from './home';

type NavTo = '/' | '/inbox' | '/days' | '/trips' | '/people' | '/settings';

interface NavItem {
  to: NavTo;
  label: MessageDescriptor;
  icon: Icon;
  /** Other path prefixes that highlight this item. */
  also?: string[];
}

const SIDE_NAV: NavItem[] = [
  { to: '/', label: msg`Home`, icon: HomeIcon },
  { to: '/inbox', label: msg`Inbox`, icon: InboxIcon },
  { to: '/days', label: msg`Days`, icon: CalendarIcon },
  { to: '/trips', label: msg`Trips`, icon: SuitcaseIcon },
  { to: '/people', label: msg`People`, icon: PeopleIcon },
  { to: '/settings', label: msg`Settings`, icon: SettingsIcon },
];

const TAB_NAV: NavItem[] = [
  { to: '/', label: msg`Home`, icon: HomeIcon },
  { to: '/inbox', label: msg`Inbox`, icon: InboxIcon },
  { to: '/days', label: msg`Days`, icon: CalendarIcon, also: ['/trips'] },
];

/** Everything the phone tab bar has no room for, in the "More" sheet (all areas of the admin). */
type MoreTo = '/days' | '/trips' | '/people' | '/settings' | '/settings/safety' | '/settings/privacy';
const MORE_NAV: Array<{ to: MoreTo; label: MessageDescriptor; icon: Icon }> = [
  { to: '/days', label: msg`Days`, icon: CalendarIcon },
  { to: '/trips', label: msg`Trips`, icon: SuitcaseIcon },
  { to: '/people', label: msg`People`, icon: PeopleIcon },
  { to: '/settings/safety', label: msg`Safety`, icon: ShieldIcon },
  { to: '/settings/privacy', label: msg`Privacy notice`, icon: InfoIcon },
  { to: '/settings', label: msg`Settings`, icon: SettingsIcon },
];

/** Logging out, asking first when offline edits would be lost (side nav and the "More" sheet). */
function useLogout() {
  const { t } = useLingui();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pending = usePendingWrites().length;
  const [confirm, setConfirm] = useState(false);
  async function doLogout() {
    setConfirm(false);
    // Leave the signed-in screens first, so nothing refetches (401) while the data is wiped.
    await navigate({ to: '/login' });
    await logout(qc);
  }
  // Queued offline edits would be deleted with the local data: ask first (as in Settings).
  const request = () => (pending > 0 ? setConfirm(true) : void doLogout());
  const dialog = (
    <Dialog
      open={confirm}
      onClose={() => setConfirm(false)}
      closeLabel={t`Close`}
      title={<Trans>Changes not sent yet</Trans>}
      description={
        <Plural
          value={pending}
          one="# change has not reached the server. Logging out deletes it from this device."
          other="# changes have not reached the server. Logging out deletes them from this device."
        />
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => setConfirm(false)}>
            <Trans>Stay logged in</Trans>
          </Button>
          <Button className="bg-danger hover:bg-danger" icon={LogOutIcon} onClick={() => void doLogout()}>
            <Trans>Log out anyway</Trans>
          </Button>
        </>
      }
    />
  );
  return { request, dialog };
}

/** Phone tab bar "More": a sheet listing every area, so Trips, People etc. are one tap away. */
function MoreSheet({ open, onClose, pendingDevices }: { open: boolean; onClose: () => void; pendingDevices: number }) {
  const { i18n, t } = useLingui();
  const out = useLogout();
  return (
    <>
      <Dialog open={open} onClose={onClose} closeLabel={t`Close`} title={<Trans>All areas</Trans>}>
        <nav aria-label={t`All areas`}>
          <ul className="space-y-2">
            {MORE_NAV.map((item) => {
              const IconCmp = item.icon;
              return (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    onClick={onClose}
                    className="press relative flex min-h-14 items-center gap-3 rounded-card bg-blush/50 px-4 font-bold text-ink hover:bg-blush"
                  >
                    <IconCmp className="size-5 shrink-0 text-accent-strong" />
                    <span className="min-w-0 flex-1">{i18n._(item.label)}</span>
                    {item.to === '/people' && pendingDevices > 0 && (
                      <span className="rounded-pill bg-accent px-2 py-0.5 text-xs font-extrabold text-on-accent">
                        {pendingDevices}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <Button
          variant="secondary"
          icon={LogOutIcon}
          className="mt-4 w-full"
          onClick={() => {
            onClose();
            out.request();
          }}
        >
          <Trans>Log out</Trans>
        </Button>
      </Dialog>
      {out.dialog}
    </>
  );
}

function useActive() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const path = pathname.replace(/^\/admin/, '') || '/';
  return (item: NavItem) => {
    const prefixes = [item.to, ...(item.also ?? [])];
    return prefixes.some((p) => (p === '/' ? path === '/' : path === p || path.startsWith(`${p}/`)));
  };
}

function useNewCount(): number {
  const seenAt = useStore(inboxSeenStore);
  const q = useInfiniteQuery(capturesQuery());
  const first = q.data?.pages[0]?.items ?? [];
  return first.filter((c) => isNew(c.occurredAt, seenAt)).length;
}

/** Devices waiting for the owner's OK (counts only, from the persisted status query). */
function usePendingDevices(): number {
  const q = useQuery(statusQuery());
  return q.data?.access?.pendingDevices ?? 0;
}

function CountDot({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="absolute -end-1.5 -top-1 grid h-4.5 min-w-4.5 place-items-center rounded-pill bg-accent px-1 text-[0.65rem] leading-none font-extrabold text-on-accent ring-2 ring-surface">
      {count > 99 ? '99+' : count}
    </span>
  );
}

function TabBar() {
  const { i18n, t } = useLingui();
  const isActive = useActive();
  const newCount = useNewCount();
  const pendingDevices = usePendingDevices();
  const composing = useRouterState({ select: (s) => s.location.pathname.includes('/compose') });
  const [moreOpen, setMoreOpen] = useState(false);
  const tab = (item: NavItem) => {
    const active = isActive(item);
    const IconCmp = item.icon;
    return (
      <Link
        key={item.to}
        to={item.to}
        aria-current={active ? 'page' : undefined}
        className="press relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-[1.4rem] text-[0.68rem] font-bold"
      >
        {active && (
          <m.span
            layoutId="tab-pill"
            transition={SPRINGS.soft}
            className="absolute inset-1 rounded-[1.2rem] bg-blush"
          />
        )}
        <span className={cx('relative', active ? 'text-accent-strong' : 'text-muted')}>
          <IconCmp className="size-[1.4rem]" />
          {item.to === '/inbox' && <CountDot count={newCount} />}
        </span>
        <span className={cx('relative', active ? 'text-ink' : 'text-muted')}>{i18n._(item.label)}</span>
      </Link>
    );
  };
  // "More" is active on the screens only it leads to (People, Settings and their sub-screens).
  const moreActive = isActive({ to: '/settings', label: msg`Settings`, icon: SettingsIcon, also: ['/people'] });
  return (
    <nav
      aria-label={t`Main`}
      className="bottom-safe hide-when-typing fixed inset-x-3 z-40 mx-auto max-w-md rounded-[1.75rem] bg-surface/88 p-1 shadow-float ring-1 ring-line backdrop-blur-xl lg:hidden"
    >
      <div className="flex items-center">
        {TAB_NAV.slice(0, 2).map(tab)}
        <div className="flex flex-1 justify-center">
          <Link
            to="/compose"
            search={{ kind: 'note' }}
            aria-label={t`Write`}
            aria-current={composing ? 'page' : undefined}
            className="press -mt-7 grid size-15 place-items-center rounded-pill bg-accent text-on-accent shadow-lift ring-4 ring-bg hover:bg-accent-strong"
          >
            <FeatherIcon className="size-6" />
          </Link>
        </div>
        {TAB_NAV.slice(2).map(tab)}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-haspopup="dialog"
          aria-current={moreActive ? 'page' : undefined}
          className="press relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 rounded-[1.4rem] text-[0.68rem] font-bold"
        >
          {moreActive && (
            <m.span
              layoutId="tab-pill"
              transition={SPRINGS.soft}
              className="absolute inset-1 rounded-[1.2rem] bg-blush"
            />
          )}
          <span className={cx('relative', moreActive ? 'text-accent-strong' : 'text-muted')}>
            <MoreIcon className="size-[1.4rem]" />
            {pendingDevices > 0 && (
              <span
                data-testid="settings-pending-dot"
                aria-hidden="true"
                className="absolute -end-1 -top-0.5 size-2.5 rounded-pill bg-accent ring-2 ring-surface"
              />
            )}
          </span>
          {pendingDevices > 0 && <span className="sr-only">{t`A device is waiting`}</span>}
          <span className={cx('relative', moreActive ? 'text-ink' : 'text-muted')}>
            {t({ message: 'More', context: 'tab bar, keep short' })}
          </span>
        </button>
      </div>
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} pendingDevices={pendingDevices} />
    </nav>
  );
}

function SideNav() {
  const { i18n, t } = useLingui();
  const isActive = useActive();
  const newCount = useNewCount();
  const pendingDevices = usePendingDevices();
  const { me } = useRouteContext({ from: '/authed' });
  const out = useLogout();
  return (
    <aside className="fixed inset-y-0 start-0 z-30 hidden w-68 flex-col border-e border-line/70 bg-surface/60 px-4 py-6 backdrop-blur-md lg:flex">
      <Link to="/" className="press mb-8 flex items-center gap-3 rounded-card px-2 py-1">
        <span className="grid size-11 place-items-center rounded-[0.9rem] bg-linear-to-br from-rose-600 to-violet-700 text-cream shadow-soft">
          <PlaneIcon className="size-5" />
        </span>
        <span>
          <span className="display-soft block text-xl leading-tight font-semibold">On My Way</span>
          <span className="block font-hand text-sm text-accent">
            <Trans>travel journal</Trans>
          </span>
        </span>
      </Link>
      <Link to="/compose" search={{ kind: 'note' }} className={buttonClass('primary', 'md', 'mb-6 w-full')}>
        <PlusIcon className="size-5" />
        <Trans>New entry</Trans>
      </Link>
      <nav aria-label={t`Main`}>
        <ul className="space-y-1">
          {SIDE_NAV.map((item) => {
            const active = isActive(item);
            const IconCmp = item.icon;
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'press relative flex min-h-11 items-center gap-3 rounded-pill px-4 font-bold',
                    active ? 'text-ink' : 'text-muted hover:bg-blush/60 hover:text-ink',
                  )}
                >
                  {active && (
                    <m.span
                      layoutId="side-pill"
                      transition={SPRINGS.soft}
                      className="absolute inset-0 rounded-pill bg-blush"
                    />
                  )}
                  <span className={cx('relative', active && 'text-accent-strong')}>
                    <IconCmp className="size-5" />
                  </span>
                  <span className="relative flex-1">{i18n._(item.label)}</span>
                  {item.to === '/inbox' && newCount > 0 && (
                    <span className="relative rounded-pill bg-accent px-2 py-0.5 text-xs font-extrabold text-on-accent">
                      {newCount}
                    </span>
                  )}
                  {item.to === '/people' && pendingDevices > 0 && (
                    <span
                      data-testid="people-pending-badge"
                      className="relative rounded-pill bg-accent px-2 py-0.5 text-xs font-extrabold text-on-accent"
                    >
                      {pendingDevices}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="mt-auto space-y-3">
        <SiteStatusMini />
        <div className="flex items-center gap-2 rounded-card px-2 py-1">
          <span className="grid size-9 shrink-0 place-items-center rounded-pill bg-lilac font-display text-sm font-bold text-violet">
            {(me.displayName ?? me.email).slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{me.displayName ?? me.email}</span>
          <button
            type="button"
            aria-label={t`Log out`}
            title={t`Log out`}
            onClick={out.request}
            className="press grid size-9 place-items-center rounded-pill text-muted hover:bg-blush hover:text-ink"
          >
            <LogOutIcon className="size-[1.1rem]" />
          </button>
        </div>
      </div>
      {out.dialog}
    </aside>
  );
}

export function AdminLayout() {
  useTypingState();
  return (
    <div className="min-h-dvh">
      <SideNav />
      <div className="lg:ps-68">
        <main
          id="main"
          className="mx-auto w-full max-w-3xl px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-tabbar sm:px-6 lg:max-w-5xl lg:px-10 lg:pt-10 lg:pb-16"
        >
          <OfflineBanner />
          <Outlet />
        </main>
      </div>
      <div className="pointer-events-none fixed end-4 top-[max(0.75rem,env(safe-area-inset-top))] z-40">
        <SyncPill />
      </div>
      <TabBar />
    </div>
  );
}
