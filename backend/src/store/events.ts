/** Operational event log shown in the control UI (bounded via prune()). */
import type { Db } from './db.js';
import type { Clock } from './types.js';

export interface StoredEvent<T = unknown> {
  id: number;
  ts: string;
  type: string;
  data: T | null;
}

export class EventRepo {
  private readonly db: Db;
  private readonly now: Clock;

  constructor(db: Db, now: Clock) {
    this.db = db;
    this.now = now;
  }

  append(type: string, data?: unknown): StoredEvent {
    const ts = this.now().toISOString();
    const json = data === undefined ? null : JSON.stringify(data);
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO events (ts, type, data_json) VALUES (?, ?, ?)')
      .run(ts, type, json);
    return { id: Number(lastInsertRowid), ts, type, data: data === undefined ? null : data };
  }

  /** Newest first. */
  recent(options: { limit?: number; type?: string; beforeId?: number } = {}): StoredEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.type) {
      where.push('type = ?');
      params.push(options.type);
    }
    if (options.beforeId !== undefined) {
      where.push('id < ?');
      params.push(options.beforeId);
    }
    const sql = `SELECT id, ts, type, data_json FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY id DESC LIMIT ?`;
    params.push(options.limit ?? 100);
    const rows = this.db.prepare(sql).all(...params) as {
      id: number;
      ts: string;
      type: string;
      data_json: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      type: r.type,
      data: r.data_json === null ? null : (JSON.parse(r.data_json) as unknown),
    }));
  }

  /** Keeps only the newest `keep` events; returns the number deleted. */
  prune(keep: number): number {
    return this.db
      .prepare('DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?)')
      .run(Math.max(0, keep)).changes;
  }
}
