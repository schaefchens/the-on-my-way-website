import { describe, expect, it } from 'vitest';
import {
  addDays,
  compareDates,
  dateRange,
  daysBetween,
  isValidLocalDate,
  isValidTimeZone,
  localDateFor,
  localTimeFor,
  toIsoUtc,
  utcOffsetMinutes,
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
