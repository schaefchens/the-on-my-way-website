/**
 * TanStack Query keys (queries) and mutation keys (offline-resumable writes).
 * Every key starts with "admin" so logout can drop the whole cache in one call.
 */
import type { CaptureKind, Visibility } from '@omw/contracts';

export interface CaptureFilter {
  visibility?: Visibility | undefined;
  kind?: CaptureKind | undefined;
  date?: string | undefined;
}

export const qk = {
  all: ['admin'] as const,
  auth: ['admin', 'auth'] as const,
  status: ['admin', 'status'] as const,
  capturesAll: ['admin', 'captures'] as const,
  captures: (filter: CaptureFilter = {}) => ['admin', 'captures', normalizeFilter(filter)] as const,
  capture: (sourceKey: string) => ['admin', 'capture', sourceKey] as const,
  days: ['admin', 'days'] as const,
  dayAll: ['admin', 'day'] as const,
  day: (date: string) => ['admin', 'day', date] as const,
  postsAll: ['admin', 'posts'] as const,
  posts: (filter: { date?: string; kind?: 'note' | 'story' } = {}) => ['admin', 'posts', filter] as const,
  post: (publicId: string) => ['admin', 'post', publicId] as const,
  trips: ['admin', 'trips'] as const,
  settings: ['admin', 'settings'] as const,
  tokens: ['admin', 'tokens'] as const,
  /**
   * People and access (wave 5): never persisted (names, devices, last-seen times stay in memory,
   * see queries.ts), still below "admin" so logout drops them with everything else.
   */
  access: {
    all: ['admin', 'access'] as const,
    status: ['admin', 'access', 'status'] as const,
    followers: ['admin', 'access', 'followers'] as const,
    follower: (fid: string) => ['admin', 'access', 'follower', fid] as const,
    privacy: ['admin', 'access', 'privacy'] as const,
    notices: ['admin', 'access', 'notices'] as const,
  },
};

function normalizeFilter(filter: CaptureFilter): CaptureFilter {
  const out: CaptureFilter = {};
  if (filter.visibility) out.visibility = filter.visibility;
  if (filter.kind) out.kind = filter.kind;
  if (filter.date) out.date = filter.date;
  return out;
}

/** Mutation keys: their defaults (mutationFn, optimistic update, rollback) live in mutations.ts. */
export const mk = {
  annotate: ['annotate'] as const,
  patchDay: ['patchDay'] as const,
  createPost: ['createPost'] as const,
  updatePost: ['updatePost'] as const,
  deletePost: ['deletePost'] as const,
  putTrip: ['putTrip'] as const,
  deleteTrip: ['deleteTrip'] as const,
  patchSettings: ['patchSettings'] as const,
};

export type MutationName = keyof typeof mk;
export const MUTATION_NAMES = Object.keys(mk) as MutationName[];

/**
 * Mutation keys of the immediate (never queued, never persisted) actions of api/access.ts:
 * deliberately NOT in `mk`/MUTATION_NAMES, so the offline queue, the "sending…" pill and the
 * IndexedDB persister (persist.ts) never pick them up.
 */
export const ak = {
  action: ['access', 'action'] as const,
  password: ['access', 'password'] as const,
};

/** True for the queued, offline-resumable owner writes (the only mutations ever persisted). */
export function isOwnerWriteKey(key: readonly unknown[] | undefined): boolean {
  const first = key?.[0];
  return typeof first === 'string' && (MUTATION_NAMES as string[]).includes(first);
}

/** All queued owner writes run one after another, in the order they were made. */
export const WRITE_SCOPE = { id: 'omw-owner-writes' } as const;
