/**
 * Offline-resumable owner writes: optimistic updates, queueing while offline, strict replay
 * order, ifUpdatedAt rebasing, rollback, failure routing and persistence across reloads.
 */
import type { AdminDayDetail, AnnotationPatch, CaptureListItem, PostCreate } from '@omw/contracts/api';
import { onlineManager } from '@tanstack/react-query';
import { persistQueryClientRestore, persistQueryClientSave } from '@tanstack/react-query-persist-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findCapture, findPost } from '../src/api/cache';
import { ApiRequestError } from '../src/api/client';
import { qk } from '../src/api/keys';
import { CACHE_BUSTER, createAdminPersister, dehydrateOptions } from '../src/api/persist';
import { createAdminQueryClient } from '../src/api/query-client';
import type { WriteVars } from '../src/api/types';
import { pendingWrites, resetVersions, runWrite, writeRetry } from '../src/api/writes';
import { annotateVars } from '../src/lib/captures';
import { noticeStore } from '../src/lib/notices';
import { capture, dayDetail, eventually, fakeApi, flush, post, settings } from './helpers';

type Impl = Parameters<typeof fakeApi>[0];

function setup(impl: Impl) {
  const { api, calls } = fakeApi(impl);
  const conflicts: Array<{ name: string; vars: unknown }> = [];
  const unauthorized: Array<{ name: string; vars: unknown }> = [];
  const qc = createAdminQueryClient({
    api,
    onConflict: (_qc, name, vars) => conflicts.push({ name, vars }),
    onUnauthorizedWrite: (_qc, name, vars) => unauthorized.push({ name, vars }),
  });
  // What QueryClientProvider does: resume paused writes / refetch when the device is online again.
  qc.mount();
  mounted.push(qc);
  return { qc, api, calls, conflicts, unauthorized };
}

const mounted: Array<{ unmount(): void }> = [];

const DATE = '2026-11-15';

function seed(qc: ReturnType<typeof setup>['qc'], c: CaptureListItem) {
  qc.setQueryData(qk.settings, settings);
  qc.setQueryData(qk.capture(c.sourceKey), c);
  qc.setQueryData<AdminDayDetail>(qk.day(DATE), dayDetail({ captures: [c] }));
}

/** What the API would answer for an annotation patch (server-side merge + new updatedAt). */
function answer(c: CaptureListItem, patch: AnnotationPatch, updatedAt: string): CaptureListItem {
  const { ifUpdatedAt: _if, ...fields } = patch;
  const annotation = { sourceKey: c.sourceKey, ...(c.annotation ?? {}), ...fields, updatedAt };
  return { ...c, annotation, effectiveVisibility: annotation.visibility ?? 'public', changeSeq: c.changeSeq + 1 };
}

beforeEach(() => {
  resetVersions();
  noticeStore.set([]);
});

afterEach(() => {
  onlineManager.setOnline(true);
  for (const qc of mounted.splice(0)) qc.unmount();
});

describe('owner writes', () => {
  it('queue while offline, apply optimistically and replay in order on reconnect', async () => {
    const c = capture();
    const { qc, calls } = setup({
      annotate: (_key, patch) => answer(c, patch, '2026-11-20T10:00:00.000Z'),
      createPost: (body) => post({ ...(body as object), changeSeq: 9 } as never),
    });
    seed(qc, c);
    onlineManager.setOnline(false);

    void runWrite(qc, 'annotate', annotateVars(c, { visibility: 'hidden' }));
    const body: PostCreate = {
      publicId: 'p_01JXTESTNOTE000000000000001',
      kind: 'note',
      origLocale: 'de',
      occurredAt: '2026-11-15T09:00:00.000Z',
      content: { de: { body: 'Offline geschrieben' } },
    };
    void runWrite(qc, 'createPost', { body });
    await flush();

    expect(calls).toHaveLength(0);
    expect(pendingWrites(qc).map((w) => [w.name, w.paused])).toEqual([
      ['annotate', true],
      ['createPost', true],
    ]);
    // Optimistic: the capture is hidden everywhere and the note sits on its day.
    expect(findCapture(qc, c.sourceKey)?.effectiveVisibility).toBe('hidden');
    expect(qc.getQueryData<AdminDayDetail>(qk.day(DATE))?.captures[0]?.effectiveVisibility).toBe('hidden');
    expect(qc.getQueryData<AdminDayDetail>(qk.day(DATE))?.posts.map((p) => p.publicId)).toEqual([body.publicId]);

    onlineManager.setOnline(true);
    await eventually(() => expect(calls.map((x) => x.method)).toEqual(['annotate', 'createPost']));
    // Never annotated before: the patch is sent without ifUpdatedAt.
    expect(calls[0]?.args).toEqual([c.sourceKey, { visibility: 'hidden' }]);
    expect(calls[1]?.args[0]).toMatchObject({ publicId: body.publicId });
    await eventually(() => expect(pendingWrites(qc)).toHaveLength(0));
    expect(findCapture(qc, c.sourceKey)?.annotation?.updatedAt).toBe('2026-11-20T10:00:00.000Z');
    expect(findPost(qc, body.publicId)?.changeSeq).toBe(9);
  });

  it('rebases ifUpdatedAt of a later queued edit onto the version an earlier one produced', async () => {
    const c = capture({
      annotation: { sourceKey: 'wa:3EB0B028C9D92EFF4C5B', visibility: null, updatedAt: '2026-11-15T10:00:00.000Z' },
      changeSeq: 2,
    });
    let version = 0;
    const { qc, calls } = setup({
      annotate: (_key, patch) => {
        version++;
        return answer(c, patch, `2026-11-20T10:00:0${version}.000Z`);
      },
    });
    seed(qc, c);
    onlineManager.setOnline(false);
    // Both edits were made on the version the device knew (A0).
    void runWrite(qc, 'annotate', annotateVars(c, { description: { de: 'Laternen' } }));
    void runWrite(qc, 'annotate', annotateVars(c, { visibility: 'hidden' }));
    await flush();
    onlineManager.setOnline(true);
    await eventually(() => expect(calls).toHaveLength(2));
    expect((calls[0]?.args[1] as AnnotationPatch | undefined)?.ifUpdatedAt).toBe('2026-11-15T10:00:00.000Z');
    expect((calls[1]?.args[1] as AnnotationPatch | undefined)?.ifUpdatedAt).toBe('2026-11-20T10:00:01.000Z');
  });

  it('rolls back the optimistic update when the API rejects the write', async () => {
    const c = capture();
    const { qc } = setup({
      annotate: () => {
        throw new ApiRequestError(422, 'validation_failed', 'Visibility is not allowed');
      },
    });
    seed(qc, c);
    await runWrite(qc, 'annotate', annotateVars(c, { visibility: 'hidden' }));
    expect(findCapture(qc, c.sourceKey)?.effectiveVisibility).toBe('public');
    expect(qc.getQueryData<AdminDayDetail>(qk.day(DATE))?.captures[0]?.effectiveVisibility).toBe('public');
    expect(noticeStore.get().map((n) => n.tone)).toEqual(['error']);
  });

  it('keeps the optimistic state of other queued writes when one of them fails', async () => {
    const a = capture();
    const b = capture({ sourceKey: 'wa:3EB0CCAE0F9B4D04143F', publicId: 'e_bbbbbbbbbbbb' });
    const { qc } = setup({
      annotate: (key, patch) => {
        if (key === a.sourceKey) throw new ApiRequestError(422, 'validation_failed', 'no');
        return answer(b, patch, '2026-11-20T11:00:00.000Z');
      },
    });
    seed(qc, a);
    qc.setQueryData(qk.capture(b.sourceKey), b);
    onlineManager.setOnline(false);
    void runWrite(qc, 'annotate', annotateVars(a, { visibility: 'hidden' }));
    void runWrite(qc, 'annotate', annotateVars(b, { visibility: 'hidden' }));
    await flush();
    onlineManager.setOnline(true);
    await eventually(() => expect(pendingWrites(qc)).toHaveLength(0));
    expect(findCapture(qc, a.sourceKey)?.effectiveVisibility).toBe('public');
    expect(findCapture(qc, b.sourceKey)?.effectiveVisibility).toBe('hidden');
  });

  it('routes 409 to the conflict handler and 401 to the outbox', async () => {
    const c = capture();
    const { qc, conflicts, unauthorized } = setup({
      annotate: () => {
        throw new ApiRequestError(409, 'conflict', 'changed elsewhere');
      },
      patchDay: () => {
        throw new ApiRequestError(401, 'unauthorized', 'session expired');
      },
    });
    seed(qc, c);
    const vars = annotateVars(c, { visibility: 'hidden' });
    await runWrite(qc, 'annotate', vars);
    await runWrite(qc, 'patchDay', {
      date: DATE,
      patch: { placeName: 'Hội An' },
      original: { placeName: null },
      base: null,
    });
    expect(conflicts).toEqual([{ name: 'annotate', vars }]);
    expect(unauthorized.map((u) => u.name)).toEqual(['patchDay']);
  });

  it('retries network failures forever, transient server errors a few times, client errors never', () => {
    expect(writeRetry(50, new ApiRequestError(0, 'network', 'offline'))).toBe(true);
    expect(writeRetry(1, new ApiRequestError(503, 'http_503', 'busy'))).toBe(true);
    expect(writeRetry(3, new ApiRequestError(503, 'http_503', 'busy'))).toBe(false);
    expect(writeRetry(0, new ApiRequestError(422, 'validation_failed', 'bad'))).toBe(false);
  });
});

describe('persistence', () => {
  it('a write queued offline survives a reload and is replayed exactly once', async () => {
    const storage = new Map<string, string>();
    const persister = createAdminPersister(
      {
        getItem: async (k) => storage.get(k) ?? null,
        setItem: async (k, v) => storage.set(k, v),
        removeItem: async (k) => {
          storage.delete(k);
        },
      },
      0,
    );
    const body: PostCreate = {
      publicId: 'p_01JXTESTRELOAD00000000001',
      kind: 'note',
      origLocale: 'en',
      content: { en: { body: 'Written on the bus' } },
    };

    // Device goes offline, the owner writes a note, the app is closed.
    const first = setup({});
    first.qc.setQueryData(qk.settings, settings);
    onlineManager.setOnline(false);
    void runWrite(first.qc, 'createPost', { body } satisfies WriteVars['createPost']);
    await flush();
    await persistQueryClientSave({ queryClient: first.qc, persister, buster: CACHE_BUSTER, dehydrateOptions });
    const saved = JSON.parse(storage.values().next().value ?? '{}');
    expect(saved.clientState.mutations).toHaveLength(1);
    expect(saved.clientState.mutations[0].state.isPaused).toBe(true);
    expect(first.calls).toHaveLength(0);

    // The app starts again (online) and restores the cache: the note is sent once.
    onlineManager.setOnline(true);
    const second = setup({ createPost: (b) => post({ ...(b as object), changeSeq: 4 } as never) });
    await persistQueryClientRestore({ queryClient: second.qc, persister, buster: CACHE_BUSTER });
    await second.qc.resumePausedMutations();
    await eventually(() => expect(second.calls.map((c) => c.method)).toEqual(['createPost']));
    expect(second.calls[0]?.args[0]).toMatchObject({ publicId: body.publicId });
    await eventually(() => expect(findPost(second.qc, body.publicId)?.changeSeq).toBe(4));
    expect(pendingWrites(second.qc)).toHaveLength(0);
  });

  it('does not persist failed queries or the auth/token queries', async () => {
    const { qc } = setup({});
    qc.setQueryData(qk.settings, settings);
    qc.setQueryData(['admin', 'auth'], { me: null, error: null });
    const authQuery = qc.getQueryCache().find({ queryKey: ['admin', 'auth'] });
    if (authQuery) authQuery.options.meta = { persist: false };
    const queries = qc.getQueryCache().getAll();
    expect(queries.filter((q) => dehydrateOptions.shouldDehydrateQuery(q)).map((q) => q.queryKey)).toEqual([
      qk.settings,
    ]);
  });
});
