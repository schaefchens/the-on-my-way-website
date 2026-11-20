/**
 * FixtureSource (WA_MODE=fixture): replays recorded statuses without a phone. It copies
 * FIXTURES_DIR/inbox/<msgId>/ into DATA_DIR/inbox/<msgId>/ exactly like the helper would leave
 * them (atomic: staged in a dot-directory, fsynced, renamed), writes the revoke records, and emits
 * the matching `status` / `revoke` events in timestamp order. Existing inbox entries are never
 * replaced (meta.json is created once, wa.ts).
 *
 * pace: 0 = everything during start() (tests, first boot); > 0 = one status every `paceMs` in the
 * background (live demo of the pipeline).
 *
 * FIXTURES_DIR/index.json (written by `pnpm fixtures`) supplies the time zone each status was
 * captured in (tzHint) and the traveler identity.
 */
import { promises as fsp, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INBOX_META_FILE,
  InboxMeta,
  LidDigits,
  PhoneDigits,
  RevokeRecord,
  type WaCommand,
  type WaEvent,
} from '@omw/contracts/wa';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { StatePaths } from '../paths.js';
import {
  fsyncDir,
  fsyncPath,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  removeStaleTemps,
  tempPathFor,
  writeFileDurable,
} from '../pipeline/files.js';
import { listInboxMessages, listRevokes } from './inbox.js';
import type { WaSource, WaSourceState } from './types.js';

export interface FixtureSourceOptions {
  /** Default config.wa.fixturesDir. */
  fixturesDir?: string;
  /** Delay between replayed items; 0 = all at once during start(). */
  paceMs?: number;
  now?: () => Date;
}

export interface FixtureSourceDeps {
  config: Config;
  log: Logger;
  paths: StatePaths;
}

interface FixtureIndex {
  tz: Map<string, string>;
  traveler: { pn: string; lid?: string } | null;
}

type ReplayItem =
  | { kind: 'status'; msgId: string; at: string; meta: InboxMeta }
  | { kind: 'revoke'; msgId: string; at: string; record: RevokeRecord };

function loadIndex(dir: string, log: Logger): FixtureIndex {
  const out: FixtureIndex = { tz: new Map(), traveler: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'fixtures index.json not readable: no time-zone hints');
    return out;
  }
  const index = raw as { statuses?: { msgId?: unknown; tz?: unknown }[]; traveler?: { pn?: unknown; lid?: unknown } };
  for (const s of index.statuses ?? []) {
    if (typeof s.msgId === 'string' && typeof s.tz === 'string') out.tz.set(s.msgId, s.tz);
  }
  const pn = PhoneDigits.safeParse(index.traveler?.pn);
  const lid = LidDigits.safeParse(index.traveler?.lid);
  if (pn.success) out.traveler = lid.success ? { pn: pn.data, lid: lid.data } : { pn: pn.data };
  return out;
}

export class FixtureSource implements WaSource {
  private readonly log: Logger;
  private readonly paths: StatePaths;
  private readonly fixturesDir: string;
  private readonly paceMs: number;
  private readonly now: () => Date;
  private readonly index: FixtureIndex;
  private readonly eventListeners = new Set<(e: WaEvent) => void>();
  private readonly stateListeners = new Set<(s: WaSourceState) => void>();
  private current: WaSourceState;
  private running = false;
  private replay: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private replayed = 0;

  constructor(deps: FixtureSourceDeps, options: FixtureSourceOptions = {}) {
    this.log = deps.log.child({ component: 'wa-source', mode: 'fixture' });
    this.paths = deps.paths;
    this.fixturesDir = options.fixturesDir ?? deps.config.wa.fixturesDir;
    this.paceMs = Math.max(0, options.paceMs ?? 0);
    this.now = options.now ?? (() => new Date());
    this.index = loadIndex(this.fixturesDir, this.log);
    this.current = {
      mode: 'fixture',
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
      traveler: { pn: this.index.traveler?.pn ?? null, lid: this.index.traveler?.lid ?? null },
      lastStatusAt: null,
      lastEventAt: null,
      stats: {},
      invalidLines: 0,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.update({ process: 'running', helperVersion: 'fixture' });
    this.emit({ type: 'ready', version: 'fixture' });
    this.emit({ type: 'state', state: 'open', at: this.now().toISOString(), detail: `replaying ${this.fixturesDir}` });
    if (this.index.traveler) this.emit({ type: 'traveler', ...this.index.traveler });
    // Leftovers of a replay that was killed half-way (staging dirs, temp revoke files).
    await removeStaleTemps(this.paths.inbox, '.fixture-');
    await removeStaleTemps(this.paths.revokes, '');
    const items = await this.loadItems();
    if (this.paceMs === 0) {
      await this.replayItems(items);
    } else {
      this.replay = this.replayItems(items).catch((err) => this.log.error({ err }, 'fixture replay failed'));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.replay;
    this.replay = null;
    this.update({ process: 'stopped', wa: 'closed' });
  }

  send(cmd: WaCommand): void {
    if (cmd.type === 'stats') {
      this.emit({ type: 'stats', counters: { captured: this.replayed } });
      return;
    }
    this.log.debug({ command: cmd.type }, 'fixture source ignores command');
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

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  tzHint(msgId: string): string | null {
    return this.index.tz.get(msgId) ?? null;
  }

  // ------------------------------------------------------------------------------------------

  private async loadItems(): Promise<ReplayItem[]> {
    const inbox = join(this.fixturesDir, 'inbox');
    const items: ReplayItem[] = [];
    for (const msgId of await listInboxMessages(inbox)) {
      try {
        const meta = InboxMeta.parse(JSON.parse(await fsp.readFile(join(inbox, msgId, INBOX_META_FILE), 'utf8')));
        items.push({ kind: 'status', msgId, at: meta.timestamp, meta });
      } catch (err) {
        this.log.warn({ msgId, err: (err as Error).message }, 'skipping invalid fixture');
      }
    }
    const revokesDir = join(inbox, '_revokes');
    for (const msgId of await listRevokes(revokesDir)) {
      try {
        const record = RevokeRecord.parse(JSON.parse(await fsp.readFile(join(revokesDir, `${msgId}.json`), 'utf8')));
        items.push({ kind: 'revoke', msgId, at: record.at, record });
      } catch (err) {
        this.log.warn({ msgId, err: (err as Error).message }, 'skipping invalid fixture revoke');
      }
    }
    // Chronological; a revoke never precedes its status.
    return items.sort((a, b) =>
      a.at !== b.at
        ? a.at < b.at
          ? -1
          : 1
        : a.kind !== b.kind
          ? a.kind === 'status'
            ? -1
            : 1
          : a.msgId < b.msgId
            ? -1
            : 1,
    );
  }

  private async replayItems(items: ReplayItem[]): Promise<void> {
    for (const item of items) {
      if (!this.running) return;
      if (item.kind === 'status') {
        const copied = await this.copyStatus(item.msgId);
        if (copied) this.replayed++;
        this.emit({ type: 'status', msgId: item.msgId, source: item.meta.source });
      } else {
        await this.writeRevoke(item.record);
        this.emit({ type: 'revoke', msgId: item.msgId, at: item.record.at });
      }
      if (this.paceMs > 0) await this.sleep(this.paceMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  /** Copies one fixture message dir into the inbox atomically; false when it already exists. */
  private async copyStatus(msgId: string): Promise<boolean> {
    const target = join(this.paths.inbox, msgId);
    try {
      await fsp.access(target);
      return false;
    } catch {
      // not there yet
    }
    // Private like the helper's inbox (L1-09): directories 0700, files 0600.
    await fsp.mkdir(this.paths.inbox, { recursive: true, mode: PRIVATE_DIR_MODE });
    const staging = tempPathFor(join(this.paths.inbox, `.fixture-${msgId}`));
    await fsp.mkdir(staging, { mode: PRIVATE_DIR_MODE });
    await fsp.chmod(staging, PRIVATE_DIR_MODE);
    try {
      const source = join(this.fixturesDir, 'inbox', msgId);
      // The original first, meta.json last (as the helper does: meta.json names the file).
      const names = (await fsp.readdir(source)).sort((a, b) =>
        a === INBOX_META_FILE ? 1 : b === INBOX_META_FILE ? -1 : a < b ? -1 : 1,
      );
      for (const name of names) {
        await fsp.copyFile(join(source, name), join(staging, name));
        await fsp.chmod(join(staging, name), PRIVATE_FILE_MODE); // never the fixture's own mode
        await fsyncPath(join(staging, name), 'r+');
      }
      await fsyncDir(staging);
      try {
        await fsp.rename(staging, target);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOTEMPTY' || code === 'EEXIST') return false; // created concurrently
        throw err;
      }
      await fsyncDir(this.paths.inbox);
      return true;
    } finally {
      await fsp.rm(staging, { recursive: true, force: true });
    }
  }

  private async writeRevoke(record: RevokeRecord): Promise<void> {
    const target = join(this.paths.revokes, `${record.msgId}.json`);
    try {
      await fsp.access(target);
      return;
    } catch {
      // not there yet
    }
    await writeFileDurable(target, `${JSON.stringify(record, null, 2)}\n`, {
      mode: PRIVATE_FILE_MODE,
      dirMode: PRIVATE_DIR_MODE,
    });
  }

  private emit(event: WaEvent): void {
    const at = this.now().toISOString();
    const patch: Partial<WaSourceState> = { lastEventAt: at };
    if (event.type === 'state') patch.wa = event.state;
    if (event.type === 'status') patch.lastStatusAt = at;
    this.update(patch);
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        this.log.error({ err, type: event.type }, 'wa event listener failed');
      }
    }
  }

  private update(patch: Partial<WaSourceState>): void {
    Object.assign(this.current, patch);
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
