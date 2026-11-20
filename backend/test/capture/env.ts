/**
 * Test environment for the capture/pipeline tests: temp dirs below .cache/tmp, a config from env,
 * a store on disk, a log-capturing pino logger and a scriptable fake WaSource.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { WaCommand, WaEvent } from '@omw/contracts/wa';
import { pino } from 'pino';
import type { WaSource, WaSourceState } from '../../src/capture/index.js';
import { type Config, loadConfig } from '../../src/config.js';
import type { Logger } from '../../src/log.js';
import { REPO_ROOT, type StatePaths, statePaths } from '../../src/paths.js';
import { type Clock, Store } from '../../src/store/index.js';
import { makeTempDir } from '../helpers.js';

export const FIXTURES_DIR = join(REPO_ROOT, 'fixtures', 'generated');
export const FIXTURE_INBOX = join(FIXTURES_DIR, 'inbox');
export const fixturesPresent = existsSync(join(FIXTURES_DIR, 'index.json'));

export interface FixtureIndexEntry {
  key: string;
  msgId: string;
  sourceKey: string;
  publicId: string;
  kind: string;
  timestamp: string;
  tz: string;
  localDate: string;
  file: string | null;
  source: string;
  download: string;
  revokedAt: string | null;
}

export function fixtureIndex(): { statuses: FixtureIndexEntry[] } {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'index.json'), 'utf8')) as { statuses: FixtureIndexEntry[] };
}

export function fixtureByKey(key: string): FixtureIndexEntry {
  const entry = fixtureIndex().statuses.find((s) => s.key === key);
  if (!entry) throw new Error(`fixture ${key} missing`);
  return entry;
}

export interface LogRecord {
  level: number;
  msg?: string;
  component?: string;
  [key: string]: unknown;
}

export function captureLogger(): { log: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const log = pino(
    { level: 'trace' },
    {
      write(line: string) {
        records.push(JSON.parse(line) as LogRecord);
      },
    },
  );
  return { log, records };
}

export interface TestEnv {
  dir: string;
  config: Config;
  paths: StatePaths;
  store: Store;
  log: Logger;
  records: LogRecord[];
  cleanup: () => void;
  reopenStore: () => Store;
}

export function makeEnv(options: { env?: Record<string, string>; now?: Clock; prefix?: string } = {}): TestEnv {
  const { dir, cleanup } = makeTempDir(options.prefix ?? 'capture-');
  const config = loadConfig({
    NODE_ENV: 'test',
    WA_MODE: 'fixture',
    FIXTURES_DIR,
    DATA_DIR: join(dir, 'state'),
    ARCHIVE_DIR: join(dir, 'archive'),
    OUT_DIR: join(dir, 'out'),
    CONFIG_DIR: join(dir, 'config'),
    MEDIA_DIR: join(dir, 'media'),
    DEFAULT_TIMEZONE: 'Europe/Berlin',
    ...options.env,
  });
  const paths = statePaths(config.dirs.data);
  for (const d of [paths.inbox, paths.revokes]) mkdirSync(d, { recursive: true });
  const storeOptions = options.now ? { now: options.now } : {};
  const env: TestEnv = {
    dir,
    config,
    paths,
    store: Store.open(paths.storeDb, storeOptions),
    ...captureLogger(),
    cleanup: () => {
      env.store.close();
      cleanup();
    },
    reopenStore: () => {
      env.store.close();
      env.store = Store.open(paths.storeDb, storeOptions);
      return env.store;
    },
  };
  return env;
}

/** A WaSource that emits what the test tells it to and records commands. */
export class FakeSource implements WaSource {
  readonly sent: WaCommand[] = [];
  private readonly listeners = new Set<(e: WaEvent) => void>();
  tz = new Map<string, string>();
  /** Reported process state (a helper that is not running drops commands). */
  process: WaSourceState['process'] = 'running';

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  send(cmd: WaCommand): void {
    this.sent.push(cmd);
  }
  state(): WaSourceState {
    return {
      mode: 'observer',
      wa: 'open',
      reason: null,
      detail: null,
      until: null,
      jid: null,
      process: this.process,
      pid: null,
      helperVersion: 'fake',
      restarts: 0,
      nextRestartAt: null,
      lastExit: null,
      qr: null,
      pairCode: null,
      traveler: { pn: null, lid: null },
      lastStatusAt: null,
      lastEventAt: null,
      stats: {},
      invalidLines: 0,
    };
  }
  onEvent(cb: (e: WaEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  tzHint(msgId: string): string | null {
    return this.tz.get(msgId) ?? null;
  }
  emit(e: WaEvent): void {
    for (const l of this.listeners) l(e);
  }
}

/** All files below `dir` (recursive), relative paths. */
export function listFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(p.slice(base.length + 1));
  }
  return out.sort();
}
