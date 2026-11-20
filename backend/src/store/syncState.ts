/** Key/value sync bookkeeping (feed cursor, last heartbeat, …). */
import type { Db } from './db.js';
import type { Clock } from './types.js';

export const FEED_CURSOR_KEY = 'feed_cursor';
/** feedId of the API change feed the cursor belongs to. */
export const FEED_ID_KEY = 'feed_id';
/** '1' while a mirror rebuild (replay from seq 0) is in progress. */
export const FEED_REBUILD_KEY = 'feed_rebuild';
/** ISO time of the last successful change-feed pull (heartbeat sync.lastPullAt). */
export const FEED_LAST_PULL_KEY = 'feed_last_pull_at';
/**
 * ISO time since which the mirror holds a PREFIX of the feed: a page with hasMore = true was
 * applied and the page that ends the feed (hasMore = false) not yet (L2-03). Written in the same
 * transaction as the page, so a generate that reads the mirror sees a consistent pair.
 */
export const FEED_CATCHUP_KEY = 'feed_catching_up_since';
/**
 * ISO time of the first complete pull (to hasMore = false) since the owner mirror was created or
 * rebuilt (L2-02 first-sync gate). Cleared when a feed reset or a new feed id starts a rebuild.
 */
export const OWNER_SYNCED_KEY = 'owner_synced_at';

export class SyncStateRepo {
  private readonly db: Db;
  private readonly now: Clock;

  constructor(db: Db, now: Clock) {
    this.db = db;
    this.now = now;
  }

  get(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, this.now().toISOString());
  }

  delete(key: string): boolean {
    return this.db.prepare('DELETE FROM sync_state WHERE key = ?').run(key).changes > 0;
  }

  getJson<T>(key: string): T | undefined {
    const v = this.get(key);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }

  /** Last applied change-feed seq (0 = nothing applied yet). */
  feedCursor(): number {
    const v = this.get(FEED_CURSOR_KEY);
    return v === undefined ? 0 : Number.parseInt(v, 10);
  }

  setFeedCursor(seq: number): void {
    if (!Number.isInteger(seq) || seq < 0) throw new RangeError(`Invalid feed cursor: ${seq}`);
    this.set(FEED_CURSOR_KEY, String(seq));
  }

  feedId(): string | undefined {
    return this.get(FEED_ID_KEY);
  }

  setFeedId(feedId: string): void {
    this.set(FEED_ID_KEY, feedId);
  }

  rebuildPending(): boolean {
    return this.get(FEED_REBUILD_KEY) === '1';
  }

  setRebuildPending(pending: boolean): void {
    if (pending) this.set(FEED_REBUILD_KEY, '1');
    else this.delete(FEED_REBUILD_KEY);
  }

  /** Since when the mirror holds only a prefix of the feed (null = caught up). */
  catchingUpSince(): string | null {
    return this.get(FEED_CATCHUP_KEY) ?? null;
  }

  /** Records whether the page just applied left more pages to fetch. */
  setCatchingUp(hasMore: boolean): void {
    if (!hasMore) this.delete(FEED_CATCHUP_KEY);
    else if (this.get(FEED_CATCHUP_KEY) === undefined) this.set(FEED_CATCHUP_KEY, this.now().toISOString());
  }

  ownerSyncedAt(): string | null {
    return this.get(OWNER_SYNCED_KEY) ?? null;
  }

  setOwnerSynced(at: Date | null): void {
    if (at) this.set(OWNER_SYNCED_KEY, at.toISOString());
    else this.delete(OWNER_SYNCED_KEY);
  }

  lastPullAt(): string | null {
    return this.get(FEED_LAST_PULL_KEY) ?? null;
  }

  setLastPullAt(at: Date): void {
    this.set(FEED_LAST_PULL_KEY, at.toISOString());
  }
}
