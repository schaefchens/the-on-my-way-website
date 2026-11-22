/**
 * Publisher (plan A5): incremental, crash-safe deploys of OUT_DIR to publish targets.
 *
 *   const publisher = createPublisher({ config, log, store });
 *   const results = await publisher.deploy({ reason: 'generate' });  // all enabled targets
 *
 * - Targets: CONFIG_DIR/targets.json (see targets.ts); kinds "local" (folder) and "sftp".
 * - deploy() is single-flight: while a deploy runs, further calls coalesce into ONE follow-up run
 *   (union of the requested targets) and resolve with its results. busy() tells whether one runs.
 * - Every deploy result is stored as event "publish.deploy" (store.events) and as the target's
 *   status (listTargets()[i].status.lastDeploy).
 * - Transient failures (connection, timeout) are retried with a fresh connection (maxAttempts,
 *   default 3). Authentication failures are never retried: the target is blocked until it is
 *   saved again (saveTarget) or tested with { force: true }.
 * - Gate mode (ACCESS_MODE=gate, spec-wave5 §5.6): a target needs gateRoot/gateDir and its content
 *   root must be gateRoot/<secret> (gate_config otherwise). Each deploy first brings the gate tree
 *   (GATE_OUT_DIR) to gateRoot with /.htaccess last (gate.ts), then the content tree with today's
 *   algorithm to the content root, then runs the anonymous-must-be-refused check (gatecheck.ts)
 *   when due. gate_open re-uploads both .htaccess files once and checks again; still open fails
 *   the deploy (error "gate_open: …"). Store-only targets (publish: false) are never deployed.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GateCheckResult } from '@omw/contracts/access';
import { MANIFEST_PATH } from '@omw/contracts/site';
import { accessOf, type Config, isGateMode } from '../config.js';
import type { GateHtaccessConfig } from '../generator/extras.js';
import { gateHtaccessConfig } from '../generator/gate.js';
import { FORBIDDEN_TXT } from '../generator/gate-pages.js';
import { contentHash } from '../generator/hash.js';
import { verifyHtaccess } from '../generator/verify.js';
import type { Logger } from '../log.js';
import { BACKEND_ROOT } from '../paths.js';
import type { Store } from '../store/index.js';
import { type AttemptContext, deployAttempt, massDeleteRefusal, preparePlan, versionBehind } from './deploy.js';
import { deployGateTree, GATE_RECORD_NAME, type GateDeployResult, isGateTreePath } from './gate.js';
import { type CheckCookie, type GateCheckState, gateCheckDue, runGateCheck } from './gatecheck.js';
import { checkPublishedVersion, type FetchLike, type HttpCheckOptions } from './httpcheck.js';
import { LocalRemote } from './local.js';
import { JOURNAL_NAME, LEGACY_RECORD_NAME, RECORD_NAME, readDeployRecord, tmpPathFor, writeAtomic } from './record.js';
import { type RemoteFs, remoteJoin } from './remote.js';
import { HashCache, type ScanResult, scanOutDir } from './scan.js';
import { connectSftp, type SftpRemote } from './sftp.js';
import { TargetStateRepo } from './state.js';
import {
  destinationKey,
  gateTargetProblem,
  localTargetDir,
  resolveKeyPath,
  TARGETS_FILE,
  TargetStore,
  toPublic,
} from './targets.js';
import {
  type DeployResult,
  type PlanSummary,
  PublishError,
  type PublishTargetInput,
  type PublishTargetPublic,
  type StoredTarget,
  type TargetStatusPublic,
} from './types.js';

export { deployGateTree, GATE_RECORD_NAME, isGateTreePath, scanGateDir } from './gate.js';
export { gateCheckDue, runGateCheck } from './gatecheck.js';
export type { FetchLike, HttpCheckOptions, HttpCheckResult } from './httpcheck.js';
export { checkPublishedVersion, manifestUrl } from './httpcheck.js';
export { LocalRemote } from './local.js';
export { ASSET_GRACE_MS, buildPlan, type DeployPlan, PHASES, type Phase, phaseOf } from './plan.js';
export {
  decodeRecord,
  encodeRecord,
  JOURNAL_NAME,
  LEGACY_RECORD_NAME,
  RECORD_NAME,
  readDeployRecord,
  TMP_PREFIX,
} from './record.js';
export type { RemoteEntry, RemoteFs, RemoteStat } from './remote.js';
export { RemoteError } from './remote.js';
export { HashCache, type LocalFile, type ScanResult, scanOutDir } from './scan.js';
export { connectSftp, type SftpConnectOptions, type SftpRemote } from './sftp.js';
export {
  bootstrapTargetFromEnv,
  DEFAULT_SFTP_TARGET_ID,
  destinationKey,
  gateTargetProblem,
  TARGETS_FILE,
  TargetStore,
  toPublic,
} from './targets.js';
export * from './types.js';

/** Where targets come from (TargetStore in production; a fixed list for the self test). */
export interface TargetSource {
  list(): StoredTarget[];
  get(id: string): StoredTarget | undefined;
  save(input: unknown): StoredTarget;
  remove(id: string): boolean;
  pinHostKey(id: string, fingerprint: string): void;
}

export interface ConnectHooks {
  configDir: string;
  outDir: string;
  /** Local targets: the directory the remote "/" maps to (gate mode: gateDir; default: dir). */
  localRoot?: string;
  /** Backend state directories a local target must not overlap (see TargetStoreOptions). */
  protectedDirs?: readonly string[];
  log: Logger;
  /** Trust-on-first-use: persist the fingerprint the server presented. */
  onTrustedFirstUse(fingerprint: string, keyType: string | null): void;
}

export type Connector = (target: StoredTarget, hooks: ConnectHooks) => Promise<RemoteFs>;

export interface PublisherDeps {
  config: Config;
  log: Logger;
  store: Store;
  /** For the env bootstrap of targets.json (default process.env). */
  env?: Record<string, string | undefined>;
  // --- optional, for tests and tools ---
  now?: () => Date;
  fetch?: FetchLike;
  connect?: Connector;
  sleep?: (ms: number) => Promise<void>;
  targets?: TargetSource;
  /** null = in-memory only (default DATA_DIR/publisher/hash-cache.json). */
  hashCacheFile?: string | null;
  /** Connections per deploy and target (default 3). Never applies to auth failures. */
  maxAttempts?: number;
  /** Backoff before attempt 2, 3, … (default 2 s, 8 s). */
  retryDelaysMs?: readonly number[];
  graceMs?: number;
  /** HTTP check tuning; false disables it (httpCheck "skipped"). */
  httpCheck?: HttpCheckOptions | false;
  /**
   * Gate mode: rotates the service session (GET /backend/access/service-session?rotate=1) and
   * resolves once it is applied; null/absent = no API (gate check #4–#5 skipped).
   */
  serviceSession?: ServiceSessionSource | null;
}

/** The service session for gate check #4/#5 (access/service-session.ts). */
export interface ServiceSessionSource {
  rotate(): Promise<{ current: CheckCookie; previous: CheckCookie | null } | null>;
}

export interface DeployOptions {
  /** One target (deployed even when disabled); default: every enabled target. */
  targetId?: string;
  /** Free text for logs and the event log ("generate", "manual", …). */
  reason?: string;
  /** Deploy another directory than config.dirs.out. */
  outDir?: string;
  /** Upload every file even if the deployed manifest says it is current. */
  full?: boolean;
  /** Extra paths to delete when the target's state is unknown (e.g. GenerateResult.removed). */
  knownObsolete?: Iterable<string>;
  /**
   * Override the mass-delete guard (L2-02 c): a deploy that would delete at least half of the
   * files in the deploy record (records > 20 files) or every data/days/*.json is refused unless
   * forced (`backend publish --force`).
   */
  force?: boolean;
}

export interface PlanOptions {
  targetId?: string;
  outDir?: string;
  full?: boolean;
  /** Never connect; an unknown deployed state is then planned as "upload everything". */
  offline?: boolean;
}

export interface TestResult {
  ok: boolean;
  detail: string;
}

export interface Publisher {
  listTargets(): PublishTargetPublic[];
  saveTarget(t: PublishTargetInput): PublishTargetPublic;
  removeTarget(id: string): void;
  testTarget(id: string, opts?: { force?: boolean }): Promise<TestResult>;
  deploy(opts?: DeployOptions): Promise<DeployResult[]>;
  busy(): boolean;
  // --- additions ---
  getTarget(id: string): PublishTargetPublic | null;
  /** Dry run: what deploy() would do (may connect once to read the deploy record). */
  plan(opts?: PlanOptions): Promise<PlanSummary[]>;
  /** Last result per target (newest state, also after a restart). */
  lastResults(): DeployResult[];
  /**
   * One-off migration of a live open-mode site into gate mode (spec-wave5 §5.6.4): deploys the gate
   * tree (/.htaccess last) and the content tree into /<secret>/ (everything uploaded), runs the gate
   * check, then lists the legacy root deploy record's paths minus every gate tree path. Only with
   * `confirm` it deletes them and then the legacy record. The site must be generated in gate mode.
   */
  migrateToGate(targetId: string, opts?: { confirm?: boolean }): Promise<MigrationReport>;
  /**
   * Highest site version the enabled targets serve (L2-02 d): the locally known deployed version,
   * else (unknown state, e.g. a lost store) the target's deploy record and data/manifest.json,
   * read over one connection. Targets that cannot be read are skipped (logged); null if none known.
   */
  versionFloor(): Promise<number | null>;
}

export interface MigrationReport {
  deploy: DeployResult;
  /** Legacy root paths (old record minus gate tree, content folder, store and ACME paths). */
  legacy: string[];
  /** Deleted with confirm (else 0). */
  deleted: number;
  /** The legacy record was removed (confirm and every legacy path deleted). */
  recordRemoved: boolean;
}

export const defaultConnector: Connector = async (target, hooks) => {
  if (target.kind === 'local') {
    return LocalRemote.open(hooks.localRoot ?? localTargetDir(target, hooks.outDir, hooks.protectedDirs));
  }
  const privateKey =
    target.privateKey ??
    (target.privateKeyPath
      ? await readFile(resolveKeyPath(target.privateKeyPath, hooks.configDir), 'utf8')
      : undefined);
  return connectSftp({
    host: target.host,
    port: target.port,
    username: target.username,
    ...(privateKey ? { privateKey } : { password: target.password }),
    ...(target.passphrase ? { passphrase: target.passphrase } : {}),
    hostKeys: target.hostKeys,
    trustOnFirstUse: target.trustOnFirstUse,
    onTrustedFirstUse: hooks.onTrustedFirstUse,
    log: hooks.log,
  });
};

export function remoteRootOf(t: StoredTarget): string {
  return t.kind === 'sftp' ? t.remoteRoot : '/';
}

/**
 * The content root on the connection (gate mode: a local target's connection is rooted at its
 * gateDir, so its content lives at "/<secret>"; SFTP targets use remoteRoot either way).
 */
export function contentRootOf(t: StoredTarget, secret: string | null): string {
  if (t.kind === 'local' && secret && t.gateDir) return `/${secret}`;
  return remoteRootOf(t);
}

/** The gate root on the connection (gate mode). */
export function gateRootOf(t: StoredTarget): string {
  return t.kind === 'sftp' ? (t.gateRoot ?? '/') : '/';
}

/** Gate mode facts of a config (null in open mode). */
interface GateInfo {
  secret: string;
  cfg: GateHtaccessConfig;
  gateOutDir: string;
  origin: string;
  /** Changes of it make the next deploy run the gate check. */
  configKey: string;
}

function gateInfoOf(config: Config): GateInfo | null {
  if (!isGateMode(config)) return null;
  const { site, secret } = config.access;
  return {
    secret,
    cfg: gateHtaccessConfig(site, secret),
    gateOutDir: accessOf(config).gateOutDir,
    origin: site.siteOrigin,
    configKey: contentHash(site),
  };
}

const GATE_CHECK_KEY = (targetId: string) => `publisher.gatecheck.${targetId}`;
const GATE_STATE_KEY = (targetId: string) => `publisher.gate.${targetId}`;

export function createPublisher(deps: PublisherDeps): Publisher {
  const { config, store } = deps;
  const log = deps.log.child({ module: 'publisher' });
  const now = deps.now ?? store.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const connect = deps.connect ?? defaultConnector;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? 3);
  const retryDelays = deps.retryDelaysMs ?? [2000, 8000];
  const protectedDirs = [config.dirs.data, config.dirs.archive, config.dirs.config, config.dirs.media];
  const targets: TargetSource =
    deps.targets ??
    new TargetStore({
      file: join(config.dirs.config, TARGETS_FILE),
      configDir: config.dirs.config,
      baseDir: BACKEND_ROOT,
      outDir: config.dirs.out,
      protectedDirs,
      env: deps.env ?? process.env,
      log,
      now,
    });
  const states = new TargetStateRepo(store);
  const cache = new HashCache(
    deps.hashCacheFile === undefined ? join(config.dirs.data, 'publisher', 'hash-cache.json') : deps.hashCacheFile,
  );

  const gate = gateInfoOf(config);
  const hooksFor = (t: StoredTarget): ConnectHooks => ({
    configDir: config.dirs.config,
    outDir: config.dirs.out,
    protectedDirs,
    ...(gate && t.kind === 'local' && t.gateDir
      ? { localRoot: localTargetDir({ ...t, dir: t.gateDir }, config.dirs.out, protectedDirs) }
      : {}),
    log,
    onTrustedFirstUse: (fp, type) => {
      log.warn({ target: t.id, fingerprint: fp, keyType: type }, 'publisher: host key trusted on first use and pinned');
      targets.pinHostKey(t.id, fp);
    },
  });

  const publicUrlOf = (t: StoredTarget) => t.publicBaseUrl ?? (t.kind === 'sftp' ? config.site.publicUrl : null);

  const statusOf = (t: StoredTarget): TargetStatusPublic => {
    const s = states.get(t.id);
    if (!s || s.dest !== destinationKey(t)) {
      return { lastDeploy: null, deployedVersion: null, deployedAt: null, authBlocked: null, deferredDeletes: 0 };
    }
    return {
      lastDeploy: (s.last as DeployResult | null) ?? null,
      deployedVersion: s.version,
      deployedAt: s.deployedAt,
      authBlocked: s.authBlocked,
      deferredDeletes: Object.keys(s.obsoleteSince).length,
    };
  };

  const knownObsoleteFor = (extra?: Iterable<string>) => () => {
    const out = new Set<string>(extra ?? []);
    for (const c of store.captures.list()) for (const v of c.variants ?? []) out.add(v.relPath);
    return out;
  };

  const attemptContext = (t: StoredTarget, extra: Partial<AttemptContext> = {}): AttemptContext => ({
    targetId: t.id,
    dest: destinationKey(t),
    root: contentRootOf(t, gate?.secret ?? null),
    concurrency: t.kind === 'sftp' ? t.concurrency : 4,
    store,
    states,
    cache,
    log,
    now,
    knownObsolete: knownObsoleteFor(),
    ...(deps.graceMs === undefined ? {} : { graceMs: deps.graceMs }),
    ...extra,
  });

  /** The auth block of an SFTP target (null when it may log in). */
  const authBlockedState = (t: StoredTarget) => {
    if (t.kind !== 'sftp') return null;
    const s = states.get(t.id);
    return s?.authBlocked && s.dest === destinationKey(t) ? s.authBlocked : null;
  };

  const blockAuth = (t: StoredTarget, err: PublishError) => {
    states.update(t.id, destinationKey(t), (s) => ({
      ...s,
      authBlocked: { at: now().toISOString(), message: err.message },
    }));
  };

  async function deployTarget(t: StoredTarget, site: ScanResult, opts: DeployOptions): Promise<DeployResult> {
    const started = performance.now();
    const result: DeployResult = {
      targetId: t.id,
      ok: false,
      version: site.manifestVersion,
      uploaded: 0,
      deleted: 0,
      bytes: 0,
      durationMs: 0,
      httpCheck: 'skipped',
      connections: 0,
      ...(opts.reason ? { reason: opts.reason } : {}),
    };
    const fail = (err: PublishError) => {
      result.ok = false;
      result.error = err.message;
      result.errorCode = err.code;
    };
    const stats = { uploaded: 0, deleted: 0, bytes: 0 };
    let connections = 0;
    const blocked = authBlockedState(t);
    const gateProblem =
      gate && site.manifestVersion !== null
        ? (gateTargetProblem(t, gate.secret) ?? contentTreeProblem(site, gate))
        : null;
    let gateDeploy: GateDeployResult | null = null;
    let contentHtaccess = false;
    if (gateProblem) {
      fail(new PublishError('gate_config', gateProblem));
    } else if (site.manifestVersion === null) {
      fail(
        new PublishError('not_generated', `${site.outDir} has no valid data/manifest.json; generate the site first`),
      );
    } else if (blocked) {
      fail(
        new PublishError(
          'auth_blocked',
          `Login blocked after an authentication failure at ${blocked.at}; save the target with corrected credentials`,
        ),
      );
    } else {
      const lock = states.acquireLock(t.id);
      if (!lock) {
        fail(new PublishError('busy', 'Another deploy of this target is running (other process)'));
      } else {
        try {
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              const ctx = attemptContext(t, {
                stats,
                knownObsolete: knownObsoleteFor(opts.knownObsolete),
                ...(opts.full ? { full: true } : {}),
                ...(opts.force ? { force: true } : {}),
              });
              const openTarget = async () => {
                connections++;
                // Fresh copy: a host key pinned by trust-on-first-use in an earlier attempt applies.
                const current = targets.get(t.id);
                return connect(current && destinationKey(current) === destinationKey(t) ? current : t, hooksFor(t));
              };
              const r = gate
                ? await withSharedRemote(openTarget, async (getRemote) => {
                    // 1. the gate tree (/.htaccess last), 2. the content tree (today's algorithm).
                    const g = await deployGateTree(getRemote, {
                      gateRoot: gateRootOf(t),
                      gateOutDir: gate.gateOutDir,
                      secret: gate.secret,
                      verifyRoot: (text) => verifyHtaccess(text, 'root', gate.cfg),
                      known: gateKnown(t),
                      log,
                      targetId: t.id,
                    });
                    rememberGate(t, g.files);
                    gateDeploy = mergeGate(gateDeploy, g);
                    const content = await deployAttempt(ctx, site, async () => nonClosing(await getRemote()));
                    if (content.plan.uploads.some((u) => u.path === '.htaccess')) contentHtaccess = true;
                    return content;
                  })
                : await deployAttempt(ctx, site, openTarget);
              result.ok = true;
              result.unchanged = r.unchanged;
              result.deferred = r.deferred;
              result.recovered = r.recovered;
              delete result.error;
              delete result.errorCode;
              break;
            } catch (err) {
              const pe = toPublishError(err);
              fail(pe);
              if (pe.code === 'auth') blockAuth(t, pe);
              if (!pe.transient || attempt === maxAttempts) break;
              const delay = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)] ?? 2000;
              log.warn(
                { target: t.id, attempt, err: pe.message, retryInMs: delay },
                'publisher: deploy attempt failed',
              );
              await sleep(delay);
            }
          }
        } finally {
          lock.release();
        }
      }
    }
    result.uploaded = stats.uploaded;
    result.deleted = stats.deleted;
    result.bytes = stats.bytes;
    result.connections = connections;

    if (gate && gateDeploy) {
      const g = gateDeploy as GateDeployResult;
      result.gate = { uploaded: g.uploaded, deleted: g.deleted, htaccess: g.htaccess };
      result.uploaded += g.uploaded;
      result.deleted += g.deleted;
      result.bytes += g.bytes;
    }
    if (result.ok && gate && site.manifestVersion !== null) {
      await gateCheckAfterDeploy(t, site, result, {
        gateChanged: (gateDeploy as GateDeployResult | null)?.changed === true || contentHtaccess,
        reconnect: async () => {
          connections++;
          return connect(t, hooksFor(t));
        },
      });
      result.connections = connections;
    } else if (result.ok && deps.httpCheck !== false) {
      const check = await checkPublishedVersion(publicUrlOf(t), site.manifestVersion, {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        sleep,
        now,
        ...(deps.httpCheck ?? {}),
      });
      result.httpCheck = check.status;
      result.httpDetail = check.detail;
    }
    result.durationMs = Math.round(performance.now() - started);
    result.at = now().toISOString();
    persistResult(t, result);
    return result;
  }

  /** The gate record this backend last wrote to `t` (only while its destination is unchanged). */
  function gateKnown(t: StoredTarget): Record<string, string> | null {
    const raw = store.meta.get(GATE_STATE_KEY(t.id));
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as { dest?: unknown; gateRoot?: unknown; files?: unknown };
      if (v.dest !== destinationKey(t) || v.gateRoot !== gateRootOf(t) || !v.files || typeof v.files !== 'object') {
        return null;
      }
      return v.files as Record<string, string>;
    } catch {
      return null;
    }
  }

  function rememberGate(t: StoredTarget, files: Record<string, string> | null): void {
    if (files === null) {
      store.db.prepare('DELETE FROM meta WHERE key = ?').run(GATE_STATE_KEY(t.id));
      return;
    }
    store.meta.set(GATE_STATE_KEY(t.id), JSON.stringify({ dest: destinationKey(t), gateRoot: gateRootOf(t), files }));
  }

  function gateCheckState(t: StoredTarget): GateCheckState {
    try {
      const v = JSON.parse(store.meta.get(GATE_CHECK_KEY(t.id)) ?? 'null') as Partial<GateCheckState> | null;
      return { okAt: typeof v?.okAt === 'string' ? v.okAt : null, configKey: v?.configKey ?? null };
    } catch {
      return { okAt: null, configKey: null };
    }
  }

  /**
   * Gate check after a gate-mode deploy (spec-wave5 §5.6.2 step 3, §5.6.3): when due, run it;
   * gate_open re-uploads both .htaccess files once (forced) and checks again; still open fails
   * the deploy. store_unverified, error and skipped leave `ok` as it is and travel in gateCheck.
   */
  async function gateCheckAfterDeploy(
    t: StoredTarget,
    site: ScanResult,
    result: DeployResult,
    opts: { gateChanged: boolean; reconnect: () => Promise<RemoteFs> },
  ): Promise<void> {
    if (!gate || site.manifestVersion === null) return;
    const g = gate;
    const state = gateCheckState(t);
    // The access configuration plus this target's destination and store path: a change of the
    // writer or store settings makes the next deploy check (spec-wave5 §5.6.3).
    const configKey = contentHash({
      site: g.configKey,
      dest: destinationKey(t),
      store: t.kind === 'sftp' ? (t.accessStoreRoot ?? null) : (t.accessStoreDir ?? null),
    });
    const due = gateCheckDue(state, { gateChanged: opts.gateChanged, configKey, now: now() });
    const neutral = await readFile(join(g.gateOutDir, '_/n/index.html')).catch(() => null);
    const defaultLocale = await defaultLocaleOf(site);
    let check: GateCheckResult;
    if (!due) {
      check = {
        at: now().toISOString(),
        by: 'mac',
        result: 'skipped',
        detail: 'nothing changed; last check passed less than 6 h ago',
      };
    } else if (!neutral || !defaultLocale) {
      check = { at: now().toISOString(), by: 'mac', result: 'error', detail: 'gate tree or manifest not readable' };
    } else {
      const run = () =>
        runGateCheck({
          fetch: deps.fetch ?? fetch,
          sleep,
          now,
          origin: g.origin,
          secret: g.secret,
          defaultLocale,
          forbiddenBody: Buffer.from(FORBIDDEN_TXT),
          neutralBody: neutral,
          expectedVersion: site.manifestVersion as number,
          rotateSession: deps.serviceSession ? () => (deps.serviceSession as ServiceSessionSource).rotate() : null,
        });
      check = await run();
      if (check.result === 'gate_open') {
        log.error(
          { target: t.id, detail: check.detail },
          'publisher: the gate is open; re-uploading both .htaccess files',
        );
        try {
          await withSharedRemote(opts.reconnect, async (getRemote) => {
            const repaired = await deployGateTree(getRemote, {
              gateRoot: gateRootOf(t),
              gateOutDir: g.gateOutDir,
              secret: g.secret,
              verifyRoot: (text) => verifyHtaccess(text, 'root', g.cfg),
              forceHtaccess: true,
              known: null,
              log,
              targetId: t.id,
            });
            rememberGate(t, repaired.files);
            const content = await readFile(join(site.outDir, '.htaccess'));
            await writeAtomic(await getRemote(), remoteJoin(contentRootOf(t, g.secret), '.htaccess'), content);
          });
          check = await run();
        } catch (err) {
          log.error(
            { target: t.id, err: (err as Error).message },
            'publisher: re-uploading the .htaccess files failed',
          );
        }
      }
    }
    result.gateCheck = check;
    if (check.result === 'ok') {
      store.meta.set(GATE_CHECK_KEY(t.id), JSON.stringify({ okAt: check.at, configKey }));
    } else if (due) {
      store.meta.set(GATE_CHECK_KEY(t.id), JSON.stringify({ okAt: state.okAt, configKey }));
    }
    result.httpCheck =
      check.result === 'ok'
        ? 'ok'
        : check.result === 'store_unverified'
          ? 'mismatch'
          : check.result === 'skipped'
            ? 'skipped'
            : 'error';
    result.httpDetail = `gate check: ${check.result}${check.detail ? ` (${check.detail})` : ''}`;
    if (check.result === 'gate_open') {
      result.ok = false;
      result.errorCode = 'gate_open';
      result.error = `gate_open: ${check.detail ?? 'anonymous requests reach the content'}`;
    }
  }

  function persistResult(t: StoredTarget, result: DeployResult): void {
    try {
      states.update(t.id, destinationKey(t), (s) => ({ ...s, last: result }));
      store.events.append('publish.deploy', result);
    } catch (err) {
      log.error({ err: (err as Error).message }, 'publisher: could not persist the deploy result');
    }
    const summary = {
      target: t.id,
      ok: result.ok,
      version: result.version,
      uploaded: result.uploaded,
      deleted: result.deleted,
      bytes: result.bytes,
      httpCheck: result.httpCheck,
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error, code: result.errorCode } : {}),
    };
    if (result.ok && result.httpCheck !== 'mismatch' && result.httpCheck !== 'error')
      log.info(summary, 'publisher: deployed');
    else log.warn(summary, result.ok ? 'publisher: deployed, but the HTTP check failed' : 'publisher: deploy failed');
  }

  async function runDeploys(opts: DeployOptions): Promise<DeployResult[]> {
    const all = targets.list().filter((t) => t.publish !== false || t.id === opts.targetId);
    const selected = opts.targetId
      ? all.filter((t) => t.id === opts.targetId)
      : all.filter((t) => t.enabled && t.publish !== false);
    const storeOnly = selected.find((t) => t.publish === false);
    if (storeOnly) {
      return [
        {
          targetId: storeOnly.id,
          ok: false,
          version: null,
          uploaded: 0,
          deleted: 0,
          bytes: 0,
          durationMs: 0,
          httpCheck: 'skipped',
          error: `Target ${storeOnly.id} is store-only (publish: false): it is never deployed`,
          errorCode: 'config',
        },
      ];
    }
    if (opts.targetId && selected.length === 0) {
      return [
        {
          targetId: opts.targetId,
          ok: false,
          version: null,
          uploaded: 0,
          deleted: 0,
          bytes: 0,
          durationMs: 0,
          httpCheck: 'skipped',
          error: `Unknown publish target: ${opts.targetId}`,
          errorCode: 'not_found',
        },
      ];
    }
    if (selected.length === 0) return [];
    const outDir = opts.outDir ?? config.dirs.out;
    let site: ScanResult;
    try {
      site = await scanOutDir(outDir, cache);
    } catch (err) {
      const message = `Cannot read ${outDir}: ${(err as Error).message}`;
      return selected.map((t) => {
        const r: DeployResult = {
          targetId: t.id,
          ok: false,
          version: null,
          uploaded: 0,
          deleted: 0,
          bytes: 0,
          durationMs: 0,
          httpCheck: 'skipped',
          error: message,
          errorCode: 'internal',
          at: now().toISOString(),
        };
        persistResult(t, r);
        return r;
      });
    }
    if (site.skipped.length > 0)
      log.warn({ skipped: site.skipped.slice(0, 20) }, 'publisher: unsupported file names skipped');
    const results: DeployResult[] = [];
    for (const t of selected) results.push(await deployTarget(t, site, opts));
    return results;
  }

  // --- single flight with one coalesced follow-up ---------------------------------------------
  let running: Promise<DeployResult[]> | null = null;
  let queued: {
    all: boolean;
    ids: Set<string>;
    opts: DeployOptions;
    promise: Promise<DeployResult[]>;
    resolve: (r: DeployResult[]) => void;
    reject: (e: unknown) => void;
  } | null = null;

  const start = (opts: DeployOptions): Promise<DeployResult[]> => {
    const p = runDeploys(opts).finally(() => {
      running = null;
      const next = queued;
      queued = null;
      if (next) {
        const nextOpts: DeployOptions = { ...next.opts };
        if (next.all || next.ids.size !== 1) delete nextOpts.targetId;
        else nextOpts.targetId = [...next.ids][0] as string;
        start(nextOpts).then(next.resolve, next.reject);
      }
    });
    running = p;
    return p;
  };

  return {
    listTargets: () => targets.list().map((t) => toPublic(t, statusOf(t))),

    getTarget: (id) => {
      const t = targets.get(id);
      return t ? toPublic(t, statusOf(t)) : null;
    },

    saveTarget: (input) => {
      const id = (input as { id?: unknown }).id;
      const before = typeof id === 'string' ? targets.get(id) : undefined;
      const saved = targets.save(input);
      if (before && destinationKey(before) !== destinationKey(saved)) states.forget(saved.id);
      else if (states.get(saved.id)) {
        states.update(saved.id, destinationKey(saved), (s) => ({ ...s, authBlocked: null }));
      }
      log.info({ target: saved.id, kind: saved.kind }, 'publisher: target saved');
      store.events.append('publish.target.saved', { id: saved.id, kind: saved.kind });
      return toPublic(saved, statusOf(saved));
    },

    removeTarget: (id) => {
      if (!targets.remove(id)) throw new PublishError('not_found', `Unknown publish target: ${id}`);
      states.forget(id);
      log.info({ target: id }, 'publisher: target removed');
      store.events.append('publish.target.removed', { id });
    },

    testTarget: async (id, opts = {}) => {
      const t = targets.get(id);
      if (!t) return { ok: false, detail: `Unknown publish target: ${id}` };
      const blocked = authBlockedState(t);
      if (blocked && !opts.force) {
        return {
          ok: false,
          detail: `Login blocked after an authentication failure at ${blocked.at} (${blocked.message}). Save corrected credentials, or test with force.`,
        };
      }
      let remote: RemoteFs | null = null;
      try {
        remote = await connect(t, hooksFor(t));
        const lines: string[] = [`Connected to ${remote.description}`];
        const hk = (remote as Partial<SftpRemote>).hostKey;
        if (hk) lines.push(`host key ${hk.fingerprint}${hk.type ? ` (${hk.type})` : ''}`);
        const root = contentRootOf(t, gate?.secret ?? null);
        const st = await remote.stat(root);
        if (st && st.type !== 'dir') throw new PublishError('config', `Remote root ${root} is not a directory`);
        if (!st) {
          lines.push(`remote root ${root} does not exist yet (created on the first deploy)`);
        } else {
          const probe = `${root === '/' ? '' : root}/.omw-test-${randomBytes(4).toString('hex')}`;
          await writeAtomic(remote, probe, Buffer.from('omw publish test\n'));
          const back = await remote.readFile(probe);
          await remote.remove(probe);
          await remote.remove(tmpPathFor(probe));
          if (back?.toString() !== 'omw publish test\n')
            throw new PublishError('remote', 'Write test read back different content');
          lines.push(
            `remote root ${root} is writable`,
            `atomic replace: ${remote.atomicReplace ? 'yes' : 'no (delete + rename fallback)'}`,
          );
        }
        if (gate && t.publish !== false) {
          const problem = gateTargetProblem(t, gate.secret);
          if (problem) return { ok: false, detail: [...lines, `gate mode: ${problem}`].join('; ') };
          if (!remote.atomicReplace) {
            return { ok: false, detail: [...lines, 'gate mode refuses a target without atomic replace'].join('; ') };
          }
          lines.push(`gate root ${gateRootOf(t)}, content root ${root}`);
        }
        if (blocked) states.update(id, destinationKey(t), (s) => ({ ...s, authBlocked: null }));
        return { ok: true, detail: lines.join('; ') };
      } catch (err) {
        const pe = toPublishError(err);
        if (pe.code === 'auth') blockAuth(t, pe);
        return { ok: false, detail: pe.message };
      } finally {
        if (remote) await remote.close().catch(() => {});
      }
    },

    deploy: (opts = {}) => {
      if (!running) return start(opts);
      if (!queued) {
        let resolve!: (r: DeployResult[]) => void;
        let reject!: (e: unknown) => void;
        const promise = new Promise<DeployResult[]>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        queued = { all: false, ids: new Set(), opts: { ...opts }, promise, resolve, reject };
      }
      if (opts.targetId) queued.ids.add(opts.targetId);
      else queued.all = true;
      if (opts.full) queued.opts.full = true;
      if (opts.force) queued.opts.force = true;
      if (opts.reason) queued.opts.reason = opts.reason;
      if (opts.outDir) queued.opts.outDir = opts.outDir;
      if (opts.knownObsolete) {
        queued.opts.knownObsolete = new Set([...(queued.opts.knownObsolete ?? []), ...opts.knownObsolete]);
      }
      return queued.promise;
    },

    busy: () => running !== null,

    plan: async (opts = {}) => {
      const all = targets.list();
      const selected = opts.targetId ? all.filter((t) => t.id === opts.targetId) : all.filter((t) => t.enabled);
      if (opts.targetId && selected.length === 0)
        throw new PublishError('not_found', `Unknown publish target: ${opts.targetId}`);
      const site = await scanOutDir(opts.outDir ?? config.dirs.out, cache);
      const out: PlanSummary[] = [];
      for (const t of selected) {
        let remote: RemoteFs | null = null;
        try {
          const ctx = attemptContext(t, opts.full ? { full: true } : {});
          // Never log in to an auth-blocked target, not even for a dry run.
          const getRemote =
            opts.offline || authBlockedState(t)
              ? null
              : async () => {
                  try {
                    remote ??= await connect(t, hooksFor(t));
                  } catch (err) {
                    const pe = toPublishError(err);
                    if (pe.code === 'auth') blockAuth(t, pe);
                    throw pe;
                  }
                  return remote;
                };
          const prepared = await preparePlan(ctx, site, getRemote, { dryRun: true });
          const { plan } = prepared;
          // The same checks deploy() makes before it uploads anything (deploy.ts, run()).
          const refusal = versionBehind(prepared, site) ?? massDeleteRefusal(plan.deletes, prepared.deployed);
          out.push({
            targetId: t.id,
            version: site.manifestVersion,
            remoteKnown: plan.remoteKnown,
            uploads: plan.uploads,
            deletes: plan.deletes,
            deferred: plan.deferred,
            unchanged: plan.unchanged,
            uploadBytes: plan.uploadBytes,
            skipped: site.skipped,
            ...(refusal ? { refusal } : {}),
          });
        } finally {
          const r = remote as RemoteFs | null;
          if (r) await r.close().catch(() => {});
        }
      }
      return out;
    },

    lastResults: () =>
      targets
        .list()
        .map((t) => states.last(t.id))
        .filter((r): r is DeployResult => r !== null),

    migrateToGate: async (targetId, opts = {}) => {
      if (!gate) throw new PublishError('gate_config', 'migrate-to-gate needs ACCESS_MODE=gate');
      const t = targets.get(targetId);
      if (!t) throw new PublishError('not_found', `Unknown publish target: ${targetId}`);
      const problem = gateTargetProblem(t, gate.secret);
      if (problem) throw new PublishError('gate_config', problem);
      if (gateRootOf(t) !== '/')
        throw new PublishError('gate_config', `target ${t.id}: migrate-to-gate needs gateRoot "/"`);
      const [deploy] = await runDeploys({ targetId, full: true, reason: 'migrate-to-gate' });
      const result = deploy as DeployResult;
      const report: MigrationReport = { deploy: result, legacy: [], deleted: 0, recordRemoved: false };
      if (!result.ok) return report;
      let remote: RemoteFs | null = null;
      try {
        remote = await connect(t, hooksFor(t));
        const root = gateRootOf(t);
        const rec = await readDeployRecord(remote, root, remoteJoin);
        if (rec.status !== 'ok') return report;
        report.legacy = Object.keys(rec.value.files)
          .filter(
            (p) =>
              !isGateTreePathOrReserved(p, gate.secret) &&
              p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..'),
          )
          .sort();
        if (!opts.confirm) return report;
        const dirs = new Set<string>();
        for (const p of report.legacy) {
          if (await remote.remove(remoteJoin(root, p))) report.deleted++;
          for (let d = p.split('/').slice(0, -1); d.length > 0; d = d.slice(0, -1)) dirs.add(d.join('/'));
        }
        for (const d of [...dirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
          await remote.rmdir(remoteJoin(root, d)).catch(() => false);
        }
        for (const name of [RECORD_NAME, LEGACY_RECORD_NAME, JOURNAL_NAME]) {
          await remote.remove(remoteJoin(root, name)).catch(() => false);
        }
        report.recordRemoved = true;
        log.info({ target: t.id, deleted: report.deleted }, 'publisher: legacy root files removed (migrate-to-gate)');
        return report;
      } finally {
        const r = remote as RemoteFs | null;
        if (r) await r.close().catch(() => {});
      }
    },

    versionFloor: async () => {
      let floor: number | null = null;
      const raise = (v: number | null | undefined) => {
        if (typeof v === 'number' && Number.isInteger(v)) floor = Math.max(floor ?? 0, v);
      };
      for (const t of targets.list().filter((x) => x.enabled)) {
        const s = states.get(t.id);
        if (s && s.dest === destinationKey(t) && s.known) {
          raise(s.version);
          continue;
        }
        if (authBlockedState(t)) continue;
        let remote: RemoteFs | null = null;
        try {
          remote = await connect(t, hooksFor(t));
          const root = contentRootOf(t, gate?.secret ?? null);
          const rec = await readDeployRecord(remote, root, remoteJoin);
          if (rec.status === 'ok') raise(rec.value.version);
          const manifest = await remote.readFile(remoteJoin(root, MANIFEST_PATH));
          if (manifest) {
            try {
              raise((JSON.parse(manifest.toString('utf8')) as { version?: number }).version);
            } catch {
              // not JSON: ignore
            }
          }
        } catch (err) {
          const pe = toPublishError(err);
          if (pe.code === 'auth') blockAuth(t, pe);
          log.warn({ target: t.id, err: pe.message }, 'publisher: cannot read the published site version');
        } finally {
          const r = remote as RemoteFs | null;
          if (r) await r.close().catch(() => {});
        }
      }
      return floor;
    },
  };
}

/** Gate tree paths and the places a migration never deletes (content folder, store, ACME). */
function isGateTreePathOrReserved(p: string, secret: string): boolean {
  return (
    isGateTreePath(p) ||
    p.startsWith(`${secret}/`) ||
    p.startsWith('.well-known/') ||
    p.startsWith('.omw-store/') ||
    p === GATE_RECORD_NAME
  );
}

/** Problems of OUT_DIR for a gate-mode deploy: its .htaccess must verify, no other may exist. */
function contentTreeProblem(site: ScanResult, gate: GateInfo): string | null {
  const ht = site.files.get('.htaccess');
  if (!ht) return 'OUT_DIR has no .htaccess: generate the site in gate mode first';
  for (const path of site.files.keys()) {
    if (path !== '.htaccess' && path.split('/').at(-1) === '.htaccess') {
      return `OUT_DIR contains another .htaccess (${path}): refused (it could switch the gate off for its folder)`;
    }
  }
  let text: string;
  try {
    text = readFileSyncUtf8(ht.abs);
  } catch {
    return 'OUT_DIR .htaccess is not readable';
  }
  const problems = verifyHtaccess(text, 'content', gate.cfg);
  return problems.length > 0 ? `the content .htaccess fails verification: ${problems.join('; ')}` : null;
}

function readFileSyncUtf8(path: string): string {
  return readFileSync(path, 'utf8');
}

/** site.defaultLocale of the deployed manifest (gate check #3). */
async function defaultLocaleOf(site: ScanResult): Promise<string | null> {
  const m = site.files.get(MANIFEST_PATH);
  if (!m) return null;
  try {
    const v = JSON.parse(await readFile(m.abs, 'utf8')) as { site?: { defaultLocale?: unknown } };
    return typeof v.site?.defaultLocale === 'string' ? v.site.defaultLocale : null;
  } catch {
    return null;
  }
}

/** Opens one connection lazily for `fn` (gate tree + content) and closes it afterwards. */
async function withSharedRemote<T>(
  open: () => Promise<RemoteFs>,
  fn: (getRemote: () => Promise<RemoteFs>) => Promise<T>,
): Promise<T> {
  let remote: RemoteFs | null = null;
  const getRemote = async () => {
    if (!remote) {
      const r = await open();
      if (!r.atomicReplace) {
        await r.close().catch(() => {});
        throw new PublishError(
          'gate_config',
          `${r.description} has no atomic replace (posix-rename@openssh.com): gate mode refuses it, a .htaccess must never be missing for a moment`,
        );
      }
      remote = r;
    }
    return remote;
  };
  try {
    return await fn(getRemote);
  } finally {
    const r = remote as RemoteFs | null;
    if (r) await r.close().catch(() => {});
  }
}

/** A view of `remote` whose close() does nothing (the content deploy shares the connection). */
function nonClosing(remote: RemoteFs): RemoteFs {
  return {
    get description() {
      return remote.description;
    },
    get atomicReplace() {
      return remote.atomicReplace;
    },
    writeFile: (p, d) => remote.writeFile(p, d),
    uploadFile: (l, p, n) => remote.uploadFile(l, p, n),
    readFile: (p) => remote.readFile(p),
    replace: (a, b) => remote.replace(a, b),
    remove: (p) => remote.remove(p),
    mkdir: (p) => remote.mkdir(p),
    rmdir: (p) => remote.rmdir(p),
    stat: (p) => remote.stat(p),
    list: (p) => remote.list(p),
    close: async () => {},
  };
}

function mergeGate(a: GateDeployResult | null, b: GateDeployResult): GateDeployResult {
  if (!a) return b;
  return {
    uploaded: a.uploaded + b.uploaded,
    deleted: a.deleted + b.deleted,
    bytes: a.bytes + b.bytes,
    htaccess: a.htaccess || b.htaccess,
    changed: a.changed || b.changed,
    files: b.files,
  };
}

function toPublishError(err: unknown): PublishError {
  if (err instanceof PublishError) return err;
  const e = err as Error;
  return new PublishError('internal', e?.message ?? String(err), { cause: err });
}
