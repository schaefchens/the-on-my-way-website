import { describe, expect, it } from '@jest/globals';
import { DEFAULT_UPLOAD_SETTINGS } from '../modules/omw-native';
import {
  allowSimPatch,
  effectiveMode,
  meteredAllowed,
  networkBlock,
  settingsRelevance,
  uploadClass,
  uploadNowQuestion,
  uploadSummary,
} from '../src/core/upload-rules';
import { HOTSPOT, MOBILE, OFFLINE_NET, ROAMING, SETTINGS, WIFI } from './fixtures';

describe('A4 defaults (Q6 c)', () => {
  it('are automatic, Wi-Fi only, no photos on mobile data, no roaming', () => {
    expect(DEFAULT_UPLOAD_SETTINGS).toEqual({
      mode: 'auto',
      wifiOnly: true,
      photosOnMobileData: false,
      roaming: false,
      roamingAllowedSims: [],
    });
  });
});

describe('upload classes', () => {
  it('treats photos, text and voice as small, videos and originals apart', () => {
    expect(uploadClass('photo')).toBe('small');
    expect(uploadClass('text')).toBe('small');
    expect(uploadClass('voice')).toBe('small');
    expect(uploadClass('video')).toBe('video');
    expect(uploadClass('photo', 'original')).toBe('original');
    expect(uploadClass('video', 'preview')).toBe('video');
  });
});

describe('network rules', () => {
  it('lets everything go on Wi-Fi (unmetered)', () => {
    for (const cls of ['small', 'video', 'original'] as const) expect(networkBlock(cls, SETTINGS, WIFI)).toBeNull();
  });

  it('waits for a connection, and for a validated one (captive portals)', () => {
    expect(networkBlock('small', SETTINGS, OFFLINE_NET)).toBe('no_network');
    expect(networkBlock('small', SETTINGS, { ...WIFI, validated: false })).toBe('not_validated');
  });

  it('Wi-Fi only blocks every class on mobile data, and a hotspot counts as mobile data', () => {
    for (const net of [MOBILE, HOTSPOT]) {
      expect(networkBlock('small', SETTINGS, net)).toBe('wifi_only');
      expect(networkBlock('video', SETTINGS, net)).toBe('wifi_only');
    }
  });

  it('"Photos also on mobile data" lets small entries go, videos and originals still wait', () => {
    const s = { ...SETTINGS, photosOnMobileData: true };
    expect(networkBlock('small', s, MOBILE)).toBeNull();
    expect(networkBlock('video', s, MOBILE)).toBe('wifi_only');
    expect(networkBlock('original', s, MOBILE)).toBe('wifi_only');
  });

  it('originals never use mobile data, even with Wi-Fi only off or "Upload anyway"', () => {
    const s = { ...SETTINGS, wifiOnly: false };
    expect(networkBlock('original', s, MOBILE)).toBe('wifi_only');
    expect(networkBlock('original', SETTINGS, MOBILE, { allowMetered: true })).toBe('wifi_only');
    expect(meteredAllowed('original', s, true)).toBe(false);
  });

  it('"Upload anyway" lifts Wi-Fi only for that run', () => {
    expect(networkBlock('video', SETTINGS, MOBILE, { allowMetered: true })).toBeNull();
  });

  it('roaming blocks mobile data unless allowed in general or for this SIM', () => {
    const mobileOk = { ...SETTINGS, wifiOnly: false };
    expect(networkBlock('small', mobileOk, ROAMING)).toBe('roaming');
    expect(networkBlock('small', { ...mobileOk, roaming: true }, ROAMING)).toBeNull();
    expect(networkBlock('small', { ...mobileOk, roamingAllowedSims: ['45204'] }, ROAMING)).toBeNull();
    // Another SIM abroad is asked about again.
    expect(networkBlock('small', { ...mobileOk, roamingAllowedSims: ['23415'] }, ROAMING)).toBe('roaming');
    // "Upload anyway" never lifts roaming.
    expect(networkBlock('small', mobileOk, ROAMING, { allowMetered: true })).toBe('roaming');
    // Roaming on Wi-Fi doesn't matter.
    expect(networkBlock('video', SETTINGS, { ...WIFI, roaming: true })).toBeNull();
  });
});

describe('modes', () => {
  it('uses the per-entry override before the setting', () => {
    expect(effectiveMode(SETTINGS)).toBe('auto');
    expect(effectiveMode(SETTINGS, 'manual')).toBe('manual');
    expect(effectiveMode({ ...SETTINGS, mode: 'manual' }, 'auto')).toBe('auto');
    expect(effectiveMode({ ...SETTINGS, mode: 'manual' }, null)).toBe('manual');
  });
});

describe('"Upload now" on mobile data', () => {
  const waiting = [
    { kind: 'video' as const, bytes: 150_000_000 },
    { kind: 'photo' as const, bytes: 34_000_000 },
  ];

  it('asks once with the total size of what Wi-Fi only holds back', () => {
    expect(uploadNowQuestion(waiting, SETTINGS, MOBILE)).toEqual({ ask: true, bytes: 184_000_000, count: 2 });
  });

  it('does not ask on Wi-Fi, offline, or when nothing is held by Wi-Fi only', () => {
    expect(uploadNowQuestion(waiting, SETTINGS, WIFI)).toEqual({ ask: false });
    expect(uploadNowQuestion(waiting, SETTINGS, OFFLINE_NET)).toEqual({ ask: false });
    expect(uploadNowQuestion(waiting, { ...SETTINGS, wifiOnly: false }, MOBILE)).toEqual({ ask: false });
  });

  it('asks only about the videos when photos may already use mobile data', () => {
    expect(uploadNowQuestion(waiting, { ...SETTINGS, photosOnMobileData: true }, MOBILE)).toEqual({
      ask: true,
      bytes: 150_000_000,
      count: 1,
    });
  });

  it('does not offer "Upload anyway" while roaming is not allowed', () => {
    expect(uploadNowQuestion(waiting, SETTINGS, ROAMING)).toEqual({ ask: false });
  });
});

describe('Settings rows', () => {
  it('shows "Photos also on mobile data" only under Wi-Fi only, roaming only when mobile data may be used', () => {
    expect(settingsRelevance(SETTINGS)).toEqual({ photosOnMobileData: true, roaming: false });
    expect(settingsRelevance({ ...SETTINGS, photosOnMobileData: true })).toEqual({
      photosOnMobileData: true,
      roaming: true,
    });
    expect(settingsRelevance({ ...SETTINGS, wifiOnly: false })).toEqual({ photosOnMobileData: false, roaming: true });
  });

  it('"Allow on this SIM" remembers the data SIM once', () => {
    expect(allowSimPatch(SETTINGS, ROAMING)).toEqual({ roamingAllowedSims: ['45204'] });
    expect(allowSimPatch({ ...SETTINGS, roamingAllowedSims: ['45204'] }, ROAMING)).toEqual({
      roamingAllowedSims: ['45204'],
    });
    expect(allowSimPatch(SETTINGS, { ...ROAMING, simOperator: null })).toBeNull();
  });

  it('summarises what happens right now', () => {
    expect(uploadSummary(SETTINGS, MOBILE)).toMatchObject({
      network: 'metered',
      photoWouldGo: false,
      videoWouldGo: false,
    });
    expect(uploadSummary({ ...SETTINGS, photosOnMobileData: true }, MOBILE)).toMatchObject({
      photoWouldGo: true,
      videoWouldGo: false,
    });
    expect(uploadSummary(SETTINGS, WIFI)).toMatchObject({ network: 'wifi', photoWouldGo: true, videoWouldGo: true });
  });
});
