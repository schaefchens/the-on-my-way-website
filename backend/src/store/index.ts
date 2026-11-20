/**
 * Content store (plan A3): one SQLite database (DATA_DIR/store.db) with typed repositories.
 *
 *   const store = Store.open(statePaths(config.dirs.data).storeDb);
 *   store.captures.insert(…); store.owner.applyChanges(page); store.outbox.enqueue(…);
 *   store.transaction(() => { …several repository calls… });
 */
import { CaptureRepo } from './captures.js';
import { type Db, MEMORY, openDatabase } from './db.js';
import { DeployManifestRepo } from './deployManifest.js';
import { EventRepo } from './events.js';
import { MetaRepo } from './meta.js';
import { migrate } from './migrations.js';
import { OutboxRepo } from './outbox.js';
import { OwnerRepo } from './owner.js';
import { SyncStateRepo } from './syncState.js';
import { type Clock, systemClock } from './types.js';

export interface StoreOptions {
  now?: Clock;
  busyTimeoutMs?: number;
}

export class Store {
  readonly captures: CaptureRepo;
  readonly owner: OwnerRepo;
  readonly outbox: OutboxRepo;
  readonly syncState: SyncStateRepo;
  readonly deploys: DeployManifestRepo;
  readonly events: EventRepo;
  readonly meta: MetaRepo;
  /** Migration result of this open. */
  readonly migration: { from: number; to: number; applied: number[] };

  readonly db: Db;
  readonly now: Clock;

  private constructor(db: Db, now: Clock) {
    this.db = db;
    this.now = now;
    this.migration = migrate(db);
    this.syncState = new SyncStateRepo(db, now);
    this.events = new EventRepo(db, now);
    this.captures = new CaptureRepo(db, now);
    this.owner = new OwnerRepo(db, now, this.syncState, this.events);
    this.outbox = new OutboxRepo(db, now);
    this.deploys = new DeployManifestRepo(db, now);
    this.meta = new MetaRepo(db);
  }

  /** Opens (creating + migrating if needed) the store at `path`; use ":memory:" in tests. */
  static open(path: string, options: StoreOptions = {}): Store {
    const opts = options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs };
    return new Store(openDatabase(path, opts), options.now ?? systemClock);
  }

  static memory(options: StoreOptions = {}): Store {
    return Store.open(MEMORY, options);
  }

  /** Runs `fn` in an IMMEDIATE transaction (nested calls become savepoints). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}

export { type CaptureListFilter, type DownloadResult, initialCaptureState, newCaptureFromInbox } from './captures.js';
export type { DeployEntry, DeployedFile } from './deployManifest.js';
export type { StoredEvent } from './events.js';
export { LATEST_SCHEMA_VERSION, MIGRATIONS, type Migration, MigrationError } from './migrations.js';
export type { OutboxItem, OutboxKind, OutboxStats } from './outbox.js';
export { OUTBOX_KINDS } from './outbox.js';
export type { ChangeSummary, QuarantinedItem } from './owner.js';
export { capturesForEffectiveDate, type PlacedCapture } from './queries.js';
export {
  FEED_CATCHUP_KEY,
  FEED_CURSOR_KEY,
  FEED_ID_KEY,
  FEED_LAST_PULL_KEY,
  FEED_REBUILD_KEY,
  OWNER_SYNCED_KEY,
} from './syncState.js';
export {
  CAPTURE_STATES,
  type CaptureRow,
  type CaptureState,
  type Clock,
  type NewCapture,
  ProcessedMeta,
  ProcessedVariant,
  systemClock,
} from './types.js';
export { CaptureRepo, DeployManifestRepo, EventRepo, MetaRepo, OutboxRepo, OwnerRepo, SyncStateRepo };
