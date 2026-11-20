/** Capture helpers shared by the inbox, the item sheet and the day editor. */
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { Visibility } from '@omw/contracts';
import type { CaptureListItem } from '@omw/contracts/api';
import { capturePublishAt, effectiveCaptureVisibility, type PolicySettings } from '@omw/contracts/policy';
import { type AnnotateVars, type AnnotationFields, writeBase } from '../api/types';

/** Annotation fields as they are now (the `original` of a patch). */
export function annotationFields(c: CaptureListItem): Required<AnnotationFields> {
  return {
    description: c.annotation?.description ?? null,
    origLocale: c.annotation?.origLocale ?? null,
    visibility: c.annotation?.visibility ?? null,
    localDateOverride: c.annotation?.localDateOverride ?? null,
  };
}

/** Write variables for an annotation patch of a capture as currently cached. */
export function annotateVars(c: CaptureListItem, patch: AnnotationFields): AnnotateVars {
  const current = annotationFields(c);
  const original: AnnotationFields = {};
  for (const key of Object.keys(patch) as Array<keyof AnnotationFields>) {
    (original as Record<string, unknown>)[key] = current[key];
  }
  return { sourceKey: c.sourceKey, patch, original, base: writeBase(c.annotation?.updatedAt, c.changeSeq) };
}

type CapturePolicy = Pick<CaptureListItem, 'occurredAt' | 'revokedAt'>;

/**
 * What the publish policy alone (no owner override) makes of a capture: mode, mode_since, delay
 * and revoke. Without cached settings only a revoke is known (hidden by the default on_revoke).
 */
export function automaticVisibility(
  c: CapturePolicy,
  settings: PolicySettings | undefined,
  now: number,
): Visibility | 'unknown' {
  if (!settings) return c.revokedAt ? 'hidden' : 'unknown';
  return effectiveCaptureVisibility(c, null, settings, now);
}

/**
 * The annotation visibility a one-tap toggle (card button, swipe) sets:
 * - visible -> hidden (explicit);
 * - hidden -> back to automatic (null), so delayed/review publishing keeps protecting a fresh
 *   status; explicit "public" only when the policy itself hides it (revoked with on_revoke=hide);
 * - waiting -> "public" (explicit): "Publish now" is a deliberate release.
 */
export function toggledVisibility(
  c: Pick<CaptureListItem, 'effectiveVisibility' | 'occurredAt' | 'revokedAt'>,
  settings: PolicySettings | undefined,
  now: number,
): Visibility | null {
  if (c.effectiveVisibility === 'public') return 'hidden';
  if (c.effectiveVisibility === 'pending') return 'public';
  return automaticVisibility(c, settings, now) === 'hidden' ? 'public' : null;
}

/** Where a capture ends up after setting its override to `next` (null = automatic). */
export type VisibilityOutcome =
  | { kind: 'public' | 'hidden' | 'review' | 'unknown' }
  | { kind: 'delayed'; publishAt: string | null };

export function visibilityOutcome(
  c: CapturePolicy,
  next: Visibility | null,
  settings: PolicySettings | undefined,
  now: number,
): VisibilityOutcome {
  if (next === 'public' || next === 'hidden') return { kind: next };
  const visibility = next ?? automaticVisibility(c, settings, now);
  if (visibility === 'pending') {
    if (next === null && settings?.['publish.mode'] === 'delayed') {
      return { kind: 'delayed', publishAt: capturePublishAt(c, null, settings) };
    }
    return { kind: 'review' };
  }
  return { kind: visibility };
}

/** Toast after a visibility change; `time` formats the delayed publish instant. */
export function visibilityNotice(outcome: VisibilityOutcome, time: (iso: string) => string): MessageDescriptor {
  switch (outcome.kind) {
    case 'hidden':
      return msg`Hidden from the site`;
    case 'public':
      return msg`Visible on the site`;
    case 'review':
      return msg`Waiting for your release`;
    case 'unknown':
      return msg`Follows the publish setting again`;
    case 'delayed': {
      if (!outcome.publishAt) return msg`Appears after the delay`;
      const at = time(outcome.publishAt);
      return msg`Appears after the delay (${at})`;
    }
  }
}

/** Captures that can be a day or trip cover (they have a picture). */
export function canBeCover(c: Pick<CaptureListItem, 'kind' | 'mediaState'>): boolean {
  return (c.kind === 'photo' || c.kind === 'video' || c.kind === 'gif') && c.mediaState !== 'lost';
}

/** Groups items by a date key, keeping the incoming order of groups and items. */
export function groupBy<T>(items: readonly T[], key: (item: T) => string): Array<{ key: string; items: T[] }> {
  const groups: Array<{ key: string; items: T[] }> = [];
  const index = new Map<string, { key: string; items: T[] }>();
  for (const item of items) {
    const k = key(item);
    let g = index.get(k);
    if (!g) {
      g = { key: k, items: [] };
      index.set(k, g);
      groups.push(g);
    }
    g.items.push(item);
  }
  return groups;
}
