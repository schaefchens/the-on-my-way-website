-- 0050_app_inbox: the traveler app's transit inbox (app-plan §3.6, owner decisions Q2 c, Q4 a, Q8 a;
-- contracts packages/contracts/src/app.ts + app-inbox.ts).
--
-- Numbered 0050 on purpose: the app was built on its own branch next to wave 5 (0002_settings_w5
-- and whatever 000x files follow). Infra\Migrator records applied versions by full name and applies
-- every pending file in lexical order, so a database that already ran 0050 still gets wave-5 files
-- merged later, and a fresh one runs them first. Purely additive (new app_* tables and indexes, no
-- rebuild of an existing table), so either order gives the same schema. A later migration that
-- changes app_* tables must sort after 0050.
-- IF NOT EXISTS only because the app branch's dev databases ran this file as 0004_app_inbox
-- before it was renumbered: there it applies as a no-op (same schema) instead of failing.
-- Conventions as in 0001 (ISO UTC timestamps with milliseconds, json_valid guards).
--
-- Capture tokens deliberately do NOT live in api_tokens: AdminAuth/BackendAuth only look there,
-- so a phone's token can never reach the admin or backend routes, whatever its scope says.

-- One-time pairing codes made in the admin ("Connect a phone"). Two forms of the same code: the
-- 26-char link code (omw://pair#…) and the 8-char typed code; only their sha256 is stored. Single
-- use; valid 1 h by default, at most 24 h. A new code cancels the open one.
CREATE TABLE IF NOT EXISTS app_pairings (
    id           INTEGER PRIMARY KEY,
    link_hash    TEXT NOT NULL UNIQUE CHECK (length(link_hash) = 64),
    typed_hash   TEXT NOT NULL UNIQUE CHECK (length(typed_hash) = 64),
    user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    used_at      TEXT,
    cancelled_at TEXT,
    phone_id     INTEGER                                  -- app_phones.id once redeemed
);

-- Connected phones: one capture token each ("omw_" + 43 base64url chars, stored as sha256 only).
-- Scope is always ["capture"] (Q4 a). Sliding expiry; revoked_at = "Disconnect" in the admin.
CREATE TABLE IF NOT EXISTS app_phones (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    platform     TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
    app_version  TEXT NOT NULL CHECK (length(app_version) BETWEEN 1 AND 40),
    token_hash   TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
    token_hint   TEXT NOT NULL,
    scopes       TEXT NOT NULL DEFAULT '["capture"]' CHECK (scopes = '["capture"]'),
    created_at   TEXT NOT NULL,
    expires_at   TEXT,
    last_used_at TEXT,
    last_used_ip TEXT,
    revoked_at   TEXT
);

-- App entries in transit (primary copy of the entry: none; it is a queue item until the backend's
-- sha256-checked ack, app-plan §3.2). entry_json is the AppEntry exactly as the phone sent it;
-- entry_hash = sha256 of its canonical JSON (idempotent create). phone_id = the token that made it
-- (the scope rules of app-plan §3.4). app_visibility = what the app last wrote into
-- annotations.visibility; a different current value means the owner decided (the app may not
-- change it any more).
CREATE TABLE IF NOT EXISTS app_entries (
    entry_id           TEXT PRIMARY KEY CHECK (length(entry_id) = 26),
    source_key         TEXT NOT NULL UNIQUE CHECK (source_key = 'app:' || entry_id),
    phone_id           INTEGER NOT NULL REFERENCES app_phones (id),
    entry_hash         TEXT NOT NULL CHECK (length(entry_hash) = 64),
    entry_json         TEXT NOT NULL CHECK (json_valid(entry_json)),
    kind               TEXT NOT NULL CHECK (kind IN ('photo', 'video', 'text', 'voice')),
    state              TEXT NOT NULL CHECK (state IN ('receiving', 'uploaded', 'fetching', 'archived', 'withdrawn', 'rejected')),
    occurred_at        TEXT NOT NULL,                      -- corrected (correctAppOccurredAt)
    clamped            INTEGER NOT NULL CHECK (clamped IN (0, 1)),
    held_back          INTEGER NOT NULL CHECK (held_back IN (0, 1)),
    received_at        TEXT NOT NULL,
    uploaded_at        TEXT,
    fetching_at        TEXT,
    archived_at        TEXT,
    withdrawn_at       TEXT,
    withdraw_relay     INTEGER NOT NULL DEFAULT 0 CHECK (withdraw_relay IN (0, 1)), -- the backend must learn it
    rejected_at        TEXT,
    reject_reason      TEXT CHECK (reject_reason IS NULL OR length(reject_reason) <= 200),
    app_visibility     TEXT CHECK (app_visibility IS NULL OR app_visibility IN ('pending', 'hidden')),
    updated_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_entries_phone ON app_entries (phone_id, received_at);
CREATE INDEX IF NOT EXISTS app_entries_state ON app_entries (state, received_at);

-- One upload slot per declared file (tus 1.0 subset). The bytes live in var/app-inbox/<entryId>/
-- <uploadId>.part (denied by var/.htaccess) until the backend acks them.
CREATE TABLE IF NOT EXISTS app_uploads (
    upload_id     TEXT PRIMARY KEY CHECK (upload_id GLOB 'u_?*'),
    entry_id      TEXT NOT NULL REFERENCES app_entries (entry_id) ON DELETE CASCADE,
    role          TEXT NOT NULL CHECK (role IN ('media', 'preview', 'original')),
    mimetype      TEXT NOT NULL,
    bytes         INTEGER NOT NULL CHECK (bytes > 0),
    sha256        TEXT NOT NULL CHECK (length(sha256) = 64),
    upload_offset INTEGER NOT NULL DEFAULT 0 CHECK (upload_offset >= 0 AND upload_offset <= bytes),
    state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'committed', 'archived', 'abandoned', 'deleted')),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    committed_at  TEXT,
    archived_at   TEXT,
    UNIQUE (entry_id, role)
);
CREATE INDEX IF NOT EXISTS app_uploads_state ON app_uploads (state, updated_at);

-- Fixed-window request counters (pairing attempts per IP, requests per phone).
CREATE TABLE IF NOT EXISTS app_rate_hits (
    bucket       TEXT NOT NULL,
    window_start TEXT NOT NULL,
    hits         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, window_start)
) WITHOUT ROWID;

-- Small facts of the app inbox: the backend's archive-only report, the last housekeeping run.
CREATE TABLE IF NOT EXISTS app_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL CHECK (json_valid(value)),
    updated_at TEXT NOT NULL
) WITHOUT ROWID;
