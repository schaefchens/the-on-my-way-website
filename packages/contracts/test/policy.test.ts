import { describe, expect, it } from 'vitest';
import type { Visibility } from '../src/common.js';
import {
  capturePublishAt,
  effectiveCaptureVisibility,
  effectiveLocalDate,
  effectivePostVisibility,
  effectiveTz,
  entryReleaseAt,
  type HoldDay,
  holdEndAt,
  leftPlaceAt,
  MODE_SINCE_EPOCH,
  modeForCapture,
  nextModeSince,
  nextReleaseSlot,
  overlappingTrips,
  type PolicySettings,
  placeKey,
  portraitReleaseAt,
  publishedTrips,
  type ReleaseSettings,
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

describe('nextModeSince (PHP Policy::nextModeSince)', () => {
  const s = (mode: PolicySettings['publish.mode'], delay: number, since: string = MODE_SINCE_EPOCH) => ({
    'publish.mode': mode,
    'publish.delay_minutes': delay,
    'publish.mode_since': since,
  });
  const t = '2026-11-20T10:00:00.000Z';

  it('moves the cut-off only where a switch could otherwise unpublish or release', () => {
    expect(nextModeSince(s('instant', 60), s('delayed', 60), t)).toBe(t);
    expect(nextModeSince(s('instant', 60), s('review', 60), t)).toBe(t);
    expect(nextModeSince(s('instant', 60), s('instant', 120), t)).toBe(MODE_SINCE_EPOCH);
    expect(nextModeSince(s('delayed', 60), s('review', 60), t)).toBe('2026-11-20T09:00:00.001Z');
    expect(nextModeSince(s('delayed', 60, '2026-11-20T09:30:00Z'), s('review', 60), t)).toBe(
      '2026-11-20T09:30:00.000Z',
    );
    expect(nextModeSince(s('delayed', 0), s('review', 0), t)).toBe('2026-11-20T10:00:00.001Z');
    expect(nextModeSince(s('delayed', 60), s('delayed', 120), t)).toBe('2026-11-20T09:00:00.001Z');
    expect(nextModeSince(s('delayed', 60), s('delayed', 60), t)).toBe(MODE_SINCE_EPOCH);
    expect(nextModeSince(s('delayed', 60), s('instant', 60), t)).toBe(MODE_SINCE_EPOCH);
    expect(nextModeSince(s('review', 60, '2026-11-17T10:00:00Z'), s('delayed', 30), t)).toBe(
      '2026-11-17T10:00:00.000Z',
    );
    expect(nextModeSince({ 'publish.mode': 'review', 'publish.delay_minutes': 60 }, s('delayed', 60), t)).toBe(
      MODE_SINCE_EPOCH,
    );
  });

  it('review -> delayed releases exactly the waiting statuses older than the new delay', () => {
    const before = { ...s('review', 720, '2026-11-17T10:00:00.000Z'), 'ingest.on_revoke': 'hide' as const };
    const patch = { 'publish.mode': 'delayed' as const, 'publish.delay_minutes': 360 };
    const after = { ...before, ...patch, 'publish.mode_since': nextModeSince(before, patch, t) };
    const vis = (at: string, st: PolicySettings) => effectiveCaptureVisibility({ occurredAt: at }, null, st, t);
    const cases: [string, Visibility, Visibility][] = [
      ['2026-11-17T09:59:59.999Z', 'public', 'public'], // before review began: instant
      ['2026-11-19T22:00:00.000Z', 'pending', 'public'], // 12 h old
      ['2026-11-20T04:00:00.000Z', 'pending', 'public'], // exactly the new delay
      ['2026-11-20T04:00:00.001Z', 'pending', 'pending'], // 1 ms younger than the delay
      ['2026-11-20T09:59:00.000Z', 'pending', 'pending'],
    ];
    for (const [at, was, is] of cases) {
      expect(vis(at, before), at).toBe(was);
      expect(vis(at, after), at).toBe(is);
    }
    // ...and the younger ones follow the delay from then on.
    expect(
      effectiveCaptureVisibility({ occurredAt: '2026-11-20T09:59:00.000Z' }, null, after, '2026-11-20T15:59:00Z'),
    ).toBe('public');
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

  it('publishedTrips: only trips with at least one public day (planned trips stay off the site)', () => {
    const planned = { slug: 'japan-2027', startDate: '2027-03-01', endDate: '2027-03-20' };
    const all = [berlin, vietnam, planned];
    expect(publishedTrips(all, ['2026-11-15', '2026-11-20'])).toEqual([vietnam]);
    expect(publishedTrips(all, ['2026-11-01', '2027-03-20'])).toEqual([berlin, planned]);
    expect(publishedTrips(all, [])).toEqual([]);
    // A day of overlapping (forbidden) ranges counts for the trip tripForDate() picks.
    const overlap = { slug: 'a-hoi-an', startDate: '2026-11-15', endDate: '2026-11-16' };
    expect(publishedTrips([...all, overlap], ['2026-11-15'])).toEqual([vietnam]);
  });
});

describe('release slots (Q1, publish.release_slots)', () => {
  const twice = { enabled: true, times: ['08:00', '20:00'] };
  const berlin = 'Europe/Berlin';

  it('off (or no times): the instant itself, canonical ISO', () => {
    expect(nextReleaseSlot('2026-11-20T10:17:33Z', { enabled: false, times: ['08:00'] }, berlin)).toBe(
      '2026-11-20T10:17:33.000Z',
    );
    expect(nextReleaseSlot('2026-11-20T10:17:33.5Z', { enabled: true, times: [] }, berlin)).toBe(
      '2026-11-20T10:17:33.500Z',
    );
  });

  it('the first slot at or after the instant, in wall-clock time of the zone', () => {
    // 08:00 Berlin in November = 07:00Z; 20:00 = 19:00Z.
    expect(nextReleaseSlot('2026-11-20T06:59:59.999Z', twice, berlin)).toBe('2026-11-20T07:00:00.000Z');
    expect(nextReleaseSlot('2026-11-20T07:00:00.000Z', twice, berlin)).toBe('2026-11-20T07:00:00.000Z');
    expect(nextReleaseSlot('2026-11-20T07:00:00.001Z', twice, berlin)).toBe('2026-11-20T19:00:00.000Z');
    expect(nextReleaseSlot('2026-11-20T19:00:00.001Z', twice, berlin)).toBe('2026-11-21T07:00:00.000Z');
    // 00:30 Berlin on the 21st is still "after 20:00 on the 20th" in UTC terms.
    expect(nextReleaseSlot('2026-11-20T23:30:00Z', twice, berlin)).toBe('2026-11-21T07:00:00.000Z');
    // The traveler's zone, not Berlin: 12:00 in Ho Chi Minh City = 05:00Z.
    expect(nextReleaseSlot('2026-11-15T05:00:01Z', { enabled: true, times: ['12:00'] }, 'Asia/Ho_Chi_Minh')).toBe(
      '2026-11-16T05:00:00.000Z',
    );
  });

  it('DST: a slot in the gap fires at the transition, an ambiguous slot at the earlier instant only', () => {
    const at0230 = { enabled: true, times: ['02:30'] };
    expect(nextReleaseSlot('2026-03-28T23:00:00Z', at0230, berlin)).toBe('2026-03-29T01:00:00.000Z');
    expect(nextReleaseSlot('2026-10-24T22:00:00Z', at0230, berlin)).toBe('2026-10-25T00:30:00.000Z');
    // After the first 02:30 the second one (CET) is not a slot: the next is the following day.
    expect(nextReleaseSlot('2026-10-25T00:30:00.001Z', at0230, berlin)).toBe('2026-10-26T01:30:00.000Z');
    expect(nextReleaseSlot('2026-03-08T05:00:00Z', at0230, 'America/New_York')).toBe('2026-03-08T07:00:00.000Z');
  });

  it('crosses a skipped calendar day', () => {
    expect(nextReleaseSlot('2011-12-29T20:00:00Z', { enabled: true, times: ['08:00'] }, 'Pacific/Apia')).toBe(
      '2011-12-30T10:00:00.000Z',
    );
  });
});

describe('departure hold (Q1, publish.departure_hold / publish.moved_on_at)', () => {
  const base: ReleaseSettings = {
    'publish.release_slots': { enabled: false, times: ['08:00', '20:00'] },
    'publish.departure_hold': { enabled: false, maxDays: 7 },
    'timezone.current': 'Europe/Berlin',
  };
  const hold = (maxDays = 7, movedOn?: string): ReleaseSettings => ({
    ...base,
    'publish.departure_hold': { enabled: true, maxDays },
    ...(movedOn ? { 'publish.moved_on_at': movedOn } : {}),
  });
  const entryAt = '2026-11-15T02:12:00Z';

  it('placeKey normalises place names', () => {
    expect(placeKey('Hội An ')).toBe('hội an');
    expect(placeKey('  Hội   An ')).toBe('hội an');
    expect(placeKey('Ho\u0302\u0323i An')).toBe(placeKey('Hội An')); // decomposed = composed (NFC)
    expect(placeKey('SAIGON')).toBe('saigon');
    expect(placeKey('   ')).toBeNull();
    expect(placeKey('')).toBeNull();
    expect(placeKey(null)).toBeNull();
    expect(placeKey(undefined)).toBeNull();
  });

  it('leftPlaceAt: first item of the next later date at ANOTHER known place', () => {
    const days: HoldDay[] = [
      { date: '2026-11-16', place: 'hội an', firstAt: '2026-11-16T00:30:00Z' },
      { date: '2026-11-14', place: 'Hanoi', firstAt: '2026-11-14T01:00:00Z' },
      { date: '2026-11-15', place: 'Hội An ', firstAt: '2026-11-15T02:12:00Z' },
      { date: '2026-11-17', place: null, firstAt: '2026-11-17T03:00:00Z' },
      { date: '2026-11-18', place: 'Saigon', firstAt: '2026-11-18T04:00:00Z' },
    ];
    expect(Object.fromEntries(leftPlaceAt(days))).toEqual({
      '2026-11-14': '2026-11-15T02:12:00.000Z',
      '2026-11-15': '2026-11-18T04:00:00.000Z', // the next day is the same place, the place-less day does not count
      '2026-11-16': '2026-11-18T04:00:00.000Z',
      '2026-11-17': null, // no place: never "left"
      '2026-11-18': null, // nothing later
    });
    expect(leftPlaceAt([]).size).toBe(0);
  });

  it('holdEndAt = min(entry + maxDays, moved on (not before the entry), left)', () => {
    expect(holdEndAt(entryAt, '2026-11-18T04:00:00Z', base)).toBeNull();
    expect(holdEndAt(entryAt, null, hold())).toBe('2026-11-22T02:12:00.000Z');
    expect(holdEndAt(entryAt, null, hold(1))).toBe('2026-11-16T02:12:00.000Z');
    expect(holdEndAt(entryAt, '2026-11-18T04:00:00Z', hold())).toBe('2026-11-18T04:00:00.000Z');
    expect(holdEndAt(entryAt, '2026-11-30T04:00:00Z', hold())).toBe('2026-11-22T02:12:00.000Z');
    expect(holdEndAt(entryAt, null, hold(7, '2026-11-16T10:00:00.000Z'))).toBe('2026-11-16T10:00:00.000Z');
    expect(holdEndAt(entryAt, null, hold(7, entryAt))).toBe('2026-11-15T02:12:00.000Z');
    // A "moved on" tap BEFORE the entry is about an earlier place: it does not end this hold.
    expect(holdEndAt(entryAt, null, hold(7, '2026-11-15T02:11:59.999Z'))).toBe('2026-11-22T02:12:00.000Z');
  });

  it('entryReleaseAt = the next slot after max(publishAt, holdEnd)', () => {
    const slotted: ReleaseSettings = { ...base, 'publish.release_slots': { enabled: true, times: ['08:00', '20:00'] } };
    expect(entryReleaseAt(null, null, slotted)).toBeNull();
    expect(entryReleaseAt(entryAt, null, base)).toBe('2026-11-15T02:12:00.000Z');
    expect(entryReleaseAt(entryAt, null, slotted)).toBe('2026-11-15T07:00:00.000Z');
    expect(entryReleaseAt(entryAt, '2026-11-18T04:00:00.000Z', base)).toBe('2026-11-18T04:00:00.000Z');
    expect(entryReleaseAt(entryAt, '2026-11-18T04:00:00.000Z', slotted)).toBe('2026-11-18T07:00:00.000Z');
    // A hold that ended before the (delayed) publish instant does not pull it earlier.
    expect(entryReleaseAt('2026-11-20T09:00:00Z', '2026-11-18T04:00:00.000Z', slotted)).toBe(
      '2026-11-20T19:00:00.000Z',
    );
  });
});

describe('portraitReleaseAt (P0: the portrait never bypasses the delay)', () => {
  const release: ReleaseSettings = {
    'publish.release_slots': { enabled: false, times: ['08:00'] },
    'publish.departure_hold': { enabled: false, maxDays: 7 },
    'timezone.current': 'Europe/Berlin',
  };
  const s = (mode: PolicySettings['publish.mode'], onRevoke: PolicySettings['ingest.on_revoke'] = 'hide') => ({
    ...settings(mode, onRevoke),
    ...release,
  });
  const capture = { occurredAt, revokedAt: null };

  it('follows the publish mode, except that review mode treats the pick as the review', () => {
    expect(portraitReleaseAt(capture, null, s('instant'), null)).toBe('2026-11-18T02:00:00.000Z');
    expect(portraitReleaseAt(capture, null, s('delayed'), null)).toBe('2026-11-18T14:00:00.000Z');
    expect(portraitReleaseAt(capture, null, s('review'), null)).toBe('2026-11-18T02:00:00.000Z');
  });

  it('overrides: pending blocks, public releases at once, hidden is ignored', () => {
    expect(portraitReleaseAt(capture, { visibility: 'pending' }, s('instant'), null)).toBeNull();
    expect(portraitReleaseAt(capture, { visibility: 'public' }, s('delayed'), null)).toBe('2026-11-18T02:00:00.000Z');
    expect(portraitReleaseAt(capture, { visibility: 'hidden' }, s('delayed'), null)).toBe('2026-11-18T14:00:00.000Z');
  });

  it('a revoked photo is never the portrait when revokes hide', () => {
    const revoked = { occurredAt, revokedAt: '2026-11-18T03:00:00Z' };
    expect(portraitReleaseAt(revoked, null, s('instant', 'hide'), null)).toBeNull();
    expect(portraitReleaseAt(revoked, { visibility: 'public' }, s('instant', 'hide'), null)).toBeNull();
    expect(portraitReleaseAt(revoked, null, s('instant', 'keep'), null)).toBe('2026-11-18T02:00:00.000Z');
  });

  it('waits for the departure hold and the next release slot', () => {
    const slotted = { ...s('delayed'), 'publish.release_slots': { enabled: true, times: ['08:00', '20:00'] } };
    // Delayed 12 h -> 14:00Z = 15:00 Berlin -> next slot 20:00 Berlin = 19:00Z.
    expect(portraitReleaseAt(capture, null, slotted, null)).toBe('2026-11-18T19:00:00.000Z');
    // A hold ending the next morning -> 08:00 Berlin on the 19th = 07:00Z.
    expect(portraitReleaseAt(capture, null, slotted, '2026-11-19T06:00:00.000Z')).toBe('2026-11-19T07:00:00.000Z');
  });
});
