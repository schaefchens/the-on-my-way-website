/**
 * Where a capture came from (app-plan §2.1 "source marker"): derived from the sourceKey namespace
 * ("app:<ULID>" = the traveler app, "wa:…" = WhatsApp), never stored or published. The App badge
 * sits on the capture's picture; the item sheet shows the phone and what the inbox knows about it.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { CaptureListItem } from '@omw/contracts/api';
import { formatDateTime } from '@omw/ui/locale';
import { useQuery } from '@tanstack/react-query';
import { appEntryQuery, appPhonesQuery } from '../api/app-phones';
import { useLocale } from '../lib/hooks';
import { deviceTimeZone } from '../lib/places';
import { type IconProps, InfoIcon, LockIcon } from './icons';
import { Badge, cx } from './ui';

/**
 * captureOrigin(key) === 'app' (@omw/contracts/app), restated for the API's (valid) source keys:
 * importing any value from that module pulls its zod schemas into the bundle (see lib/publish.ts).
 * test/app-phones.test.tsx checks that both agree.
 */
export function isAppCapture(capture: Pick<CaptureListItem, 'sourceKey'>): boolean {
  return capture.sourceKey.startsWith('app:');
}

/**
 * Owner decision Q8 a: while the backend's APP_PUBLISH is off (as the API last heard it; assumed on
 * until the first answer), app captures are never published, whatever their visibility says. True
 * for an app capture in that mode, so its chip says "Archive only" instead of "Live".
 */
export function useAppArchiveOnly(capture: Pick<CaptureListItem, 'sourceKey'>): boolean {
  const app = isAppCapture(capture);
  const q = useQuery({ ...appPhonesQuery(), enabled: app, select: (d) => d.archiveOnly });
  return app && q.data !== false;
}

/** The publish chip of an app capture in archive-only mode. */
export function AppArchiveOnlyChip() {
  const { t } = useLingui();
  return (
    <span title={t`Moments from the app go to the archive at home. Nothing from the app is published yet.`}>
      <Badge tone="lilac" icon={LockIcon}>
        <Trans>Archive only</Trans>
      </Badge>
    </span>
  );
}

/** A phone outline (24×24, stroke = currentColor), decorative like the other icons. */
export function PhoneIcon({ className, flip: _flip, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className ?? 'size-5'}`}
      {...props}
    >
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <path d="M10.5 18.5h3" />
    </svg>
  );
}

/** The "App" chip on a capture's picture (nothing for WhatsApp captures). */
export function AppBadge({
  capture,
  compact = false,
}: {
  capture: Pick<CaptureListItem, 'sourceKey'>;
  compact?: boolean;
}) {
  const { t } = useLingui();
  if (!isAppCapture(capture)) return null;
  return (
    <span
      data-testid="app-badge"
      title={t`Shared from the On My Way app`}
      className={cx(
        'absolute top-2 start-2 z-10 inline-flex items-center gap-1 rounded-pill bg-violet font-bold text-white shadow-soft',
        compact ? 'px-1.5 py-0.5 text-[0.6rem]' : 'px-2.5 py-1 text-xs',
      )}
    >
      <PhoneIcon className={compact ? 'size-2.5' : 'size-3.5'} />
      {compact ? <span className="sr-only">{t`App`}</span> : <Trans>App</Trans>}
    </span>
  );
}

/**
 * Item sheet: replaces the WhatsApp caption note for app entries ("the caption comes from WhatsApp")
 * with the phone it came from, the 30-day "Hold back" note and the state of the original.
 */
export function AppOriginNote({ capture }: { capture: CaptureListItem }) {
  const locale = useLocale();
  const q = useQuery(appEntryQuery(capture.sourceKey));
  const info = q.data;
  return (
    <div className="space-y-2 px-2 text-xs text-muted" data-testid="app-origin">
      <p className="flex items-start gap-2">
        <PhoneIcon className="size-4 text-violet" />
        <span>
          {info ? (
            <Trans>
              Shared from the app on “{info.phone.name}”, received{' '}
              {formatDateTime(info.receivedAt, deviceTimeZone(), locale)}. The caption comes from the app and cannot be
              changed here.
            </Trans>
          ) : (
            <Trans>Shared from the app. The caption comes from the app and cannot be changed here.</Trans>
          )}
        </span>
      </p>
      {info?.heldBack && (
        <p className="flex items-start gap-2 rounded-tile bg-blush px-3 py-2 text-ink">
          <InfoIcon className="size-4" />
          <Trans>It arrived more than 30 days after it was shared, so it waits for your release (Hold back).</Trans>
        </p>
      )}
      {info?.clamped && (
        <p className="flex items-start gap-2">
          <InfoIcon className="size-4" />
          <Trans>The phone's clock was off, so the time it arrived is used.</Trans>
        </p>
      )}
      {info && (
        <p className={cx('flex items-start gap-2', info.originalArchived && 'text-success-strong')}>
          <InfoIcon className="size-4" />
          {info.originalArchived ? (
            <Trans>The full-quality original is safe in the archive at home.</Trans>
          ) : (
            <Trans>The full-quality original has not reached the archive yet (it follows on Wi-Fi).</Trans>
          )}
        </p>
      )}
      {capture.revokedAt && (
        <p className="rounded-tile bg-surface-2 px-3 py-2 text-sm text-ink">
          <Trans>You withdrew this moment in the app.</Trans>
        </p>
      )}
    </div>
  );
}
