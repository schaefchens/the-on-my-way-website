/**
 * Deploy planning (pure): desired manifest vs last deployed manifest -> ordered uploads + deletes.
 *
 * Upload phases (each completes before the next starts), so that a file is only ever referenced
 * after everything it references is live:
 *   1 immutable  media/**, assets/**           (content-addressed, referenced by everything else)
 *   2 data       data/** except index/manifest  (days/*.json, trips/*.json reference media)
 *   3 index      data/timeline*.json            (references day/trip files by hash)
 *   4 pages      HTML and every other file      (reference assets, media, data)
 *   5 manifest   data/manifest.json             (switches clients to the new version)
 * Deletes run after the manifest, in the reverse order (pages, index, data, immutable), so a file
 * still on the target never references one that is already gone.
 *
 * Obsolete files are deleted immediately (privacy: media of hidden/revoked items, pages and data
 * of days that disappeared) except assets/**, which stay for ASSET_GRACE_MS after they were first
 * seen obsolete (old HTML in browser caches may still load them).
 */

export const ASSET_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export const PHASES = ['immutable', 'data', 'index', 'pages', 'manifest'] as const;
export type Phase = (typeof PHASES)[number];

export const MANIFEST_PATH = 'data/manifest.json';

export function phaseOf(path: string): Phase {
  if (path === MANIFEST_PATH) return 'manifest';
  if (path.startsWith('media/') || path.startsWith('assets/')) return 'immutable';
  if (/^data\/timeline[^/]*\.json$/.test(path)) return 'index';
  if (path.startsWith('data/')) return 'data';
  return 'pages';
}

/** Delete order: referencing files first. */
const DELETE_RANK: Record<Phase, number> = { pages: 0, manifest: 0, index: 1, data: 2, immutable: 3 };

export function hasGracePeriod(path: string): boolean {
  return path.startsWith('assets/');
}

export interface FileSig {
  sha256: string;
  size: number;
}

export interface PlanInput {
  desired: ReadonlyMap<string, FileSig>;
  /** Files on the target per the last deploy; null = unknown (no local state, no remote record). */
  deployed: ReadonlyMap<string, FileSig> | null;
  /** Paths whose remote state is uncertain (interrupted deploy): re-uploaded if desired, else deleted. */
  maybePresent?: ReadonlySet<string>;
  /** Paths known to be obsolete even without a deployed manifest (e.g. media of hidden captures). */
  knownObsolete?: Iterable<string>;
  /** First time each obsolete grace-period file was seen obsolete (ISO). */
  obsoleteSince?: ReadonlyMap<string, string>;
  now: Date;
  graceMs?: number;
  /** Upload every desired file regardless of the deployed manifest. */
  full?: boolean;
}

export type UploadReason = 'new' | 'changed' | 'unknown' | 'forced';

export interface PlannedUpload {
  path: string;
  phase: Phase;
  size: number;
  reason: UploadReason;
}

export interface DeployPlan {
  uploads: PlannedUpload[];
  /** In execution order. */
  deletes: string[];
  /** Obsolete grace-period files that stay for now. */
  deferred: { path: string; since: string; dueAt: string }[];
  /** obsoleteSince to persist (only files still on the target). */
  obsoleteSince: Map<string, string>;
  unchanged: number;
  uploadBytes: number;
  remoteKnown: boolean;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function buildPlan(input: PlanInput): DeployPlan {
  const { desired, deployed } = input;
  const maybe = input.maybePresent ?? new Set<string>();
  const graceMs = input.graceMs ?? ASSET_GRACE_MS;
  const nowMs = input.now.getTime();
  const nowIso = input.now.toISOString();

  const uploads: PlannedUpload[] = [];
  let unchanged = 0;
  for (const [path, sig] of desired) {
    const prev = deployed?.get(path);
    let reason: UploadReason | null;
    if (maybe.has(path)) reason = 'forced';
    else if (deployed === null) reason = 'unknown';
    else if (!prev) reason = 'new';
    else if (prev.sha256 !== sig.sha256 || prev.size !== sig.size) reason = 'changed';
    else if (input.full) reason = 'forced';
    else reason = null;
    if (reason) uploads.push({ path, phase: phaseOf(path), size: sig.size, reason });
    else unchanged++;
  }
  const phaseIndex = (p: Phase) => PHASES.indexOf(p);
  uploads.sort((a, b) => phaseIndex(a.phase) - phaseIndex(b.phase) || cmp(a.path, b.path));

  const candidates = new Set<string>();
  if (deployed) for (const path of deployed.keys()) if (!desired.has(path)) candidates.add(path);
  for (const path of maybe) if (!desired.has(path)) candidates.add(path);
  if (deployed === null) for (const path of input.knownObsolete ?? []) if (!desired.has(path)) candidates.add(path);

  const deletes: string[] = [];
  const deferred: DeployPlan['deferred'] = [];
  const obsoleteSince = new Map<string, string>();
  for (const path of [...candidates].sort(cmp)) {
    // Grace only for files we know are on the target (uncertain leftovers go right away).
    if (hasGracePeriod(path) && deployed?.has(path) && !maybe.has(path)) {
      const since = input.obsoleteSince?.get(path) ?? nowIso;
      const sinceMs = Date.parse(since);
      const dueMs = (Number.isNaN(sinceMs) ? nowMs : sinceMs) + graceMs;
      if (dueMs > nowMs) {
        obsoleteSince.set(path, since);
        deferred.push({ path, since, dueAt: new Date(dueMs).toISOString() });
        continue;
      }
    }
    deletes.push(path);
  }
  deletes.sort((a, b) => DELETE_RANK[phaseOf(a)] - DELETE_RANK[phaseOf(b)] || cmp(a, b));

  return {
    uploads,
    deletes,
    deferred,
    obsoleteSince,
    unchanged,
    uploadBytes: uploads.reduce((n, u) => n + u.size, 0),
    remoteKnown: deployed !== null,
  };
}

/** Groups deletes into the sequential steps of the delete phase. */
export function deleteGroups(deletes: readonly string[]): string[][] {
  const groups: string[][] = [];
  let rank = -1;
  for (const p of deletes) {
    const r = DELETE_RANK[phaseOf(p)];
    if (r !== rank) {
      groups.push([]);
      rank = r;
    }
    groups[groups.length - 1]?.push(p);
  }
  return groups;
}
