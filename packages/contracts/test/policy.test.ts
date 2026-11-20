import { describe, expect, it } from 'vitest';
import type { Visibility } from '../src/common.js';
import {
  capturePublishAt,
  effectiveCaptureVisibility,
  effectiveLocalDate,
  effectivePostVisibility,
  effectiveTz,
  MODE_SINCE_EPOCH,
  modeForCapture,
  overlappingTrips,
  type PolicySettings,
  tripForDate,
  tripRangesOverlap,
} from '../src/policy.js';

const occurredAt = '2026-11-18T02:00:00Z';
const settings = (
  mode: PolicySettings['publish.mode'],
  onRevoke: PolicySettings['ingest.on_revoke'] = 'hide',
  delay = 720,
): PolicySettings => ({ 'publish.mode': mode, 'publish.delay_minutes': delay, 'ingest.on_revoke': onRevoke });

const before = '2026-11-18T13:59:59Z'; // 11h59m59s after occurredAt
const atDelay = '2026-11-18T14:00:00Z'; // exactly 12h after
const after = '2026-11-19T00:00:00Z';

describe('effectiveCaptureVisibility (D11)', () => {
  type Row = [
    name: string,
    mode: PolicySettings['publish.mode'],
    onRevoke: PolicySettings['ingest.on_revoke'],
    revoked: boolean,
    override: Visibility | null,
    now: string,
    expected: Visibility,
  ];
  const rows: Row[] = [
    // no override, not revoked
    ['instant', 'instant', 'hide', false, null, before, 'public'],
    ['delayed before', 'delayed', 'hide', false, null, before, 'pending'],
    ['delayed exactly at delay', 'delayed', 'hide', false, null, atDelay, 'public'],
    ['delayed after', 'delayed', 'hide', false, null, after, 'public'],
    ['review', 'review', 'hide', false, null, after, 'pending'],
    // revoked
    ['revoked+hide instant', 'instant', 'hide', true, null, after, 'hidden'],
    ['revoked+hide delayed', 'delayed', 'hide', true, null, after, 'hidden'],
    ['revoked+hide review', 'review', 'hide', true, null, after, 'hidden'],
    ['revoked+keep instant', 'instant', 'keep', true, null, after, 'public'],
    ['revoked+keep delayed before', 'delayed', 'keep', true, null, before, 'pending'],
    ['revoked+keep review', 'review', 'keep', true, null, after, 'pending'],
    // owner override always wins
    ['override public over review', 'review', 'hide', false, 'public', before, 'public'],
    ['override public over revoked+hide', 'instant', 'hide', true, 'public', after, 'public'],
    ['override hidden over instant', 'instant', 'hide', false, 'hidden', after, 'hidden'],
    ['override pending over instant', 'instant', 'hide', false, 'pending', after, 'pending'],
    ['override public over delayed before', 'delayed', 'hide', false, 'public', before, 'public'],
  ];

  it.each(rows)('%s', (_name, mode, onRevoke, revoked, override, now, expected) => {
    const capture = { occurredAt, revokedAt: revoked ? '2026-11-18T03:00:00Z' : null };
    const annotation = override === null ? { visibility: null } : { visibility: override };
    expect(effectiveCaptureVisibility(capture, annotation, settings(mode, onRevoke), now)).toBe(expected);
  });

  it('treats a missing annotation like no override', () => {
    expect(effectiveCaptureVisibility({ occurredAt }, null, settings('review'), after)).toBe('pending');
    expect(effectiveCaptureVisibility({ occurredAt }, undefined, settings('instant'), after)).toBe('public');
  });

  it('accepts Date and epoch "now" and a zero/negative delay', () => {
    expect(effectiveCaptureVisibility({ occurredAt }, null, settings('delayed'), new Date(before))).toBe('pending');
    expect(effectiveCaptureVisibility({ occurredAt }, null, settings('delayed'), Date.parse(atDelay))).toBe('public');
    expect(effectiveCaptureVisibility({ occurredAt }, null, settings('delayed', 'hide', 0), occurredAt)).toBe('public');
    expect(effectiveCaptureVisibility({ occurredAt }, null, settings('delayed', 'hide', -5), occurredAt)).toBe(
      'public',
    );
  });

  it('throws on invalid instants', () => {
    expect(() => effectiveCaptureVisibility({ occurredAt: 'x' }, null, settings('delayed'), after)).toThrow(RangeError);
  });
});

describe('capturePublishAt', () => {
  it('returns the instant the capture becomes public', () => {
    expect(capturePublishAt({ occurredAt }, null, settings('instant'))).toBe('2026-11-18T02:00:00.000Z');
    expect(capturePublishAt({ occurredAt }, null, settings('delayed'))).toBe('2026-11-18T14:00:00.000Z');
    expect(capturePublishAt({ occurredAt }, null, settings('review'))).toBeNull();
    expect(capturePublishAt({ occurredAt, revokedAt: after }, null, settings('instant'))).toBeNull();
    expect(capturePublishAt({ occurredAt }, { visibility: 'hidden' }, settings('instant'))).toBeNull();
    expect(capturePublishAt({ occurredAt }, { visibility: 'public' }, settings('review'))).toBe(
      '2026-11-18T02:00:00.000Z',
    );
  });
});

describe('publish.mode_since: mode switches only affect newer captures', () => {
  const since = '2026-11-18T12:00:00Z';
  const withSince = (mode: PolicySettings['publish.mode']): PolicySettings => ({
    ...settings(mode),
    'publish.mode_since': since,
  });
  const older = { occurredAt: '2026-11-18T11:59:59Z' };
  const newer = { occurredAt: '2026-11-18T12:00:00Z' };

  it('keeps older captures public when switching to review or delayed', () => {
    expect(effectiveCaptureVisibility(older, null, withSince('review'), after)).toBe('public');
    expect(effectiveCaptureVisibility(newer, null, withSince('review'), after)).toBe('pending');
    expect(effectiveCaptureVisibility(older, null, withSince('delayed'), '2026-11-18T12:00:01Z')).toBe('public');
    expect(effectiveCaptureVisibility(newer, null, withSince('delayed'), '2026-11-18T12:00:01Z')).toBe('pending');
    expect(modeForCapture(older, withSince('review'))).toBe('instant');
    expect(modeForCapture(newer, withSince('review'))).toBe('review');
  });

  it('defaults to the epoch and still honours overrides and revokes', () => {
    expect(MODE_SINCE_EPOCH).toBe('1970-01-01T00:00:00.000Z');
    expect(effectiveCaptureVisibility(older, null, settings('review'), after)).toBe('pending');
    expect(effectiveCaptureVisibility(older, { visibility: 'hidden' }, withSince('review'), after)).toBe('hidden');
    expect(effectiveCaptureVisibility({ ...older, revokedAt: after }, null, withSince('review'), after)).toBe('hidden');
    expect(capturePublishAt(older, null, withSince('review'))).toBe('2026-11-18T11:59:59.000Z');
    expect(capturePublishAt(newer, null, withSince('review'))).toBeNull();
  });

  it('rejects an invalid mode_since', () => {
    expect(() =>
      effectiveCaptureVisibility(older, null, { ...settings('review'), 'publish.mode_since': 'x' }, after),
    ).toThrow(RangeError);
  });
});

describe('posts and placement', () => {
  it('posts carry their own visibility', () => {
    expect(effectivePostVisibility({ visibility: 'hidden' })).toBe('hidden');
    expect(effectivePostVisibility({ visibility: 'public' })).toBe('public');
  });

  // 2026-11-15T18:30Z is 01:30 on the 16th in Ho Chi Minh City, 19:30 on the 15th in Berlin
  const item = { occurredAt: '2026-11-15T18:30:00Z', tz: 'Asia/Ho_Chi_Minh', localDate: '2026-11-16' };

  it('localDateOverride wins over the capture local date and any day tz fix', () => {
    expect(effectiveLocalDate(item, null)).toBe('2026-11-16');
    expect(effectiveLocalDate(item, { localDateOverride: null })).toBe('2026-11-16');
    expect(effectiveLocalDate(item, { localDateOverride: '2026-11-17' })).toBe('2026-11-17');
    expect(effectiveLocalDate(item, { localDateOverride: '2026-11-17' }, 'Europe/Berlin')).toBe('2026-11-17');
    expect(effectiveTz(item, { localDateOverride: '2026-11-17' }, 'Europe/Berlin')).toBe('Asia/Ho_Chi_Minh');
  });

  it('a day tz fix re-dates the item in that zone (may move it to another day)', () => {
    expect(effectiveLocalDate(item, null, 'Europe/Berlin')).toBe('2026-11-15');
    expect(effectiveTz(item, null, 'Europe/Berlin')).toBe('Europe/Berlin');
    expect(effectiveLocalDate(item, null, 'Asia/Bangkok')).toBe('2026-11-16');
    expect(effectiveTz(item, null, null)).toBe('Asia/Ho_Chi_Minh');
  });
});

describe('trips', () => {
  const vietnam = { slug: 'vietnam-2026', startDate: '2026-11-14', endDate: '2026-11-17' };
  const berlin = { slug: 'berlin', startDate: '2026-11-01', endDate: '2026-11-12' };
  const trips = [vietnam, berlin];

  it('tripForDate uses the inclusive date ranges', () => {
    expect(tripForDate('2026-11-14', trips)).toBe('vietnam-2026');
    expect(tripForDate('2026-11-17', trips)).toBe('vietnam-2026');
    expect(tripForDate('2026-11-13', trips)).toBeNull();
    expect(tripForDate('2026-11-01', trips)).toBe('berlin');
    expect(tripForDate('2026-11-14', [])).toBeNull();
  });

  it('resolves (forbidden) overlaps deterministically and detects them', () => {
    const overlap = [...trips, { slug: 'a-hoi-an', startDate: '2026-11-15', endDate: '2026-11-16' }];
    expect(tripForDate('2026-11-15', overlap)).toBe('vietnam-2026'); // earlier start wins
    expect(tripForDate('2026-11-15', [...overlap].reverse())).toBe('vietnam-2026');
    expect(tripRangesOverlap(vietnam, berlin)).toBe(false);
    expect(overlappingTrips({ slug: 'a-hoi-an', startDate: '2026-11-12', endDate: '2026-11-15' }, trips)).toEqual([
      'berlin',
      'vietnam-2026',
    ]);
    expect(overlappingTrips({ ...vietnam, endDate: '2026-11-18' }, trips)).toEqual([]);
  });
});
