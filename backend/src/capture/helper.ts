/**
 * HelperSource: supervises the Go wa-helper (whatsmeow) process (plan A1/A2, protocol D9 in
 * contracts wa.ts).
 *
 * - spawns WA_HELPER_BIN with -data-dir, -mode (observer|self), -traveler-phone, -traveler-lid
 *   (the persisted learned LID, see traveler.ts), -send-read-receipt, -connect and -log-level; the
 *   child gets a minimal environment (no secrets of the backend);
 * - stdout: one WaEvent per line, validated with the contracts' schema; invalid lines are logged
 *   (rate-limited) and counted, never fatal; lines over 1 MiB are dropped;
 * - stderr: zerolog JSON lines, re-logged through pino (component "wa-helper");
 * - restarts after unexpected exits per restart-policy.ts (exponential backoff with jitter; slow
 *   after stream_replaced, long hold after client_outdated, the ban end after a temporary ban), the
 *   failure streak resets after a stable run. Invalid configuration (exit 2) and an unused pairing
 *   window (exit 7) are NOT restarted automatically: restart() starts the helper again (control
 *   UI "new QR");
 * - send(cmd) writes WaCommand lines to stdin; stop() sends `shutdown`, closes stdin (EOF also
 *   stops the helper) and escalates to SIGTERM/SIGKILL after a timeout.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { parseWaEventLine, serializeWaCommand, type WaCommand, type WaEvent } from '@omw/contracts/wa';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { StatePaths } from '../paths.js';
import type { Store } from '../store/index.js';
import { LineSplitter } from './lines.js';
import {
  DEFAULT_RESTART_POLICY,
  exitMeaning,
  HELPER_EXIT,
  type RestartPolicy,
  restartDelay,
} from './restart-policy.js';
import { knownTravelerLid, persistTravelerLid } from './traveler.js';
import type { WaSource, WaSourceState } from './types.js';

export interface HelperSourceOptions {
  /** Executable (default config.wa.helperBin). */
  bin?: string;
  /** Arguments placed before the helper flags (e.g. a script path when `bin` is node). */
  binArgs?: string[];
  policy?: Partial<RestartPolicy>;
  /** Grace period for a clean shutdown before SIGTERM, then SIGKILL (default 8 s). */
  stopTimeoutMs?: number;
  /** Environment the child inherits selected variables from (default process.env). */
  env?: Record<string, string | undefined>;
  random?: () => number;
  now?: () => Date;
  /** Max invalid stdout lines logged per process run (all are counted). */
  maxLoggedInvalidLines?: number;
}

export interface HelperSourceDeps {
  config: Config;
  log: Logger;
  paths: StatePaths;
  store: Store;
}

/** Variables passed through to the helper; everything else (tokens, passwords) stays in Node. */
const PASSTHROUGH_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TZ',
  'LANG',
  'LC_ALL',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
];

type PinoLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

function pinoLevel(zerolog: unknown): PinoLevel {
  switch (zerolog) {
    case 'trace':
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
    case 'fatal':
      return zerolog;
    case 'panic':
      return 'fatal';
    default:
      return 'info';
  }
}

export class HelperSource implements WaSource {
  private readonly config: Config;
  private readonly log: Logger;
  private readonly helperLog: Logger;
  private readonly paths: StatePaths;
  private readonly store: Store;
  private readonly policy: RestartPolicy;
  private readonly options: HelperSourceOptions;
  private readonly now: () => Date;
  private readonly random: () => number;

  private child: ChildProcessWithoutNullStreams | null = null;
  private childExit: Promise<void> | null = null;
  private startedAtMs = 0;
  private streak = 0;
  /** The running helper emitted `ready` (config validated; see onExit for exit code 2). */
  private readyThisRun = false;
  private running = false;
  private restartTimer: NodeJS.Timeout | null = null;
  /**
   * start/stop/restart run one after another: two overlapping restart() calls (double click in
   * the control UI) must never leave two helpers on the same WhatsApp session.
   */
  private lifecycle: Promise<unknown> = Promise.resolve();
  private loggedInvalid = 0;
  private readonly eventListeners = new Set<(e: WaEvent) => void>();
  private readonly stateListeners = new Set<(s: WaSourceState) => void>();
  private current: WaSourceState;

  constructor(deps: HelperSourceDeps, options: HelperSourceOptions = {}) {
    this.config = deps.config;
    this.log = deps.log.child({ component: 'wa-source', mode: deps.config.wa.mode });
    this.helperLog = deps.log.child({ component: 'wa-helper' });
    this.paths = deps.paths;
    this.store = deps.store;
    this.options = options;
    this.policy = { ...DEFAULT_RESTART_POLICY, ...options.policy };
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.current = {
      mode: deps.config.wa.mode,
      wa: 'connecting',
      reason: null,
      detail: null,
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
      traveler: { pn: deps.config.wa.travelerPhone, lid: knownTravelerLid(deps.config, deps.store) },
      lastStatusAt: null,
      lastEventAt: null,
      stats: {},
      invalidLines: 0,
    };
  }

  start(): Promise<void> {
    return this.serialized(async () => {
      if (this.running) return;
      this.running = true;
      this.streak = 0;
      this.current.restarts = 0;
      this.spawnHelper();
    });
  }

  stop(): Promise<void> {
    return this.serialized(async () => {
      this.running = false;
      this.clearRestartTimer();
      await this.terminateChild();
      this.update({ process: 'stopped', pid: null, nextRestartAt: null });
    });
  }

  restart(): Promise<void> {
    return this.serialized(async () => {
      this.clearRestartTimer();
      const wasRunning = this.running;
      this.running = false;
      await this.terminateChild();
      this.running = true;
      this.streak = 0;
      if (wasRunning) this.current.restarts++;
      this.spawnHelper();
    });
  }

  private serialized(fn: () => Promise<void>): Promise<void> {
    const run = this.lifecycle.then(fn, fn);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  send(cmd: WaCommand): void {
    let line: string;
    try {
      line = serializeWaCommand(cmd);
    } catch (err) {
      this.log.warn({ err, cmd }, 'refusing to send an invalid helper command');
      return;
    }
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null || !child.stdin.writable) {
      this.log.warn({ command: cmd.type }, 'helper not running: command dropped');
      return;
    }
    child.stdin.write(line);
  }

  state(): WaSourceState {
    return structuredClone(this.current);
  }

  onEvent(cb: (e: WaEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  onStateChange(cb: (s: WaSourceState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  tzHint(): string | null {
    return null;
  }

  // ------------------------------------------------------------------------------------------

  /** Command line of the next spawn (exported for tests and the control UI). */
  commandLine(): { bin: string; args: string[] } {
    const args = [...(this.options.binArgs ?? []), '-data-dir', this.paths.root, '-mode', this.config.wa.mode];
    if (this.config.wa.travelerPhone) args.push('-traveler-phone', this.config.wa.travelerPhone);
    let lid: string | null = null;
    try {
      lid = knownTravelerLid(this.config, this.store);
    } catch (err) {
      // Start without it rather than not at all: the helper learns the LID again.
      this.log.error({ err }, 'reading the learned traveler LID failed');
    }
    if (lid) args.push('-traveler-lid', lid);
    args.push(
      '-send-read-receipt',
      this.config.wa.sendReadReceipt ? 'true' : 'false',
      '-connect',
      // The helper accepts the pino level names (silent = disabled).
      '-log-level',
      this.config.logLevel,
    );
    return { bin: this.options.bin ?? this.config.wa.helperBin, args };
  }

  private childEnv(): Record<string, string> {
    const source = this.options.env ?? process.env;
    const env: Record<string, string> = {};
    for (const key of PASSTHROUGH_ENV) {
      const v = source[key];
      if (v !== undefined) env[key] = v;
    }
    env.DATA_DIR = this.paths.root;
    env.WA_MODE = this.config.wa.mode;
    env.SEND_READ_RECEIPT = this.config.wa.sendReadReceipt ? 'true' : 'false';
    return env;
  }

  private spawnHelper(): void {
    if (!this.running) return;
    if (this.child) {
      // The previous helper survived SIGKILL (or is still exiting): never run two at once. Its
      // exit schedules the next start.
      this.log.error({ pid: this.child.pid }, 'previous wa-helper still alive: not starting another');
      return;
    }
    const { bin, args } = this.commandLine();
    this.loggedInvalid = 0;
    this.readyThisRun = false;
    this.startedAtMs = this.now().getTime();
    this.update({ process: 'starting', nextRestartAt: null, qr: null, pairCode: null });
    this.log.info({ bin, args }, 'starting wa-helper');

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: this.childEnv(), windowsHide: true });
    } catch (err) {
      this.log.error({ err, bin }, 'failed to spawn wa-helper');
      this.onExit(null, null, (err as Error).message);
      return;
    }
    this.child = child;
    let spawnError: string | null = null;
    let resolveExit: () => void = () => {};
    this.childExit = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const stdout = new LineSplitter({
      onLine: (line) => this.handleStdoutLine(line),
      onOverflow: (head) => this.invalidLine(head, 'line longer than 1 MiB'),
    });
    const stderr = new LineSplitter({
      maxLineLength: 64 * 1024,
      onLine: (line) => this.handleStderrLine(line),
      onOverflow: (head) => this.helperLog.warn({ head }, 'over-long stderr line dropped'),
    });
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stdout.on('end', () => stdout.end());
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stderr.on('end', () => stderr.end());
    // EPIPE etc. when the helper died while we were writing: the exit handler takes over.
    child.stdin.on('error', (err) => this.log.debug({ err }, 'helper stdin error'));

    let finished = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      const isCurrent = this.child === child;
      if (isCurrent) this.child = null;
      resolveExit();
      if (isCurrent) this.onExit(code, signal, spawnError);
      else this.log.warn({ code, signal, pid: child.pid }, 'a replaced wa-helper exited');
    };
    child.on('spawn', () => {
      this.update({ process: 'running', pid: child.pid ?? null });
    });
    child.on('error', (err) => {
      this.log.error({ err, bin }, 'wa-helper process error');
      // A process that never started (ENOENT, EACCES) may not emit 'close'.
      if (child.pid === undefined) {
        spawnError = err.message;
        finish(null, null);
      }
    });
    child.on('close', (code, signal) => finish(code, signal));
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, error: string | null): void {
    const nowMs = this.now().getTime();
    // The helper validates its configuration BEFORE `ready`, so exit 2 after `ready` is not a
    // config error: it is the Go runtime's exit code for an unrecovered panic (e.g. inside a
    // whatsmeow goroutine). The restart policy treats it like a fatal error (restart with
    // backoff), never as "stop until restart()"; lastExit and the event keep the real code.
    const crashed = code === HELPER_EXIT.invalidConfig && this.readyThisRun;
    const policyCode = crashed ? HELPER_EXIT.fatal : code;
    const meaning = error
      ? `spawn failed: ${error}`
      : crashed
        ? 'crashed (Go runtime panic, exit 2 after ready)'
        : exitMeaning(code, signal);
    const lastExit = { code, signal, at: new Date(nowMs).toISOString(), meaning };
    const wa = code === 3 ? 'logged_out' : code === 4 ? 'stream_replaced' : code === 6 ? 'banned' : this.current.wa;
    const closed = wa === 'open' || wa === 'connecting' || wa === 'qr' || wa === 'pairing' ? 'closed' : wa;
    try {
      this.store.events.append('wa.helper_exit', { code, signal, meaning });
    } catch (err) {
      // Never let a store problem stop the supervision (the restart below must be scheduled).
      this.log.error({ err, code, signal }, 'recording the wa-helper exit failed');
    }
    if (!this.running) {
      this.log.info({ code, signal }, 'wa-helper stopped');
      this.update({ process: 'stopped', pid: null, lastExit, wa: closed, qr: null });
      return;
    }
    if (nowMs - this.startedAtMs >= this.policy.stableAfterMs) this.streak = 0;
    this.streak++;
    const until = this.current.until ? Date.parse(this.current.until) : Number.NaN;
    const delay = restartDelay(
      this.policy,
      { code: policyCode },
      this.streak,
      nowMs,
      Number.isFinite(until) ? until : null,
      this.random,
    );
    if (delay === null) {
      // Invalid configuration or an unused pairing window: wait for restart() (control UI).
      this.running = false;
      this.log[code === 2 ? 'error' : 'warn']({ code, meaning }, 'wa-helper exited; not restarting until restart()');
      this.update({ process: 'stopped', pid: null, lastExit, wa: closed, qr: null, pairCode: null, detail: meaning });
      return;
    }
    const nextRestartAt = new Date(nowMs + delay).toISOString();
    const level = crashed || code === 3 || code === 4 || code === 5 || code === 6 || error ? 'error' : 'warn';
    this.log[level](
      { code, signal, meaning, delayMs: delay, streak: this.streak },
      'wa-helper exited; restart scheduled',
    );
    this.update({
      process: 'backoff',
      pid: null,
      lastExit,
      wa: closed,
      qr: null,
      pairCode: null,
      nextRestartAt,
      detail: meaning,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.running) return;
      this.current.restarts++;
      this.spawnHelper();
    }, delay);
    this.restartTimer.unref?.();
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private async terminateChild(): Promise<void> {
    const child = this.child;
    const exited = this.childExit;
    if (!child || !exited || child.exitCode !== null || child.signalCode !== null) return;
    const timeoutMs = this.options.stopTimeoutMs ?? 8_000;
    const waitFor = (ms: number) =>
      Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms).unref?.()),
      ]);
    try {
      if (child.stdin.writable) {
        child.stdin.write(serializeWaCommand({ type: 'shutdown' }));
        child.stdin.end();
      }
    } catch (err) {
      this.log.debug({ err }, 'could not send shutdown');
    }
    if (await waitFor(timeoutMs)) return;
    this.log.warn('wa-helper did not stop in time: SIGTERM');
    child.kill('SIGTERM');
    if (await waitFor(3_000)) return;
    this.log.error('wa-helper ignored SIGTERM: SIGKILL');
    child.kill('SIGKILL');
    await waitFor(3_000);
  }

  private handleStdoutLine(line: string): void {
    const parsed = parseWaEventLine(line);
    if (!parsed.ok) {
      this.invalidLine(line, parsed.error);
      return;
    }
    const event = parsed.value;
    try {
      this.applyEvent(event);
    } catch (err) {
      // e.g. the store failed while persisting the traveler LID: this runs inside the stdout
      // stream handler, where a throw would crash the backend.
      this.log.error({ err, type: event.type }, 'handling a wa-helper event failed');
    }
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        this.log.error({ err, type: event.type }, 'wa event listener failed');
      }
    }
  }

  private invalidLine(line: string, error: string): void {
    this.current.invalidLines++;
    const max = this.options.maxLoggedInvalidLines ?? 20;
    this.loggedInvalid++;
    if (this.loggedInvalid <= max) {
      this.log.warn({ line: line.slice(0, 200), error: error.slice(0, 500) }, 'invalid line from wa-helper ignored');
    } else if (this.loggedInvalid % 100 === 0) {
      this.log.warn({ count: this.loggedInvalid }, 'still receiving invalid lines from wa-helper');
    }
    this.notifyState();
  }

  private handleStderrLine(line: string): void {
    let record: Record<string, unknown> | null = null;
    if (line.startsWith('{')) {
      try {
        const v = JSON.parse(line) as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v)) record = v as Record<string, unknown>;
      } catch {
        record = null;
      }
    }
    if (!record) {
      this.helperLog.info(line.slice(0, 4000));
      return;
    }
    const { level, message, time: _time, ...rest } = record;
    this.helperLog[pinoLevel(level)](rest, typeof message === 'string' ? message : 'wa-helper');
  }

  private applyEvent(event: WaEvent): void {
    const at = this.now().toISOString();
    const patch: Partial<WaSourceState> = { lastEventAt: at };
    switch (event.type) {
      case 'ready':
        this.readyThisRun = true;
        patch.helperVersion = event.version;
        break;
      case 'state':
        patch.wa = event.state;
        patch.reason = event.reason ?? null;
        patch.detail = event.detail ?? null;
        patch.until = event.until ?? null;
        if (event.jid) patch.jid = event.jid;
        if (event.state === 'open') {
          patch.qr = null;
          patch.pairCode = null;
        }
        if (event.state === 'logged_out') patch.jid = null;
        break;
      case 'qr':
        patch.qr = { code: event.code, expiresAt: event.expiresAt };
        patch.wa = 'qr';
        break;
      case 'pair_code':
        patch.pairCode = event.code;
        break;
      case 'status':
        patch.lastStatusAt = at;
        break;
      case 'traveler':
        if (persistTravelerLid(this.config, this.store, event.pn, event.lid)) {
          this.log.info({ pn: event.pn, lid: event.lid }, 'learned the traveler LID');
        }
        if (event.lid && (!this.config.wa.travelerPhone || event.pn === this.config.wa.travelerPhone)) {
          patch.traveler = { pn: event.pn, lid: event.lid };
        }
        break;
      case 'stats':
        patch.stats = { ...event.counters };
        break;
      case 'warning':
        this.log.warn(
          { code: event.code, command: event.command, msgId: event.msgId, detail: event.detail },
          'wa-helper warning',
        );
        break;
      case 'media':
      case 'revoke':
        break;
    }
    this.update(patch);
  }

  private update(patch: Partial<WaSourceState>): void {
    Object.assign(this.current, patch);
    this.notifyState();
  }

  private notifyState(): void {
    if (this.stateListeners.size === 0) return;
    const snapshot = this.state();
    for (const listener of this.stateListeners) {
      try {
        listener(snapshot);
      } catch (err) {
        this.log.error({ err }, 'wa state listener failed');
      }
    }
  }
}
