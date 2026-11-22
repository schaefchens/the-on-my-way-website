/**
 * Versioned in-code migrations. The applied version lives in meta.schema_version; each
 * migration runs in its own transaction. Never edit a released migration — append a new one.
 *
 * Schema (v1)
 * - meta(key, value)                       schema_version, site_version (monotonic counter)
 * - captures                               captured statuses (primary data, see captures.ts)
 * - pending_revokes(msg_id, at)            revokes that arrived before their status
 * - posts / annotations / days / trips     owner mirror (JSON payload as received from the API
 *   / settings                             + a few indexed columns), pulled via the change feed
 * - feed_quarantine                        change-feed items that could not be applied
 * - sync_outbox                            queued pushes to the API (coalesced per kind+key)
 * - sync_state(key, value)                 feed_cursor, feed_id and other sync bookkeeping
 * - deploy_manifest(target, path, …)       last deployed file list per publish target
 * - events(id, ts, type, data_json)        operational event log (control UI)
 *
 * Conventions and additions to the original table sketch:
 * - All timestamps are canonical ISO UTC with milliseconds (Date#toISOString), so string
 *   comparison equals time order; local dates are "YYYY-MM-DD".
 * - captures.received_at (helper receive time); unique partial index on msg_id.
 * - captures.download_state mirrors InboxMeta.download.state; media captures wait in state
 *   'awaiting_media' until the helper reports the download as ok (or permanently failed).
 * - captures.variants_json = ProcessedVariant[], processed_meta_json = ProcessedMeta (types.ts);
 *   text_json / media_json / sender_json hold the InboxMeta parts verbatim.
 * - Owner mirror rows keep the full entity in data_json plus the columns needed for queries
 *   (posts: kind, occurred_at, local_date, visibility; annotations: visibility,
 *   local_date_override; trips: start/end date) and the change-feed seq that last wrote them.
 *   Trip membership of a day comes from trip date ranges only (contracts ./policy).
 * - sync_outbox.rev + updated_at implement coalescing (see outbox.ts).
 */
import type { Db } from './db.js';

export interface Migration {
  version: number;
  name: string;
  up(db: Db): void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) WITHOUT ROWID;

        CREATE TABLE captures (
          source_key          TEXT PRIMARY KEY,
          public_id           TEXT NOT NULL UNIQUE,
          msg_id              TEXT,
          source              TEXT NOT NULL CHECK (source IN ('live', 'history', 'fixture')),
          kind                TEXT NOT NULL
                              CHECK (kind IN ('photo', 'video', 'gif', 'voice', 'text', 'unsupported')),
          occurred_at         TEXT NOT NULL,
          received_at         TEXT,
          tz                  TEXT NOT NULL,
          local_date          TEXT NOT NULL,
          caption             TEXT,
          text_json           TEXT,
          media_json          TEXT,
          sender_json         TEXT,
          state               TEXT NOT NULL DEFAULT 'received'
                              CHECK (state IN ('awaiting_media', 'received', 'archived', 'processed', 'ready',
                                               'failed', 'media_lost')),
          download_state      TEXT NOT NULL DEFAULT 'not_applicable'
                              CHECK (download_state IN ('pending', 'retrying', 'ok', 'failed', 'not_applicable')),
          download_reason     TEXT,
          download_permanent  INTEGER CHECK (download_permanent IN (0, 1)),
          attempts            INTEGER NOT NULL DEFAULT 0,
          next_attempt_at     TEXT,
          last_error          TEXT,
          archive_path        TEXT,
          original_sha256     TEXT,
          variants_json       TEXT,
          processed_meta_json TEXT,
          revoked_at          TEXT,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL
        );
        CREATE UNIQUE INDEX captures_msg_id ON captures (msg_id) WHERE msg_id IS NOT NULL;
        CREATE INDEX captures_local_date ON captures (local_date, occurred_at);
        CREATE INDEX captures_occurred_at ON captures (occurred_at);
        CREATE INDEX captures_due ON captures (state, next_attempt_at);

        CREATE TABLE pending_revokes (
          msg_id      TEXT PRIMARY KEY,
          at          TEXT NOT NULL,
          received_at TEXT NOT NULL
        ) WITHOUT ROWID;

        CREATE TABLE posts (
          public_id   TEXT PRIMARY KEY,
          kind        TEXT NOT NULL CHECK (kind IN ('note', 'story')),
          occurred_at TEXT NOT NULL,
          local_date  TEXT NOT NULL,
          visibility  TEXT NOT NULL CHECK (visibility IN ('public', 'hidden', 'pending')),
          data_json   TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          seq         INTEGER
        ) WITHOUT ROWID;
        CREATE INDEX posts_local_date ON posts (local_date, occurred_at);

        CREATE TABLE annotations (
          source_key          TEXT PRIMARY KEY,
          visibility          TEXT CHECK (visibility IN ('public', 'hidden', 'pending')),
          local_date_override TEXT,
          data_json           TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          seq                 INTEGER
        ) WITHOUT ROWID;
        CREATE INDEX annotations_local_date_override ON annotations (local_date_override)
          WHERE local_date_override IS NOT NULL;

        CREATE TABLE days (
          local_date  TEXT PRIMARY KEY,
          tz          TEXT,
          data_json   TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          seq         INTEGER
        ) WITHOUT ROWID;

        CREATE TABLE trips (
          slug        TEXT PRIMARY KEY,
          start_date  TEXT NOT NULL,
          end_date    TEXT NOT NULL,
          data_json   TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          seq         INTEGER
        ) WITHOUT ROWID;

        CREATE TABLE settings (
          key         TEXT PRIMARY KEY,
          value_json  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          seq         INTEGER
        ) WITHOUT ROWID;

        CREATE TABLE feed_quarantine (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          feed_id     TEXT,
          seq         INTEGER,
          entity      TEXT,
          key         TEXT,
          raw_json    TEXT NOT NULL,
          error       TEXT NOT NULL,
          received_at TEXT NOT NULL
        );

        CREATE TABLE sync_outbox (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          kind            TEXT NOT NULL
                          CHECK (kind IN ('capture', 'preview', 'revoke', 'heartbeat', 'published')),
          key             TEXT NOT NULL,
          payload_json    TEXT NOT NULL,
          rev             INTEGER NOT NULL DEFAULT 1,
          attempts        INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NOT NULL,
          last_error      TEXT,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          done_at         TEXT
        );
        CREATE UNIQUE INDEX sync_outbox_pending ON sync_outbox (kind, key) WHERE done_at IS NULL;
        CREATE INDEX sync_outbox_due ON sync_outbox (done_at, next_attempt_at);

        CREATE TABLE sync_state (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) WITHOUT ROWID;

        CREATE TABLE deploy_manifest (
          target      TEXT NOT NULL,
          path        TEXT NOT NULL,
          sha256      TEXT NOT NULL,
          size        INTEGER NOT NULL,
          deployed_at TEXT NOT NULL,
          PRIMARY KEY (target, path)
        ) WITHOUT ROWID;

        CREATE TABLE events (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          ts        TEXT NOT NULL,
          type      TEXT NOT NULL,
          data_json TEXT
        );
        CREATE INDEX events_type ON events (type, id);

        INSERT INTO meta (key, value) VALUES ('site_version', '0')
          ON CONFLICT (key) DO NOTHING;
      `);
    },
  },
  {
    // The traveler app (app-plan §3.7): captures.source also allows 'app' (sourceKey "app:<ULID>",
    // capture/app-source.ts). SQLite cannot change a CHECK in place, so captures is rebuilt with
    // the same columns and indexes (no foreign key references it). Nothing else changes.
    version: 2,
    name: 'captures.source app',
    up(db) {
      db.exec(`
        CREATE TABLE captures_v2 (
          source_key          TEXT PRIMARY KEY,
          public_id           TEXT NOT NULL UNIQUE,
          msg_id              TEXT,
          source              TEXT NOT NULL CHECK (source IN ('live', 'history', 'fixture', 'app')),
          kind                TEXT NOT NULL
                              CHECK (kind IN ('photo', 'video', 'gif', 'voice', 'text', 'unsupported')),
          occurred_at         TEXT NOT NULL,
          received_at         TEXT,
          tz                  TEXT NOT NULL,
          local_date          TEXT NOT NULL,
          caption             TEXT,
          text_json           TEXT,
          media_json          TEXT,
          sender_json         TEXT,
          state               TEXT NOT NULL DEFAULT 'received'
                              CHECK (state IN ('awaiting_media', 'received', 'archived', 'processed', 'ready',
                                               'failed', 'media_lost')),
          download_state      TEXT NOT NULL DEFAULT 'not_applicable'
                              CHECK (download_state IN ('pending', 'retrying', 'ok', 'failed', 'not_applicable')),
          download_reason     TEXT,
          download_permanent  INTEGER CHECK (download_permanent IN (0, 1)),
          attempts            INTEGER NOT NULL DEFAULT 0,
          next_attempt_at     TEXT,
          last_error          TEXT,
          archive_path        TEXT,
          original_sha256     TEXT,
          variants_json       TEXT,
          processed_meta_json TEXT,
          revoked_at          TEXT,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          CHECK (source <> 'app' OR (source_key GLOB 'app:*' AND msg_id IS NULL))
        );
        INSERT INTO captures_v2 SELECT * FROM captures;
        DROP TABLE captures;
        ALTER TABLE captures_v2 RENAME TO captures;
        CREATE UNIQUE INDEX captures_msg_id ON captures (msg_id) WHERE msg_id IS NOT NULL;
        CREATE INDEX captures_local_date ON captures (local_date, occurred_at);
        CREATE INDEX captures_occurred_at ON captures (occurred_at);
        CREATE INDEX captures_due ON captures (state, next_attempt_at);
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

export class MigrationError extends Error {
  override name = 'MigrationError';
}

export function currentSchemaVersion(db: Db): number {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() as
    | { name: string }
    | undefined;
  if (!table) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row ? Number.parseInt(row.value, 10) : 0;
}

/** Applies pending migrations; returns the versions before and after. */
export function migrate(
  db: Db,
  migrations: readonly Migration[] = MIGRATIONS,
): { from: number; to: number; applied: number[] } {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  sorted.forEach((m, i) => {
    if (m.version !== i + 1) throw new MigrationError(`Migration versions must be 1..n, got ${m.version}`);
  });
  const latest = sorted.at(-1)?.version ?? 0;
  const from = currentSchemaVersion(db);
  if (from > latest) {
    throw new MigrationError(`Database schema v${from} is newer than this backend (v${latest}); refusing to open`);
  }
  const applied: number[] = [];
  for (const m of sorted) {
    if (m.version <= from) continue;
    db.transaction(() => {
      m.up(db);
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ).run(String(m.version));
    }).immediate();
    applied.push(m.version);
  }
  return { from, to: Math.max(from, latest), applied };
}
