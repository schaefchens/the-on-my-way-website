/**
 * 409 "conflict" handling: three-way merge of a failed write against the newer server version.
 *
 * For every field (localized fields: every locale) the write changed, compare
 *   mine   = the value the write wanted,
 *   base   = the value before the edit (vars.original),
 *   server = the value the server has now.
 * - mine == server          -> "same" (nothing to do)
 * - server == base          -> "mine" (only we changed it: apply silently)
 * - otherwise               -> "conflict" (both changed it: the owner chooses, default mine)
 * Fields the write did not change always keep the server value.
 *
 * No conflicting field -> the write is retried at once with the merged patch and the server's
 * updatedAt ("merged automatically"); everything "same" -> it was already applied (e.g. a
 * replayed request whose first answer got lost). Otherwise the conflict goes to the dialog.
 */

import { msg } from '@lingui/core/macro';
import type { AdminPost, AdminTrip, Annotation, CaptureListItem, Day } from '@omw/contracts/api';
import type { QueryClient } from '@tanstack/react-query';
import { settleFieldDraft } from '../lib/drafts';
import { notify, settleWriteNotice } from '../lib/notices';
import { createStore } from '../lib/store';
import { CacheTx, confirmDay, putCapture, putPost, putTrip } from './cache';
import { type AdminApi, ApiRequestError, adminApi } from './client';
import type { MutationName } from './keys';
import { qk } from './keys';
import {
  type AnnotateVars,
  type AnnotationFields,
  type DayFields,
  entityOf,
  type PatchDayVars,
  type PostFields,
  type PutTripVars,
  type TripBody,
  type UpdatePostVars,
  type WriteVars,
} from './types';
import { forgetVersions, pruneVersions, runWrite } from './writes';

export type FieldStatus = 'same' | 'mine' | 'conflict';
export type Choice = 'mine' | 'server';

export interface FieldDiff {
  /** "title" or "title.de". */
  id: string;
  field: string;
  locale: string | null;
  mine: unknown;
  base: unknown;
  server: unknown;
  status: FieldStatus;
}

/** Writes with ifUpdatedAt (the only ones that can conflict). */
export type ConflictingWrite = 'annotate' | 'patchDay' | 'updatePost' | 'putTrip';

export interface ServerVersion {
  /** null: the entity does not exist (any more) on the server. */
  values: Record<string, unknown> | null;
  updatedAt: string | null;
}

export interface MergePlan<N extends ConflictingWrite = ConflictingWrite> {
  name: N;
  fields: FieldDiff[];
  conflicts: FieldDiff[];
  alreadyApplied: boolean;
  /** The server deleted the entity. */
  gone: boolean;
  /**
   * New variables for the given choices (conflict id -> choice; default mine). Their base is the
   * fetched server version, marked `exactBase`: it is sent as is, never rebased (writes.ts).
   */
  merge(choices?: Record<string, Choice>): WriteVars[N];
  /** updatedAt of the server version the plan was made against (null: no row). */
  serverUpdatedAt: string | null;
}

// ---------------------------------------------------------------------------------------------
// Value comparison

function blank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function canonical(v: unknown): unknown {
  if (blank(v)) return null;
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const c = canonical((v as Record<string, unknown>)[k]);
      if (c !== null) out[k] = c;
    }
    return Object.keys(out).length ? out : null;
  }
  return v;
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function statusOf(mine: unknown, base: unknown, server: unknown): FieldStatus | null {
  if (sameValue(mine, base)) return null; // not changed by this write
  if (sameValue(mine, server)) return 'same';
  if (sameValue(server, base)) return 'mine';
  return 'conflict';
}

type Dict = Record<string, unknown>;
const asDict = (v: unknown): Dict => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : {});

/** Per-field (and per-locale for localized maps) diff of a patch against base and server. */
export function diffFields(
  patch: Dict,
  original: Dict,
  server: Dict | null,
  localized: ReadonlySet<string>,
): FieldDiff[] {
  const out: FieldDiff[] = [];
  const srv = server ?? {};
  for (const field of Object.keys(patch)) {
    const mine = patch[field];
    if (mine === undefined) continue;
    if (localized.has(field)) {
      const m = asDict(mine);
      const b = asDict(original[field]);
      const s = asDict(srv[field]);
      const locales = [...new Set([...Object.keys(m), ...Object.keys(b), ...Object.keys(s)])].sort();
      for (const locale of locales) {
        const status = statusOf(m[locale], b[locale], s[locale]);
        if (status) {
          out.push({
            id: `${field}.${locale}`,
            field,
            locale,
            mine: m[locale],
            base: b[locale],
            server: s[locale],
            status,
          });
        }
      }
    } else {
      const status = statusOf(mine, original[field], srv[field]);
      if (status) out.push({ id: field, field, locale: null, mine, base: original[field], server: srv[field], status });
    }
  }
  return out;
}

/** Builds the patch to send: chosen "mine" values over the server's current values. */
export function mergePatch(
  patch: Dict,
  server: Dict | null,
  fields: readonly FieldDiff[],
  localized: ReadonlySet<string>,
  choices: Record<string, Choice> = {},
): { patch: Dict; original: Dict } {
  const srv = server ?? {};
  const takeMine = (f: FieldDiff) => f.status === 'mine' || (f.status === 'conflict' && choices[f.id] !== 'server');
  const outPatch: Dict = {};
  const outOriginal: Dict = {};
  for (const field of Object.keys(patch)) {
    const mine = fields.filter((f) => f.field === field && takeMine(f));
    if (mine.length === 0) continue;
    if (localized.has(field)) {
      const merged: Dict = { ...asDict(srv[field]) };
      for (const f of mine) {
        if (f.locale === null) continue;
        if (blank(f.mine)) delete merged[f.locale];
        else merged[f.locale] = f.mine;
      }
      outPatch[field] = Object.keys(merged).length ? merged : null;
    } else {
      outPatch[field] = patch[field];
    }
    outOriginal[field] = srv[field] ?? null;
  }
  return { patch: outPatch, original: outOriginal };
}

// ---------------------------------------------------------------------------------------------
// Plans per write

const ANNOTATION_LOCALIZED = new Set(['description']);
const DAY_LOCALIZED = new Set(['title', 'summary']);
const POST_LOCALIZED = new Set(['content']);
const TRIP_LOCALIZED = new Set(['title', 'description']);

function plan<N extends ConflictingWrite>(
  name: N,
  patch: Dict,
  original: Dict,
  server: ServerVersion,
  localized: ReadonlySet<string>,
  build: (patch: Dict, original: Dict, base: string | null) => WriteVars[N],
): MergePlan<N> {
  const fields = diffFields(patch, original, server.values, localized);
  const conflicts = fields.filter((f) => f.status === 'conflict');
  return {
    name,
    fields,
    conflicts,
    gone: server.values === null,
    alreadyApplied: server.values !== null && fields.every((f) => f.status === 'same'),
    merge(choices) {
      const merged = mergePatch(patch, server.values, fields, localized, choices);
      return build(merged.patch, merged.original, server.updatedAt);
    },
    serverUpdatedAt: server.updatedAt,
  };
}

/** Bookkeeping fields a merged write keeps from the failed one (the editor draft it settles). */
function carried(vars: AnnotateVars | PatchDayVars): Pick<AnnotateVars, 'draft'> {
  return vars.draft ? { draft: vars.draft } : {};
}

export function annotationValues(a: Annotation | null | undefined): Record<string, unknown> {
  return {
    description: a?.description ?? null,
    origLocale: a?.origLocale ?? null,
    visibility: a?.visibility ?? null,
    localDateOverride: a?.localDateOverride ?? null,
  };
}

export function planAnnotate(vars: AnnotateVars, server: CaptureListItem | null): MergePlan<'annotate'> {
  // A capture always exists; a missing annotation row means "nothing annotated yet".
  const version: ServerVersion = server
    ? { values: annotationValues(server.annotation), updatedAt: server.annotation?.updatedAt ?? null }
    : { values: null, updatedAt: null };
  return plan('annotate', vars.patch, vars.original, version, ANNOTATION_LOCALIZED, (patch, original, base) => ({
    ...carried(vars),
    sourceKey: vars.sourceKey,
    patch: patch as AnnotationFields,
    original: original as AnnotationFields,
    base,
    exactBase: true,
  }));
}

export function dayValues(day: Day | null | undefined): Record<string, unknown> {
  return {
    title: day?.title ?? null,
    summary: day?.summary ?? null,
    origLocale: day?.origLocale ?? null,
    placeName: day?.placeName ?? null,
    countryCode: day?.countryCode ?? null,
    lat: day?.lat ?? null,
    lng: day?.lng ?? null,
    coverSourceKey: day?.coverSourceKey ?? null,
    tz: day?.tz ?? null,
  };
}

export function planPatchDay(vars: PatchDayVars, server: Day | null): MergePlan<'patchDay'> {
  // A day without a row is an empty day (PATCH creates it), never "gone".
  const version: ServerVersion = { values: dayValues(server), updatedAt: server?.updatedAt ?? null };
  return plan('patchDay', vars.patch, vars.original, version, DAY_LOCALIZED, (patch, original, base) => ({
    ...carried(vars),
    date: vars.date,
    patch: patch as DayFields,
    original: original as DayFields,
    base,
    exactBase: true,
  }));
}

export function postValues(post: AdminPost | null): Record<string, unknown> | null {
  if (!post) return null;
  return {
    content: post.content,
    origLocale: post.origLocale,
    visibility: post.visibility,
    occurredAt: post.occurredAt,
    tz: post.tz,
  };
}

export function planUpdatePost(vars: UpdatePostVars, server: AdminPost | null): MergePlan<'updatePost'> {
  const version: ServerVersion = { values: postValues(server), updatedAt: server?.updatedAt ?? null };
  return plan('updatePost', vars.patch, vars.original, version, POST_LOCALIZED, (patch, original, base) => ({
    publicId: vars.publicId,
    kind: vars.kind,
    patch: patch as PostFields,
    original: original as PostFields,
    base,
    exactBase: true,
    ...(vars.draftId ? { draftId: vars.draftId } : {}),
  }));
}

export function tripValues(trip: AdminTrip | null): Record<string, unknown> | null {
  if (!trip) return null;
  return {
    title: trip.title,
    description: trip.description ?? null,
    origLocale: trip.origLocale ?? null,
    startDate: trip.startDate,
    endDate: trip.endDate,
    coverSourceKey: trip.coverSourceKey ?? null,
  };
}

/** Trips are PUT as a whole: the "patch" is every field that differs from the original. */
export function planPutTrip(vars: PutTripVars, server: AdminTrip | null): MergePlan<'putTrip'> {
  const body = vars.body as unknown as Dict;
  const changed: Dict = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'slug') continue;
    if (!sameValue(v, (vars.original as Dict)[k])) changed[k] = v;
  }
  const values = tripValues(server);
  const version: ServerVersion = { values, updatedAt: server?.updatedAt ?? null };
  return plan('putTrip', changed, vars.original as Dict, version, TRIP_LOCALIZED, (patch) => {
    // Rebuild a full body: server values (or, if the trip is gone, mine) + chosen fields.
    const fromServer = values ?? body;
    const next: Dict = { slug: vars.body.slug };
    for (const k of ['title', 'description', 'origLocale', 'startDate', 'endDate', 'coverSourceKey']) {
      const v = k in patch ? patch[k] : fromServer[k];
      if (v !== null && v !== undefined) next[k] = v;
      else if (k === 'coverSourceKey') next[k] = null;
    }
    return {
      body: next as unknown as TripBody,
      base: server?.updatedAt ?? null,
      exactBase: true,
      original: (values ?? {}) as Partial<TripBody>,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Store + resolution

export interface Conflict {
  id: number;
  name: ConflictingWrite;
  vars: WriteVars[ConflictingWrite];
  plan: MergePlan;
}

export const conflictStore = createStore<Conflict[]>([]);
let nextConflictId = 1;

function isConflicting(name: MutationName): name is ConflictingWrite {
  return name === 'annotate' || name === 'patchDay' || name === 'updatePost' || name === 'putTrip';
}

async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) return null;
    throw err;
  }
}

/** Fetches the newer server version, writes it into the caches and builds the merge plan. */
export async function planConflict(
  qc: QueryClient,
  name: ConflictingWrite,
  vars: WriteVars[ConflictingWrite],
  api: AdminApi = adminApi,
): Promise<MergePlan> {
  const tx = new CacheTx(qc, false);
  let result: MergePlan;
  switch (name) {
    case 'annotate': {
      const v = vars as AnnotateVars;
      const server = await orNull(api.capture(v.sourceKey));
      if (server) {
        tx.set(qk.capture(server.sourceKey), server);
        putCapture(tx, server);
      }
      result = planAnnotate(v, server);
      break;
    }
    case 'patchDay': {
      const v = vars as PatchDayVars;
      const detail = await api.day(v.date);
      confirmDay(tx, detail);
      result = planPatchDay(v, detail.day);
      break;
    }
    case 'updatePost': {
      const v = vars as UpdatePostVars;
      const server = await orNull(api.post(v.publicId));
      if (server) putPost(tx, server);
      result = planUpdatePost(v, server);
      break;
    }
    case 'putTrip': {
      const v = vars as PutTripVars;
      const server = await orNull(api.trip(v.body.slug));
      if (server) putTrip(tx, server);
      result = planPutTrip(v, server);
      break;
    }
  }
  // The server's version is known now: rebases that do not lead to it are stale (it moved on
  // elsewhere or went back to an older version), and following them would 409 again.
  pruneVersions(entityOf(name, vars), result.serverUpdatedAt);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Loop guard: a server that keeps answering 409 (or keeps changing) must not make the app send
// merge after merge. At most AUTO_MERGE_LIMIT automatic merges per entity and minute; after that
// the owner decides (the sheet when fields collide, else an error with "Try again").

export const AUTO_MERGE_LIMIT = 2;
const AUTO_MERGE_WINDOW_MS = 60_000;
const autoMerges = new Map<string, number[]>();

function takeAutoMerge(entity: string, now: number): boolean {
  const recent = (autoMerges.get(entity) ?? []).filter((t) => now - t < AUTO_MERGE_WINDOW_MS);
  if (recent.length >= AUTO_MERGE_LIMIT) {
    autoMerges.set(entity, recent);
    return false;
  }
  autoMerges.set(entity, [...recent, now]);
  return true;
}

/** Forgets the automatic merges counted so far (tests; a fresh session). */
export function resetConflictGuard(): void {
  autoMerges.clear();
}

/** Entry point from the mutation cache (writes.ts onConflict). */
export async function handleConflict(
  qc: QueryClient,
  name: MutationName,
  vars: WriteVars[MutationName],
  api: AdminApi = adminApi,
  now: () => number = Date.now,
): Promise<void> {
  if (!isConflicting(name)) return;
  let mergePlan: MergePlan;
  try {
    mergePlan = await planConflict(qc, name, vars as WriteVars[ConflictingWrite], api);
  } catch {
    settleWriteNotice(entityOf(name, vars as WriteVars[ConflictingWrite]), false);
    notify({ tone: 'error', message: msg`Changed elsewhere, and the newer version could not be loaded.` });
    return;
  }
  const entity = entityOf(name, vars as WriteVars[ConflictingWrite]);
  if (mergePlan.alreadyApplied) {
    settleDraftOf(vars);
    settleWriteNotice(entity, true);
    return;
  }
  if (!mergePlan.gone && mergePlan.conflicts.length === 0) {
    if (takeAutoMerge(entity, now())) {
      notify({ tone: 'info', message: msg`Merged with a newer version from another device.` });
      await runWrite(qc, name, mergePlan.merge());
      return;
    }
    // Merged twice within a minute and still refused: stop sending on our own.
    settleWriteNotice(entity, false);
    const plan = mergePlan;
    notify({
      tone: 'error',
      message: msg`Could not save – it was changed elsewhere at the same time.`,
      action: {
        label: msg`Try again`,
        // The owner asked for it: count afresh (the guard only stops sending on our own).
        run: () => {
          autoMerges.delete(entity);
          void runWrite(qc, name, plan.merge());
        },
      },
      timeoutMs: 15_000,
    });
    return;
  }
  // The owner decides in the sheet: no "sending…" toast meanwhile.
  settleWriteNotice(entity, false);
  const conflict: Conflict = { id: nextConflictId++, name, vars: vars as WriteVars[ConflictingWrite], plan: mergePlan };
  conflictStore.set((list) => [...list, conflict]);
}

/** The owner's decision in the conflict dialog. */
export async function resolveConflict(
  qc: QueryClient,
  id: number,
  resolution: { keep: 'server' } | { keep: 'merge'; choices: Record<string, Choice> },
): Promise<void> {
  const conflict = conflictStore.get().find((c) => c.id === id);
  conflictStore.set((list) => list.filter((c) => c.id !== id));
  if (!conflict) return;
  if (resolution.keep === 'server') {
    // The owner chose the other version: the editor draft of this edit is done with.
    settleDraftOf(conflict.vars);
    return;
  }
  const merged = conflict.plan.merge(resolution.choices);
  // Every conflicting field kept the newer version and nothing else changed: nothing to send.
  if ('patch' in merged && Object.keys(merged.patch).length === 0) {
    settleDraftOf(conflict.vars);
    return;
  }
  // Restoring a deleted entity creates it again: no rebase onto the versions of the old row.
  if (conflict.plan.gone) forgetVersions(entityOf(conflict.name, merged));
  await runWrite(qc, conflict.name, merged);
}

function settleDraftOf(vars: WriteVars[MutationName]): void {
  const draft = (vars as Partial<AnnotateVars>).draft;
  if (draft) settleFieldDraft(draft);
}
