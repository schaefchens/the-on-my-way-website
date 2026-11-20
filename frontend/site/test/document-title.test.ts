import type { DayDetail, Entry, TripDetail } from '@omw/contracts/site';
import { describe, expect, it } from 'vitest';
import { documentTitle, joinTitle } from '../src/document-title';

type StoryEntry = Extract<Entry, { kind: 'story' }>;

function dayDetail(extra: Partial<DayDetail> = {}): DayDetail {
  return {
    contractVersion: 1,
    date: '2026-11-15',
    v: 'abcd1234',
    tz: 'Asia/Bangkok',
    entries: [],
    ...extra,
  };
}

const trip: TripDetail = {
  contractVersion: 1,
  slug: 'suedostasien-2026',
  v: 'trip1234',
  title: { de: 'Südostasien', en: 'Southeast Asia' },
  orig: 'de',
  start: '2026-09-20',
  end: '2026-11-20',
  days: [],
};

const story: StoryEntry = {
  kind: 'story',
  id: 'p_abc123',
  at: '2026-11-15T10:00:00Z',
  tz: 'Asia/Bangkok',
  story: { de: { title: 'Ein langer Tag', body: '…' } },
  orig: 'de',
};

describe('documentTitle', () => {
  it('names the site on the timeline', () => {
    expect(documentTitle({ name: 'home' }, 'de', 'On My Way')).toBe('On My Way');
  });

  it('day: owner title plus short date, else the long date (like the generator)', () => {
    const titled = dayDetail({ title: { de: 'Laternen', en: 'Lanterns' }, orig: 'de' });
    expect(documentTitle({ name: 'day', day: titled }, 'de', 'OMW')).toBe('Laternen · 15. Nov. 2026 · OMW');
    expect(documentTitle({ name: 'day', day: titled }, 'en', 'OMW')).toBe('Lanterns · 15 Nov 2026 · OMW');
    expect(documentTitle({ name: 'day', day: dayDetail() }, 'de', 'OMW')).toBe('Sonntag, 15. November 2026 · OMW');
  });

  it('story: the title in the locale, falling back to the original', () => {
    expect(documentTitle({ name: 'story', story, date: '2026-11-15' }, 'en', 'OMW')).toBe('Ein langer Tag · OMW');
    const untitled = { ...story, story: {} };
    // (ICU versions differ on the comma after the weekday in en-GB.)
    expect(documentTitle({ name: 'story', story: untitled, date: '2026-11-15' }, 'en', 'OMW')).toMatch(
      /^Sunday,? 15 November 2026 · OMW$/,
    );
  });

  it('trip: localized title, else the slug; labels (404) are joined the same way', () => {
    expect(documentTitle({ name: 'trip', trip }, 'en', 'OMW')).toBe('Southeast Asia · OMW');
    expect(documentTitle({ name: 'trip', trip: { ...trip, title: {} } }, 'de', 'OMW')).toBe('suedostasien-2026 · OMW');
    expect(documentTitle({ name: 'label', label: 'Hier ist nichts' }, 'de', 'OMW')).toBe('Hier ist nichts · OMW');
  });

  it('joinTitle skips blank parts', () => {
    expect(joinTitle('Site', '', '  ', null, undefined, 'A')).toBe('A · Site');
  });
});
