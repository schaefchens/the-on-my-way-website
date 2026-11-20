/** 409 handling: three-way merge per field/locale, auto-merge, the dialog queue and resolution. */
import type { AdminDayDetail, AnnotationPatch, CaptureListItem, Day, DayPatch } from '@omw/contracts/api';
import type { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiRequestError } from '../src/api/client';
import {
  AUTO_MERGE_LIMIT,
  conflictStore,
  diffFields,
  handleConflict,
  mergePatch,
  planPatchDay,
  planPutTrip,
  resetConflictGuard,
  resolveConflict,
} from '../src/api/conflicts';
import { qk } from '../src/api/keys';
import { createAdminQueryClient } from '../src/api/query-client';
import type { PatchDayVars } from '../src/api/types';
import {
  noteFeedId,
  pruneVersions,
  recordVersion,
  resetVersions,
  resolveBase,
  runWrite,
  versionsOf,
} from '../src/api/writes';
import { annotateVars } from '../src/lib/captures';
import { fieldDraftKey, fieldDraftStore, findFieldDraft, saveFieldDraft } from '../src/lib/drafts';
import { noticeStore } from '../src/lib/notices';
import { capture, dayDetail, eventually, fakeApi, flush, settings, trip } from './helpers';

const LOCALIZED = new Set(['title']);
const DATE = '2026-11-15';

function day(overrides: Partial<Day> = {}): Day {
  return { localDate: DATE, updatedAt: '2026-11-15T20:00:00.000Z', ...overrides };
}

const mounted: QueryClient[] = [];

afterEach(() => {
  conflictStore.set([]);
  noticeStore.set([]);
  fieldDraftStore.set({});
  resetVersions();
  resetConflictGuard();
  for (const qc of mounted.splice(0)) qc.unmount();
});

describe('diffFields / mergePatch', () => {
  it('classifies each locale: only mine changed, both changed, or already the same', () => {
    const patch = { title: { de: 'Laternen', en: 'Lanterns' }, placeName: 'Hội An' };
    const original = { title: { de: 'Hội An', en: 'Hoi An' }, placeName: null };
    const server = { title: { de: 'Hội An', en: 'Lantern night' }, placeName: 'Hội An' };
    const fields = diffFields(patch, original, server, LOCALIZED);
    expect(fields.map((f) => [f.id, f.status])).toEqual([
      ['title.de', 'mine'],
      ['title.en', 'conflict'],
      ['placeName', 'same'],
    ]);
    // Default: my value wins the conflict; untouched server locales are kept.
    expect(mergePatch(patch, server, fields, LOCALIZED).patch).toEqual({ title: { de: 'Laternen', en: 'Lanterns' } });
    // Choosing the newer version for a locale keeps the server text for it.
    expect(mergePatch(patch, server, fields, LOCALIZED, { 'title.en': 'server' }).patch).toEqual({
      title: { de: 'Laternen', en: 'Lantern night' },
    });
  });

  it('treats blank strings, null and absent as equal', () => {
    const fields = diffFields({ placeName: '' }, { placeName: null }, { placeName: undefined }, LOCALIZED);
    expect(fields).toEqual([]);
  });

  it('plans a trip PUT as a whole body rebuilt from the server version', () => {
    const server = trip({ title: { de: 'Vietnam 2026', en: 'Vietnam' }, updatedAt: '2026-11-16T00:00:00.000Z' });
    const plan = planPutTrip(
      {
        body: { slug: server.slug, title: { de: 'Vietnam ’26' }, startDate: server.startDate, endDate: '2026-11-30' },
        base: '2026-11-14T00:00:00.000Z',
        original: { title: { de: 'Vietnam 2026' }, startDate: server.startDate, endDate: server.endDate },
      },
      server,
    );
    expect(plan.conflicts).toEqual([]);
    const merged = plan.merge();
    expect(merged.base).toBe('2026-11-16T00:00:00.000Z');
    expect(merged.body).toMatchObject({ title: { de: 'Vietnam ’26', en: 'Vietnam' }, endDate: '2026-11-30' });
  });

  it('recognises a replayed write that already landed', () => {
    const vars: PatchDayVars = {
      date: DATE,
      patch: { placeName: 'Hội An' },
      original: { placeName: null },
      base: null,
    };
    expect(planPatchDay(vars, day({ placeName: 'Hội An' })).alreadyApplied).toBe(true);
  });
});

describe('handleConflict', () => {
  function client(serverDay: Day, patchDay?: (date: string, body: DayPatch) => AdminDayDetail) {
    const { api, calls } = fakeApi({
      day: () => dayDetail({ day: serverDay }),
      ...(patchDay ? { patchDay } : {}),
    });
    const qc = createAdminQueryClient({ api, onConflict: () => undefined, onUnauthorizedWrite: () => undefined });
    qc.mount();
    return { qc, api, calls };
  }

  it('merges automatically when the other device changed different fields', async () => {
    const server = day({ title: { en: 'Lanterns' }, updatedAt: '2026-11-16T08:00:00.000Z' });
    const { qc, api, calls } = client(server, (_d, body) =>
      dayDetail({ day: { ...server, ...body, updatedAt: 'x' } as Day }),
    );
    const vars: PatchDayVars = {
      date: DATE,
      patch: { title: { de: 'Laternen' }, placeName: 'Hội An' },
      original: { title: null, placeName: null },
      base: '2026-11-15T20:00:00.000Z',
    };
    await handleConflict(qc, 'patchDay', vars, api);
    await eventually(() => expect(calls.map((c) => c.method)).toEqual(['day', 'patchDay']));
    expect(calls[1]?.args[1]).toEqual({
      title: { de: 'Laternen', en: 'Lanterns' },
      placeName: 'Hội An',
      ifUpdatedAt: '2026-11-16T08:00:00.000Z',
    });
    expect(conflictStore.get()).toEqual([]);
    qc.unmount();
  });

  it('asks the owner when both changed the same field, then sends the chosen merge', async () => {
    const server = day({ placeName: 'Đà Nẵng', updatedAt: '2026-11-16T08:00:00.000Z' });
    const { qc, api, calls } = client(server, (_d, body) => dayDetail({ day: { ...server, ...body } as Day }));
    const vars: PatchDayVars = {
      date: DATE,
      patch: { placeName: 'Hội An' },
      original: { placeName: null },
      base: null,
    };
    await handleConflict(qc, 'patchDay', vars, api);
    const [conflict] = conflictStore.get();
    expect(conflict?.plan.conflicts.map((f) => [f.id, f.mine, f.server])).toEqual([['placeName', 'Hội An', 'Đà Nẵng']]);
    // Cache already shows the newer server version.
    expect(qc.getQueryData<AdminDayDetail>(['admin', 'day', DATE])?.day?.placeName).toBe('Đà Nẵng');

    await resolveConflict(qc, conflict?.id ?? -1, { keep: 'merge', choices: {} });
    await eventually(() => expect(calls.map((c) => c.method)).toEqual(['day', 'patchDay']));
    expect(calls[1]?.args[1]).toEqual({ placeName: 'Hội An', ifUpdatedAt: '2026-11-16T08:00:00.000Z' });
    expect(conflictStore.get()).toEqual([]);
    qc.unmount();
  });

  it('sends nothing when the owner keeps the newer version', async () => {
    const server = day({ placeName: 'Đà Nẵng' });
    const { qc, api, calls } = client(server);
    await handleConflict(
      qc,
      'patchDay',
      { date: DATE, patch: { placeName: 'Hội An' }, original: { placeName: null }, base: null },
      api,
    );
    const [conflict] = conflictStore.get();
    await resolveConflict(qc, conflict?.id ?? -1, { keep: 'merge', choices: { placeName: 'server' } });
    await resolveConflict(qc, conflict?.id ?? -1, { keep: 'server' });
    expect(calls.map((c) => c.method)).toEqual(['day']);
    qc.unmount();
  });
});

describe('server rewind (API restored from a backup)', () => {
  const KEY = 'wa:3EB0A95100B25384B95E';
  const ENTITY = `capture:${KEY}`;
  const T1 = '2026-11-20T06:00:00.000Z';

  /** A strict annotation server: 409 unless ifUpdatedAt matches the stored row (none at first). */
  function server(start: CaptureListItem) {
    let current = start;
    let n = 0;
    const patches: AnnotationPatch[] = [];
    const { api, calls } = fakeApi({
      capture: () => current,
      annotate: (_key, body) => {
        patches.push(body);
        if ((body.ifUpdatedAt ?? null) !== (current.annotation?.updatedAt ?? null)) {
          throw new ApiRequestError(409, 'conflict', 'changed elsewhere');
        }
        const { ifUpdatedAt: _if, ...fields } = body;
        const annotation = {
          sourceKey: KEY,
          ...(current.annotation ?? {}),
          ...fields,
          updatedAt: `2026-11-20T07:00:0${++n}.000Z`,
        };
        current = { ...current, annotation, changeSeq: current.changeSeq + 1 };
        return current;
      },
    });
    const qc = createAdminQueryClient({
      api,
      onConflict: (c, name, vars) => void handleConflict(c, name, vars, api),
      onUnauthorizedWrite: () => undefined,
    });
    qc.mount();
    mounted.push(qc);
    qc.setQueryData(qk.settings, settings);
    qc.setQueryData(qk.capture(KEY), start);
    return { qc, api, calls, patches, current: () => current };
  }

  it('merges once, without the stale ifUpdatedAt, when the annotation row is gone', async () => {
    // We once wrote the first annotation (no base -> T1); the restore dropped that row.
    recordVersion(ENTITY, [null], T1);
    expect(resolveBase(ENTITY, null)).toBe(T1);
    const restored = capture({ sourceKey: KEY, annotation: null, changeSeq: 0 });
    const { qc, api, patches, current } = server(restored);
    const vars = annotateVars(restored, { description: { de: 'Zweite Beschreibung' }, origLocale: 'de' });
    expect(vars.base).toBeNull();

    await handleConflict(qc, 'annotate', vars, api);
    await eventually(() => expect(current().annotation?.description).toEqual({ de: 'Zweite Beschreibung' }));
    await flush(50);
    // Exactly one PATCH, sent without the stale T1, and it landed.
    expect(patches).toEqual([{ description: { de: 'Zweite Beschreibung' }, origLocale: 'de' }]);
    // The stale rebase is gone; only the version our merged write produced is remembered.
    expect(versionsOf(ENTITY)).toEqual({ '-': current().annotation?.updatedAt });
    expect(conflictStore.get()).toEqual([]);
  });

  it('end to end: the stale write gets one 409, the merged write lands (no PATCH loop)', async () => {
    recordVersion(ENTITY, [null], T1);
    const restored = capture({ sourceKey: KEY, annotation: null, changeSeq: 0 });
    const { qc, patches, current } = server(restored);
    void runWrite(qc, 'annotate', annotateVars(restored, { description: { de: 'Zweite' }, origLocale: 'de' }));
    await eventually(() => expect(current().annotation?.description).toEqual({ de: 'Zweite' }));
    await flush(100);
    expect(patches.map((p) => p.ifUpdatedAt ?? null)).toEqual([T1, null]);
  });

  it('a version the server went back to is not rebased onto our superseded one', async () => {
    // We moved S0 -> T1; the restore brought S0 back.
    const S0 = '2026-11-19T10:00:00.000Z';
    recordVersion(ENTITY, [S0], T1);
    const back = capture({
      sourceKey: KEY,
      annotation: { sourceKey: KEY, visibility: null, updatedAt: S0 },
      changeSeq: 3,
    });
    const { qc, patches, current } = server(back);
    void runWrite(qc, 'annotate', annotateVars(back, { visibility: 'hidden' }));
    await eventually(() => expect(current().annotation?.visibility).toBe('hidden'));
    await flush(100);
    expect(patches.map((p) => p.ifUpdatedAt)).toEqual([T1, S0]);
  });

  it(`stops after ${AUTO_MERGE_LIMIT} automatic merges when the server always answers 409`, async () => {
    const stuck = capture({
      sourceKey: KEY,
      annotation: { sourceKey: KEY, visibility: null, updatedAt: '2026-11-19T10:00:00.000Z' },
      changeSeq: 3,
    });
    const { api, calls } = fakeApi({
      capture: () => stuck,
      annotate: () => {
        throw new ApiRequestError(409, 'conflict', 'changed elsewhere');
      },
    });
    const qc = createAdminQueryClient({
      api,
      onConflict: (c, name, vars) => void handleConflict(c, name, vars, api),
      onUnauthorizedWrite: () => undefined,
    });
    qc.mount();
    mounted.push(qc);
    qc.setQueryData(qk.capture(KEY), stuck);
    void runWrite(qc, 'annotate', annotateVars(stuck, { description: { de: 'Laternen' } }));
    await eventually(() => expect(noticeStore.get().some((n) => n.tone === 'error')).toBe(true));
    await flush(300);
    const patchCount = calls.filter((c) => c.method === 'annotate').length;
    expect(patchCount).toBe(AUTO_MERGE_LIMIT + 1);
    const error = noticeStore.get().find((n) => n.tone === 'error');
    expect(error?.action).toBeDefined();
    // "Try again" is the owner's decision: it sends once more (and is guarded again).
    error?.action?.run();
    await eventually(() => expect(calls.filter((c) => c.method === 'annotate').length).toBeGreaterThan(patchCount));
    await flush(300);
    expect(calls.filter((c) => c.method === 'annotate').length).toBeLessThanOrEqual(2 * (AUTO_MERGE_LIMIT + 1));
  });
});

describe('version map hygiene', () => {
  it('prunes rebases that do not lead to the server version', () => {
    recordVersion('day:2026-11-15', ['A', 'B'], 'T2');
    recordVersion('day:2026-11-15', ['C'], 'T3');
    pruneVersions('day:2026-11-15', 'T3');
    expect(versionsOf('day:2026-11-15')).toEqual({ C: 'T3' });
    pruneVersions('day:2026-11-15', null);
    expect(versionsOf('day:2026-11-15')).toEqual({});
  });

  it('forgets every version when the API feed id changes (database restored)', () => {
    noteFeedId('feed_aaaaaaaa');
    recordVersion('post:p_1', [null], 'T1');
    noteFeedId('feed_aaaaaaaa');
    noteFeedId(null);
    expect(versionsOf('post:p_1')).toEqual({ '-': 'T1' });
    noteFeedId('feed_bbbbbbbb');
    expect(versionsOf('post:p_1')).toEqual({});
  });
});

describe('field drafts and conflicts', () => {
  it('keeps the draft through a 409 and drops it once the merged write is confirmed', async () => {
    const KEY = 'wa:3EB0B028C9D92EFF4C5B';
    let current = capture({
      annotation: { sourceKey: KEY, description: { en: 'Old' }, updatedAt: '2026-11-19T10:00:00.000Z' },
      changeSeq: 2,
    });
    const stale = { ...current, annotation: { ...current.annotation, updatedAt: '2026-11-18T10:00:00.000Z' } };
    const { api } = fakeApi({
      capture: () => current,
      annotate: (_k, body) => {
        if (body.ifUpdatedAt !== current.annotation?.updatedAt) throw new ApiRequestError(409, 'conflict', 'x');
        const { ifUpdatedAt: _if, ...fields } = body;
        current = {
          ...current,
          annotation: { sourceKey: KEY, ...current.annotation, ...fields, updatedAt: '2026-11-20T08:00:00.000Z' },
          changeSeq: 3,
        };
        return current;
      },
    });
    const qc = createAdminQueryClient({
      api,
      onConflict: (c, name, vars) => void handleConflict(c, name, vars, api),
      onUnauthorizedWrite: () => undefined,
    });
    qc.mount();
    mounted.push(qc);
    const entity = `capture:${KEY}`;
    const base = stale.annotation?.updatedAt ?? null;
    const draft = {
      key: fieldDraftKey(entity, base),
      entity,
      base,
      original: { description: { en: 'Old' } },
      form: { description: { de: 'Neu' } },
      savedAt: '2026-11-20T07:59:00.000Z',
    };
    saveFieldDraft(draft);
    const vars = {
      ...annotateVars(stale as CaptureListItem, { description: { en: 'Old', de: 'Neu' } }),
      draft: { key: draft.key, savedAt: draft.savedAt },
    };
    void runWrite(qc, 'annotate', vars);
    await eventually(() => expect(current.annotation?.description).toEqual({ en: 'Old', de: 'Neu' }));
    await eventually(() => expect(findFieldDraft(fieldDraftStore.get(), entity)).toBeNull());
  });
});
