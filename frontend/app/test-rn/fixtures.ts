/** Shared fixtures for the jest-expo tests. */
import type { NetworkState, UploadSettings, UploadStatus } from '../modules/omw-native';
import type { OutboxFile } from '../src/core/outbox-machine';

export const SETTINGS: UploadSettings = {
  mode: 'auto',
  wifiOnly: true,
  photosOnMobileData: false,
  roaming: false,
  roamingAllowedSims: [],
};

export const WIFI: NetworkState = {
  connected: true,
  validated: true,
  unmetered: true,
  roaming: false,
  transport: 'wifi',
  simOperator: '26201',
  simOperatorName: 'Telekom',
};

export const MOBILE: NetworkState = { ...WIFI, unmetered: false, transport: 'cellular' };
export const ROAMING: NetworkState = { ...MOBILE, roaming: true, simOperator: '45204', simOperatorName: 'Viettel' };
export const HOTSPOT: NetworkState = { ...WIFI, unmetered: false };
export const OFFLINE_NET: NetworkState = {
  connected: false,
  validated: false,
  unmetered: false,
  roaming: false,
  transport: 'none',
  simOperator: null,
  simOperatorName: null,
};

export const ID = '01JD4Z8W3K5V7X9Y1Z3B5C7D9F';
export const NOW = '2026-11-20T10:00:00.000Z';
export const LATER = '2026-11-20T10:00:05.000Z';

export const SHA = 'a'.repeat(64);

export const PHOTO_FILES: OutboxFile[] = [
  { role: 'media', name: 'media.jpg', mimetype: 'image/jpeg', bytes: 900_000, sha256Hex: SHA },
  { role: 'preview', name: 'preview.jpg', mimetype: 'image/jpeg', bytes: 60_000, sha256Hex: 'b'.repeat(64) },
  { role: 'original', name: 'source.jpg', mimetype: 'image/jpeg', bytes: 4_000_000, sha256Hex: 'c'.repeat(64) },
];

export function status(patch: Partial<UploadStatus> = {}): UploadStatus {
  // (original: the private original's own line, null = none)
  return {
    entryId: ID,
    state: 'queued',
    sentBytes: 0,
    totalBytes: 960_000,
    blockedBy: null,
    error: null,
    updatedAt: NOW,
    original: null,
    ...patch,
  };
}
