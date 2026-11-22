/**
 * The A4 upload rules as the app explains them (owner decisions A4, Q2 c, Q6 c). The native
 * uploader evaluates the same facts on its own (API.md "Uploader"); this module words the queue,
 * the publish sheet and Settings, and decides when "Upload now" has to ask about mobile data.
 *
 * - "Wi-Fi" = an unmetered network. A phone hotspot or a metered Wi-Fi counts as mobile data.
 * - wifiOnly (default on): nothing on mobile data, except photos, text and voice with
 *   photosOnMobileData. Videos and originals wait for Wi-Fi.
 * - Originals (Q2 c: photo AND video originals for the home archive) only ever on Wi-Fi.
 * - Roaming blocks mobile data unless "also while roaming" is on or this SIM was allowed.
 * - "Upload now" on mobile data asks once per tap; its yes lifts wifiOnly for that run, never the
 *   roaming rule (that is the per-SIM answer).
 *
 * Framework-free.
 */
import type { AppEntryKind, AppFileRole } from '@omw/contracts/app';
import type { NetworkState, UploadBlock, UploadMode, UploadSettings } from '../../modules/omw-native';

/** small: photo/text/voice artifacts; video: the MP4; original: the archive copy. */
export type UploadClass = 'small' | 'video' | 'original';

export function uploadClass(kind: AppEntryKind, role: AppFileRole = 'media'): UploadClass {
  if (role === 'original') return 'original';
  return kind === 'video' ? 'video' : 'small';
}

/** May this class use a metered network under these settings? */
export function meteredAllowed(cls: UploadClass, settings: UploadSettings, allowMetered = false): boolean {
  if (cls === 'original') return false;
  if (!settings.wifiOnly || allowMetered) return true;
  return cls === 'small' && settings.photosOnMobileData;
}

/** Roaming blocks unless she allowed roaming in general or for this data SIM. */
export function roamingAllowed(settings: UploadSettings, network: NetworkState): boolean {
  if (settings.roaming) return true;
  return network.simOperator !== null && settings.roamingAllowedSims.includes(network.simOperator);
}

/**
 * Why a file of this class can't go right now (null = the network rules allow it). The manual
 * mode is not a network rule: see effectiveMode().
 */
export function networkBlock(
  cls: UploadClass,
  settings: UploadSettings,
  network: NetworkState,
  options: { allowMetered?: boolean } = {},
): UploadBlock | null {
  if (!network.connected) return 'no_network';
  if (!network.validated) return 'not_validated';
  if (network.unmetered) return null;
  if (!meteredAllowed(cls, settings, options.allowMetered)) return 'wifi_only';
  if (network.roaming && !roamingAllowed(settings, network)) return 'roaming';
  return null;
}

/** The mode of one entry: the publish sheet's override, else the setting (default auto). */
export function effectiveMode(settings: UploadSettings, override?: UploadMode | null): UploadMode {
  return override ?? settings.mode;
}

/** A waiting entry as "Upload now" sees it. */
export interface WaitingEntry {
  kind: AppEntryKind;
  /** Bytes still to send (media + preview). */
  bytes: number;
}

/**
 * "Upload now" asks once ("You're on mobile data. Upload 184 MB anyway?") when she is on a
 * metered network and at least one waiting entry is held back only by "Only on Wi-Fi".
 */
export function uploadNowQuestion(
  entries: readonly WaitingEntry[],
  settings: UploadSettings,
  network: NetworkState,
): { ask: false } | { ask: true; bytes: number; count: number } {
  if (!network.connected || network.unmetered) return { ask: false };
  const held = entries.filter((e) => networkBlock(uploadClass(e.kind), settings, network) === 'wifi_only');
  // Roaming stays blocked even after "Upload anyway": then there is nothing to ask about.
  if (held.length === 0 || (network.roaming && !roamingAllowed(settings, network))) return { ask: false };
  return { ask: true, bytes: held.reduce((sum, e) => sum + e.bytes, 0), count: held.length };
}

/** Which Settings rows matter under the current switches (hidden rows keep their values). */
export function settingsRelevance(settings: UploadSettings) {
  return {
    /** "Photos also on mobile data" only refines "Only on Wi-Fi". */
    photosOnMobileData: settings.wifiOnly,
    /** "Also while roaming" only matters when something may use mobile data. */
    roaming: !settings.wifiOnly || settings.photosOnMobileData,
  };
}

/**
 * The "Allow on this SIM" answer: adds the data SIM to roamingAllowedSims (idempotent). Returns
 * the patch for Uploader.setSettings, or null when there is no SIM to name.
 */
export function allowSimPatch(
  settings: UploadSettings,
  network: NetworkState,
): Pick<UploadSettings, 'roamingAllowedSims'> | null {
  const sim = network.simOperator;
  if (!sim) return null;
  if (settings.roamingAllowedSims.includes(sim)) return { roamingAllowedSims: [...settings.roamingAllowedSims] };
  return { roamingAllowedSims: [...settings.roamingAllowedSims, sim] };
}

/** The facts behind the one-line summary on Today and in the publish sheet. */
export interface UploadSummary {
  mode: UploadMode;
  wifiOnly: boolean;
  photosOnMobileData: boolean;
  /** none | wifi (unmetered) | metered (mobile data, hotspot, metered Wi-Fi) */
  network: 'none' | 'wifi' | 'metered';
  roaming: boolean;
  /** Small entries (a photo) would start right now in auto mode. */
  photoWouldGo: boolean;
  /** A video would start right now in auto mode. */
  videoWouldGo: boolean;
}

export function uploadSummary(settings: UploadSettings, network: NetworkState): UploadSummary {
  return {
    mode: settings.mode,
    wifiOnly: settings.wifiOnly,
    photosOnMobileData: settings.photosOnMobileData,
    network: !network.connected ? 'none' : network.unmetered ? 'wifi' : 'metered',
    roaming: network.connected && network.roaming,
    photoWouldGo: networkBlock('small', settings, network) === null,
    videoWouldGo: networkBlock('video', settings, network) === null,
  };
}
