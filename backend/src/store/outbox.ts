/**
 * Outgoing sync queue to the API (capture mirror, previews, revokes, heartbeat, publish reports).
 *
 * At most one pending row exists per (kind, key): enqueueing again replaces the payload and bumps
 * `rev`. A sender completes an item with markDone(id, rev); if the payload changed meanwhile the
 * rev no longer matches, the row stays pending and the newer payload is sent next.
 */
import { toIsoUtc } from '@omw/contracts/time';
import type { Db } from './db.js';
import type { Clock } from './types.js';

export const OUTBOX_KINDS = ['capture', 'preview', 'revoke', 'heartbeat', 'published'] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

export interface OutboxItem<T = unknown> {
  id: number;
  kind: OutboxKind;
  key: string;
  payload: T;
  rev: number;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
}

interface RawOutboxRow {
  id: number;
  kind: OutboxKind;
  key: string;
  payload_json: string;
  rev: number;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  done_at: string | null;
}

const mapRow = (r: RawOutboxRow): OutboxItem => ({
  id: r.id,
  kind: r.kind,
  key: r.key,
  payload: JSON.parse(r.payload_json) as unknown,
  rev: r.rev,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  lastError: r.last_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  doneAt: r.done_at,
});

export interface OutboxStats {
  pending: number;
  /** Pending items that failed at least once. */
  failed: number;
  oldestAt: string | null;
}

export class OutboxRepo {
  private readonly db: Db;
  private readonly now: Clock;

  constructor(db: Db, now: Clock) {
    this.db = db;
    this.now = now;
  }

  /** Adds or replaces the pending item for (kind, key); it becomes due immediately. */
  enqueue(kind: OutboxKind, key: string, payload: unknown): OutboxItem {
    const now = this.now().toISOString();
    const row = this.db
      .prepare(
        `INSERT INTO sync_outbox (kind, key, payload_json, next_attempt_at, created_at, updated_at)
         VALUES (@kind, @key, @payload, @now, @now, @now)
         ON CONFLICT (kind, key) WHERE done_at IS NULL DO UPDATE SET
           payload_json = excluded.payload_json, rev = rev + 1, next_attempt_at = excluded.next_attempt_at,
           updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get({ kind, key, payload: JSON.stringify(payload), now }) as RawOutboxRow;
    return mapRow(row);
  }

  get(id: number): OutboxItem | undefined {
    const r = this.db.prepare('SELECT * FROM sync_outbox WHERE id = ?').get(id) as RawOutboxRow | undefined;
    return r ? mapRow(r) : undefined;
  }

  pending(kind: OutboxKind, key: string): OutboxItem | undefined {
    const r = this.db
      .prepare('SELECT * FROM sync_outbox WHERE kind = ? AND key = ? AND done_at IS NULL')
      .get(kind, key) as RawOutboxRow | undefined;
    return r ? mapRow(r) : undefined;
  }

  /** Pending items due now, in enqueue order. */
  due(limit = 50): OutboxItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sync_outbox WHERE done_at IS NULL AND next_attempt_at <= ?
         ORDER BY id LIMIT ?`,
      )
      .all(this.now().toISOString(), limit) as RawOutboxRow[];
    return rows.map(mapRow);
  }

  /** Completes the item if its payload is unchanged since it was read (rev matches). */
  markDone(id: number, rev: number): boolean {
    return (
      this.db
        .prepare('UPDATE sync_outbox SET done_at = ?, updated_at = ? WHERE id = ? AND rev = ? AND done_at IS NULL')
        .run(this.now().toISOString(), this.now().toISOString(), id, rev).changes > 0
    );
  }

  markFailed(id: number, error: string, nextAttemptAt: Date | string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE sync_outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?, updated_at = ?
           WHERE id = ? AND done_at IS NULL`,
        )
        .run(error, toIsoUtc(nextAttemptAt), this.now().toISOString(), id).changes > 0
    );
  }

  /**
   * Makes pending items that failed at or after `since` due now (their backoff is dropped). Used
   * when the API answers again after an outage, so the queue catches up at once instead of
   * waiting for each item's backoff (up to 15 min). Returns the number of items rescheduled.
   */
  retryFailedSince(since: Date | string): number {
    const now = this.now().toISOString();
    return this.db
      .prepare(
        `UPDATE sync_outbox SET next_attempt_at = ?
         WHERE done_at IS NULL AND attempts > 0 AND next_attempt_at > ? AND updated_at >= ?`,
      )
      .run(now, now, toIsoUtc(since)).changes;
  }

  stats(): OutboxStats {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS pending, COALESCE(SUM(attempts > 0), 0) AS failed, MIN(created_at) AS oldestAt
         FROM sync_outbox WHERE done_at IS NULL`,
      )
      .get() as { pending: number; failed: number; oldestAt: string | null };
    return { pending: r.pending, failed: r.failed, oldestAt: r.oldestAt };
  }

  /** Deletes completed items older than `before`. */
  purgeDone(before: Date | string): number {
    return this.db.prepare('DELETE FROM sync_outbox WHERE done_at IS NOT NULL AND done_at < ?').run(toIsoUtc(before))
      .changes;
  }
}
