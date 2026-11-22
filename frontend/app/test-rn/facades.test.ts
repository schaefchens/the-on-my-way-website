import { describe, expect, it, jest } from '@jest/globals';
import { appPairingCodeFromLink, normalizeAppPairingCode } from '@omw/contracts/app';
import { HAPTIC_CONSTANTS } from '../modules/omw-native';
import { formatTypedInput } from '../src/app/pair';
import { meterLevel } from '../src/app/voice';
import { MAX_PREPARE_ATTEMPTS, newDraft, transition } from '../src/core/outbox-machine';
import { lockDue } from '../src/state/lock';
import { HAPTIC_MOMENTS } from '../src/ui/haptics';
import { oemFamily } from '../src/ui/oem-card';
import { ID, LATER, NOW } from './fixtures';

jest.mock('expo-router', () => ({ useRouter: () => ({}), useLocalSearchParams: () => ({}) }));

describe('haptics facade (app-plan §5.3)', () => {
  it('uses only Android’s own feedback constants, one meaning each', () => {
    for (const constant of Object.values(HAPTIC_MOMENTS)) expect(HAPTIC_CONSTANTS).toContain(constant);
    expect(HAPTIC_MOMENTS).toMatchObject({
      shutter: 'VIRTUAL_KEY',
      holdToRecord: 'LONG_PRESS',
      recordEnd: 'GESTURE_END',
      step: 'SEGMENT_TICK',
      threshold: 'GESTURE_THRESHOLD_ACTIVATE',
      thresholdBack: 'GESTURE_THRESHOLD_DEACTIVATE',
      confirm: 'CONFIRM',
      reject: 'REJECT',
      toggleOn: 'TOGGLE_ON',
      toggleOff: 'TOGGLE_OFF',
    });
  });
});

describe('app lock rule', () => {
  const base = {
    enabled: true,
    available: true,
    unlockedOnce: true,
    backgroundSince: null,
    afterSeconds: 300,
    now: 1_000_000,
  };
  it('asks after a cold start, and after the chosen time in the background', () => {
    expect(lockDue({ ...base, unlockedOnce: false })).toBe(true);
    expect(lockDue(base)).toBe(false);
    expect(lockDue({ ...base, backgroundSince: base.now - 299_000 })).toBe(false);
    expect(lockDue({ ...base, backgroundSince: base.now - 300_000 })).toBe(true);
    expect(lockDue({ ...base, afterSeconds: 0, backgroundSince: base.now - 1 })).toBe(true);
  });
  it('never asks when switched off or when the phone has no screen lock', () => {
    expect(lockDue({ ...base, enabled: false, unlockedOnce: false })).toBe(false);
    expect(lockDue({ ...base, available: false, unlockedOnce: false })).toBe(false);
  });
});

describe('pairing input', () => {
  it('formats while typing and forgives look-alikes', () => {
    expect(formatTypedInput('k7q2m9px')).toBe('K7Q2-M9PX');
    expect(formatTypedInput('k7q')).toBe('K7Q');
    expect(normalizeAppPairingCode(formatTypedInput('k7q2 m9pO'))).toBe('K7Q2M9P0');
  });
  it('takes only the code from an omw:// link (never a host)', () => {
    expect(appPairingCodeFromLink('omw://pair#01JD4Z8W3K5V7X9Y1Z3B5C7D9F')).toBe('01JD4Z8W3K5V7X9Y1Z3B5C7D9F');
    expect(appPairingCodeFromLink('https://evil.example/pair#01JD4Z8W3K5V7X9Y1Z3B5C7D9F')).toBeNull();
  });
});

describe('small rules', () => {
  it('names the phone family for the battery card', () => {
    expect(oemFamily('samsung', 'samsung')).toBe('samsung');
    expect(oemFamily('Redmi', 'Xiaomi')).toBe('xiaomi');
    expect(oemFamily('HONOR')).toBe('huawei');
    expect(oemFamily('OnePlus')).toBe('oppo');
    expect(oemFamily('google', 'Google')).toBe('other');
  });

  it('maps the voice meter from dBFS', () => {
    expect(meterLevel(0)).toBe(1);
    expect(meterLevel(-30)).toBeCloseTo(0.5);
    expect(meterLevel(-160)).toBe(0.05);
    expect(meterLevel(undefined)).toBe(0.05);
  });

  it('keeps a video "Preparing…" while the native export is missing (never gives up)', () => {
    let m = transition(
      newDraft({
        entryId: ID,
        kind: 'video',
        origin: 'camera',
        now: NOW,
        source: { name: 'source.mp4', mimetype: 'video/mp4', bytes: 9 },
      }),
      { type: 'share', at: NOW, tz: 'UTC' },
      LATER,
    ).next;
    for (let i = 0; i < MAX_PREPARE_ATTEMPTS + 3; i++) {
      m = transition(
        m,
        { type: 'prepare_failed', error: { code: 'ERR_NOT_IMPLEMENTED', message: 'later', permanent: false } },
        LATER,
      ).next;
    }
    expect(m.phase).toBe('preparing');
    expect(m.attempts).toBe(0);
  });
});
