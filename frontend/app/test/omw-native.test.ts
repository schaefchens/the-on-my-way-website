import { beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadEntryStatus, uploadPercent } from '../modules/omw-native/src/status';
import {
  DEFAULT_UPLOAD_SETTINGS,
  EXPORT_ERROR_CODES,
  HAPTIC_CONSTANTS,
  UPLOAD_BLOCKS,
  type UploadStatus,
} from '../modules/omw-native/src/types';
import { clearFakeNativeModules, setFakeNativeModule } from './stubs/expo';

// Each test gets fresh module state (the facade caches native modules and the haptic throttle).
async function load() {
  vi.resetModules();
  return import('../modules/omw-native/index');
}

beforeEach(() => clearFakeNativeModules());

describe('omw-native without the native side (tests, web)', () => {
  it('falls back instead of crashing', async () => {
    const m = await load();
    expect(m.isNativeAvailable()).toBe(false);
    expect(await m.TokenVault.get()).toBeNull();
    expect(await m.Uploader.getSettings()).toEqual(DEFAULT_UPLOAD_SETTINGS);
    expect(await m.Uploader.status()).toEqual([]);
    expect(await m.Network.getState()).toEqual(m.OFFLINE);
    expect(await m.haptic('CONFIRM')).toBe(false);
    m.Network.addListener(() => {}).remove();
    await expect(m.Uploader.setSettings({ wifiOnly: false })).rejects.toThrow(m.NativeUnavailableError);
    await expect(m.MediaExport.exportPhoto({ jobId: 'j', sourceUri: 'a', outputUri: 'b' })).rejects.toThrow(
      m.NativeUnavailableError,
    );
  });

  it('defaults follow the owner decisions: automatic, Wi-Fi only, roaming off (Q6 c, A4)', () => {
    expect(DEFAULT_UPLOAD_SETTINGS).toEqual({
      mode: 'auto',
      wifiOnly: true,
      photosOnMobileData: false,
      roaming: false,
      roamingAllowedSims: [],
    });
  });

  it('refuses to store anything but an app token', async () => {
    const set = vi.fn(async () => {});
    setFakeNativeModule('OmwTokenVault', { get: async () => null, set, clear: async () => {} });
    const m = await load();
    await expect(m.TokenVault.set('hunter2')).rejects.toThrow(RangeError);
    const token = `omw_${'x'.repeat(43)}`;
    await m.TokenVault.set(token);
    expect(set).toHaveBeenCalledWith(token);
  });
});

describe('haptic()', () => {
  it('throttles to one effect per 100 ms and honours the in-app switch', async () => {
    const perform = vi.fn(async () => true);
    setFakeNativeModule('OmwHaptics', { perform });
    const m = await load();
    expect(await m.haptic('VIRTUAL_KEY', 1000)).toBe(true);
    expect(await m.haptic('VIRTUAL_KEY', 1050)).toBe(false);
    expect(await m.haptic('CONFIRM', 1100)).toBe(true);
    m.setHapticsEnabled(false);
    expect(await m.haptic('CONFIRM', 2000)).toBe(false);
    m.setHapticsEnabled(true);
    expect(perform).toHaveBeenCalledTimes(2);
    expect(perform).toHaveBeenLastCalledWith('CONFIRM');
  });

  it('stays silent while suppressed (recording), nested', async () => {
    const perform = vi.fn(async () => true);
    setFakeNativeModule('OmwHaptics', { perform });
    const m = await load();
    const endA = m.suppressHaptics();
    const endB = m.suppressHaptics();
    expect(await m.haptic('SEGMENT_TICK', 0)).toBe(false);
    endA();
    endA();
    expect(await m.haptic('SEGMENT_TICK', 200)).toBe(false);
    endB();
    expect(await m.haptic('SEGMENT_TICK', 400)).toBe(true);
  });

  it('swallows native errors (unknown constant, no activity)', async () => {
    setFakeNativeModule('OmwHaptics', { perform: async () => Promise.reject(new Error('ERR_UNKNOWN_HAPTIC')) });
    const m = await load();
    expect(await m.haptic('REJECT', 0)).toBe(false);
  });

  it('names exactly the constants the Kotlin HapticMap knows', async () => {
    const { readFileSync } = await import('node:fs');
    const kotlin = readFileSync(
      new URL('../modules/omw-native/android/src/main/java/app/omw/omwnative/HapticMap.kt', import.meta.url),
      'utf8',
    );
    const block = /NAMES: List<String> = listOf\(([\s\S]*?)\)/.exec(kotlin)?.[1] ?? '';
    const names = [...block.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
    expect(names).toEqual([...HAPTIC_CONSTANTS]);
  });
});

const KOTLIN = new URL('../modules/omw-native/android/src/', import.meta.url);

async function kotlin(path: string): Promise<string> {
  const { readFileSync } = await import('node:fs');
  return readFileSync(new URL(path, KOTLIN), 'utf8');
}

describe('Uploader', () => {
  it('configure sends only the API base and needs the native side', async () => {
    let m = await load();
    await expect(m.Uploader.configure({ apiBaseUrl: 'https://api.example.org' })).rejects.toThrow(
      m.NativeUnavailableError,
    );
    const configure = vi.fn(async () => {});
    setFakeNativeModule('OmwUploader', { configure });
    m = await load();
    await m.Uploader.configure({ apiBaseUrl: 'http://127.0.0.1:8080', extra: 'ignored' } as never);
    expect(configure).toHaveBeenCalledWith({ apiBaseUrl: 'http://127.0.0.1:8080' });
  });

  it('passes uploadNow and status through, with fallbacks', async () => {
    const uploadNow = vi.fn(async () => 2);
    const status = vi.fn(async () => []);
    setFakeNativeModule('OmwUploader', { uploadNow, status });
    const m = await load();
    expect(await m.Uploader.uploadNow({ allowMetered: true })).toBe(2);
    expect(uploadNow).toHaveBeenCalledWith({ allowMetered: true });
    await m.Uploader.status();
    expect(status).toHaveBeenCalledWith(null);
  });

  it('withdraw needs the native side (the outbox keeps the withdrawal until it has it)', async () => {
    let m = await load();
    await expect(m.Uploader.withdraw('01JD0000000000000000000001')).rejects.toThrow(m.NativeUnavailableError);
    const withdraw = vi.fn(async () => true);
    setFakeNativeModule('OmwUploader', { withdraw });
    m = await load();
    expect(await m.Uploader.withdraw('01JD0000000000000000000001')).toBe(true);
    expect(withdraw).toHaveBeenCalledWith('01JD0000000000000000000001');
  });

  it('the bridge has every function the facade calls', async () => {
    const bridge = await kotlin('expo/java/app/omw/omwnative/OmwUploaderModule.kt');
    const names = [...bridge.matchAll(/AsyncFunction\("([a-zA-Z]+)"\)/g)].map((x) => x[1]);
    expect(names).toEqual(
      expect.arrayContaining([
        'configure',
        'getSettings',
        'setSettings',
        'enqueue',
        'cancel',
        'withdraw',
        'uploadNow',
        'status',
      ]),
    );
  });
});

describe('uploadEntryStatus (API.md mapping onto APP_ENTRY_STATUSES)', () => {
  const base: UploadStatus = {
    entryId: '01JD0000000000000000000001',
    state: 'waiting',
    sentBytes: 0,
    totalBytes: 1000,
    blockedBy: null,
    error: null,
    updatedAt: '2026-11-20T10:00:00.000Z',
    original: null,
  };
  it.each([
    ['queued', null, 'uploading'],
    ['uploading', null, 'uploading'],
    ['committing', null, 'uploading'],
    ['uploaded', null, 'uploaded'],
    ['failed', null, 'needs_you'],
    ['failed', 'unauthorized', 'needs_you'],
    ['waiting', 'manual', 'ready'],
    ['waiting', 'no_network', 'waiting_network'],
    ['waiting', 'not_validated', 'waiting_network'],
    ['waiting', 'backoff', 'waiting_network'],
    ['waiting', 'server_busy', 'waiting_network'],
    ['waiting', 'inbox_full', 'waiting_network'],
    ['waiting', 'wifi_only', 'waiting_wifi'],
    ['waiting', 'roaming', 'waiting_roaming'],
    ['cancelled', null, null],
  ] as const)('%s / %s -> %s', (state, blockedBy, expected) => {
    expect(uploadEntryStatus({ ...base, state, blockedBy })).toBe(expected);
  });

  it('computes the artifact percentage', () => {
    expect(uploadPercent({ ...base, sentBytes: 421, totalBytes: 1000 })).toBe(42);
    expect(uploadPercent({ ...base, state: 'uploaded', totalBytes: 0 })).toBe(100);
    expect(uploadPercent({ ...base, totalBytes: 0 })).toBe(0);
  });
});

describe('the Kotlin side speaks the same vocabulary', () => {
  it('every blockedBy the engine writes is an UploadBlock', async () => {
    const engine =
      (await kotlin('main/java/app/omw/omwnative/UploadEngine.kt')) +
      (await kotlin('main/java/app/omw/omwnative/UploadRules.kt'));
    const written = new Set([...engine.matchAll(/(?:return|->|failure\(|backoff\()\s*"([a-z_]+)"/g)].map((x) => x[1]));
    for (const block of [
      'manual',
      'unauthorized',
      'no_network',
      'not_validated',
      'wifi_only',
      'roaming',
      'server_busy',
      'inbox_full',
      'backoff',
    ]) {
      expect(written.has(block) || engine.includes(`"${block}"`)).toBe(true);
      expect(UPLOAD_BLOCKS).toContain(block);
    }
  });

  it('every export error code Kotlin rejects with is an ExportErrorCode', async () => {
    const src =
      (await kotlin('main/java/app/omw/omwnative/MediaExport.kt')) +
      (await kotlin('expo/java/app/omw/omwnative/OmwMediaExportModule.kt'));
    const codes = new Set([...src.matchAll(/"(ERR_[A-Z_]+)"/g)].map((x) => x[1]));
    expect(codes.size).toBeGreaterThan(5);
    for (const code of codes) expect(EXPORT_ERROR_CODES).toContain(code);
  });
});
