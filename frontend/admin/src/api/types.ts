/**
 * Variables of the offline-resumable owner writes. They are persisted to IndexedDB together with
 * paused mutations, so they must be plain JSON and carry everything needed to replay the write
 * after a reload (no closures, no component state).
 *
 * `base` is the updatedAt the edit was based on (null = no server row known yet: the request is
 * sent without ifUpdatedAt). `original` holds the pre-edit values of the patched fields; on a
 * 409 conflict it allows a three-way merge (see conflicts.ts).
 */
import type {
  AdminDayDetail,
  AdminPost,
  AdminTrip,
  AnnotationPatch,
  CaptureListItem,
  DayPatch,
  PostCreate,
  PostUpdate,
  Settings,
  SettingsPatch,
  TripUpsert,
} from '@omw/contracts/api';
import type { MutationName } from './keys';

export type AnnotationFields = Omit<AnnotationPatch, 'ifUpdatedAt'>;
export type DayFields = Omit<DayPatch, 'ifUpdatedAt'>;
export type PostFields = Omit<PostUpdate, 'ifUpdatedAt'>;
export type TripBody = Omit<TripUpsert, 'ifUpdatedAt'>;

/**
 * `exactBase`: the base is the server version fetched right before (a merge after a 409), so it
 * is sent verbatim, never rebased through the version map: after a server rewind (restore from
 * a backup) the map can point at versions the server no longer has, and rebasing onto them would
 * provoke the same 409 again and again.
 */
export interface Rebaseable {
  base: string | null;
  exactBase?: true;
}

/** The editor draft (lib/drafts.ts field drafts) a write saves: dropped once the server confirmed it. */
export interface DraftRef {
  key: string;
  /** savedAt of the draft when it was sent (a draft edited after that is kept). */
  savedAt: string;
}

export interface AnnotateVars extends Rebaseable {
  sourceKey: string;
  patch: AnnotationFields;
  original: AnnotationFields;
  draft?: DraftRef;
}

export interface PatchDayVars extends Rebaseable {
  date: string;
  patch: DayFields;
  original: DayFields;
  draft?: DraftRef;
}

export interface CreatePostVars {
  body: PostCreate;
  /** Composer draft the post was written in (restored there if the API rejects the write). */
  draftId?: string;
}

export interface UpdatePostVars extends Rebaseable {
  publicId: string;
  kind: 'note' | 'story';
  patch: PostFields;
  original: PostFields;
  /** Composer draft of the edit (restored there if the API rejects the write). */
  draftId?: string;
}

export interface DeletePostVars {
  publicId: string;
}

export interface PutTripVars extends Rebaseable {
  body: TripBody;
  /** null: a new trip (sent without ifUpdatedAt). */
  base: string | null;
  original: Partial<TripBody>;
}

export interface DeleteTripVars {
  slug: string;
}

export interface PatchSettingsVars {
  patch: SettingsPatch;
}

export interface WriteVars {
  annotate: AnnotateVars;
  patchDay: PatchDayVars;
  createPost: CreatePostVars;
  updatePost: UpdatePostVars;
  deletePost: DeletePostVars;
  putTrip: PutTripVars;
  deleteTrip: DeleteTripVars;
  patchSettings: PatchSettingsVars;
}

export interface WriteResult {
  annotate: CaptureListItem;
  patchDay: AdminDayDetail;
  createPost: AdminPost;
  updatePost: AdminPost;
  deletePost: undefined;
  putTrip: AdminTrip;
  deleteTrip: undefined;
  patchSettings: Settings;
}

/** Snapshot of the query data a write touched optimistically: [queryKey, data | undefined]. */
export type CacheSnapshot = Array<[readonly unknown[], unknown]>;

export interface WriteContext {
  snapshot: CacheSnapshot;
}

/**
 * The `base` (ifUpdatedAt) of an edit: the server's updatedAt, or null while the entity has no
 * confirmed server version (changeSeq 0). Optimistic copies of entities our own queued writes
 * created (a note written offline, a capture annotated for the first time, a new day row) carry
 * a made-up updatedAt that the server never had; sending it would provoke a 409. A null base is
 * rebased onto the version our earlier write produced when it is sent (writes.ts resolveBase).
 */
export function writeBase(updatedAt: string | null | undefined, changeSeq: number | null | undefined): string | null {
  return (changeSeq ?? 0) > 0 && updatedAt ? updatedAt : null;
}

/** Stable id of the entity a write targets (pending badges, version rebasing, conflicts). */
export function entityOf<N extends MutationName>(name: N, vars: WriteVars[N]): string {
  switch (name) {
    case 'annotate':
      return `capture:${(vars as AnnotateVars).sourceKey}`;
    case 'patchDay':
      return `day:${(vars as PatchDayVars).date}`;
    case 'createPost':
      return `post:${(vars as CreatePostVars).body.publicId}`;
    case 'updatePost':
    case 'deletePost':
      return `post:${(vars as UpdatePostVars | DeletePostVars).publicId}`;
    case 'putTrip':
      return `trip:${(vars as PutTripVars).body.slug}`;
    case 'deleteTrip':
      return `trip:${(vars as DeleteTripVars).slug}`;
    case 'patchSettings':
      return 'settings';
    default:
      return String(name);
  }
}
