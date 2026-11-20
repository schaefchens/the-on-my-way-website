/**
 * Composer drafts, autosaved on this device (localStorage) while typing. A draft keeps the
 * publicId it will be created with, so publishing twice (double tap, offline replay) can never
 * create two posts. Drafts of existing posts remember the post and the updatedAt they started
 * from (for ifUpdatedAt).
 */

import type { Visibility } from '@omw/contracts';
import type { LocaleCode } from '@omw/contracts/i18n';
import type { PostFields } from '../api/types';
import { createStore, localStore } from './store';

export type DraftKind = 'note' | 'story';

export interface DraftLocale {
  title: string;
  body: string;
}

export interface Draft {
  id: string;
  kind: DraftKind;
  /** publicId the new post will get, or the edited post's id. */
  publicId: string;
  /** True when the draft edits an existing post. */
  editing: boolean;
  /** updatedAt of the edited post when editing started (null: no server version yet). */
  base: string | null;
  /**
   * The edited post's fields when editing started: the "before" of the three-way merge, so an
   * edit made on an older version never silently overwrites what changed on the server since.
   * Absent in drafts saved by older app versions (then the current post is used).
   */
  original?: PostFields;
  content: Partial<Record<LocaleCode, DraftLocale>>;
  origLocale: LocaleCode;
  visibility: Visibility;
  /** ISO instant chosen by the owner (null = "now" when publishing). */
  occurredAt: string | null;
  tz: string | null;
  savedAt: string;
}

const KEY = 'omw.admin.drafts';
export const draftStore = createStore<Record<string, Draft>>(localStore.read<Record<string, Draft>>(KEY, {}));
draftStore.subscribe(() => {
  const drafts = draftStore.get();
  localStore.write(KEY, Object.keys(drafts).length ? drafts : null);
});

export function saveDraft(draft: Draft): void {
  draftStore.set((all) => ({ ...all, [draft.id]: draft }));
}

export function removeDraft(id: string): void {
  draftStore.set((all) => {
    if (!(id in all)) return all;
    const { [id]: _removed, ...rest } = all;
    return rest;
  });
}

export function clearDrafts(): void {
  draftStore.set({});
}

export function draftHasText(draft: Pick<Draft, 'content'>): boolean {
  return Object.values(draft.content).some((c) => c && (c.body.trim() !== '' || c.title.trim() !== ''));
}

/** Drafts with text, newest first. */
export function listDrafts(all: Record<string, Draft>): Draft[] {
  return Object.values(all)
    .filter(draftHasText)
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

/**
 * Puts a draft back after the API rejected it. Never overwrites another draft with text: the
 * restored one then gets its own id. Returns the id it was stored under.
 */
export function restoreDraft(draft: Draft, now = new Date()): string {
  const taken = draftStore.get()[draft.id];
  const id =
    taken && draftHasText(taken) && taken.publicId !== draft.publicId ? `${draft.id}~${draft.publicId}` : draft.id;
  saveDraft({ ...draft, id, savedAt: now.toISOString() });
  return id;
}

/** Composer search params that open a draft. */
export function draftSearch(draft: Pick<Draft, 'id' | 'kind' | 'editing' | 'publicId'>) {
  return draft.editing
    ? { kind: draft.kind, post: draft.publicId }
    : ({ kind: draft.kind, draft: draft.id } as { kind: DraftKind; post?: string; draft?: string });
}

/** First words of a draft (title, else text) for lists. */
export function draftPreview(draft: Pick<Draft, 'content' | 'origLocale'>): string {
  const hasText = (c: DraftLocale | undefined): c is DraftLocale => !!c && !!(c.title.trim() || c.body.trim());
  const orig = draft.content[draft.origLocale];
  const first = hasText(orig) ? orig : Object.values(draft.content).find(hasText);
  const text = (first?.title.trim() || first?.body.trim() || '').replace(/\s+/g, ' ');
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

// ---------------------------------------------------------------------------------------------
// Field drafts: unsaved edits of the day editor and of a status description, autosaved on this
// device so leaving the screen (tab bar, back, reload, a closed app) never loses them.
//
// A draft is keyed by the entity AND the server version (updatedAt) the edit started from:
// saving it later sends that version as ifUpdatedAt, so if the item changed elsewhere in the
// meantime the normal 409 path merges per field (or asks) instead of overwriting newer text.
// One draft per entity: a newer edit replaces an older one. A draft that was sent stays until
// the server confirmed the write (writes.ts -> settleFieldDraft); if the write fails for good it
// is still there and comes back as "Not saved yet".

export interface FieldDraft<F extends object = Record<string, unknown>> {
  /** fieldDraftKey(entity, base). */
  key: string;
  /** "day:2026-11-20", "capture:wa:…" (api/types.ts entityOf). */
  entity: string;
  /** updatedAt the edit started from (null: no server row yet). */
  base: string | null;
  /** API values of the edited fields when editing started (the "before" of a three-way merge). */
  original: Record<string, unknown>;
  /** The edited form fields, as typed (e.g. coordinates as text). */
  form: Partial<F>;
  savedAt: string;
  /** Set when a save was sent; the draft is hidden while that write is pending. */
  sentAt?: string;
}

const FIELD_KEY = 'omw.admin.fieldDrafts';

export const fieldDraftStore = createStore<Record<string, FieldDraft>>(
  localStore.read<Record<string, FieldDraft>>(FIELD_KEY, {}),
);
fieldDraftStore.subscribe(() => {
  const drafts = fieldDraftStore.get();
  localStore.write(FIELD_KEY, Object.keys(drafts).length ? drafts : null);
});

export function fieldDraftKey(entity: string, base: string | null): string {
  return `${entity}@${base ?? '-'}`;
}

/** The draft of an entity (newest, whatever version it started from), or null. */
export function findFieldDraft<F extends object>(
  all: Record<string, FieldDraft>,
  entity: string,
): FieldDraft<F> | null {
  let found: FieldDraft | null = null;
  for (const d of Object.values(all)) {
    if (d.entity === entity && (!found || d.savedAt > found.savedAt)) found = d;
  }
  return found as FieldDraft<F> | null;
}

/** Stores a draft (replacing every other draft of the same entity). */
export function saveFieldDraft<F extends object>(draft: FieldDraft<F>): void {
  fieldDraftStore.set((all) => {
    const next: Record<string, FieldDraft> = {};
    for (const [k, d] of Object.entries(all)) if (d.entity !== draft.entity) next[k] = d;
    next[draft.key] = draft as FieldDraft;
    return next;
  });
}

export function removeFieldDrafts(entity: string): void {
  fieldDraftStore.set((all) => {
    if (!Object.values(all).some((d) => d.entity === entity)) return all;
    return Object.fromEntries(Object.entries(all).filter(([, d]) => d.entity !== entity));
  });
}

/**
 * The write that saved a draft was confirmed (or the owner settled its conflict): drop the
 * draft, unless it was edited again after it was sent.
 */
export function settleFieldDraft(ref: { key: string; savedAt: string }): void {
  fieldDraftStore.set((all) => {
    const d = all[ref.key];
    if (!d || d.savedAt > ref.savedAt) return all;
    const { [ref.key]: _done, ...rest } = all;
    return rest;
  });
}

export function clearFieldDrafts(): void {
  fieldDraftStore.set({});
}
