/**
 * Types of the omw-native JS API (the contract between the native and the UI work; see API.md).
 * Wire payloads (entries, upload slots) come from @omw/contracts/app.
 */
import type { AppEntry, AppFileRole } from '@omw/contracts/app';

// ---- Haptics (Android's own constants only; app-plan §5.3)

export const HAPTIC_CONSTANTS = [
  'VIRTUAL_KEY',
  'LONG_PRESS',
  'KEYBOARD_TAP',
  'CLOCK_TICK',
  'CONTEXT_CLICK',
  'CONFIRM',
  'REJECT',
  'GESTURE_START',
  'GESTURE_END',
  'GESTURE_THRESHOLD_ACTIVATE',
  'GESTURE_THRESHOLD_DEACTIVATE',
  'SEGMENT_TICK',
  'SEGMENT_FREQUENT_TICK',
  'DRAG_START',
  'TOGGLE_ON',
  'TOGGLE_OFF',
] as const;
export type HapticConstant = (typeof HAPTIC_CONSTANTS)[number];

// ---- Network (A4)

export type NetworkTransport = 'wifi' | 'cellular' | 'ethernet' | 'vpn' | 'other' | 'none';

export interface NetworkState {
  /** A default network with INTERNET exists. */
  connected: boolean;
  /** NET_CAPABILITY_VALIDATED: the internet is really reachable (no captive portal). */
  validated: boolean;
  /** NOT_METERED: what A4 calls "Wi-Fi". A hotspot or a metered Wi-Fi is false. */
  unmetered: boolean;
  /** The default network is roaming (no NOT_ROAMING capability). */
  roaming: boolean;
  transport: NetworkTransport;
  /** MCC+MNC of the default data SIM (the per-SIM roaming answer), e.g. "45204". */
  simOperator: string | null;
  /** Carrier name of the data SIM, e.g. "Viettel". */
  simOperatorName: string | null;
}

// ---- Uploader (A4, Q6 c)

export type UploadMode = 'auto' | 'manual';

export interface UploadSettings {
  /** auto: upload when the rules allow; manual: wait for "Upload now". Default auto. */
  mode: UploadMode;
  /** Only unmetered networks for every upload. Default true (Q6 c). */
  wifiOnly: boolean;
  /** With wifiOnly: photos, text and voice may still use mobile data. Default false. */
  photosOnMobileData: boolean;
  /** "Also while roaming" for every SIM. Default false (A4). */
  roaming: boolean;
  /** SIMs (MCC+MNC) she allowed while roaming ("Allow on this SIM"). */
  roamingAllowedSims: string[];
}

export const DEFAULT_UPLOAD_SETTINGS: Readonly<UploadSettings> = Object.freeze({
  mode: 'auto',
  wifiOnly: true,
  photosOnMobileData: false,
  roaming: false,
  roamingAllowedSims: [],
});

export interface UploadJobFile {
  role: AppFileRole;
  /** file:// URI inside the app's outbox (outbox/<entryId>/…). */
  uri: string;
}

/** One entry to bring from the outbox to the API (create -> PATCH chunks -> commit). */
export interface UploadJob {
  entryId: string;
  /** The AppEntry exactly as POST /app/entries will send it (clientNow is added at send time). */
  entry: AppEntry;
  /** Local files for the roles declared in entry.files. */
  files: UploadJobFile[];
  /** Per-entry override from the publish sheet; default = the settings' mode. */
  mode?: UploadMode;
}

export type UploadState = 'queued' | 'waiting' | 'uploading' | 'committing' | 'uploaded' | 'failed' | 'cancelled';

/** Why a job is waiting (maps onto the status vocabulary of @omw/contracts/app, see uploadEntryStatus). */
export const UPLOAD_BLOCKS = [
  'manual',
  'no_network',
  'not_validated',
  'wifi_only',
  'roaming',
  'backoff',
  'server_busy',
  'inbox_full',
  'unauthorized',
] as const;
export type UploadBlock = (typeof UPLOAD_BLOCKS)[number];

export interface UploadError {
  /** ApiError code (APP_ERROR_CODES) or a client code (e.g. "file_missing"). */
  code: string;
  message: string;
  /** true = retrying cannot help ("Needs you"). */
  permanent: boolean;
}

export interface UploadStatus {
  entryId: string;
  state: UploadState;
  /** Bytes of the artifact (media + preview) the API holds. The original is counted in `original`. */
  sentBytes: number;
  totalBytes: number;
  blockedBy: UploadBlock | null;
  error: UploadError | null;
  /** ISO UTC. */
  updatedAt: string;
  /**
   * The private original (Q2 c): uploaded on its own after the artifact is "uploaded", and only
   * on unmetered networks (never after "Upload anyway"). null when the entry has no original.
   */
  original: UploadOriginalStatus | null;
}

/** The original's own line in the queue ("Original waits for Wi-Fi · 184 MB"). */
export interface UploadOriginalStatus {
  /** queued: waits for the artifact first, or for its turn. */
  state: 'queued' | 'waiting' | 'uploading' | 'uploaded' | 'failed';
  blockedBy: UploadBlock | null;
  sentBytes: number;
  totalBytes: number;
  error: UploadError | null;
}

/** Where the uploader sends to: the build's API base (`extra.apiBaseUrl`), never a link's. */
export interface UploaderConfig {
  /** https://…, or http://127.0.0.1:<port> in development (adb reverse). */
  apiBaseUrl: string;
}

export interface UploadProgressEvent {
  entryId: string;
  role: AppFileRole;
  sentBytes: number;
  totalBytes: number;
}

export interface UploadNowOptions {
  /** One entry, or all waiting entries when absent. */
  entryId?: string;
  /** She confirmed "Upload anyway" on mobile data (asked once per tap). */
  allowMetered?: boolean;
}

// ---- MediaExport

export interface VideoExportRequest {
  /** Client-chosen id, echoed in progress events. */
  jobId: string;
  /** content:// (Photo Picker) or file:// source. */
  sourceUri: string;
  /** file:// target inside the outbox. */
  outputUri: string;
  trimStartMs?: number;
  trimEndMs?: number;
  mute?: boolean;
  /** Default 1920 (APP_LIMITS.videoMaxLongSide). */
  maxLongSide?: number;
  /** Default 30 (FrameDropEffect). */
  maxFps?: number;
  /** Full-frame transparent PNG baked on top (v0.6; rejects with ERR_NOT_IMPLEMENTED until then). */
  overlayPngUri?: string;
}

export interface PhotoExportRequest {
  jobId: string;
  sourceUri: string;
  outputUri: string;
  /** Defaults 2880 / 1600 (APP_LIMITS). */
  maxLongSide?: number;
  maxShortSide?: number;
  /** JPEG quality 0..1, default 0.9. */
  quality?: number;
}

export interface ExportResult {
  jobId: string;
  uri: string;
  mimetype: 'image/jpeg' | 'video/mp4';
  bytes: number;
  sha256Hex: string;
  width: number;
  height: number;
  /** Videos only. */
  durationMs?: number;
}

/** error.code of a rejected export. */
export const EXPORT_ERROR_CODES = [
  'ERR_INVALID_REQUEST',
  'ERR_INVALID_SOURCE',
  'ERR_INVALID_OUTPUT',
  'ERR_UNSUPPORTED_SOURCE',
  'ERR_INVALID_TRIM',
  'ERR_EXPORT_FAILED',
  'ERR_CANCELLED',
  'ERR_NOT_IMPLEMENTED',
] as const;
export type ExportErrorCode = (typeof EXPORT_ERROR_CODES)[number];

export interface ExportProgressEvent {
  jobId: string;
  /** 0..1 */
  progress: number;
}

/** Removes a listener (same shape as expo's EventSubscription). */
export interface Subscription {
  remove(): void;
}
