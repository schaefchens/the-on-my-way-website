import { describe, expect, it } from '@jest/globals';
import { AppEntry } from '@omw/contracts/app';
import {
  buildAppEntry,
  exifLocalDate,
  fitPhoto,
  formatBytes,
  formatClock,
  localDateIn,
  normalizeCaption,
  suggestedDay,
  suggestionsByDay,
} from '../src/core/entry';
import { newDraft, transition } from '../src/core/outbox-machine';
import { initialTrim, MAX_CLIP_MS, moveHandle, trimForExport } from '../src/core/trim';
import { monotonicUlid, ulidTime } from '../src/core/ulid';
import { ID, LATER, NOW, PHOTO_FILES } from './fixtures';

const CLIENT = { app: '0.1.0-dev', os: '16' };

describe('ULIDs', () => {
  it('are valid entry ids, monotonic inside one millisecond', () => {
    let seed = 0;
    const next = monotonicUlid((n) => Uint8Array.from({ length: n }, () => (seed = (seed * 31 + 7) % 256)));
    const t = Date.parse(NOW);
    const ids = [next(t), next(t), next(t), next(t + 1)];
    for (const id of ids) expect(id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(4);
    expect(ulidTime(ids[0] as string)).toBe(t);
    // A clock that steps back never breaks the order.
    expect(next(t - 5) > (ids[3] as string)).toBe(true);
  });
});

describe('AppEntry from a manifest', () => {
  const shared = (patch: Parameters<typeof newDraft>[0] & { caption?: string }) => {
    const draft = { ...newDraft(patch), ...(patch.caption ? { caption: patch.caption } : {}) };
    return transition(
      draft,
      { type: 'share', at: NOW, tz: 'Asia/Ho_Chi_Minh', choice: { visibility: 'pending' } },
      LATER,
    ).next;
  };

  it('builds a valid photo entry with caption, files and the publish choice', () => {
    const m = shared({
      entryId: ID,
      kind: 'photo',
      origin: 'gallery',
      now: NOW,
      source: { name: 'source.jpg', mimetype: 'image/jpeg', bytes: 4_000_000 },
      caption: '  Lanterns everywhere ✨ ',
    });
    const r = buildAppEntry(m, { files: PHOTO_FILES, media: { width: 2133, height: 1600 } }, CLIENT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry).toMatchObject({
      schema: 1,
      entryId: ID,
      source: 'app',
      kind: 'photo',
      occurredAt: NOW,
      tz: 'Asia/Ho_Chi_Minh',
      caption: 'Lanterns everywhere ✨',
      visibility: 'pending',
      client: { app: '0.1.0-dev', platform: 'android', os: '16' },
    });
    expect(r.entry.files.map((f) => f.role)).toEqual(['media', 'preview', 'original']);
    expect(AppEntry.safeParse(r.entry).success).toBe(true);
  });

  it('builds a text entry without files or media', () => {
    const m = shared({
      entryId: ID,
      kind: 'text',
      origin: 'text',
      now: NOW,
      text: { body: 'Xin chào', bgArgb: 0xff3b2341, textArgb: 0xffffffff, font: 'SYSTEM' },
    });
    const r = buildAppEntry(m, { files: [] }, CLIENT);
    expect(r.ok && r.entry.text?.body).toBe('Xin chào');
    expect(r.ok && r.entry.files).toEqual([]);
  });

  it('reports the contract problems instead of throwing', () => {
    const m = shared({
      entryId: ID,
      kind: 'video',
      origin: 'camera',
      now: NOW,
      source: { name: 'source.mp4', mimetype: 'video/mp4', bytes: 1 },
    });
    const r = buildAppEntry(m, { files: [], media: { width: 1920, height: 1080 } }, CLIENT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => p.message).join(' ')).toMatch(/seconds|media file/);
  });

  it('drops an empty caption', () => {
    expect(normalizeCaption('  \n ')).toBeUndefined();
    expect(normalizeCaption('a\r\nb')).toBe('a\nb');
  });
});

describe('days', () => {
  it('computes the local date in the phone’s zone', () => {
    expect(localDateIn('2026-11-19T18:30:00Z', 'Asia/Ho_Chi_Minh')).toBe('2026-11-20');
    expect(localDateIn('2026-11-19T18:30:00Z', 'Europe/Berlin')).toBe('2026-11-19');
  });

  it('reads the EXIF day and suggests only earlier days', () => {
    expect(exifLocalDate('2026:11:17 18:42:05')).toBe('2026-11-17');
    expect(exifLocalDate('2026:02:30 10:00:00')).toBeNull();
    expect(exifLocalDate(undefined)).toBeNull();
    expect(suggestedDay('2026-11-17', '2026-11-20')).toBe('2026-11-17');
    expect(suggestedDay('2026-11-20', '2026-11-20')).toBeNull();
    expect(suggestedDay('2026-11-21', '2026-11-20')).toBeNull();
  });

  it('groups a batch into one chip per day, newest day first', () => {
    expect(
      suggestionsByDay(
        [
          { entryId: 'a', takenOn: '2026-11-17' },
          { entryId: 'b', takenOn: '2026-11-20' },
          { entryId: 'c', takenOn: '2026-11-17' },
          { entryId: 'd', takenOn: '2026-11-18' },
          { entryId: 'e' },
        ],
        '2026-11-20',
      ),
    ).toEqual([
      { day: '2026-11-18', entryIds: ['d'] },
      { day: '2026-11-17', entryIds: ['a', 'c'] },
    ]);
  });
});

describe('sizes and clocks', () => {
  it('fits photos into 2880 × 1600 without upscaling', () => {
    expect(fitPhoto(4000, 3000)).toEqual({ width: 2133, height: 1600 });
    expect(fitPhoto(3000, 4000)).toEqual({ width: 1600, height: 2133 });
    expect(fitPhoto(6000, 1000)).toEqual({ width: 2880, height: 480 });
    expect(fitPhoto(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('formats sizes and clocks', () => {
    expect(formatBytes(184_000_000, 'en')).toBe('184 MB');
    expect(formatBytes(1_500_000, 'de')).toBe('1,5 MB');
    expect(formatClock(42_000)).toBe('0:42');
    expect(formatClock(61_500)).toBe('1:01');
  });
});

describe('video trim (≤ 60 s)', () => {
  it('starts with the first 60 seconds of a long clip', () => {
    expect(initialTrim(95_000)).toEqual({ startMs: 0, endMs: MAX_CLIP_MS });
    expect(initialTrim(12_400)).toEqual({ startMs: 0, endMs: 12_400 });
  });

  it('stops a handle at the 60 s limit and says so', () => {
    const w = initialTrim(95_000);
    expect(moveHandle(w, 'end', 90_000, 95_000)).toEqual({ startMs: 0, endMs: MAX_CLIP_MS, atLimit: true });
    expect(moveHandle({ startMs: 20_000, endMs: 60_000 }, 'end', 90_000, 95_000)).toEqual({
      startMs: 20_000,
      endMs: 80_000,
      atLimit: true,
    });
    expect(moveHandle({ startMs: 20_000, endMs: 60_000 }, 'start', 10_000, 95_000)).toEqual({
      startMs: 10_000,
      endMs: 60_000,
      atLimit: false,
    });
  });

  it('keeps at least one second and stays inside the clip', () => {
    expect(moveHandle({ startMs: 0, endMs: 5000 }, 'start', 4800, 5000)).toMatchObject({ startMs: 4000 });
    expect(moveHandle({ startMs: 0, endMs: 5000 }, 'end', 9000, 5000)).toMatchObject({ endMs: 5000 });
    expect(moveHandle({ startMs: 0, endMs: 5000 }, 'start', -50, 5000)).toMatchObject({ startMs: 0 });
  });

  it('sends no clipping when nothing is cut', () => {
    expect(trimForExport({ startMs: 0, endMs: 12_400 }, 12_400)).toEqual({});
    expect(trimForExport({ startMs: 1000, endMs: 61_000 }, 95_000)).toEqual({ trimStartMs: 1000, trimEndMs: 61_000 });
  });
});
