/** App-wide feedback: toasts with undo, the offline banner and the "new version" prompt. */
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { SPRINGS } from '@omw/ui/motion';
import { useRouterState } from '@tanstack/react-router';
import { AnimatePresence } from 'motion/react';
import * as m from 'motion/react-m';
import { useEffect, useRef, useState } from 'react';
import { useConnectivity, usePendingWrites } from '../lib/hooks';
import {
  clearNoticesOnNavigation,
  dismissNotice,
  holdNotice,
  type Notice,
  noticeStore,
  releaseNotice,
} from '../lib/notices';
import { useStore } from '../lib/store';
import { updateStore } from '../pwa';
import {
  AlertIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CloseIcon,
  CloudOffIcon,
  InfoIcon,
  SparklesIcon,
  UndoIcon,
} from './icons';
import { Button, cx, Spinner } from './ui';

function NoticeItem({ notice }: { notice: Notice }) {
  const { i18n, t } = useLingui();
  const text = typeof notice.message === 'string' ? notice.message : i18n._(notice.message);
  // A finger on the toast pauses it (pointerleave fires right after a tap, so release later).
  const release = (e: { pointerType: string }) => releaseNotice(notice.id, e.pointerType === 'touch' ? 6000 : 3000);
  const IconCmp =
    notice.tone === 'error'
      ? AlertIcon
      : notice.tone === 'success'
        ? CheckCircleIcon
        : notice.tone === 'undo'
          ? UndoIcon
          : InfoIcon;
  return (
    <m.li
      layout
      initial={{ opacity: 0, y: 24, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 12, scale: 0.96, transition: { duration: 0.15 } }}
      transition={SPRINGS.soft}
      role={notice.tone === 'error' ? 'alert' : 'status'}
      onPointerEnter={() => holdNotice(notice.id)}
      onPointerDown={() => holdNotice(notice.id)}
      onPointerLeave={release}
      onFocus={() => holdNotice(notice.id)}
      onBlur={() => releaseNotice(notice.id)}
      className="pointer-events-auto flex w-full items-center gap-3 rounded-[1.4rem] bg-ink py-2 ps-4 pe-2 text-bg shadow-float"
    >
      {notice.waitFor ? (
        <Spinner className="size-5 shrink-0 opacity-80" />
      ) : (
        <IconCmp
          className={cx('size-5 shrink-0', notice.tone === 'error' ? 'text-rose-300 dark:text-rose-700' : 'opacity-80')}
        />
      )}
      <div className="min-w-0 flex-1 py-1.5">
        <p className="text-sm font-semibold">{text}</p>
        {notice.detail && (
          <details className="group mt-0.5 text-xs opacity-80">
            <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 font-bold pointer-coarse:min-h-11">
              <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90 rtl:-scale-x-100" />
              <Trans>Details</Trans>
            </summary>
            <p className="font-mono break-words" dir="ltr">
              {notice.detail}
            </p>
          </details>
        )}
      </div>
      {notice.action && (
        <button
          type="button"
          onClick={() => {
            notice.action?.run();
            dismissNotice(notice.id);
          }}
          className="press min-h-11 shrink-0 rounded-pill px-3.5 text-sm font-extrabold text-rose-300 hover:bg-white/10 dark:text-rose-700 dark:hover:bg-black/10"
        >
          {i18n._(notice.action.label)}
        </button>
      )}
      <button
        type="button"
        aria-label={t`Dismiss`}
        onClick={() => dismissNotice(notice.id)}
        className="press grid size-9 shrink-0 place-items-center rounded-pill opacity-70 hover:bg-white/10 hover:opacity-100 pointer-coarse:size-11 dark:hover:bg-black/10"
      >
        <CloseIcon className="size-4" />
      </button>
    </m.li>
  );
}

export function Toaster() {
  const notices = useStore(noticeStore);
  const { t } = useLingui();
  // Toasts belong to the screen they were made on (the undo offer may follow the owner).
  const path = useRouterState({ select: (s) => s.location.pathname });
  const firstPath = useRef(path);
  useEffect(() => {
    if (path === firstPath.current) return;
    firstPath.current = path;
    clearNoticesOnNavigation();
  }, [path]);
  return (
    <ol
      aria-label={t`Notifications`}
      className="toaster-stack pointer-events-none fixed inset-x-0 z-50 mx-auto flex max-w-md flex-col gap-2 px-4"
    >
      <AnimatePresence initial={false}>
        {notices.map((n) => (
          <NoticeItem key={n.id} notice={n} />
        ))}
      </AnimatePresence>
    </ol>
  );
}

/** Offline / API unreachable banner with the number of edits waiting on this device. */
export function OfflineBanner() {
  const { browserOnline, online } = useConnectivity();
  const pending = usePendingWrites().length;
  return (
    <AnimatePresence initial={false}>
      {!online && (
        <m.div
          key="offline"
          role="status"
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={SPRINGS.soft}
          className="mb-5 flex items-start gap-3 rounded-card bg-lilac px-4 py-3 text-ink shadow-soft"
        >
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-pill bg-surface text-violet">
            <CloudOffIcon className="size-[1.1rem]" />
          </span>
          <div className="min-w-0 text-sm">
            <p className="font-bold">
              {browserOnline ? <Trans>The server is not reachable right now</Trans> : <Trans>You are offline</Trans>}
            </p>
            <p className="text-muted">
              {pending > 0 ? (
                <Plural
                  value={pending}
                  one="# change is saved on this device and will be sent automatically."
                  other="# changes are saved on this device and will be sent automatically."
                />
              ) : (
                <Trans>You can keep editing: changes are kept on this device and sent later.</Trans>
              )}
            </p>
          </div>
        </m.div>
      )}
    </AnimatePresence>
  );
}

/** Small "sending…" pill while queued writes are being sent (online). */
export function SyncPill() {
  const { online } = useConnectivity();
  const pending = usePendingWrites().length;
  if (!online || pending === 0) return null;
  return (
    <span
      role="status"
      className="inline-flex items-center gap-1.5 rounded-pill bg-surface px-3 py-1 text-xs font-bold text-muted shadow-soft"
    >
      <Spinner className="size-3" />
      <Plural value={pending} one="Sending # change…" other="Sending # changes…" />
    </span>
  );
}

export function UpdatePrompt() {
  const update = useStore(updateStore);
  const [busy, setBusy] = useState(false);
  return (
    <AnimatePresence>
      {update && (
        <m.div
          role="status"
          data-update-prompt
          initial={{ opacity: 0, y: -24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -24 }}
          transition={SPRINGS.soft}
          // Below the notch / Dynamic Island in standalone mode (viewport-fit=cover).
          className="fixed inset-x-4 top-[max(1rem,env(safe-area-inset-top))] z-50 mx-auto flex max-w-md items-center gap-3 rounded-card bg-surface p-3 ps-4 shadow-float ring-1 ring-line"
        >
          <SparklesIcon className="size-5 shrink-0 text-accent" />
          <p className="min-w-0 flex-1 text-sm font-semibold">
            <Trans>A new version is ready. Reload now?</Trans>
          </p>
          <Button
            size="md"
            busy={busy}
            onClick={() => {
              setBusy(true);
              void update();
            }}
          >
            <Trans>Reload</Trans>
          </Button>
        </m.div>
      )}
    </AnimatePresence>
  );
}
