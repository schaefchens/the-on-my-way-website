/**
 * Composer writes are optimistic: the draft is removed when the owner taps "Publish". If the API
 * then rejects the post for good (422, 413, 5xx after the retries), the rollback would make the
 * text disappear. This puts it back into a draft instead and offers to open it.
 * (409 conflicts and 401s never get here: they are merged / replayed after login.)
 */
import { msg } from '@lingui/core/macro';
import type { QueryClient } from '@tanstack/react-query';
import { findPost } from '../api/cache';
import type { MutationName } from '../api/keys';
import type { CreatePostVars, UpdatePostVars, WriteVars } from '../api/types';
import { draftFromCreate, draftFromFailedUpdate } from './compose';
import { type Draft, restoreDraft } from './drafts';
import { friendlyError } from './errors';
import { notify } from './notices';

/** Restores the draft of a rejected post write; returns it (null when nothing was restored). */
export function rescuePostDraft(qc: QueryClient, name: MutationName, vars: WriteVars[MutationName]): Draft | null {
  if (name === 'createPost') {
    const v = vars as CreatePostVars;
    const draft = draftFromCreate(v.body, v.draftId ?? `new:${v.body.kind}`);
    return { ...draft, id: restoreDraft(draft) };
  }
  if (name === 'updatePost') {
    const v = vars as UpdatePostVars;
    const post = findPost(qc, v.publicId);
    if (!post) return null;
    const draft = draftFromFailedUpdate(v, post, v.draftId ?? `edit:${v.publicId}`);
    return { ...draft, id: restoreDraft(draft) };
  }
  return null;
}

/** onFailedWrite of the QueryClient: rescue post texts and tell the owner where they are. */
export function createPostRescue(open: (draft: Draft) => void) {
  return (qc: QueryClient, name: MutationName, vars: WriteVars[MutationName], error: unknown, reason: string) => {
    const draft = rescuePostDraft(qc, name, vars);
    if (!draft) return false;
    const detail = friendlyError(error).detail;
    notify({
      tone: 'error',
      message: msg`Not saved: ${reason}. Your text is back in your drafts.`,
      action: { label: msg`Open draft`, run: () => open(draft) },
      timeoutMs: 15_000,
      ...(detail ? { detail } : {}),
    });
    return true;
  };
}
