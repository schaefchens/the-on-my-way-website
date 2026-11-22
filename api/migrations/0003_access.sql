-- 0003_access: followers, devices, privacy notices + consent, lock and the site-store projection
-- (spec-wave5.md §3). Conventions as in 0001 (ISO UTC timestamps with ms, json_valid guards).

CREATE TABLE followers (
    id              TEXT PRIMARY KEY CHECK (length(id) = 12 AND id NOT GLOB '*[^a-z2-7]*'),
    kind            TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'service')),
    state           TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked', 'deleted')),
    name            TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 60),
    note            TEXT CHECK (note IS NULL OR length(note) <= 200),          -- owner-only memo
    link_hash       TEXT UNIQUE CHECK (link_hash IS NULL OR length(link_hash) = 64),
    link_created_at TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    revoked_at      TEXT,
    deleted_at      TEXT,
    deleted_by      TEXT CHECK (deleted_by IS NULL OR deleted_by IN ('follower', 'owner', 'restore')),
    -- a tombstone keeps only id, kind, state, deleted_at, deleted_by (D12); created_at and
    -- updated_at are overwritten with deleted_at (the invitation date is not kept), revoked_at is NULL
    CHECK (state <> 'deleted' OR (name IS NULL AND note IS NULL AND link_hash IS NULL AND link_created_at IS NULL AND revoked_at IS NULL AND deleted_at IS NOT NULL AND deleted_by IS NOT NULL AND created_at = deleted_at)),
    CHECK (state = 'deleted' OR name IS NOT NULL),
    CHECK (state = 'active' OR link_hash IS NULL)
);
CREATE INDEX followers_state ON followers (state, created_at);

CREATE TABLE devices (
    id           TEXT PRIMARY KEY CHECK (length(id) = 8 AND id NOT GLOB '*[^a-z2-7]*'),
    follower_id  TEXT NOT NULL REFERENCES followers (id) ON DELETE CASCADE,
    state        TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked', 'declined')),
    first        INTEGER NOT NULL DEFAULT 0 CHECK (first IN (0, 1)),   -- joined without approval (Q3 c)
    key_hash     TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64),
    label        TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 60),  -- "iPhone · Safari" (no raw UA)
    session_hash TEXT CHECK (session_hash IS NULL OR length(session_hash) = 64),
    session_at   TEXT,
    pending_sid  TEXT CHECK (pending_sid IS NULL OR length(pending_sid) = 43),  -- §3.8.3 only
    handoff_at   TEXT,
    created_at   TEXT NOT NULL,
    decided_at   TEXT,
    revoked_at   TEXT,
    revoked_by   TEXT CHECK (revoked_by IS NULL OR revoked_by IN ('owner', 'follower', 'system')),
    last_seen_at TEXT,
    CHECK (state = 'active' OR (session_hash IS NULL AND pending_sid IS NULL AND handoff_at IS NULL))
);
CREATE INDEX devices_follower ON devices (follower_id, state);
CREATE INDEX devices_pending ON devices (created_at) WHERE state = 'pending';

-- Privacy notice (D11, Q7): one editable draft, immutable published versions, consent records.
CREATE TABLE privacy_notice_draft (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    notice     TEXT NOT NULL CHECK (json_valid(notice)),   -- contract PrivacyNoticeDraft
    updated_at TEXT NOT NULL
);
CREATE TABLE privacy_notice_versions (
    version      INTEGER PRIMARY KEY CHECK (version >= 1),
    notice       TEXT NOT NULL CHECK (json_valid(notice)), -- contract PrivacyNotice
    sha256       TEXT NOT NULL CHECK (length(sha256) = 64),-- of the canonical JSON
    published_at TEXT NOT NULL
);
CREATE TABLE consents (
    id             INTEGER PRIMARY KEY,
    follower_id    TEXT NOT NULL REFERENCES followers (id) ON DELETE CASCADE,
    device_id      TEXT REFERENCES devices (id) ON DELETE SET NULL,
    notice_version INTEGER NOT NULL REFERENCES privacy_notice_versions (version),
    locale         TEXT NOT NULL,
    confirmed_at   TEXT NOT NULL
);
CREATE INDEX consents_follower ON consents (follower_id, notice_version);

-- Lock, epoch and writer state (single row).
CREATE TABLE access_state (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    store_id         TEXT CHECK (store_id IS NULL OR length(store_id) = 16), -- NULL until store-init (§2.2)
    epoch            TEXT NOT NULL CHECK (length(epoch) = 16),   -- rotated by the restore bootstrap
    reconciled_epoch TEXT,                                       -- != epoch: joins frozen (§3.8.6)
    locked           INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
    locked_at        TEXT,
    locked_by        TEXT CHECK (locked_by IS NULL OR locked_by IN ('admin', 'panic', 'mac')),
    unlocked_at      TEXT,                                       -- sticky-lock import only for newer files (§3.3)
    panic_hash       TEXT CHECK (panic_hash IS NULL OR length(panic_hash) = 64),
    last_applied_op  INTEGER NOT NULL DEFAULT 0,
    last_applied_at  TEXT,
    lease_holder     TEXT CHECK (lease_holder IS NULL OR lease_holder IN ('api', 'mac')),
    lease_until      TEXT,
    writer_blocked_at TEXT,                                     -- SFTP auth failure: no retries
    writer_error     TEXT,
    last_reconcile_at TEXT,
    reconcile_report TEXT CHECK (reconcile_report IS NULL OR json_valid(reconcile_report)), -- StoreReport
    gate_check       TEXT CHECK (gate_check IS NULL OR json_valid(gate_check)), -- GateCheckResult (newest of Mac / cron)
    store_proof_at   TEXT,                                       -- last passed "created accepted + deleted refused"
    updated_at       TEXT NOT NULL
);
INSERT INTO access_state (id, epoch, reconciled_epoch, updated_at)
SELECT 1, e, e, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM (SELECT lower(hex(randomblob(8))) AS e);

-- Outbox of store operations, applied strictly in id order by one holder of the lease.
CREATE TABLE store_ops (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    epoch      TEXT NOT NULL,
    op         TEXT NOT NULL CHECK (op IN ('init', 'put', 'delete', 'delete_prefix', 'delete_tree')),
    path       TEXT NOT NULL,          -- store-relative (StoreLayout regexes); a session put is redacted after apply
    content    TEXT,                   -- put only; never secret
    exclusive  INTEGER NOT NULL DEFAULT 1 CHECK (exclusive IN (0, 1)), -- put: never overwrite (0 only for the marker)
    created_at TEXT NOT NULL,
    applied_at TEXT,
    applied_by TEXT CHECK (applied_by IS NULL OR applied_by IN ('api', 'mac')),
    attempts   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);
CREATE INDEX store_ops_pending ON store_ops (id) WHERE applied_at IS NULL;

-- Rate limiting (hashed subjects; pruned after 48 h).
CREATE TABLE rate_events (
    bucket TEXT NOT NULL,              -- "<kind>:<first 32 hex of sha256(subject + meta.rl_salt)>"
    at     TEXT NOT NULL
);
CREATE INDEX rate_events_bucket ON rate_events (bucket, at);
INSERT INTO meta (key, value) VALUES ('rl_salt', lower(hex(randomblob(16))));

-- One-shot owner notices without names ("A follower deleted their data").
CREATE TABLE owner_notices (
    id           INTEGER PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('follower_deleted', 'restore_reconciled', 'store_mismatch')),
    data         TEXT CHECK (data IS NULL OR json_valid(data)),
    created_at   TEXT NOT NULL,
    delivered_at TEXT,
    read_at      TEXT
);
