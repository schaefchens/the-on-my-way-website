import { describe, expect, it } from 'vitest';
import {
  addDays,
  coarsenToBucket,
  compareDates,
  dateRange,
  daysBetween,
  isValidLocalDate,
  isValidTimeZone,
  localDateFor,
  localTimeFor,
  MAX_BUCKET_INDEX,
  timeBucket,
  toIsoUtc,
  utcOffsetMinutes,
  zonedWallTimeToUtc,
} from '../src/time.js';

describe('localDateFor / localTimeFor', () => {
  it.each([
    // Asia/Ho_Chi_Minh is UTC+7 all year
    ['2026-11-15T16:59:59Z', 'Asia/Ho_Chi_Minh', '2026-11-15', '23:59'],
    ['2026-11-15T17:00:00Z', 'Asia/Ho_Chi_Minh', '2026-11-16', '00:00'],
    ['2026-11-15T18:30:00Z', 'Asia/Ho_Chi_Minh', '2026-11-16', '01:30'],
    // Europe/Berlin in winter (CET, UTC+1)
    ['2026-11-10T22:59:00Z', 'Europe/Berlin', '2026-11-10', '23:59'],
    ['2026-11-10T23:30:00Z', 'Europe/Berlin', '2026-11-11', '00:30'],
    // UTC
    ['2026-01-01T00:00:00Z', 'UTC', '2026-01-01', '00:00'],
    // Date line: Kiritimati is UTC+14, Pago Pago UTC-11 (same wall clock, 25 h apart in date)
    ['2026-11-18T10:00:00Z', 'Pacific/Kiritimati', '2026-11-19', '00:00'],
    ['2026-11-18T09:59:00Z', 'Pacific/Kiritimati', '2026-11-18', '23:59'],
    ['2026-11-18T10:00:00Z', 'Pacific/Pago_Pago', '2026-11-17', '23:00'],
    ['2026-11-18T11:00:00Z', 'Pacific/Pago_Pago', '2026-11-18', '00:00'],
    // Half/quarter hour zones
    ['2026-11-18T18:14:00Z', 'Asia/Kathmandu', '2026-11-18', '23:59'],
    ['2026-11-18T18:15:00Z', 'Asia/Kathmandu', '2026-11-19', '00:00'],
    ['2026-11-18T18:30:00Z', 'Asia/Kolkata', '2026-11-19', '00:00'],
  ])('%s in %s -> %s %s', (iso, tz, date, time) => {
    expect(localDateFor(iso, tz)).toBe(date);
    expect(localTimeFor(iso, tz)).toBe(time);
  });

  it('formats midnight as 00:xx, never 24:xx', () => {
    expect(localTimeFor('2026-06-30T22:05:00Z', 'Europe/Berlin')).toBe('00:05');
  });

  it('accepts Date and epoch input', () => {
    const d = new Date('2026-11-15T17:00:00Z');
    expect(localDateFor(d, 'Asia/Ho_Chi_Minh')).toBe('2026-11-16');
    expect(localDateFor(d.getTime(), 'Asia/Ho_Chi_Minh')).toBe('2026-11-16');
  });

  it('throws on invalid input', () => {
    expect(() => localDateFor('not a date', 'UTC')).toThrow(RangeError);
    expect(() => localDateFor('2026-11-15T17:00:00Z', 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('DST transitions', () => {
  it('Europe/Berlin spring forward (2026-03-29 02:00 -> 03:00)', () => {
    expect(localTimeFor('2026-03-29T00:59:00Z', 'Europe/Berlin')).toBe('01:59');
    expect(localTimeFor('2026-03-29T01:00:00Z', 'Europe/Berlin')).toBe('03:00');
    expect(utcOffsetMinutes('2026-03-29T00:59:00Z', 'Europe/Berlin')).toBe(60);
    expect(utcOffsetMinutes('2026-03-29T01:00:00Z', 'Europe/Berlin')).toBe(120);
    // 23:30 local on the transition day still belongs to that day
    expect(localDateFor('2026-03-29T21:30:00Z', 'Europe/Berlin')).toBe('2026-03-29');
    expect(localDateFor('2026-03-29T22:00:00Z', 'Europe/Berlin')).toBe('2026-03-30');
  });

  it('Europe/Berlin fall back (2026-10-25 03:00 -> 02:00, 02:xx happens twice)', () => {
    expect(localTimeFor('2026-10-25T00:30:00Z', 'Europe/Berlin')).toBe('02:30');
    expect(localTimeFor('2026-10-25T01:30:00Z', 'Europe/Berlin')).toBe('02:30');
    expect(utcOffsetMinutes('2026-10-25T00:30:00Z', 'Europe/Berlin')).toBe(120);
    expect(utcOffsetMinutes('2026-10-25T01:30:00Z', 'Europe/Berlin')).toBe(60);
    expect(localDateFor('2026-10-25T22:59:00Z', 'Europe/Berlin')).toBe('2026-10-25');
    expect(localDateFor('2026-10-25T23:00:00Z', 'Europe/Berlin')).toBe('2026-10-26');
  });

  it('America/New_York (2026-03-08 and 2026-11-01)', () => {
    expect(localDateFor('2026-03-08T04:59:00Z', 'America/New_York')).toBe('2026-03-07');
    expect(localDateFor('2026-03-08T05:00:00Z', 'America/New_York')).toBe('2026-03-08');
    expect(localTimeFor('2026-03-08T07:00:00Z', 'America/New_York')).toBe('03:00');
    expect(localDateFor('2026-11-02T03:59:00Z', 'America/New_York')).toBe('2026-11-01');
    expect(localDateFor('2026-11-02T05:00:00Z', 'America/New_York')).toBe('2026-11-02');
  });

  it('Southern hemisphere: Australia/Lord_Howe uses a 30 minute DST shift', () => {
    expect(utcOffsetMinutes('2026-01-15T00:00:00Z', 'Australia/Lord_Howe')).toBe(660);
    expect(utcOffsetMinutes('2026-07-15T00:00:00Z', 'Australia/Lord_Howe')).toBe(630);
  });
});

describe('isValidTimeZone', () => {
  it.each(['UTC', 'Europe/Berlin', 'Asia/Ho_Chi_Minh', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5'])(
    'accepts %s',
    (tz) => expect(isValidTimeZone(tz)).toBe(true),
  );
  it.each(['', 'Mars/Olympus', '+07:00', '-05:00', 'Europe/', 42, null, undefined])('rejects %s', (tz) =>
    expect(isValidTimeZone(tz)).toBe(false),
  );
});

describe('calendar date helpers', () => {
  it('addDays crosses months, years and leap days', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-11-18', 0)).toBe('2026-11-18');
    // a DST day is still exactly one calendar day
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
  });

  it('addDays rejects invalid input', () => {
    expect(() => addDays('2026-02-30', 1)).toThrow(RangeError);
    expect(() => addDays('2026-11-18', 0.5)).toThrow(RangeError);
  });

  it('compareDates / daysBetween / dateRange', () => {
    expect(compareDates('2026-11-17', '2026-11-18')).toBe(-1);
    expect(compareDates('2026-11-18', '2026-11-18')).toBe(0);
    expect(compareDates('2027-01-01', '2026-12-31')).toBe(1);
    expect(daysBetween('2026-11-14', '2026-11-17')).toBe(3);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(dateRange('2026-11-14', '2026-11-17')).toEqual(['2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17']);
    expect(dateRange('2026-11-17', '2026-11-14')).toEqual([]);
    const unsorted = ['2026-11-18', '2025-01-01', '2026-02-03'];
    expect([...unsorted].sort(compareDates)).toEqual(['2025-01-01', '2026-02-03', '2026-11-18']);
  });

  it('isValidLocalDate', () => {
    expect(isValidLocalDate('2028-02-29')).toBe(true);
    expect(isValidLocalDate('2026-02-29')).toBe(false);
    expect(isValidLocalDate('2026-13-01')).toBe(false);
    expect(isValidLocalDate('2026-1-01')).toBe(false);
    expect(isValidLocalDate(20261118)).toBe(false);
  });

  it('toIsoUtc canonicalises', () => {
    expect(toIsoUtc('2026-11-18T02:12:00Z')).toBe('2026-11-18T02:12:00.000Z');
    expect(toIsoUtc('2026-11-18T09:12:00+07:00')).toBe('2026-11-18T02:12:00.000Z');
    expect(() => toIsoUtc('nope')).toThrow(RangeError);
  });
});

describe('zonedWallTimeToUtc (release slots)', () => {
  it('maps a wall time to its instant in zones without a transition', () => {
    expect(zonedWallTimeToUtc('2026-11-20', '08:00', 'Europe/Berlin')).toBe('2026-11-20T07:00:00.000Z');
    expect(zonedWallTimeToUtc('2026-07-01', '08:00', 'Europe/Berlin')).toBe('2026-07-01T06:00:00.000Z');
    expect(zonedWallTimeToUtc('2026-11-15', '00:00', 'Asia/Ho_Chi_Minh')).toBe('2026-11-14T17:00:00.000Z');
    expect(zonedWallTimeToUtc('2026-11-18', '23:59', 'Asia/Kathmandu')).toBe('2026-11-18T18:14:00.000Z');
    expect(zonedWallTimeToUtc('2026-01-01', '00:00', 'UTC')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('a wall time in a spring-forward gap maps to the transition (the first instant after the gap)', () => {
    // Berlin 2026-03-29: 02:00 CET (01:00Z) jumps to 03:00 CEST.
    expect(zonedWallTimeToUtc('2026-03-29', '01:59', 'Europe/Berlin')).toBe('2026-03-29T00:59:00.000Z');
    expect(zonedWallTimeToUtc('2026-03-29', '02:00', 'Europe/Berlin')).toBe('2026-03-29T01:00:00.000Z');
    expect(zonedWallTimeToUtc('2026-03-29', '02:30', 'Europe/Berlin')).toBe('2026-03-29T01:00:00.000Z');
    expect(zonedWallTimeToUtc('2026-03-29', '03:00', 'Europe/Berlin')).toBe('2026-03-29T01:00:00.000Z');
    expect(zonedWallTimeToUtc('2026-03-29', '03:01', 'Europe/Berlin')).toBe('2026-03-29T01:01:00.000Z');
    // New York 2026-03-08: 02:00 EST (07:00Z) jumps to 03:00 EDT.
    expect(zonedWallTimeToUtc('2026-03-08', '02:30', 'America/New_York')).toBe('2026-03-08T07:00:00.000Z');
    // Lord Howe: a 30-minute shift (02:00 +10:30 -> 02:30 +11).
    expect(zonedWallTimeToUtc('2026-10-04', '02:15', 'Australia/Lord_Howe')).toBe('2026-10-03T15:30:00.000Z');
    // Samoa skipped 2011-12-30 entirely: the next instant is 2011-12-31 00:00 (+14).
    expect(zonedWallTimeToUtc('2011-12-30', '08:00', 'Pacific/Apia')).toBe('2011-12-30T10:00:00.000Z');
  });

  it('an ambiguous wall time (fall back) maps to the earlier instant', () => {
    // Berlin 2026-10-25: 03:00 CEST (01:00Z) falls back to 02:00 CET; 02:30 happens twice.
    expect(zonedWallTimeToUtc('2026-10-25', '02:30', 'Europe/Berlin')).toBe('2026-10-25T00:30:00.000Z');
    expect(zonedWallTimeToUtc('2026-10-25', '02:00', 'Europe/Berlin')).toBe('2026-10-25T00:00:00.000Z');
    expect(zonedWallTimeToUtc('2026-10-25', '03:00', 'Europe/Berlin')).toBe('2026-10-25T02:00:00.000Z');
    // New York 2026-11-01: 01:30 EDT (05:30Z) and 01:30 EST (06:30Z).
    expect(zonedWallTimeToUtc('2026-11-01', '01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
  });

  it('rejects invalid input', () => {
    expect(() => zonedWallTimeToUtc('2026-02-30', '08:00', 'Europe/Berlin')).toThrow(RangeError);
    expect(() => zonedWallTimeToUtc('2026-11-20', '8:00', 'Europe/Berlin')).toThrow(RangeError);
    expect(() => zonedWallTimeToUtc('2026-11-20', '24:00', 'Europe/Berlin')).toThrow(RangeError);
    expect(() => zonedWallTimeToUtc('2026-11-20', '08:00', 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('timeBucket / coarsenToBucket (site.time_precision = part_of_day)', () => {
  it('assigns every local hour to its 3-hour bucket and part of day', () => {
    const expected = ['night', 'night', 'morning', 'morning', 'midday', 'afternoon', 'evening', 'night'];
    for (let hour = 0; hour < 24; hour++) {
      // Ho Chi Minh City is UTC+7 without DST.
      const at = new Date(Date.UTC(2026, 10, 15, hour - 7, 59, 59)).toISOString();
      const bucket = timeBucket(at, 'Asia/Ho_Chi_Minh');
      expect(bucket.startHour, `${hour}:59`).toBe(Math.floor(hour / 3) * 3);
      expect(bucket.partOfDay, `${hour}:59`).toBe(expected[Math.floor(hour / 3)]);
    }
  });

  it('coarsens to the local bucket start plus index seconds, dropping milliseconds', () => {
    const tz = 'Asia/Ho_Chi_Minh';
    // 12:47:12.345 local -> 12:00:00 local (05:00Z) + index seconds.
    expect(coarsenToBucket('2026-11-15T05:47:12.345Z', tz, 0)).toBe('2026-11-15T05:00:00.000Z');
    expect(coarsenToBucket('2026-11-15T05:47:12.345Z', tz, 1)).toBe('2026-11-15T05:00:01.000Z');
    expect(coarsenToBucket('2026-11-15T07:59:59Z', tz, 2)).toBe('2026-11-15T05:00:02.000Z');
    // Local midnight starts a bucket; the minute before it belongs to the 21:00 bucket.
    expect(coarsenToBucket('2026-11-15T17:00:00Z', tz, 0)).toBe('2026-11-15T17:00:00.000Z');
    expect(coarsenToBucket('2026-11-15T16:59:59.999Z', tz, 0)).toBe('2026-11-15T14:00:00.000Z');
    // Quarter-hour offsets: Kathmandu is +05:45.
    expect(coarsenToBucket('2026-11-18T18:14:00Z', 'Asia/Kathmandu', 0)).toBe('2026-11-18T15:15:00.000Z');
  });

  it("keeps the order of a bucket's entries when the index follows (at, id)", () => {
    const tz = 'Europe/Berlin';
    // Fall back: 02:30 CEST (00:30Z) and 02:30 CET (01:30Z) share the 00:00 bucket.
    const ats = ['2026-10-24T22:10:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z'];
    const coarse = ats.map((at, i) => coarsenToBucket(at, tz, i));
    expect([...coarse].sort()).toEqual(coarse);
    expect(new Set(coarse).size).toBe(coarse.length);
    for (const c of coarse) expect(timeBucket(c, tz).startHour).toBe(0);
  });

  it('rejects an index outside 0..MAX_BUCKET_INDEX', () => {
    expect(MAX_BUCKET_INDEX).toBe(3599);
    expect(() => coarsenToBucket('2026-11-15T05:00:00Z', 'UTC', -1)).toThrow(RangeError);
    expect(() => coarsenToBucket('2026-11-15T05:00:00Z', 'UTC', 1.5)).toThrow(RangeError);
    expect(() => coarsenToBucket('2026-11-15T05:00:00Z', 'UTC', MAX_BUCKET_INDEX + 1)).toThrow(RangeError);
    expect(coarsenToBucket('2026-11-15T05:00:00Z', 'UTC', MAX_BUCKET_INDEX)).toBe('2026-11-15T03:59:59.000Z');
  });
});
