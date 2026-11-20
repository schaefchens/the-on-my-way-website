/**
 * Regressions found in verification: follow-up edits of entities that exist only optimistically,
 * PUT semantics of trips, stale composer drafts and rejected posts that must not lose the text.
 */
import type {
  AdminDayDetail,
  AdminPost,
  AnnotationPatch,
  CaptureListItem,
  PostCreate,
  PostUpdate,
  TripListResponse,
  TripUpsert,
} from '@omw/contracts/api';
import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CacheTx, findCapture, findPost, optimisticPutTrip } from '../src/api/cache';
import { ApiRequestError } from '../src/api/client';
import { planUpdatePost } from '../src/api/conflicts';
import { qk } from '../src/api/keys';
import { createAdminQueryClient } from '../src/api/query-client';
import { type UpdatePostVars, writeBase } from '../src/api/types';
import { pendingWrites, resetVersions, runWrite } from '../src/api/writes';
import { annotateVars } from '../src/lib/captures';
import { buildUpdate, draftFromPost } from '../src/lib/compose';
import { draftPreview, draftSearch, draftStore, restoreDraft } from '../src/lib/drafts';
import { noticeStore } from '../src/lib/notices';
import { createPostRescue } from '../src/lib/rescue';
import { capture, dayDetail, eventually, fakeApi, flush, post, settings, trip } from './helpers';

const mounted: QueryClient[] = [];

function setup(impl: Parameters<typeof fakeApi>[0], opened: unknown[] = []) {
  const { api, calls } = fakeApi(impl);
  const conflicts: unknown[] = [];
  const qc = createAdminQueryClient({
    api,
    onConflict: (_qc, name, vars) => conflicts.push({ name, vars }),
    onUnauthorizedWrite: () => undefined,
    onFailedWrite: createPostRescue((draft) => opened.push(draft)),
  });
  qc.mount();
  mounted.push(qc);
  qc.setQueryData(qk.settings, settings);
  return { qc, calls, conflicts };
}

beforeEach(() => {
  resetVersions();
  noticeStore.set([]);
  draftStore.set({});
});

afterEach(() => {
  onlineManager.setOnline(true);
  for (const qc of mounted.splice(0)) qc.unmount();
});

/** A strict server for one capture's annotation: 409 on a stale ifUpdatedAt. */
function annotationServer(c: CaptureListItem) {
  let stored = c;
  let n = 0;
  return (_key: string, patch: AnnotationPatch) => {
    const current = stored.annotation?.updatedAt;
    if (patch.ifUpdatedAt !== undefined && patch.ifUpdatedAt !== current) {
      throw new ApiRequestError(409, 'conflict', 'stale');
    }
    const { ifUpdatedAt: _if, ...fields } = patch;
    const annotation = {
      sourceKey: c.sourceKey,
      ...(stored.annotation ?? {}),
      ...fields,
      updatedAt: `2026-11-20T10:00:0${++n}.000Z`,
    };
    stored = { ...stored, annotation, effectiveVisibility: annotation.visibility ?? 'public', changeSeq: 10 + n };
    return stored;
  };
}

describe('follow-up edits of entities that exist only optimistically', () => {
  it('writeBase ignores the made-up updatedAt of optimistic copies (changeSeq 0)', () => {
    expect(writeBase('2026-11-20T02:00:00.000Z', 0)).toBeNull();
    expect(writeBase('2026-11-20T02:00:00.000Z', 4)).toBe('2026-11-20T02:00:00.000Z');
    expect(writeBase(undefined, 4)).toBeNull();
  });

  it('a second toggle of a never-annotated capture is rebased, not sent with a made-up ifUpdatedAt', async () => {
    const c = capture();
    const { qc, calls, conflicts } = setup({ annotate: annotationServer(c) });
    qc.setQueryData(qk.capture(c.sourceKey), c);
    qc.setQueryData<AdminDayDetail>(qk.day('2026-11-15'), dayDetail({ captures: [c] }));
    onlineManager.setOnline(false);
    void runWrite(qc, 'annotate', annotateVars(c, { visibility: 'hidden' }));
    await flush();
    // The UI builds the next write from the cached (optimistic) capture.
    const cached = findCapture(qc, c.sourceKey);
    if (!cached) throw new Error('capture not cached');
    void runWrite(qc, 'annotate', annotateVars(cached, { visibility: 'public' }));
    await flush();
    onlineManager.setOnline(true);
    await eventually(() => expect(pendingWrites(qc)).toHaveLength(0));
    expect(calls.map((x) => x.args[1])).toEqual([
      { visibility: 'hidden' },
      { visibility: 'public', ifUpdatedAt: '2026-11-20T10:00:01.000Z' },
    ]);
    expect(conflicts).toEqual([]);
    expect(findCapture(qc, c.sourceKey)?.effectiveVisibility).toBe('public');
  });

  it('editing a note that was written offline waits for the create and uses its version', async () => {
    const body: PostCreate = {
      publicId: 'p_01JXOFFLINEEDIT0000000001',
      kind: 'note',
      origLocale: 'de',
      occurredAt: '2026-11-15T09:00:00.000Z',
      tz: 'Asia/Ho_Chi_Minh',
      content: { de: { body: 'Erste Fassung' } },
    };
    let stored: AdminPost | null = null;
    const { qc, calls, conflicts } = setup({
      createPost: (b) => {
        stored = post({ ...(b as object), updatedAt: '2026-11-20T11:00:00.000Z', changeSeq: 7 } as never);
        return stored;
      },
      updatePost: (_id, patch: PostUpdate) => {
        if (!stored || (patch.ifUpdatedAt !== undefined && patch.ifUpdatedAt !== stored.updatedAt)) {
          throw new ApiRequestError(409, 'conflict', 'stale');
        }
        stored = { ...stored, ...(patch.content ? { content: patch.content } : {}) } as AdminPost;
        return { ...stored, updatedAt: '2026-11-20T11:00:05.000Z', changeSeq: 8 };
      },
    });
    onlineManager.setOnline(false);
    void runWrite(qc, 'createPost', { body });
    await flush();
    const optimistic = findPost(qc, body.publicId);
    if (!optimistic) throw new Error('post not cached');
    expect(optimistic.changeSeq).toBe(0);
    const draft = draftFromPost(optimistic, `edit:${body.publicId}`);
    expect(draft.base).toBeNull();
    const edited = { ...draft, content: { de: { title: '', body: 'Zweite Fassung' } } };
    const update = buildUpdate(edited, optimistic);
    if (!update) throw new Error('invalid draft');
    void runWrite(qc, 'updatePost', {
      publicId: body.publicId,
      kind: 'note',
      patch: update.patch,
      original: update.original,
      base: draft.base,
    });
    await flush();
    onlineManager.setOnline(true);
    await eventually(() => expect(pendingWrites(qc)).toHaveLength(0));
    expect(calls.map((x) => x.method)).toEqual(['createPost', 'updatePost']);
    expect((calls[1]?.args[1] as PostUpdate | undefined)?.ifUpdatedAt).toBe('2026-11-20T11:00:00.000Z');
    expect(conflicts).toEqual([]);
    expect(findPost(qc, body.publicId)?.content).toEqual({ de: { body: 'Zweite Fassung' } });
  });

  it('re-creating a deleted trip is not sent with the old row version', async () => {
    const t = trip();
    let n = 0;
    const { qc, calls } = setup({
      putTrip: (b) => ({ ...t, ...(b as object), updatedAt: `2026-11-20T12:00:0${++n}.000Z`, changeSeq: 20 + n }),
      deleteTrip: () => undefined,
    });
    qc.setQueryData<TripListResponse>(qk.trips, { items: [] });
    const body = { slug: t.slug, title: t.title, startDate: t.startDate, endDate: t.endDate, coverSourceKey: null };
    await runWrite(qc, 'putTrip', { body, base: null, original: {} });
    await runWrite(qc, 'deleteTrip', { slug: t.slug });
    await runWrite(qc, 'putTrip', { body, base: null, original: {} });
    expect(calls.map((x) => x.method)).toEqual(['putTrip', 'deleteTrip', 'putTrip']);
    expect(calls[2]?.args[0]).toMatchObject({ slug: t.slug });
    expect((calls[2]?.args[0] as TripUpsert | undefined)?.ifUpdatedAt).toBeUndefined();
  });
});

describe('trips are PUT as a whole', () => {
  it('a description left out of the body is cleared optimistically (as the API stores it)', () => {
    const qc = createAdminQueryClient({ onConflict: () => undefined, onUnauthorizedWrite: () => undefined });
    const t = trip({ description: { de: 'Von Hà Nội nach Sài Gòn' }, origLocale: 'de', coverSourceKey: 'wa:ABC' });
    qc.setQueryData<TripListResponse>(qk.trips, { items: [t] });
    const tx = new CacheTx(qc);
    optimisticPutTrip(
      tx,
      { body: { slug: t.slug, title: t.title, startDate: t.startDate, endDate: t.endDate }, base: null, original: {} },
      0,
    );
    const [after] = qc.getQueryData<TripListResponse>(qk.trips)?.items ?? [];
    expect(after?.description).toBeNull();
    expect(after?.origLocale).toBeNull();
    expect(after?.coverSourceKey).toBeNull();
    expect(after?.updatedAt).toBe(t.updatedAt);
  });
});

describe('composer drafts', () => {
  it('an edit started on an older version does not silently overwrite what changed since', () => {
    const v1 = post({
      content: { de: { body: 'Laternen am Fluss' }, en: { body: 'Lanterns by the river' } },
      updatedAt: '2026-11-15T05:00:00.000Z',
    });
    // Draft autosaved on this device, then the English text was fixed on another device.
    const draft = draftFromPost(v1, `edit:${v1.publicId}`);
    const typed = {
      ...draft,
      content: { ...draft.content, de: { title: '', body: 'Tausend Laternen am Fluss' } },
    };
    const v2 = post({
      content: { de: { body: 'Laternen am Fluss' }, en: { body: 'Lanterns by the river!' } },
      updatedAt: '2026-11-16T08:00:00.000Z',
    });
    const update = buildUpdate(typed, v2);
    if (!update) throw new Error('invalid draft');
    const vars: UpdatePostVars = {
      publicId: v1.publicId,
      kind: 'note',
      patch: update.patch,
      original: update.original,
      base: typed.base,
    };
    // Sent with the old base -> 409; the merge keeps the other device's English fix.
    expect(vars.base).toBe('2026-11-15T05:00:00.000Z');
    const plan = planUpdatePost(vars, v2);
    expect(plan.conflicts).toEqual([]);
    expect(plan.fields.map((f) => [f.id, f.status])).toEqual([['content.de', 'mine']]);
    expect(plan.merge().patch.content).toEqual({
      de: { body: 'Tausend Laternen am Fluss' },
      en: { body: 'Lanterns by the river!' },
    });
  });

  it('restoring a draft never overwrites another draft with text', () => {
    const a = {
      ...draftFromPost(post(), 'x'),
      id: 'new:note',
      editing: false,
      publicId: 'p_01JXAAAAAAAAAAAAAAAAAAAAAA',
    };
    draftStore.set({ 'new:note': { ...a, publicId: 'p_01JXBBBBBBBBBBBBBBBBBBBBBB' } });
    const id = restoreDraft(a);
    expect(id).toBe('new:note~p_01JXAAAAAAAAAAAAAAAAAAAAAA');
    expect(Object.keys(draftStore.get()).sort()).toEqual(['new:note', 'new:note~p_01JXAAAAAAAAAAAAAAAAAAAAAA']);
    expect(draftSearch({ ...a, id })).toEqual({ kind: 'note', draft: id });
    expect(draftSearch({ ...a, editing: true })).toEqual({ kind: 'note', post: a.publicId });
    expect(draftPreview({ origLocale: 'en', content: { de: { title: '', body: '  Hallo\n Welt ' } } })).toBe(
      'Hallo Welt',
    );
  });
});

describe('posts the API rejects come back as drafts', () => {
  it('a rejected create puts the text back into its draft and offers to open it', async () => {
    const opened: unknown[] = [];
    const { qc } = setup(
      {
        createPost: () => {
          throw new ApiRequestError(422, 'validation_failed', 'Too big');
        },
      },
      opened,
    );
    const body: PostCreate = {
      publicId: 'p_01JXREJECTED00000000000001',
      kind: 'story',
      origLocale: 'de',
      content: { de: { title: 'Mekong', body: 'Lange Geschichte' } },
    };
    await runWrite(qc, 'createPost', { body, draftId: 'new:story:2026-11-15' });
    expect(findPost(qc, body.publicId)).toBeUndefined();
    const draft = draftStore.get()['new:story:2026-11-15'];
    expect(draft).toMatchObject({
      kind: 'story',
      publicId: body.publicId,
      editing: false,
      content: { de: { title: 'Mekong', body: 'Lange Geschichte' } },
    });
    const notices = noticeStore.get();
    expect(notices.map((n) => n.tone)).toEqual(['error']);
    notices[0]?.action?.run();
    expect(opened).toMatchObject([{ id: 'new:story:2026-11-15' }]);
  });

  it('a rejected edit keeps the changes and the version they were based on', async () => {
    const p = post({ changeSeq: 5 });
    const { qc } = setup({
      updatePost: () => {
        throw new ApiRequestError(413, 'payload_too_large', 'Too large');
      },
    });
    qc.setQueryData(qk.post(p.publicId), p);
    await runWrite(qc, 'updatePost', {
      publicId: p.publicId,
      kind: 'note',
      patch: { content: { de: { body: 'Neu' } } },
      original: { content: p.content },
      base: p.updatedAt,
      draftId: `edit:${p.publicId}`,
    });
    expect(findPost(qc, p.publicId)?.content).toEqual(p.content);
    const draft = draftStore.get()[`edit:${p.publicId}`];
    expect(draft).toMatchObject({ editing: true, base: p.updatedAt, content: { de: { title: '', body: 'Neu' } } });
    expect(draft?.original?.content).toEqual(p.content);
  });

  it('other rejected writes still get the generic error toast', async () => {
    const c = capture();
    const { qc } = setup({
      annotate: () => {
        throw new ApiRequestError(422, 'validation_failed', 'nope');
      },
    });
    qc.setQueryData(qk.capture(c.sourceKey), c);
    await runWrite(qc, 'annotate', annotateVars(c, { visibility: 'hidden' }));
    expect(noticeStore.get().map((n) => [n.tone, !!n.action])).toEqual([['error', false]]);
    expect(Object.keys(draftStore.get())).toEqual([]);
  });
});
