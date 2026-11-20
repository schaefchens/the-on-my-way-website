/**
 * One deploy attempt of one target (plan A5). Steps:
 *
 *   0. Deployed state: store.deploys when known; else recover it from <root>/.omw-deploy.json.gz
 *      (or the legacy .omw-deploy.json) + the pending journal; else "unknown": upload everything,
 *      delete only known-obsolete. Paths of an interrupted deploy that were not confirmed are
 *      "maybe present". A recovered target that already serves a newer site version than OUT_DIR
 *      (this backend lost its store) is refused with `version_behind` and the version floor is
 *      raised, so the next generate releases above it (L2-02 d).
 *   1. Plan (plan.ts). Mass-delete guard (L2-02 c): a plan that would delete at least half of the
 *      deployed files (more than 20 deployed) or every data/days/*.json is refused unless forced.
 *      Nothing to do and nothing pending -> return without connecting.
 *   2. Persist `pending` locally. After an interrupted deploy, first refresh <root>/.omw-deploy.json
 *      with the confirmed state (store.deploys). Then write the journal remotely.
 *   3. Upload by phase (immutable, data, index, pages, manifest) with bounded concurrency; every
 *      file goes to "<dir>/.omw-tmp.<name>" and is renamed into place, then recorded in
 *      store.deploys. Small files are uploaded from the exact bytes that were hashed; a file that
 *      changed since the scan aborts the deploy before the manifest switches.
 *   4. Write <root>/.omw-deploy.json.gz (state after this deploy; skipped when unchanged).
 *   5. Deletes (pages, index, data, immutable), then empty directories (best effort).
 *   6. Remove the journal, clear `pending`.
 *
 * Any failure leaves the target consistent: the manifest only switches after everything it
 * references is uploaded, and deletes only start after it switched.
 */
import { promises as fsp } from 'node:fs';
import { posix } from 'node:path';
import { MANIFEST_PATH } from '@omw/contracts/site';
import type { Logger } from '../log.js';
import type { Store } from '../store/index.js';
import { buildPlan, type DeployPlan, deleteGroups, PHASES } from './plan.js';
import {
  DeployJournal,
  type DeployRecord,
  encodeRecord,
  JOURNAL_NAME,
  LEGACY_RECORD_NAME,
  RECORD_NAME,
  readDeployRecord,
  readJsonFile,
  recordContentHash,
  tmpPathFor,
  writeAtomic,
} from './record.js';
import { RemoteError, type RemoteFs, remoteJoin, runPool } from './remote.js';
import { type HashCache, type LocalFile, type ScanResult, sha256Buffer } from './scan.js';
import type { PendingOps, TargetState, TargetStateRepo } from './state.js';
import { PublishError } from './types.js';

/** Files up to this size are read into memory, verified and uploaded from that buffer. */
const BUFFER_LIMIT = 16 * 1024 * 1024;

export interface AttemptContext {
  targetId: string;
  dest: string;
  /** Remote root ("/" for local targets). */
  root: string;
  concurrency: number;
  store: Store;
  states: TargetStateRepo;
  cache: HashCache;
  log: Logger;
  now: () => Date;
  graceMs?: number;
  full?: boolean;
  /** Only consulted when the deployed state is unknown. */
  knownObsolete: () => Iterable<string>;
  /** Override the mass-delete guard (DeployOptions.force). */
  force?: boolean;
  /** Progress counters, shared across retry attempts of one deploy. */
  stats?: { uploaded: number; deleted: number; bytes: number };
}

export interface AttemptResult {
  uploaded: number;
  deleted: number;
  bytes: number;
  unchanged: number;
  deferred: number;
  recovered: boolean;
  connected: boolean;
  plan: DeployPlan;
}

export interface PlanContext {
  plan: DeployPlan;
  maybePresent: Set<string>;
  recovered: boolean;
  state: TargetState | null;
  /** The deployed file list the plan was made against (null = unknown). */
  deployed: ReadonlyMap<string, { sha256: string; size: number }> | null;
  /** Recovered from the target: highest of the record's and data/manifest.json's version. */
  remoteVersion: number | null;
  /** Recovered from the target: sha256 of its data/manifest.json. */
  remoteManifestSha: string | null;
}

/** Deployed site files below which the mass-delete guard does not use the 50 % rule. */
export const GUARD_MIN_FILES = 20;
const DAY_FILE = /^data\/days\/[^/]+\.json$/;

/**
 * L2-02 (c): refuses a plan that would delete at least half of the deployed files (when more
 * than GUARD_MIN_FILES are deployed) or every deployed data/days/*.json, e.g. after the store
 * was lost or emptied. Returns the refusal message, null when the plan is fine.
 */
export function massDeleteRefusal(
  deletes: readonly string[],
  deployed: ReadonlyMap<string, unknown> | null,
): string | null {
  if (!deployed || deployed.size === 0) return null;
  const doomed = new Set(deletes.filter((p) => deployed.has(p)));
  const total = deployed.size;
  const days = [...deployed.keys()].filter((p) => DAY_FILE.test(p));
  const allDays = days.length > 0 && days.every((p) => doomed.has(p));
  const most = total > GUARD_MIN_FILES && doomed.size * 2 >= total;
  if (!allDays && !most) return null;
  return `refused: would delete ${doomed.size} of ${total} remote files; use backend publish --force`;
}

/**
 * L2-02 d: the recovered target serves a newer release than OUT_DIR, or the same number with
 * other bytes (null = not behind). The deploy refuses it with `version_behind`.
 */
export function versionBehind(
  p: Pick<PlanContext, 'recovered' | 'remoteVersion' | 'remoteManifestSha'>,
  site: ScanResult,
): string | null {
  const { recovered, remoteVersion, remoteManifestSha } = p;
  if (!recovered || remoteVersion === null || site.manifestVersion === null) return null;
  const local = site.files.get(MANIFEST_PATH);
  const behind =
    remoteVersion > site.manifestVersion ||
    (remoteVersion === site.manifestVersion && remoteManifestSha !== null && local?.sha256 !== remoteManifestSha);
  return behind
    ? `the target serves site version ${remoteVersion}, OUT_DIR has ${site.manifestVersion}: regenerating above it`
    : null;
}

/** Steps 0–1. `getRemote` is only called when the local state is not enough. */
export async function preparePlan(
  ctx: AttemptContext,
  site: ScanResult,
  getRemote: (() => Promise<RemoteFs>) | null,
  opts: { dryRun?: boolean } = {},
): Promise<PlanContext> {
  const { targetId, dest, store, states, log } = ctx;
  const persist = !opts.dryRun;
  let state = states.get(targetId);
  if (state && state.dest !== dest) {
    if (persist) {
      log.info({ target: targetId }, 'publisher: destination changed; deployed state discarded');
      states.forget(targetId);
    }
    state = null;
  }
  const maybePresent = new Set<string>();
  let deployed: Map<string, { sha256: string; size: number; deployedAt?: string }> | null = null;
  let obsoleteSince = new Map<string, string>(Object.entries(state?.obsoleteSince ?? {}));
  let recovered = false;
  let remoteVersion: number | null = null;
  let remoteManifestSha: string | null = null;

  if (state?.known) {
    deployed = store.deploys.get(targetId);
    if (state.pending) for (const p of uncertainPaths(state.pending, deployed)) maybePresent.add(p);
  } else if (getRemote) {
    recovered = true;
    const remote = await getRemote();
    const rec = await readDeployRecord(remote, ctx.root, remoteJoin);
    const journal = await readJsonFile(remote, remoteJoin(ctx.root, JOURNAL_NAME), DeployJournal);
    const manifest = await remote.readFile(remoteJoin(ctx.root, MANIFEST_PATH)).catch(() => null);
    if (manifest) {
      remoteManifestSha = sha256Buffer(manifest);
      remoteVersion = manifestVersionOf(manifest);
    }
    if (rec.status === 'ok' && rec.value.version !== null) {
      remoteVersion = Math.max(remoteVersion ?? 0, rec.value.version);
    }
    if (rec.status === 'ok') {
      // Local recovery time, not the record's own string: uncertainPaths() compares deployedAt with
      // this process's clock, and the record may come from another machine (or be hand-edited).
      const recoveredAt = ctx.now().toISOString();
      const entries = Object.entries(rec.value.files).map(([path, [sha256, size]]) => ({
        path,
        sha256,
        size,
        deployedAt: recoveredAt,
      }));
      if (persist) {
        store.deploys.replace(targetId, entries);
        deployed = store.deploys.get(targetId);
        log.info(
          { target: targetId, files: entries.length, from: rec.source },
          'publisher: deployed state recovered from the target',
        );
      } else {
        deployed = new Map(entries.map((e) => [e.path, e]));
      }
      obsoleteSince = new Map(Object.entries(rec.value.obsoleteSince));
    } else {
      if (persist) store.deploys.clear(targetId);
      if (rec.status === 'invalid')
        log.warn({ target: targetId, error: rec.error }, 'publisher: ignoring invalid deploy record');
      log.info({ target: targetId }, 'publisher: no deploy record on the target; uploading everything');
    }
    if (journal.status === 'ok')
      for (const p of [...journal.value.uploads, ...journal.value.deletes]) maybePresent.add(p);
  }

  const plan = buildPlan({
    desired: site.files,
    deployed,
    maybePresent,
    knownObsolete: deployed ? [] : ctx.knownObsolete(),
    obsoleteSince,
    now: ctx.now(),
    ...(ctx.graceMs === undefined ? {} : { graceMs: ctx.graceMs }),
    ...(ctx.full ? { full: true } : {}),
  });
  return { plan, maybePresent, recovered, state, deployed, remoteVersion, remoteManifestSha };
}

function manifestVersionOf(data: Buffer): number | null {
  try {
    const v = (JSON.parse(data.toString('utf8')) as { version?: unknown }).version;
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}

/** Paths of an interrupted deploy whose remote state is not confirmed by store.deploys. */
export function uncertainPaths(pending: PendingOps, deployed: ReadonlyMap<string, { deployedAt?: string }>): string[] {
  const out: string[] = [];
  for (const p of pending.uploads) {
    // Confirmed only when recorded strictly after the interrupted deploy started.
    const d = deployed.get(p);
    if (!d?.deployedAt || d.deployedAt <= pending.startedAt) out.push(p);
  }
  for (const p of pending.deletes) if (deployed.has(p)) out.push(p);
  out.push(...pending.probes);
  return out;
}

export async function deployAttempt(
  ctx: AttemptContext,
  site: ScanResult,
  openRemote: () => Promise<RemoteFs>,
): Promise<AttemptResult> {
  let remote: RemoteFs | null = null;
  const getRemote = async () => {
    remote ??= await openRemote();
    return remote;
  };
  try {
    return await run(ctx, site, getRemote, () => remote !== null);
  } finally {
    const r = remote as RemoteFs | null;
    if (r) await r.close().catch(() => {});
  }
}

async function run(
  ctx: AttemptContext,
  site: ScanResult,
  getRemote: () => Promise<RemoteFs>,
  connected: () => boolean,
): Promise<AttemptResult> {
  const { targetId, dest, root, store, states, log } = ctx;
  const prepared = await preparePlan(ctx, site, getRemote);
  const { plan, maybePresent, recovered, state, deployed, remoteVersion } = prepared;
  const behind = versionBehind(prepared, site);
  if (behind !== null && remoteVersion !== null && site.manifestVersion !== null) {
    // Same number, other bytes: the target's release N is not this store's N, so N is taken
    // as well. The floor must then exceed the last local release, or the generator finds
    // nothing to re-release ("site unchanged") and every deploy stops here again.
    store.meta.raiseSiteVersion(remoteVersion > site.manifestVersion ? remoteVersion : remoteVersion + 1);
    throw new PublishError('version_behind', behind);
  }
  if (!ctx.force) {
    const refusal = massDeleteRefusal(plan.deletes, deployed);
    if (refusal) {
      log.error({ target: targetId, deletes: plan.deletes.length, deployed: deployed?.size }, `publisher: ${refusal}`);
      throw new PublishError('refused', refusal);
    }
  }
  const result: AttemptResult = {
    uploaded: 0,
    deleted: 0,
    bytes: 0,
    unchanged: plan.unchanged,
    deferred: plan.deferred.length,
    recovered,
    connected: false,
    plan,
  };

  const nothingToDo =
    plan.uploads.length === 0 && plan.deletes.length === 0 && state?.known === true && state.pending === null;
  if (nothingToDo) {
    states.update(targetId, dest, (s) => ({ ...s, obsoleteSince: Object.fromEntries(plan.obsoleteSince) }));
    result.connected = connected();
    return result;
  }

  const remote = await getRemote();
  result.connected = true;
  const startedAt = ctx.now().toISOString();
  const deployedBefore = store.deploys.get(targetId);
  const pending: PendingOps = {
    startedAt,
    uploads: plan.uploads.map((u) => u.path),
    deletes: plan.deletes.filter((p) => deployedBefore.has(p)),
    probes: plan.deletes.filter((p) => !deployedBefore.has(p)),
  };
  states.update(targetId, dest, (s) => ({
    ...s,
    dest,
    known: true,
    pending,
    obsoleteSince: Object.fromEntries(plan.obsoleteSince),
  }));

  const dirs = new DirCache(remote, root);
  // Directories of files already on the target exist (re-created on demand if not).
  for (const p of deployedBefore.keys()) dirs.assume(posix.dirname(p));
  await dirs.ensureRoot();

  // After an interrupted deploy, store.deploys knows files that deploy confirmed but never wrote
  // into the remote record, and this deploy's journal will not list them (they are certain now).
  // Publish the confirmed state first, before the new journal replaces the old one: otherwise a
  // second interruption followed by a lost store would leave them on the target unknown to
  // everyone (e.g. media of an item hidden since). Uncertain paths stay covered by the journals.
  if (state?.known === true && state.pending !== null) {
    await writeRecord(remote, ctx, state.version, deployedBefore, plan.obsoleteSince);
  }

  const journal: DeployJournal = {
    format: 'omw-deploy-pending/1',
    target: targetId,
    startedAt,
    version: site.manifestVersion,
    uploads: pending.uploads,
    deletes: plan.deletes,
  };
  await writeAtomic(remote, remoteJoin(root, JOURNAL_NAME), Buffer.from(JSON.stringify(journal)));

  // 3. uploads, phase by phase
  for (const phase of PHASES) {
    const batch = plan.uploads.filter((u) => u.phase === phase);
    if (batch.length === 0) continue;
    await runPool(batch, ctx.concurrency, async (u) => {
      const file = site.files.get(u.path);
      if (!file) throw new PublishError('internal', `Planned upload missing from scan: ${u.path}`);
      await uploadOne(ctx, remote, dirs, file);
      result.uploaded++;
      result.bytes += file.size;
      if (ctx.stats) {
        ctx.stats.uploaded++;
        ctx.stats.bytes += file.size;
      }
    });
    log.debug({ target: targetId, phase, files: batch.length }, 'publisher: phase uploaded');
  }

  // 4. deploy record: state after this deploy (pending deletes are covered by the journal)
  const after = store.deploys.get(targetId);
  for (const p of plan.deletes) after.delete(p);
  await writeRecord(remote, ctx, site.manifestVersion, after, plan.obsoleteSince);

  // 5. deletes, referencing files first; leftover temp files of uncertain uploads too
  const uncertainUploads = new Set([...maybePresent].filter((p) => !site.files.has(p)));
  for (const group of deleteGroups(plan.deletes)) {
    await runPool(group, ctx.concurrency, async (p) => {
      const full = remoteJoin(root, p);
      if (await remote.remove(full)) {
        result.deleted++;
        if (ctx.stats) ctx.stats.deleted++;
      }
      if (uncertainUploads.has(p)) await remote.remove(tmpPathFor(full));
      store.deploys.remove(targetId, [p]);
    });
  }
  if (plan.deletes.length > 0) await removeEmptyDirs(remote, root, plan.deletes, after, dirs);

  // 6. done
  await remote.remove(remoteJoin(root, JOURNAL_NAME));
  states.update(targetId, dest, (s) => ({
    ...s,
    known: true,
    pending: null,
    version: site.manifestVersion,
    deployedAt: ctx.now().toISOString(),
    obsoleteSince: Object.fromEntries(plan.obsoleteSince),
  }));
  return result;
}

/**
 * Writes <root>/.omw-deploy.json.gz describing `files` as present on the target; skipped when the
 * target already has a record with the same content (TargetState.recordHash). The legacy
 * uncompressed record is removed after the first successful .gz write.
 */
async function writeRecord(
  remote: RemoteFs,
  ctx: AttemptContext,
  version: number | null,
  files: ReadonlyMap<string, { sha256: string; size: number }>,
  obsoleteSince: ReadonlyMap<string, string>,
): Promise<void> {
  const record: DeployRecord = {
    format: 'omw-deploy/1',
    target: ctx.targetId,
    version,
    deployedAt: ctx.now().toISOString(),
    files: Object.fromEntries([...files].map(([p, f]) => [p, [f.sha256, f.size]])),
    obsoleteSince: Object.fromEntries(obsoleteSince),
  };
  const hash = recordContentHash(record);
  const state = ctx.states.get(ctx.targetId);
  if (state?.recordHash !== hash) {
    await writeAtomic(remote, remoteJoin(ctx.root, RECORD_NAME), encodeRecord(record));
    ctx.states.update(ctx.targetId, ctx.dest, (s) => ({ ...s, recordHash: hash }));
  }
  if (!ctx.states.get(ctx.targetId)?.legacyRecordGone) {
    await remote.remove(remoteJoin(ctx.root, LEGACY_RECORD_NAME));
    await remote.remove(tmpPathFor(remoteJoin(ctx.root, LEGACY_RECORD_NAME)));
    ctx.states.update(ctx.targetId, ctx.dest, (s) => ({ ...s, legacyRecordGone: true }));
  }
}

async function uploadOne(ctx: AttemptContext, remote: RemoteFs, dirs: DirCache, file: LocalFile): Promise<void> {
  const target = remoteJoin(ctx.root, file.path);
  const tmp = tmpPathFor(target);
  const relDir = posix.dirname(file.path);
  await dirs.ensure(relDir);

  let data: Buffer | null = null;
  if (file.size <= BUFFER_LIMIT) {
    data = await fsp.readFile(file.abs).catch(() => null);
    if (!data || data.length !== file.size || sha256Buffer(data) !== file.sha256) {
      ctx.cache.invalidate(file.abs);
      throw new PublishError('out_dir_changed', `OUT_DIR changed during the deploy: ${file.path}`);
    }
  }
  const put = async () => {
    if (data) await remote.writeFile(tmp, data);
    else await remote.uploadFile(file.abs, tmp, file.size);
  };
  try {
    await put();
  } catch (err) {
    // The directory may have been removed behind our back: create it again, once.
    if (!(err instanceof RemoteError) || err.kind !== 'not_found') throw err;
    await dirs.ensure(relDir, true);
    await put();
  }
  if (!data) {
    const st = await fsp.stat(file.abs).catch(() => null);
    if (!st || st.ino !== file.ino || st.size !== file.size || st.mtimeMs !== file.mtimeMs) {
      ctx.cache.invalidate(file.abs);
      await remote.remove(tmp).catch(() => {});
      throw new PublishError('out_dir_changed', `OUT_DIR changed during the deploy: ${file.path}`);
    }
  }
  await remote.replace(tmp, target);
  ctx.store.deploys.upsert(ctx.targetId, [{ path: file.path, sha256: file.sha256, size: file.size }]);
}

/** mkdir -p with a cache of directories known to exist (relative to the root, "." = root). */
class DirCache {
  private readonly known = new Set<string>(['.']);
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly remote: RemoteFs;
  private readonly root: string;

  constructor(remote: RemoteFs, root: string) {
    this.remote = remote;
    this.root = root;
  }

  assume(relDir: string): void {
    for (let d = relDir; d !== '.' && d !== '/' && d !== ''; d = posix.dirname(d)) this.known.add(d);
  }

  forget(relDir: string): void {
    this.known.delete(relDir);
  }

  async ensureRoot(): Promise<void> {
    if (this.root === '/') return;
    const st = await this.remote.stat(this.root);
    if (st?.type === 'dir') return;
    const parts = this.root.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur += `/${part}`;
      await this.remote.mkdir(cur);
    }
  }

  async ensure(relDir: string, force = false): Promise<void> {
    if (relDir === '.' || relDir === '') return;
    if (force) {
      for (let d = relDir; d !== '.'; d = posix.dirname(d)) this.known.delete(d);
      await this.ensureRoot();
    }
    if (this.known.has(relDir)) return;
    const running = this.inflight.get(relDir);
    if (running) return running;
    const p = (async () => {
      await this.ensure(posix.dirname(relDir));
      await this.remote.mkdir(remoteJoin(this.root, relDir));
      this.known.add(relDir);
    })().finally(() => this.inflight.delete(relDir));
    this.inflight.set(relDir, p);
    return p;
  }
}

/** Removes directories left empty by deletes (deepest first); non-empty ones are kept silently. */
async function removeEmptyDirs(
  remote: RemoteFs,
  root: string,
  deleted: readonly string[],
  remaining: ReadonlyMap<string, unknown>,
  dirs: DirCache,
): Promise<void> {
  const needed = new Set<string>();
  for (const p of remaining.keys()) {
    for (let d = posix.dirname(p); d !== '.'; d = posix.dirname(d)) needed.add(d);
  }
  const candidates = new Set<string>();
  for (const p of deleted) {
    for (let d = posix.dirname(p); d !== '.'; d = posix.dirname(d)) if (!needed.has(d)) candidates.add(d);
  }
  const ordered = [...candidates].sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? -1 : 1));
  for (const d of ordered) {
    try {
      if (await remote.rmdir(remoteJoin(root, d))) dirs.forget(d);
    } catch {
      // Foreign files or permissions: leave the directory.
    }
  }
}
