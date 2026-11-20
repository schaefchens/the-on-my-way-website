/** Pure helpers: composer validation, forms, places/time zones, publish state, cache updaters. */
import type { AdminDayDetail, PostListResponse, StatusResponse, TargetPublishStatus } from '@omw/contracts/api';
import { itemPublishState } from '@omw/contracts/api';
import { effectiveCaptureVisibility } from '@omw/contracts/policy';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { annotateLocally, CacheTx, putPost, restoreSnapshot, settingsLocally } from '../src/api/cache';
import { qk } from '../src/api/keys';
import { toggledVisibility, visibilityOutcome } from '../src/lib/captures';
import {
  buildCreate,
  buildUpdate,
  charCount,
  composeContent,
  draftFromPost,
  NOTE_MAX,
  newDraft,
} from '../src/lib/compose';
import { cleanText, dirtyPatch, parseCoordinate, slugify } from '../src/lib/forms';
import { modeSinceAfter, waitingToPublish } from '../src/lib/mode-since';
import { canonicalZone, utcToZonedInput, zonedTimeToUtc } from '../src/lib/places';
import { capturePublishInput, itemState, publishStateOf, publishSummary } from '../src/lib/publish';
import { capture, dayDetail, post, settings } from './helpers';

describe('composer', () => {
  const base = newDraft('note', { id: 'new:note', origLocale: 'de', now: new Date('2026-11-20T08:00:00Z') });

  it('needs text, counts graphemes and enforces 280 characters per note', () => {
    expect(composeContent(base).problems).toEqual([{ code: 'empty' }]);
    expect(charCount('👩‍👩‍👧 Hội An')).toBe(8);
    const long = { ...base, content: { de: { title: '', body: 'x'.repeat(NOTE_MAX + 3) } } };
    expect(composeContent(long).problems).toEqual([{ code: 'too_long', locale: 'de', length: NOTE_MAX + 3 }]);
    expect(buildCreate(long)).toBeNull();
  });

  it('builds an idempotent create with the draft publicId and a filled original language', () => {
    const draft = { ...base, origLocale: 'de' as const, content: { en: { title: '', body: '  Hello from Hội An  ' } } };
    expect(buildCreate(draft)).toEqual({
      publicId: base.publicId,
      kind: 'note',
      origLocale: 'en',
      visibility: 'public',
      content: { en: { body: 'Hello from Hội An' } },
    });
  });

  it('requires a title for every story language with text', () => {
    const story = newDraft('story', { id: 'new:story', origLocale: 'de' });
    const draft = {
      ...story,
      content: { de: { title: 'Fluss', body: 'Text' }, en: { title: ' ', body: 'Only body' } },
    };
    expect(composeContent(draft).problems).toEqual([{ code: 'title_missing', locale: 'en' }]);
  });

  it('patches only what changed when editing a post', () => {
    const p = post({ content: { de: { body: 'Hallo' } } });
    const draft = draftFromPost(p, 'edit');
    expect(buildUpdate(draft, p)?.dirty).toBe(false);
    const edited = { ...draft, content: { ...draft.content, en: { title: '', body: 'Hello' } } };
    expect(buildUpdate(edited, p)).toEqual({
      patch: { content: { de: { body: 'Hallo' }, en: { body: 'Hello' } } },
      original: { content: { de: { body: 'Hallo' } } },
      dirty: true,
    });
  });
});

describe('forms', () => {
  it('dirtyPatch ignores blank vs null and reports originals', () => {
    expect(dirtyPatch({ a: null, b: 'x', c: { de: 'T' } }, { a: '', b: 'y', c: { de: 'T' } })).toEqual({
      patch: { b: 'y' },
      original: { b: 'x' },
      dirty: true,
    });
  });

  it('cleans localized text, slugs and coordinates', () => {
    expect(cleanText({ de: '  Hallo ', en: '   ' })).toEqual({ de: 'Hallo' });
    expect(cleanText({ en: '' })).toBeNull();
    expect(slugify('Đà Nẵng & Hội An – Straße 2026!')).toBe('da-nang-hoi-an-strasse-2026');
    expect(parseCoordinate('15,8801', 90)).toBe(15.8801);
    expect(parseCoordinate('', 90)).toBeNull();
    expect(parseCoordinate('91', 90)).toBeUndefined();
    expect(parseCoordinate('abc', 180)).toBeUndefined();
  });
});

describe('places', () => {
  it('maps legacy ICU zone names to current IANA names', () => {
    expect(canonicalZone('Asia/Saigon')).toBe('Asia/Ho_Chi_Minh');
    expect(canonicalZone('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(canonicalZone('Europe/Berlin')).toBe('Europe/Berlin');
  });

  it('converts wall-clock input in a zone to UTC and back, across DST', () => {
    expect(zonedTimeToUtc('2026-11-15T19:30', 'Asia/Ho_Chi_Minh')).toBe('2026-11-15T12:30:00.000Z');
    expect(zonedTimeToUtc('2026-03-29T03:30', 'Europe/Berlin')).toBe('2026-03-29T01:30:00.000Z');
    expect(zonedTimeToUtc('2026-10-25T12:00', 'Europe/Berlin')).toBe('2026-10-25T11:00:00.000Z');
    expect(zonedTimeToUtc('nope', 'Europe/Berlin')).toBeNull();
    expect(utcToZonedInput('2026-11-15T12:30:00.000Z', 'Asia/Ho_Chi_Minh')).toBe('2026-11-15T19:30');
  });
});

describe('publish state', () => {
  const report = (o: Partial<TargetPublishStatus> = {}): TargetPublishStatus => ({
    contractVersion: 1,
    version: 3,
    at: '2026-11-20T08:00:00.000Z',
    target: 'sftp-main',
    ok: true,
    uploaded: 1,
    deleted: 0,
    feedSeq: 10,
    capturesThrough: '2026-11-19T04:00:00.000Z',
    lastOkAt: '2026-11-20T08:00:00.000Z',
    consecutiveFailures: 0,
    receivedAt: '2026-11-20T08:00:00.000Z',
    ...o,
  });
  const status = (publish: TargetPublishStatus[], lastStatusAt = '2026-11-19T04:00:00.000Z'): StatusResponse =>
    ({ backend: { wa: { lastStatusAt } }, lastSeenAt: null, publish, alerts: [] }) as unknown as StatusResponse;

  it('is live when every target contains our latest change and the latest status', () => {
    expect(publishSummary(status([report()]), { seq: 10, at: '' }).state).toBe('live');
    expect(publishSummary(status([report()]), { seq: 11, at: '' })).toMatchObject({
      state: 'publishing',
      waitingFor: ['edits'],
    });
    expect(publishSummary(status([report()], '2026-11-20T01:00:00.000Z'), null).waitingFor).toEqual(['captures']);
    expect(publishSummary(status([report({ ok: false })]), null).state).toBe('failing');
    // Status loaded, no deploy at all: "not published yet"; no status (request failed): unknown.
    expect(publishSummary(status([]), null, 2)).toMatchObject({ state: 'never', waitingFor: ['edits'] });
    expect(publishSummary(undefined, null).state).toBe('unknown');
  });

  it('agrees with itemPublishState() of the contracts on every combination', () => {
    const items = [
      { visibility: 'public' as const, changeSeq: 0 },
      { visibility: 'public' as const, changeSeq: 10 },
      { visibility: 'public' as const, changeSeq: 11 },
      { visibility: 'hidden' as const, changeSeq: 1 },
      { visibility: 'pending' as const, changeSeq: 1 },
      { visibility: 'public' as const, changeSeq: 1, occurredAt: '2026-11-19T04:00:00.000Z' },
      { visibility: 'public' as const, changeSeq: 1, occurredAt: '2026-11-19T04:00:00.001Z' },
      {
        visibility: 'public' as const,
        changeSeq: 0,
        occurredAt: '2026-11-18T04:00:00.000Z',
        mediaState: 'ok' as const,
      },
      {
        visibility: 'public' as const,
        changeSeq: 0,
        occurredAt: '2026-11-18T04:00:00.000Z',
        mediaState: 'pending' as const,
      },
      {
        visibility: 'public' as const,
        changeSeq: 0,
        occurredAt: '2026-11-18T04:00:00.000Z',
        mediaState: 'lost' as const,
      },
      {
        visibility: 'hidden' as const,
        changeSeq: 0,
        occurredAt: '2026-11-18T04:00:00.000Z',
        mediaState: 'pending' as const,
      },
      // delayed mode: public at occurredAt + delay (before, at and after the report's `at`)
      {
        visibility: 'public' as const,
        changeSeq: 0,
        occurredAt: '2026-11-18T04:00:00.000Z',
        publishAt: '2026-11-18T05:00:00.000Z',
      },
      {
        visibility: 'public' as const,
        changeSeq: 0,
        occurredAt: '2026-11-18T04:00:00.000Z',
        publishAt: '2026-11-18T05:00:00.001Z',
      },
      {
        visibility: 'public' as const,
        changeSeq: 0,
        occurredAt: '2026-11-18T04:00:00.000Z',
        publishAt: '2026-11-20T09:00:00.000Z',
      },
    ];
    const reportSets = [
      [],
      [report()],
      [report({ ok: false })],
      [report({ capturesThrough: null })],
      [report(), report({ target: 'b', feedSeq: 5 })],
      [report({ at: '2026-11-18T05:00:00.000Z' })],
    ];
    for (const item of items) {
      for (const reports of reportSets) expect(publishStateOf(item, reports)).toBe(itemPublishState(item, reports));
    }
  });

  it('marks queued items as saving, hidden ones as not public', () => {
    const s = status([report()]);
    expect(itemState({ visibility: 'public', changeSeq: 4 }, s, true)).toBe('saving');
    expect(itemState({ visibility: 'public', changeSeq: 11 }, s, false)).toBe('publishing');
    expect(itemState({ visibility: 'hidden', changeSeq: 1 }, s, false)).toBe('not_public');
    expect(itemState({ visibility: 'public', changeSeq: 4, occurredAt: '2026-11-18T00:00:00.000Z' }, s, false)).toBe(
      'live',
    );
  });
});

describe('optimistic cache updates', () => {
  it('re-derives visibility and day of an annotated capture with the shared policy', () => {
    const c = capture();
    const reviewed = {
      ...settings,
      'publish.mode': 'review' as const,
      'publish.mode_since': '2026-01-01T00:00:00.000Z',
    };
    expect(annotateLocally(c, { visibility: 'hidden' }, { settings, now: Date.now() }).effectiveVisibility).toBe(
      'hidden',
    );
    expect(
      annotateLocally(
        { ...c, annotation: { sourceKey: c.sourceKey, visibility: 'hidden', updatedAt: 'x' } },
        { visibility: null },
        {
          settings: reviewed,
          now: Date.now(),
        },
      ).effectiveVisibility,
    ).toBe('pending');
    expect(annotateLocally(c, { localDateOverride: '2026-11-16' }, { now: Date.now() }).effectiveLocalDate).toBe(
      '2026-11-16',
    );
  });

  it('moves a post between cached days and restores exactly what it touched', () => {
    const qc = new QueryClient();
    const p = post();
    qc.setQueryData<AdminDayDetail>(qk.day('2026-11-15'), dayDetail({ posts: [p] }));
    qc.setQueryData<AdminDayDetail>(qk.day('2026-11-16'), dayDetail({ localDate: '2026-11-16' }));
    qc.setQueryData<PostListResponse>(qk.posts({}), { items: [p], nextCursor: null });
    const tx = new CacheTx(qc);
    putPost(tx, { ...p, occurredAt: '2026-11-16T05:00:00.000Z', localDate: '2026-11-16' });
    expect(qc.getQueryData<AdminDayDetail>(qk.day('2026-11-15'))?.posts).toEqual([]);
    expect(qc.getQueryData<AdminDayDetail>(qk.day('2026-11-16'))?.posts.map((x) => x.publicId)).toEqual([p.publicId]);
    restoreSnapshot(qc, tx.snapshot);
    expect(qc.getQueryData<AdminDayDetail>(qk.day('2026-11-15'))?.posts).toEqual([p]);
    expect(qc.getQueryData(qk.post(p.publicId))).toBeUndefined();
  });

  it('stamps publish.mode_since when the mode changes and clears nullable settings', () => {
    const next = settingsLocally(
      { ...settings, 'alerts.email': 'a@b.c' },
      { 'publish.mode': 'delayed', 'alerts.email': null },
      Date.parse('2026-11-20T08:00:00Z'),
    );
    expect(next['publish.mode_since']).toBe('2026-11-20T08:00:00.000Z');
    expect('alerts.email' in next).toBe(false);
  });
});

describe('publish state in delayed mode (publishAt)', () => {
  const delayed = {
    ...settings,
    'publish.mode': 'delayed' as const,
    'publish.delay_minutes': 60,
    'publish.mode_since': '2026-11-01T00:00:00.000Z',
  };
  const report = (at: string) => ({ ok: true, feedSeq: 10, capturesThrough: '2026-11-20T10:00:00.000Z', at });

  it('is live only after a deploy that happened after the status became public', () => {
    // Captured 10:00Z, 60 min delay, last deploy 10:05Z (it was still waiting then).
    const c = capture({ occurredAt: '2026-11-20T10:00:00.000Z', changeSeq: 0, effectiveVisibility: 'public' });
    const input = capturePublishInput(c, delayed);
    expect(input.publishAt).toBe('2026-11-20T11:00:00.000Z');
    // 11:01Z: the API says public, but the deployed files do not contain it yet.
    expect(publishStateOf(input, [report('2026-11-20T10:05:00.000Z')])).toBe('publishing');
    expect(itemPublishState(input, [report('2026-11-20T10:05:00.000Z')])).toBe('publishing');
    // A deploy at 11:02Z contains it.
    expect(publishStateOf(input, [report('2026-11-20T11:02:00.000Z')])).toBe('live');
    expect(itemPublishState(input, [report('2026-11-20T11:02:00.000Z')])).toBe('live');
  });

  it('adds no publishAt for overrides, statuses before mode_since or other modes', () => {
    const c = capture({ occurredAt: '2026-11-20T10:00:00.000Z' });
    expect(capturePublishInput(c, settings).publishAt).toBeUndefined();
    expect(capturePublishInput(c, undefined).publishAt).toBeUndefined();
    const released = capture({
      occurredAt: '2026-11-20T10:00:00.000Z',
      annotation: { sourceKey: c.sourceKey, visibility: 'public', updatedAt: '2026-11-20T10:01:00.000Z' },
    });
    expect(capturePublishInput(released, delayed).publishAt).toBeUndefined();
    const before = { ...delayed, 'publish.mode_since': '2026-11-20T12:00:00.000Z' };
    expect(capturePublishInput(c, before).publishAt).toBeUndefined();
  });
});

describe('un-hiding keeps the publish setting (toggle decision table)', () => {
  const NOW = Date.parse('2026-11-20T10:30:00.000Z');
  const fresh = '2026-11-20T10:00:00.000Z'; // 30 min ago
  const old = '2026-11-19T10:00:00.000Z';
  const delayed = {
    ...settings,
    'publish.mode': 'delayed' as const,
    'publish.delay_minutes': 60,
    'publish.mode_since': '2026-11-01T00:00:00.000Z',
  };
  const review = { ...delayed, 'publish.mode': 'review' as const };
  const keepRevoked = { ...settings, 'ingest.on_revoke': 'keep' as const };
  const hiddenBy = (occurredAt: string, extra: Partial<Parameters<typeof capture>[0]> = {}) =>
    capture({
      occurredAt,
      effectiveVisibility: 'hidden',
      annotation: { sourceKey: 'wa:3EB0B028C9D92EFF4C5B', visibility: 'hidden', updatedAt: old },
      changeSeq: 2,
      ...extra,
    });

  it.each([
    ['visible -> hidden', capture({ effectiveVisibility: 'public' }), settings, 'hidden', 'hidden'],
    ['waiting -> publish now', capture({ effectiveVisibility: 'pending' }), delayed, 'public', 'public'],
    ['hidden, instant -> automatic, public', hiddenBy(fresh), settings, null, 'public'],
    ['hidden, delayed, fresh -> automatic, after the delay', hiddenBy(fresh), delayed, null, 'delayed'],
    ['hidden, delayed, past the delay -> automatic, public', hiddenBy(old), delayed, null, 'public'],
    ['hidden, review -> automatic, waits for release', hiddenBy(fresh), review, null, 'review'],
    [
      'hidden, review, before mode_since -> automatic, public',
      hiddenBy(fresh),
      { ...review, 'publish.mode_since': '2026-11-20T10:10:00.000Z' },
      null,
      'public',
    ],
    [
      'hidden by revoke (on_revoke hide) -> explicit public',
      capture({ effectiveVisibility: 'hidden', revokedAt: fresh, occurredAt: fresh }),
      settings,
      'public',
      'public',
    ],
    [
      'hidden override, revoked but on_revoke keep -> automatic',
      hiddenBy(fresh, { revokedAt: fresh }),
      keepRevoked,
      null,
      'public',
    ],
    ['hidden, settings unknown -> automatic', hiddenBy(fresh), undefined, null, 'unknown'],
    [
      'hidden by revoke, settings unknown -> explicit public',
      capture({ effectiveVisibility: 'hidden', revokedAt: fresh }),
      undefined,
      'public',
      'public',
    ],
  ] as const)('%s', (_name, c, s, next, outcome) => {
    const target = toggledVisibility(c, s, NOW);
    expect(target).toBe(next);
    expect(visibilityOutcome(c, target, s, NOW).kind).toBe(outcome);
  });

  it('tells when a delayed status appears', () => {
    const outcome = visibilityOutcome(hiddenBy(fresh), null, delayed, NOW);
    expect(outcome).toEqual({ kind: 'delayed', publishAt: '2026-11-20T11:00:00.000Z' });
  });
});

describe('publish.mode_since (same table as the API)', () => {
  const t = Date.parse('2026-11-20T12:00:00.000Z');
  const base = {
    'publish.mode': 'instant' as const,
    'publish.delay_minutes': 60,
    'publish.mode_since': '2026-11-01T00:00:00.000Z',
  };
  it.each([
    ['instant -> delayed: now', base, { 'publish.mode': 'delayed' }, '2026-11-20T12:00:00.000Z'],
    ['instant -> review: now', base, { 'publish.mode': 'review' }, '2026-11-20T12:00:00.000Z'],
    [
      'delayed -> review: now - old delay + 1 ms',
      { ...base, 'publish.mode': 'delayed' },
      { 'publish.mode': 'review' },
      '2026-11-20T11:00:00.001Z',
    ],
    [
      'delayed -> review: an old since later than now - delay stays',
      { ...base, 'publish.mode': 'delayed', 'publish.mode_since': '2026-11-20T11:30:00.000Z' },
      { 'publish.mode': 'review' },
      '2026-11-20T11:30:00.000Z',
    ],
    [
      'delay change while delayed: now - OLD delay + 1 ms',
      { ...base, 'publish.mode': 'delayed' },
      { 'publish.delay_minutes': 720 },
      '2026-11-20T11:00:00.001Z',
    ],
    [
      'delay change to the same value: unchanged',
      { ...base, 'publish.mode': 'delayed' },
      { 'publish.delay_minutes': 60 },
      '2026-11-01T00:00:00.000Z',
    ],
    [
      'review -> delayed: unchanged',
      { ...base, 'publish.mode': 'review' },
      { 'publish.mode': 'delayed' },
      '2026-11-01T00:00:00.000Z',
    ],
    [
      'delayed -> instant: unchanged',
      { ...base, 'publish.mode': 'delayed' },
      { 'publish.mode': 'instant' },
      '2026-11-01T00:00:00.000Z',
    ],
    [
      'review -> instant: unchanged',
      { ...base, 'publish.mode': 'review' },
      { 'publish.mode': 'instant' },
      '2026-11-01T00:00:00.000Z',
    ],
    ['delay change while instant: unchanged', base, { 'publish.delay_minutes': 5 }, '2026-11-01T00:00:00.000Z'],
    [
      'delay change while review: unchanged',
      { ...base, 'publish.mode': 'review' },
      { 'publish.delay_minutes': 5 },
      '2026-11-01T00:00:00.000Z',
    ],
    [
      'missing since counts as the epoch',
      { 'publish.mode': 'delayed' as const, 'publish.delay_minutes': 60 },
      { 'publish.mode': 'review' },
      '2026-11-20T11:00:00.001Z',
    ],
  ] as const)('%s', (_name, prev, patch, expected) => {
    expect(modeSinceAfter(prev, patch, t)).toBe(expected);
    // The optimistic settings use the same rule.
    expect(settingsLocally({ ...settings, ...prev }, patch, t)['publish.mode_since']).toBe(expected);
  });

  it('never flips a status between public and waiting on delayed -> review', () => {
    const delayed = { ...settings, 'publish.mode': 'delayed' as const, 'publish.delay_minutes': 60 };
    const review = { ...delayed, 'publish.mode': 'review' as const };
    const after = { ...review, 'publish.mode_since': modeSinceAfter(delayed, { 'publish.mode': 'review' }, t) };
    for (const [occurredAt, expected] of [
      ['2026-11-20T11:00:00.000Z', 'public'], // exactly one delay old: public, stays public
      ['2026-11-20T11:00:00.001Z', 'pending'], // still waiting, keeps waiting
      ['2026-11-20T09:00:00.000Z', 'public'],
      ['2026-11-20T11:59:00.000Z', 'pending'],
    ] as const) {
      expect(effectiveCaptureVisibility({ occurredAt }, null, delayed, t), occurredAt).toBe(expected);
      expect(effectiveCaptureVisibility({ occurredAt }, null, after, t), occurredAt).toBe(expected);
    }
  });

  it('counts the waiting statuses a switch would publish', () => {
    const now = Date.parse('2026-11-20T12:00:00.000Z');
    const waiting = (occurredAt: string, key: string, override: 'hidden' | null = null) =>
      capture({
        sourceKey: `wa:${key}`,
        occurredAt,
        effectiveVisibility: override ?? 'pending',
        annotation: override ? { sourceKey: `wa:${key}`, visibility: override, updatedAt: occurredAt } : null,
      });
    const list = [
      waiting('2026-11-20T11:50:00.000Z', 'FRESH1'),
      waiting('2026-11-20T09:00:00.000Z', 'OLD1'),
      waiting('2026-11-20T08:00:00.000Z', 'OLD2'),
      waiting('2026-11-20T08:00:00.000Z', 'HID1', 'hidden'),
      capture({ sourceKey: 'wa:PUB1', occurredAt: '2026-11-20T08:00:00.000Z', effectiveVisibility: 'public' }),
    ];
    const review = { 'publish.mode': 'review' as const, 'publish.delay_minutes': 60 };
    const delayed = { 'publish.mode': 'delayed' as const, 'publish.delay_minutes': 60 };
    expect(waitingToPublish(list, review, 'delayed', now).map((c) => c.sourceKey)).toEqual(['wa:OLD1', 'wa:OLD2']);
    expect(waitingToPublish(list, review, 'instant', now)).toHaveLength(3);
    expect(waitingToPublish(list, delayed, 'instant', now)).toHaveLength(3);
    expect(waitingToPublish(list, delayed, 'review', now)).toEqual([]);
    expect(waitingToPublish(list, review, 'review', now)).toEqual([]);
  });
});
