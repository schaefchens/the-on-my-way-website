/**
 * The one status vocabulary in words, glyphs and colours (ux.md §3.11; APP_ENTRY_STATUSES of
 * @omw/contracts/app). States always come as glyph + word, never colour alone.
 */

import { useLingui } from '@lingui/react/macro';
import type { AppEntryStatus } from '@omw/contracts/app';
import { useCallback } from 'react';
import { formatBytes } from '../core/entry';
import { type EntryStatusView, type OutboxManifest, originalLine } from '../core/outbox-machine';
import type { Theme } from '../theme';
import type { IconName } from './icons';

export const STATUS_ICONS: Record<AppEntryStatus, IconName> = {
  preparing: 'Sparkles',
  ready: 'Upload',
  waiting_network: 'CloudOff',
  waiting_wifi: 'Wifi',
  waiting_roaming: 'Signal',
  uploading: 'Upload',
  uploaded: 'Inbox',
  archived: 'Check',
  publishing: 'Sparkles',
  scheduled: 'Clock',
  held: 'Pause',
  hidden: 'EyeOff',
  live: 'Check',
  needs_you: 'Alert',
};

/** Home and safe: drawn with the check stroke. */
export function isDone(status: AppEntryStatus): boolean {
  return status === 'archived' || status === 'live';
}

export function statusColor(status: AppEntryStatus, theme: Theme): string {
  const c = theme.colors;
  if (isDone(status)) return c.success;
  if (status === 'needs_you') return c.danger;
  if (status === 'uploading' || status === 'uploaded') return c.violet;
  return c.muted;
}

/** Locale for Intl formatting (the pseudo-locale formats like English). */
export function intlLocale(locale: string): string {
  return locale === 'ar' ? 'en' : locale;
}

/** "Uploading · 42 %", "Waiting for Wi-Fi", … */
export function useStatusText() {
  const { t, i18n } = useLingui();
  const label = useCallback(
    (view: EntryStatusView): string => {
      const percent = view.percent ?? 0;
      switch (view.status) {
        case 'preparing':
          return t`Preparing…`;
        case 'ready':
          return t`Ready to upload`;
        case 'waiting_network':
          // Not paired yet: the network is not the reason, the missing connection to the site is.
          return view.reason === 'not_paired' ? t`Waits on this phone` : t`Waiting for network`;
        case 'waiting_wifi':
          return t`Waiting for Wi-Fi`;
        case 'waiting_roaming':
          return t`Waiting for Wi-Fi (roaming)`;
        case 'uploading':
          return t`Uploading · ${percent} %`;
        case 'uploaded':
          return t`Uploaded`;
        case 'archived':
          return t`Archived ✓`;
        case 'publishing':
          return t`Publishing…`;
        case 'scheduled':
          return t`Appears later`;
        case 'held':
          return t`Waiting for your release`;
        case 'hidden':
          return t`Only for you`;
        case 'live':
          return t`Live ✓`;
        case 'needs_you':
          return t`Needs you`;
      }
    },
    [t],
  );

  /** A second, calmer line with the reason (or null). */
  const detail = useCallback(
    (view: EntryStatusView, carrier?: string | null): string | null => {
      const size = view.bytesLeft && view.bytesLeft > 0 ? formatBytes(view.bytesLeft, intlLocale(i18n.locale)) : null;
      switch (view.reason) {
        case 'not_paired':
          return t`Connect this phone to your website first. Until then it waits here, safely.`;
        case 'metered_wifi':
          return size
            ? t`${size} · this Wi-Fi is metered, so it counts as mobile data`
            : t`This Wi-Fi is metered, so it counts as mobile data`;
        case 'wifi_only':
          return size ? t`${size} · goes on Wi-Fi` : t`Goes on Wi-Fi`;
        case 'roaming':
          return carrier ? t`Roaming on ${carrier}` : t`Roaming abroad`;
        case 'manual':
          return t`Waits for “Upload now”`;
        case 'export_pending':
          return t`The video step comes with the next app update. It’s safe on your phone.`;
        case 'home_offline':
          return t`Your computer at home picks it up once it’s back online. It’s safe.`;
        case 'server_busy':
        case 'inbox_full':
        case 'backoff':
          return t`The server is busy. It tries again by itself.`;
        case 'not_validated':
          return t`This network has no internet yet (a login page?)`;
        case 'unauthorized':
          return t`This phone was disconnected. Connect it again.`;
        default:
          if (view.status === 'uploaded') return t`Waiting for the computer at home`;
          if (view.status === 'archived') return t`Safe in your archive at home`;
          if (view.status === 'needs_you') return t`Something went wrong. Try again.`;
          return null;
      }
    },
    [t, i18n.locale],
  );

  /** The archive original's line (Q2 c), or null when there is nothing to say. */
  const original = useCallback(
    (m: OutboxManifest): string | null => {
      const line = originalLine(m);
      if (!line) return null;
      const size = formatBytes(line.bytesLeft, intlLocale(i18n.locale));
      switch (line.state) {
        case 'waiting_wifi':
          return t`Original for your archive waits for Wi-Fi · ${size}`;
        case 'waiting':
          return t`Original for your archive waits for a connection · ${size}`;
        case 'uploading':
          return t`Original for your archive · ${line.percent} %`;
        case 'failed':
          return t`The original could not be sent. It stays on your phone.`;
        case 'next':
          return t`Original for your archive comes next · ${size}`;
      }
    },
    [t, i18n.locale],
  );

  return { label, detail, original };
}
