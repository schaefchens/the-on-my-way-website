/**
 * Form state of an editor whose edits must never be lost (day editor, status description):
 *
 * - Seeded from the server values; while untouched, a newer server version re-seeds it.
 * - The first edit freezes the version the edit is based on (its values = the three-way merge
 *   "original", its updatedAt = ifUpdatedAt). Fields the owner did not touch are never sent, so
 *   a change made elsewhere meanwhile is not overwritten with the stale value the form showed.
 * - Every edit is autosaved (debounced, flushed when the page is hidden) as a field draft
 *   (lib/drafts.ts). Coming back restores it: `restored` drives the "Not saved yet" bar.
 * - `markSent()` (on Save) stamps the draft as sent and returns the reference the write carries:
 *   the draft is dropped when the server confirms the write, kept if it fails for good.
 * - `discard()` drops the edit and the draft.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sameValue } from '../api/conflicts';
import type { DraftRef } from '../api/types';
import {
  type FieldDraft,
  fieldDraftKey,
  fieldDraftStore,
  findFieldDraft,
  removeFieldDrafts,
  saveFieldDraft,
} from './drafts';

export interface DraftedFormOptions<F extends object, A extends Record<string, unknown>> {
  /** "day:2026-11-20", "capture:wa:…" (api/types.ts entityOf). */
  entity: string;
  /** updatedAt of the cached server version (re-seeds an untouched form when it changes). */
  version: string | null | undefined;
  /** ifUpdatedAt a save would carry now (api/types.ts writeBase). */
  base: string | null;
  /** The server values are loaded. */
  ready: boolean;
  /** Editable fields as the API holds them now. */
  fields: A;
  toForm: (fields: A) => F;
  /** A write of this entity is queued or in flight (a sent draft is not restored meanwhile). */
  pending: boolean;
  /** Autosave debounce (ms). */
  saveDelayMs?: number;
}

interface Frozen<A> {
  baseline: A;
  base: string | null;
}

interface State<F, A> {
  form: F;
  version: string | null | undefined;
  ready: boolean;
  touched: boolean;
  frozen: Frozen<A> | null;
  restored: boolean;
}

function changedKeys<F extends object>(form: F, seed: F): Array<keyof F & string> {
  return (Object.keys(form) as Array<keyof F & string>).filter((k) => !sameValue(form[k], seed[k]));
}

function pick<T extends object>(obj: T, keys: readonly string[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (k in obj) (out as Record<string, unknown>)[k] = (obj as Record<string, unknown>)[k];
  return out;
}

export function useDraftedForm<F extends object, A extends Record<string, unknown>>(o: DraftedFormOptions<F, A>) {
  const { entity, toForm } = o;
  const restore = (): State<F, A> | null => {
    if (!o.ready) return null;
    const draft = findFieldDraft<F>(fieldDraftStore.get(), entity);
    if (!draft || (draft.sentAt && o.pending)) return null;
    const form = { ...toForm(o.fields), ...draft.form } as F;
    const baseline = { ...o.fields, ...(draft.original as Partial<A>) } as A;
    // Nothing left to save (the write landed, the app closed before it heard back): drop it.
    if (changedKeys(form, toForm(o.fields)).length === 0) {
      removeFieldDrafts(entity);
      return null;
    }
    return {
      form,
      version: o.version,
      ready: true,
      touched: true,
      frozen: { baseline, base: draft.base },
      restored: true,
    };
  };
  const [state, setState] = useState<State<F, A>>(
    () =>
      restore() ?? {
        form: toForm(o.fields),
        version: o.version,
        ready: o.ready,
        touched: false,
        frozen: null,
        restored: false,
      },
  );
  if (o.ready && !state.touched && (state.version !== o.version || !state.ready)) {
    // First load or a newer server version while untouched: (re)seed, or restore a draft.
    setState(
      (!state.ready ? restore() : null) ?? {
        form: toForm(o.fields),
        version: o.version,
        ready: true,
        touched: false,
        frozen: null,
        restored: false,
      },
    );
  }

  const live = useRef({ fields: o.fields, base: o.base });
  live.current = { fields: o.fields, base: o.base };

  const edit = useCallback(
    (fn: (form: F) => F) =>
      setState((s) => ({
        ...s,
        form: fn(s.form),
        touched: true,
        // The version this edit is based on: what the form showed when editing started.
        frozen: s.frozen ?? { baseline: live.current.fields, base: live.current.base },
      })),
    [],
  );

  const baseline = state.frozen?.baseline ?? o.fields;
  const base = state.frozen ? state.frozen.base : o.base;

  // ---- autosave
  const latest = useRef({ state, entity, toForm });
  latest.current = { state, entity, toForm };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback((sentAt?: string): FieldDraft<F> | null => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const { state: s, entity: e, toForm: seed } = latest.current;
    if (!s.touched || !s.frozen) return null;
    const keys = changedKeys(s.form, seed(s.frozen.baseline));
    if (keys.length === 0) {
      removeFieldDrafts(e);
      return null;
    }
    const savedAt = new Date().toISOString();
    const draft: FieldDraft<F> = {
      key: fieldDraftKey(e, s.frozen.base),
      entity: e,
      base: s.frozen.base,
      original: pick(s.frozen.baseline, keys),
      form: pick(s.form, keys),
      savedAt,
      ...(sentAt ? { sentAt } : {}),
    };
    saveFieldDraft(draft);
    return draft;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: every edit (state.form) restarts the debounce
  useEffect(() => {
    if (!state.touched) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => persist(), o.saveDelayMs ?? 400);
  }, [state.form, state.touched, persist, o.saveDelayMs]);

  useEffect(() => {
    if (!state.touched) return;
    // Leaving the page (reload, app switch, closed tab): write the draft now.
    const flush = () => void persist();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [state.touched, persist]);

  // Unmount (in-app navigation): keep what was typed.
  useEffect(
    () => () => {
      if (latest.current.state.touched) persist();
    },
    [persist],
  );

  /** Save was tapped: stamp the draft as sent; the write carries the returned reference. */
  const markSent = useCallback((): DraftRef | undefined => {
    const draft = persist(new Date().toISOString());
    setState((s) => ({ ...s, touched: false, frozen: null, restored: false }));
    return draft ? { key: draft.key, savedAt: draft.savedAt } : undefined;
  }, [persist]);

  const discard = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    removeFieldDrafts(latest.current.entity);
    setState({
      form: toForm(live.current.fields),
      version: o.version,
      ready: o.ready,
      touched: false,
      frozen: null,
      restored: false,
    });
  }, [toForm, o.version, o.ready]);

  return useMemo(
    () => ({
      form: state.form,
      edit,
      touched: state.touched,
      /** The edit came back from a draft saved on this device. */
      restored: state.restored,
      /** API values the edit is based on (the three-way merge "original"). */
      baseline,
      /** ifUpdatedAt of a save. */
      base,
      markSent,
      discard,
    }),
    [state.form, state.touched, state.restored, edit, baseline, base, markSent, discard],
  );
}
