import type { AppEntryStatus } from '@omw/contracts/app';
import type { UploadBlock, UploadStatus } from './types';

const WAITING: Record<UploadBlock, AppEntryStatus> = {
  manual: 'ready',
  no_network: 'waiting_network',
  not_validated: 'waiting_network',
  backoff: 'waiting_network',
  server_busy: 'waiting_network',
  inbox_full: 'waiting_network',
  wifi_only: 'waiting_wifi',
  roaming: 'waiting_roaming',
  unauthorized: 'needs_you',
};

/**
 * The phone-side part of the status vocabulary (APP_ENTRY_STATUSES, ux.md §3.11) for an upload
 * status, as API.md maps it. null for a cancelled job. After "uploaded", the server's
 * AppEntryState decides (archived, live, …).
 */
export function uploadEntryStatus(status: UploadStatus): AppEntryStatus | null {
  switch (status.state) {
    case 'cancelled':
      return null;
    case 'uploaded':
      return 'uploaded';
    case 'queued':
    case 'uploading':
    case 'committing':
      return 'uploading';
    case 'failed':
      return 'needs_you';
    case 'waiting':
      return status.blockedBy ? WAITING[status.blockedBy] : 'waiting_network';
  }
}

/** Upload progress 0..100 of the artifact (the original has its own line). */
export function uploadPercent(status: UploadStatus): number {
  if (status.totalBytes <= 0) return status.state === 'uploaded' ? 100 : 0;
  return Math.min(100, Math.floor((status.sentBytes * 100) / status.totalBytes));
}
