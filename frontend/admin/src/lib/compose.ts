/**
 * Composer logic (pure, tested): drafts -> PostCreate / PostUpdate bodies and their validation.
 *   note:  per locale { body }, body <= 280 characters (UI convention, plan C)
 *   story: per locale { title, body }; a locale with text needs a non-blank title (contracts)
 * The original language must be one of the filled locales (PostCreate refinement); if the chosen
 * one is empty, the first filled locale is used.
 */
import type { Visibility } from '@omw/contracts';
import type { AdminPost, PostCreate } from '@omw/contracts/api';
import type { LocaleCode } from '@omw/contracts/i18n';
import { postLocally } from '../api/cache';
import { newPostPublicId } from '../api/client';
import { type PostFields, type UpdatePostVars, writeBase } from '../api/types';
import type { Draft, DraftKind, DraftLocale } from './drafts';
import { dirtyPatch } from './forms';

export const NOTE_MAX = 280;

export type ComposeProblem =
  | { code: 'empty' }
  | { code: 'too_long'; locale: LocaleCode; length: number }
  | { code: 'title_missing'; locale: LocaleCode };

type NoteContent = Partial<Record<LocaleCode, { body: string }>>;
type StoryContent = Partial<Record<LocaleCode, { title: string; body: string }>>;

export interface ComposeResult {
  content: NoteContent | StoryContent;
  filled: LocaleCode[];
  origLocale: LocaleCode | null;
  problems: ComposeProblem[];
}

const blank = (s: string | undefined) => !s || s.trim() === '';

/** Number of user-perceived characters (emoji count once). */
export function charCount(text: string): number {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    let n = 0;
    for (const _ of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) n++;
    return n;
  }
  return [...text].length;
}

export function composeContent(draft: Pick<Draft, 'kind' | 'content' | 'origLocale'>): ComposeResult {
  const problems: ComposeProblem[] = [];
  const filled: LocaleCode[] = [];
  const content: Record<string, { body: string } | { title: string; body: string }> = {};
  for (const [locale, value] of Object.entries(draft.content) as Array<[LocaleCode, DraftLocale | undefined]>) {
    if (!value) continue;
    const title = value.title?.trim() ?? '';
    const body = value.body.trim();
    if (draft.kind === 'note') {
      if (blank(body)) continue;
      const length = charCount(body);
      if (length > NOTE_MAX) problems.push({ code: 'too_long', locale, length });
      content[locale] = { body };
      filled.push(locale);
    } else {
      if (blank(title) && blank(body)) continue;
      if (blank(title)) problems.push({ code: 'title_missing', locale });
      content[locale] = { title, body };
      filled.push(locale);
    }
  }
  if (filled.length === 0) problems.unshift({ code: 'empty' });
  const origLocale = filled.includes(draft.origLocale) ? draft.origLocale : (filled[0] ?? null);
  return { content: content as ComposeResult['content'], filled, origLocale, problems };
}

export function newDraft(
  kind: DraftKind,
  opts: { id: string; origLocale: LocaleCode; occurredAt?: string | null; tz?: string | null; now?: Date },
): Draft {
  return {
    id: opts.id,
    kind,
    publicId: newPostPublicId(opts.now?.getTime()),
    editing: false,
    base: null,
    content: {},
    origLocale: opts.origLocale,
    visibility: 'public',
    occurredAt: opts.occurredAt ?? null,
    tz: opts.tz ?? null,
    savedAt: (opts.now ?? new Date()).toISOString(),
  };
}

function draftContent(content: PostCreate['content'] | AdminPost['content']): Draft['content'] {
  const out: Draft['content'] = {};
  for (const [locale, value] of Object.entries(content) as Array<[LocaleCode, { title?: string; body: string }]>) {
    out[locale] = { title: value.title ?? '', body: value.body };
  }
  return out;
}

export function draftFromPost(post: AdminPost, id: string, now = new Date()): Draft {
  return {
    id,
    kind: post.kind,
    publicId: post.publicId,
    editing: true,
    // A post only this device knows so far (created offline) has no server version yet.
    base: writeBase(post.updatedAt, post.changeSeq),
    original: postFields(post),
    content: draftContent(post.content),
    origLocale: post.origLocale,
    visibility: post.visibility,
    occurredAt: post.occurredAt,
    tz: post.tz,
    savedAt: now.toISOString(),
  };
}

/** A create the API rejected, back as a draft (same publicId, so a retry stays idempotent). */
export function draftFromCreate(body: PostCreate, id: string, now = new Date()): Draft {
  return {
    id,
    kind: body.kind,
    publicId: body.publicId,
    editing: false,
    base: null,
    content: draftContent(body.content),
    origLocale: body.origLocale,
    visibility: body.visibility ?? 'public',
    occurredAt: body.occurredAt ?? null,
    tz: body.tz ?? null,
    savedAt: now.toISOString(),
  };
}

/**
 * An edit the API rejected, back as a draft: the post as it is now (after the rollback) with the
 * rejected changes on top, keeping the edit's base and pre-edit values for a later merge.
 */
export function draftFromFailedUpdate(vars: UpdatePostVars, post: AdminPost, id: string, now = new Date()): Draft {
  const draft = draftFromPost(postLocally(post, vars.patch), id, now);
  return { ...draft, base: vars.base, original: { ...postFields(post), ...vars.original } };
}

/** POST /posts body (null while the draft has problems). */
export function buildCreate(draft: Draft): PostCreate | null {
  const result = composeContent(draft);
  if (result.problems.length > 0 || !result.origLocale) return null;
  const base = {
    publicId: draft.publicId,
    origLocale: result.origLocale,
    visibility: draft.visibility as Visibility,
    ...(draft.occurredAt ? { occurredAt: draft.occurredAt } : {}),
    ...(draft.tz ? { tz: draft.tz } : {}),
  };
  return draft.kind === 'note'
    ? { ...base, kind: 'note', content: result.content as NoteContent }
    : { ...base, kind: 'story', content: result.content as StoryContent };
}

export function postFields(post: AdminPost): Required<Omit<PostFields, 'tz'>> & { tz: string } {
  return {
    content: post.content,
    origLocale: post.origLocale,
    visibility: post.visibility,
    occurredAt: post.occurredAt,
    tz: post.tz,
  };
}

/**
 * PATCH /posts/{id}: only what the draft changed against the version it started from (null while
 * invalid). That version is the draft's `original`, not the current post: if the post changed on
 * the server meanwhile, the stale ifUpdatedAt gets a 409 and the three-way merge (conflicts.ts)
 * keeps both sides instead of silently writing the old text back.
 */
export function buildUpdate(
  draft: Draft,
  post: AdminPost,
): { patch: PostFields; original: PostFields; dirty: boolean } | null {
  const result = composeContent(draft);
  if (result.problems.length > 0 || !result.origLocale) return null;
  const before = { ...postFields(post), ...(draft.original ?? {}) };
  const edited = {
    content: result.content,
    origLocale: result.origLocale,
    visibility: draft.visibility,
    occurredAt: draft.occurredAt ?? before.occurredAt,
    tz: draft.tz ?? before.tz,
  };
  const { patch, original, dirty } = dirtyPatch(before as Record<string, unknown>, edited as Record<string, unknown>);
  // Content replaces all locales: always send it whole when it changed.
  return { patch: patch as PostFields, original: original as PostFields, dirty };
}
