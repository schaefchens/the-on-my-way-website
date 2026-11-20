/**
 * Backend command line.
 *
 *   backend [start]                 run the backend (capture, generate, publish, sync, control UI)
 *   backend generate [--full]       regenerate the static site
 *   backend publish [--target <id>] [--force]
 *                                   deploy OUT_DIR to all enabled targets (or one); --force
 *                                   overrides the mass-delete guard (publisher deploy.ts)
 *   backend reprocess [sourceKey]   re-run the media pipeline from the archive (all or one status)
 *   backend status [--json]         health summary
 *   backend pair-code <phone>       pairing code for linking the observer phone (needs `start`)
 *   backend owner-import <file>     DEV/OFFLINE: apply an owner change feed (e.g. fixtures/generated/owner.json)
 *   backend help
 *
 * One-shot commands talk to a running backend over its control API (Bearer CONTROL_TOKEN, found
 * via GET /healthz on CONTROL_HOST:CONTROL_PORT). Without a running backend they run in-process,
 * holding DATA_DIR/backend.lock so two processes never write OUT_DIR at the same time. The lock
 * also works across containers (heartbeat, app.ts ProcessLock): a one-shot writer in another
 * container (`docker compose run`) next to the running daemon refuses instead of taking over;
 * read-only commands (status) keep working.
 *
 * In Docker: `docker compose exec backend backend status` (the image ships a `backend` wrapper).
 * From the repo: `pnpm --filter @omw/backend cli status` (built) or `… cli:dev status` (tsx).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChangesPage } from '@omw/contracts/api';
import { LOCALE_CODES, type LocaleCode } from '@omw/contracts/i18n';
import {
  type AppFactories,
  createApp,
  FORCE_PUBLISH_KEY,
  LOCK_STALE_MS,
  LockHeldError,
  lockPath,
  PAUSE_FIRST_SYNC,
  PAUSE_RESTORE_CONFIRM,
  ProcessLock,
  RESTORE_CONFIRM_KEY,
} from './app.js';
import type { WaSourceState } from './capture/index.js';
import { createIngest, createWaSource } from './capture/index.js';
import { type Config, ConfigError, type LogLevel, loadConfig } from './config.js';
import { createGenerator } from './generator/index.js';
import { createLogger, type Logger } from './log.js';
import { statePaths } from './paths.js';
import { createPublisher, TARGETS_FILE } from './publisher/index.js';
import { Store } from './store/index.js';
import {
  createSync,
  lastCaptureAt,
  preGenerateSnapshot,
  readGenerateSnapshot,
  readPublishState,
  statfsFree,
  writeGenerateSnapshot,
} from './sync/index.js';
import { formatBytes, relativeTime } from './ui/html.js';
import { LogRing } from './ui/log-ring.js';
import type { AppStatus } from './ui/types.js';

export const realFactories: AppFactories = { createWaSource, createIngest, createGenerator, createPublisher };

const USAGE = `Usage: backend <command> [options]

Commands:
  start                   run the backend (default)
  generate [--full]       regenerate the static site (OUT_DIR)
  publish [--target ID] [--force]
                          deploy OUT_DIR to every enabled target, or one; --force overrides the
                          guard that refuses deploys deleting half the site or every day page
  reprocess [SOURCE_KEY]  re-run the media pipeline from the archive (all, or one "wa:<id>")
  status [--json]         health summary
  pair-code PHONE         get a pairing code to link the OBSERVER phone (backend must be running)
  owner-import FILE [--locales=de,en,ar] [--force]
                          DEV/OFFLINE: apply an owner change feed (API "changes" page, or a file with
                          a "changes" member such as fixtures/generated/owner.json) to the owner
                          mirror; --locales also sets site.locales (e.g. an RTL test deployment).
                          Refused while an API is configured (it owns that content) unless --force.
  help                    this text

Environment: see backend/README.md (CONTROL_TOKEN, API_BASE_URL, WA_MODE, …).`;

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const defaultIo: CliIo = {
  out: (t) => process.stdout.write(`${t}\n`),
  err: (t) => process.stderr.write(`${t}\n`),
};

interface Parsed {
  command: string;
  args: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: readonly string[]): Parsed {
  const args: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '-h') {
      flags.set('help', true);
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else if (a === '--target') {
        const v = argv[i + 1];
        if (v !== undefined && !v.startsWith('--')) {
          flags.set('target', v);
          i++;
        } else flags.set('target', true);
      } else flags.set(a.slice(2), true);
    } else args.push(a);
  }
  const command = args.shift() ?? 'start';
  return { command: flags.has('help') ? 'help' : command, args, flags };
}

// ---------------------------------------------------------------------------------------------
// Talking to a running backend

export function controlBaseUrl(config: Config): string {
  const host = ['0.0.0.0', '::', ''].includes(config.control.host) ? '127.0.0.1' : config.control.host;
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${h}:${config.control.port}`;
}

/** True when an On My Way backend answers on the control port. */
export async function daemonRunning(config: Config, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${controlBaseUrl(config)}/healthz`, { signal: AbortSignal.timeout(1_500) });
    const body = (await res.json()) as { app?: unknown };
    return body.app === 'omw-backend';
  } catch {
    return false;
  }
}

export async function callDaemon<T>(
  config: Config,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: T }> {
  const res = await fetchImpl(`${controlBaseUrl(config)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.control.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: { message: text.slice(0, 500) } };
  }
  if (res.status === 401)
    throw new Error('The running backend rejected CONTROL_TOKEN (different token in this shell?)');
  return { status: res.status, body: parsed as T };
}

// ---------------------------------------------------------------------------------------------
// Status rendering

export function formatStatus(s: AppStatus, running: boolean): string {
  const now = Date.parse(s.now);
  const by = s.captures.byState;
  const inPipeline = (by.awaiting_media ?? 0) + (by.received ?? 0) + (by.archived ?? 0) + (by.processed ?? 0);
  const lost = (by.failed ?? 0) + (by.media_lost ?? 0);
  const lines: string[] = [];
  lines.push(
    `On My Way backend ${s.version} — ${running ? `running, up ${relativeTime(s.startedAt, now).replace(' ago', '')}` : 'NOT running'}`,
  );
  if (running) {
    const t = s.wa.traveler;
    lines.push(
      `WhatsApp   ${s.wa.state}${s.wa.reason ? ` (${s.wa.reason})` : ''}${s.wa.jid ? ` as ${s.wa.jid}` : ''} · traveler ${t.pn ? `+${t.pn}` : '–'} · LID ${t.lid ? `known (${t.lidSource})` : 'not learned yet'}`,
    );
  }
  lines.push(
    `Captures   ${s.captures.total} total · ${by.ready ?? 0} ready · ${inPipeline} in pipeline · ${lost} failed/lost · last status ${relativeTime(s.captures.lastStatusAt, now)}`,
  );
  const g = s.build.last;
  lines.push(
    `Site       ${g ? `v${g.version} generated ${relativeTime(g.at, now)} (${g.full ? 'full' : 'incremental'}, ${g.changed} changed)` : 'never generated'}${s.build.pending ? ' · generate queued' : ''}${s.build.lastError ? ` · ERROR ${s.build.lastError}` : ''}`,
  );
  const p = s.publish;
  lines.push(
    `Publish    ${p.targets} enabled target${p.targets === 1 ? '' : 's'} · ${p.state.lastVersion !== undefined ? `live v${p.state.lastVersion} since ${relativeTime(p.state.lastAt, now)}` : 'nothing deployed yet'}${p.state.lastError ? ` · last error: ${p.state.lastError}` : ''}`,
  );
  if (p.pausedReason) lines.push(`           PAUSED: ${p.pausedReason}`);
  if (s.build.heldReason) lines.push(`           generate waits: ${s.build.heldReason}`);
  const y = s.sync;
  lines.push(
    y.enabled
      ? `API sync   ${y.baseUrl} · feed seq ${y.feedSeq}${y.rebuilding ? ' (rebuilding)' : ''} · outbox ${y.queue.pending} pending/${y.queue.failed} failing · last pull ${relativeTime(y.lastPullAt, now)}${y.quarantined ? ` · ${y.quarantined} quarantined` : ''}${y.authPausedUntil ? ' · TOKEN REJECTED' : ''}`
      : 'API sync   disabled (no API_BASE_URL)',
  );
  lines.push(`Disk free  ${formatBytes(s.disk.freeBytes)}`);
  return lines.join('\n');
}

/** Status from the store alone (backend not running). */
async function offlineStatus(config: Config): Promise<AppStatus> {
  const store = Store.open(statePaths(config.dirs.data).storeDb);
  try {
    const byState = store.captures.countByState() as Record<string, number>;
    let targets = 0;
    try {
      const file = JSON.parse(readFileSync(join(config.dirs.config, TARGETS_FILE), 'utf8')) as {
        targets?: { enabled?: boolean }[];
      };
      targets = (file.targets ?? []).filter((t) => t.enabled !== false).length;
    } catch {
      targets = 0;
    }
    const now = new Date().toISOString();
    return {
      app: 'omw-backend',
      version: config.version ?? 'dev',
      env: config.env,
      startedAt: now,
      now,
      uptimeS: 0,
      stopping: false,
      wa: {
        mode: config.wa.mode,
        state: 'closed',
        reason: null,
        detail: 'backend not running',
        until: null,
        jid: null,
        process: 'stopped',
        restarts: 0,
        helperVersion: null,
        nextRestartAt: null,
        qr: null,
        pairCode: null,
        traveler: {
          pn: config.wa.travelerPhone,
          lid: config.wa.travelerLid,
          lidSource: config.wa.travelerLid ? 'config' : null,
        },
        lastStatusAt: null,
        lastEventAt: null,
        stats: {},
      },
      captures: {
        byState,
        total: Object.values(byState).reduce((a, b) => a + b, 0),
        lastStatusAt: lastCaptureAt(store),
      },
      ingest: {},
      disk: {
        freeBytes: await statfsFree([config.dirs.data, config.dirs.archive, config.dirs.media, config.dirs.out]),
      },
      sync: {
        enabled: config.api !== null,
        baseUrl: config.api?.baseUrl ?? null,
        authPausedUntil: null,
        lastPullAt: store.syncState.lastPullAt(),
        lastPullError: null,
        lastPushAt: null,
        lastPushError: null,
        lastHeartbeatAt: null,
        lastHeartbeatError: null,
        feedId: store.syncState.feedId() ?? null,
        feedSeq: store.syncState.feedCursor(),
        rebuilding: store.syncState.rebuildPending(),
        quarantined: store.owner.quarantineCount(),
        queue: store.outbox.stats(),
      },
      build: { running: false, pending: null, last: readGenerateSnapshot(store), lastError: null, nextPublishAt: null },
      publish: {
        running: false,
        queued: false,
        pausedReason:
          config.api && !store.syncState.ownerSyncedAt()
            ? PAUSE_FIRST_SYNC
            : store.syncState.get(RESTORE_CONFIRM_KEY)
              ? PAUSE_RESTORE_CONFIRM
              : null,
        targets,
        state: readPublishState(store),
        lastResults: [],
        lastAt: readPublishState(store).lastAt ?? null,
        nextRetryAt: null,
      },
      site: { publicUrl: config.site.publicUrl, outDir: config.dirs.out },
    };
  } finally {
    store.close();
  }
}

/** A WaSource that does nothing: one-shot commands never start the WhatsApp helper. */
function inertSource(config: Config): Parameters<AppFactories['createIngest']>[0]['source'] {
  const state: WaSourceState = {
    mode: config.wa.mode,
    wa: 'closed',
    reason: null,
    detail: 'not started (CLI)',
    until: null,
    jid: null,
    process: 'stopped',
    pid: null,
    helperVersion: null,
    restarts: 0,
    nextRestartAt: null,
    lastExit: null,
    qr: null,
    pairCode: null,
    traveler: { pn: config.wa.travelerPhone, lid: config.wa.travelerLid },
    lastStatusAt: null,
    lastEventAt: null,
    stats: {},
    invalidLines: 0,
  };
  return {
    start: async () => {},
    stop: async () => {},
    send: () => {},
    state: () => state,
    onEvent: () => () => {},
  };
}

// ---------------------------------------------------------------------------------------------
// Commands

async function withLocalLock<T>(config: Config, command: string, fn: () => Promise<T>): Promise<T> {
  const lock = ProcessLock.acquire(lockPath(config), command).startHeartbeat();
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

/** Message for a one-shot command that finds DATA_DIR locked. */
export function lockHeldMessage(err: LockHeldError, command: string): string {
  if (err.foreign) {
    return (
      `The backend daemon is running (host ${err.holder.host}, since ${err.holder.startedAt}); ` +
      `use \`docker compose exec backend backend ${command}\` instead of a separate container (\`docker compose run\`).`
    );
  }
  return `Another backend process holds DATA_DIR (pid ${err.holder.pid}, ${err.holder.command}); try again later.`;
}

async function localGenerate(config: Config, log: Logger, full: boolean, dates: string[], reason: string) {
  const store = Store.open(statePaths(config.dirs.data).storeDb);
  try {
    const generator = createGenerator({
      config,
      log,
      store,
      ...(config.siteDistDir ? { siteDistDir: config.siteDistDir } : {}),
    });
    const pre = preGenerateSnapshot(store);
    const r = await generator.generate({ ...(full ? { full: true } : {}), ...(dates.length ? { dates } : {}), reason });
    writeGenerateSnapshot(store, {
      version: r.version,
      at: new Date().toISOString(),
      feedSeq: pre.feedSeq,
      capturesThrough: pre.capturesThrough,
      full: r.full,
      durationMs: Math.round(r.durationMs),
      changed: r.changed.length,
      removed: r.removed.length,
    });
    return {
      version: r.version,
      changed: r.changed.length,
      removed: r.removed.length,
      full: r.full,
      durationMs: Math.round(r.durationMs),
    };
  } finally {
    store.close();
  }
}

async function localPublish(config: Config, log: Logger, targetId: string | undefined, force: boolean) {
  const store = Store.open(statePaths(config.dirs.data).storeDb);
  const publisher = createPublisher({ config, log, store });
  const enabledTargets = () =>
    publisher
      .listTargets()
      .filter((t) => t.enabled)
      .map((t) => t.id);
  const sync = createSync({ config, log, store, enabledTargets });
  try {
    // The daemon's gate (L2-02 b) applies to one-shot publishes too: never publish an owner mirror
    // that has not completed a pull from the API.
    if (config.api && !store.syncState.ownerSyncedAt()) {
      throw new Error(
        `${PAUSE_FIRST_SYNC}: start the backend (it pulls the owner content from the API) and publish when the sync completed`,
      );
    }
    const results = await publisher.deploy({
      reason: force ? 'cli --force' : 'cli',
      ...(targetId ? { targetId } : {}),
      ...(force ? { force: true } : {}),
    });
    sync.reportPublished(results);
    // A successful publish by hand confirms a restore without an API (app.ts RESTORE_CONFIRM_KEY).
    if (results.length > 0 && results.every((r) => r.ok) && store.syncState.delete(RESTORE_CONFIRM_KEY)) {
      log.info('restore confirmed by this publish: automatic publishing resumes');
    }
    if (sync.enabled) {
      // Deliver the publish reports (and anything else due) now; the daemon retries the rest.
      await sync.flushNow().catch((err: unknown) => log.warn({ err }, 'API report delivery failed (queued)'));
    }
    return results;
  } finally {
    await sync.stop();
    store.close();
  }
}

async function localReprocess(config: Config, log: Logger, sourceKey: string | undefined) {
  const store = Store.open(statePaths(config.dirs.data).storeDb);
  const paths = statePaths(config.dirs.data);
  const dates = new Set<string>();
  try {
    const ingest = createIngest({
      config,
      log,
      paths,
      store,
      source: inertSource(config),
      syncOutbox: config.api !== null,
    });
    ingest.onChange((c) => {
      for (const d of c.localDates) dates.add(d);
    });
    const n = await ingest.reprocess(sourceKey);
    await ingest.stop();
    return { count: n, dates: [...dates].sort() };
  } finally {
    store.close();
  }
}

export interface OwnerImportResult {
  feedId: string;
  applied: number;
  skipped: number;
  ignored: number;
  quarantined: number;
  cursor: number;
  /** The import replaced a mirror from another feed (rebuild). */
  rebuilt: boolean;
  locales: LocaleCode[] | null;
  localDates: string[];
}

/** Parses "--locales=de,en,ar" (null when absent). Throws on unknown or duplicate codes. */
export function parseLocalesFlag(value: string | true | undefined): LocaleCode[] | null {
  if (value === undefined) return null;
  if (value === true) throw new Error('--locales needs a value, e.g. --locales=de,en,ar');
  const codes = value
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const known = new Set<string>(LOCALE_CODES);
  const bad = codes.filter((c) => !known.has(c));
  if (codes.length === 0 || bad.length > 0) {
    throw new Error(`--locales: unknown locale(s) ${bad.join(', ') || '(none)'}; known: ${LOCALE_CODES.join(', ')}`);
  }
  if (new Set(codes).size !== codes.length) throw new Error('--locales: duplicate locale');
  return codes as LocaleCode[];
}

/**
 * Applies an owner change feed page from a file to the owner mirror (what the API sync does with
 * GET /changes). For development and offline use without an API: fixtures, RTL test deployments.
 * A file from another feed id replaces the mirror (rebuild: rows the file does not contain are
 * swept). An API configured later has its own feed id, so its first pull rebuilds the mirror.
 */
export function ownerImport(store: Store, json: unknown, locales: LocaleCode[] | null): OwnerImportResult {
  const raw =
    json && typeof json === 'object' && 'changes' in json && !('items' in json)
      ? (json as { changes: unknown }).changes
      : json;
  const page = ChangesPage.parse(raw);
  // The file is the whole feed: never leave a rebuild half-done waiting for more pages.
  const full = { ...page, hasMore: false };
  let summary = store.owner.applyChanges(full);
  const rebuilt = summary.reset;
  if (summary.reset) summary = store.owner.applyChanges(full);
  const dates = new Set(summary.localDates);
  let { applied } = summary;
  if (locales) {
    const seq = summary.cursor + 1;
    const extra = store.owner.applyChanges({
      feedId: page.feedId,
      items: [{ seq, entity: 'setting', key: 'site.locales', op: 'upsert', data: { value: locales } }],
      nextSeq: seq,
      hasMore: false,
    });
    applied += extra.applied;
    if (extra.quarantined > 0) throw new Error('site.locales was rejected (see feed_quarantine)');
    summary = { ...summary, cursor: extra.cursor };
  }
  return {
    feedId: page.feedId,
    applied,
    skipped: summary.skipped,
    ignored: summary.ignored,
    quarantined: summary.quarantined,
    cursor: summary.cursor,
    rebuilt,
    locales,
    localDates: [...dates].sort(),
  };
}

function printJson(io: CliIo, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

export interface CliDeps {
  env?: Record<string, string | undefined>;
  io?: CliIo;
  fetch?: typeof fetch;
}

/** Runs one command; resolves with the exit code ("start" resolves once the backend runs). */
export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const io = deps.io ?? defaultIo;
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetch ?? fetch;
  const { command, args, flags } = parseArgs(argv);
  if (command === 'help') {
    io.out(USAGE);
    return 0;
  }
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (err) {
    io.err(err instanceof ConfigError ? err.message : String(err));
    return 2;
  }
  const chatty: LogLevel = env.LOG_LEVEL ? config.logLevel : 'info';

  if (command === 'start') return start(config, io);
  try {
    return await oneShot(command, args, flags, config, chatty, io, fetchImpl);
  } catch (err) {
    if (err instanceof LockHeldError) {
      io.err(lockHeldMessage(err, command));
    } else {
      io.err(`error: ${err instanceof Error ? err.message : String(err)}`);
      if (env.LOG_LEVEL === 'debug' && err instanceof Error && err.stack) io.err(err.stack);
    }
    return 1;
  }
}

async function oneShot(
  command: string,
  args: string[],
  flags: Map<string, string | true>,
  config: Config,
  chatty: LogLevel,
  io: CliIo,
  fetchImpl: typeof fetch,
): Promise<number> {
  switch (command) {
    case 'status': {
      const running = await daemonRunning(config, fetchImpl);
      const status = running
        ? (await callDaemon<AppStatus>(config, 'GET', '/api/status', undefined, 10_000, fetchImpl)).body
        : await offlineStatus(config);
      if (flags.has('json')) printJson(io, { running, ...status });
      else io.out(formatStatus(status, running));
      return 0;
    }

    case 'generate': {
      const full = flags.has('full');
      if (await daemonRunning(config, fetchImpl)) {
        const r = await callDaemon<{ ok: boolean; result: unknown; error?: { message: string } }>(
          config,
          'POST',
          '/api/rebuild',
          { full },
          30 * 60_000,
          fetchImpl,
        );
        if (r.status !== 200) {
          io.err(`generate failed: ${r.body.error?.message ?? `HTTP ${r.status}`}`);
          return 1;
        }
        printJson(io, r.body.result ?? { note: 'nothing to generate' });
        return 0;
      }
      const log = createLogger({ level: chatty, pretty: config.env === 'development' });
      const result = await withLocalLock(config, 'generate', () =>
        localGenerate(config, log, full, [], full ? 'cli full' : 'cli'),
      );
      printJson(io, result);
      return 0;
    }

    case 'publish': {
      const target = flags.get('target');
      const force = flags.has('force');
      if (target === true) {
        io.err('--target needs a target id');
        return 2;
      }
      if (await daemonRunning(config, fetchImpl)) {
        if (force) {
          // The control API predates --force: hand the override to the daemon through the store
          // (consumed by its next deploy, valid 10 min), then ask it to publish.
          const store = Store.open(statePaths(config.dirs.data).storeDb);
          try {
            store.syncState.set(FORCE_PUBLISH_KEY, new Date().toISOString());
          } finally {
            store.close();
          }
        }
        const r = await callDaemon<{ ok: boolean; results: unknown[]; error?: { message: string } }>(
          config,
          'POST',
          '/api/publish',
          { ...(target ? { targetId: target } : {}), ...(force ? { force: true } : {}) },
          60 * 60_000,
          fetchImpl,
        );
        if (r.status !== 200) {
          io.err(`publish failed: ${r.body.error?.message ?? `HTTP ${r.status}`}`);
          return 1;
        }
        printJson(io, r.body.results);
        if ((r.body.results ?? []).length === 0) io.err('No (enabled) publish target.');
        return r.body.ok ? 0 : 1;
      }
      const log = createLogger({ level: chatty, pretty: config.env === 'development' });
      const results = await withLocalLock(config, 'publish', () =>
        localPublish(config, log, target || undefined, force),
      );
      printJson(io, results);
      if (results.length === 0) io.err('No (enabled) publish target.');
      return results.length > 0 && results.every((r) => r.ok) ? 0 : 1;
    }

    case 'reprocess': {
      const sourceKey = args[0];
      if (await daemonRunning(config, fetchImpl)) {
        const r = await callDaemon<{ ok: boolean; count: number; error?: { message: string } }>(
          config,
          'POST',
          '/api/reprocess',
          sourceKey ? { sourceKey } : {},
          6 * 60 * 60_000,
          fetchImpl,
        );
        if (r.status !== 200) {
          io.err(`reprocess failed: ${r.body.error?.message ?? `HTTP ${r.status}`}`);
          return 1;
        }
        io.out(`Reprocessed ${r.body.count} capture(s); the running backend regenerates and publishes.`);
        return 0;
      }
      const log = createLogger({ level: chatty, pretty: config.env === 'development' });
      const out = await withLocalLock(config, 'reprocess', async () => {
        const r = await localReprocess(config, log, sourceKey);
        const g = await localGenerate(config, log, false, r.dates, 'reprocess');
        return { reprocessed: r.count, generate: g };
      });
      printJson(io, out);
      io.err('Run `backend publish` (or start the backend) to deploy the result.');
      return 0;
    }

    case 'pair-code': {
      const phone = args[0];
      if (!phone) {
        io.err('Usage: backend pair-code <observer phone, international format>');
        return 2;
      }
      if (!(await daemonRunning(config, fetchImpl))) {
        io.err('The backend is not running: start it first (the pairing code comes from the live WhatsApp helper).');
        return 1;
      }
      const r = await callDaemon<{ code?: string; error?: { message: string } }>(
        config,
        'POST',
        '/api/pair-code',
        { phone },
        45_000,
        fetchImpl,
      );
      if (r.status !== 200 || !r.body.code) {
        io.err(`No pairing code: ${r.body.error?.message ?? `HTTP ${r.status}`}`);
        return 1;
      }
      io.out(r.body.code);
      io.err('On the observer phone: WhatsApp → Linked devices → Link a device → Link with phone number instead.');
      return 0;
    }

    case 'owner-import': {
      const file = args[0];
      if (!file) {
        io.err('Usage: backend owner-import <changes.json> [--locales=de,en,ar] [--force]');
        return 2;
      }
      let locales: LocaleCode[] | null;
      try {
        locales = parseLocalesFlag(flags.get('locales'));
      } catch (err) {
        io.err((err as Error).message);
        return 2;
      }
      if (config.api && !flags.has('force')) {
        io.err(
          'An API is configured: owner content comes from its change feed (the next feed rebuild would ' +
            'replace an import). Use --force to import anyway.',
        );
        return 2;
      }
      if (await daemonRunning(config, fetchImpl)) {
        io.err('Stop the backend first: owner-import writes the store directly (start it again afterwards).');
        return 1;
      }
      const json = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      const result = await withLocalLock(config, 'owner-import', async () => {
        const store = Store.open(statePaths(config.dirs.data).storeDb);
        try {
          return ownerImport(store, json, locales);
        } finally {
          store.close();
        }
      });
      printJson(io, result);
      io.err('Run `backend generate` (or start the backend) to regenerate the site.');
      return result.quarantined > 0 ? 1 : 0;
    }

    default:
      io.err(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

async function start(config: Config, io: CliIo): Promise<number> {
  const logRing = new LogRing(2_000);
  const log = createLogger({ level: config.logLevel, pretty: config.env === 'development', tee: logRing });
  let lock: ProcessLock;
  try {
    lock = await acquireForStart(config, log);
  } catch (err) {
    if (err instanceof LockHeldError) {
      io.err(
        err.foreign
          ? `Another backend already runs on this DATA_DIR (host ${err.holder.host}, since ${err.holder.startedAt}).`
          : `Another backend already runs on this DATA_DIR (pid ${err.holder.pid}, since ${err.holder.startedAt}).`,
      );
      return 1;
    }
    throw err;
  }
  lock.startHeartbeat();
  const app = createApp({ config, log, logRing, factories: realFactories });
  let exiting = false;
  const exit = async (reason: string, code: number) => {
    if (exiting) {
      log.warn({ reason }, 'second signal: exiting immediately');
      lock.release();
      process.exit(code || 1);
    }
    exiting = true;
    try {
      await app.stop(reason);
    } catch (err) {
      log.error({ err }, 'shutdown failed');
      code = code || 1;
    }
    lock.release();
    log.flush?.();
    process.exit(code);
  };
  process.on('SIGINT', () => void exit('SIGINT', 0));
  process.on('SIGTERM', () => void exit('SIGTERM', 0));
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaught exception');
    void exit('uncaughtException', 1);
  });
  process.on('unhandledRejection', (err) => {
    log.fatal({ err }, 'unhandled promise rejection');
    void exit('unhandledRejection', 1);
  });
  try {
    await app.start();
  } catch (err) {
    log.fatal({ err }, 'backend failed to start');
    await exit('startup failure', 1);
    return 1;
  }
  return 0;
}

/**
 * The daemon's lock. A lock of another host whose heartbeat is still fresh (e.g. a container
 * replaced right after being killed) is waited for until it goes stale (at most ~35 s).
 */
async function acquireForStart(config: Config, log: Logger): Promise<ProcessLock> {
  const deadline = Date.now() + LOCK_STALE_MS + 5_000;
  for (;;) {
    try {
      return ProcessLock.acquire(lockPath(config), 'start');
    } catch (err) {
      if (!(err instanceof LockHeldError) || !err.foreign || Date.now() > deadline) throw err;
      log.warn({ host: err.holder.host }, 'DATA_DIR lock of another host is still fresh; waiting for it to expire');
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const argv = process.argv.slice(2);
  runCli(argv).then(
    (code) => {
      // `start` keeps running (servers, timers); one-shot commands exit with their code.
      if (parseArgs(argv).command !== 'start' || code !== 0) process.exit(code);
    },
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    },
  );
}
