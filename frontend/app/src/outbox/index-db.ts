/**
 * The outbox index (expo-sqlite): a rebuildable copy of every manifest for fast lists (Today's
 * strip, the queue, drafts). It is never the truth: on every start the folders are read again and
 * the index follows them (rows without a folder go, newer folder revisions win). The native
 * uploader never opens this file (it reads its own job files).
 */
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import type { OutboxManifest } from '../core/outbox-machine';

let dbPromise: Promise<SQLiteDatabase> | null = null;

async function db(): Promise<SQLiteDatabase> {
  dbPromise ??= (async () => {
    const d = await openDatabaseAsync('outbox-index.db');
    await d.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS entries (
        entry_id   TEXT PRIMARY KEY NOT NULL,
        kind       TEXT NOT NULL,
        phase      TEXT NOT NULL,
        created_at TEXT NOT NULL,
        shared_at  TEXT,
        rev        INTEGER NOT NULL,
        manifest   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entries_phase ON entries (phase);
    `);
    return d;
  })();
  return dbPromise;
}

interface Row {
  entry_id: string;
  rev: number;
  manifest: string;
}

/** Every indexed manifest (fast first paint; reconcile() makes it match the folders). */
export async function loadIndex(): Promise<OutboxManifest[]> {
  try {
    const rows = await (await db()).getAllAsync<Row>('SELECT entry_id, rev, manifest FROM entries');
    const out: OutboxManifest[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.manifest) as OutboxManifest);
      } catch {
        // a bad row is rebuilt from its folder
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function upsertIndex(m: OutboxManifest): Promise<void> {
  await (await db()).runAsync(
    `INSERT INTO entries (entry_id, kind, phase, created_at, shared_at, rev, manifest)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET kind = excluded.kind, phase = excluded.phase,
       shared_at = excluded.shared_at, rev = excluded.rev, manifest = excluded.manifest
     WHERE excluded.rev >= entries.rev`,
    m.entryId,
    m.kind,
    m.phase,
    m.createdAt,
    m.sharedAt ?? null,
    m.rev,
    JSON.stringify(m),
  );
}

export async function removeFromIndex(entryId: string): Promise<void> {
  await (await db()).runAsync('DELETE FROM entries WHERE entry_id = ?', entryId);
}

/** Makes the index match the folders exactly (one transaction). */
export async function rebuildIndex(manifests: readonly OutboxManifest[]): Promise<void> {
  const d = await db();
  await d.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync('DELETE FROM entries');
    for (const m of manifests) {
      await txn.runAsync(
        'INSERT INTO entries (entry_id, kind, phase, created_at, shared_at, rev, manifest) VALUES (?, ?, ?, ?, ?, ?, ?)',
        m.entryId,
        m.kind,
        m.phase,
        m.createdAt,
        m.sharedAt ?? null,
        m.rev,
        JSON.stringify(m),
      );
    }
  });
}
