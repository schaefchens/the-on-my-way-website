-- 0001_init: initial schema of the On My Way API (docs/PLAN.md section B, contracts ./api).
--
-- Conventions
--   * Timestamps: ISO-8601 UTC strings with milliseconds, "2026-11-19T21:35:00.123Z"
--     (strftime('%Y-%m-%dT%H:%M:%fZ', 'now') in SQL, Infra\Clock::nowIso() in PHP).
--   * Dates: "YYYY-MM-DD" (local calendar dates, D6). Time zones: IANA names.
--   * Localized owner text (I18nText) is a JSON object {"de": "...", "en": "..."}; the original
--     language lives in a separate orig_locale column (D5).
--   * JSON columns are guarded with json_valid() (SQLite JSON1; bin/doctor.php checks for it).
--   * Owner tables (posts, annotations, days, trips, settings) are the primary copy of that data.
--     Every write to them must append to change_log IN THE SAME TRANSACTION (done in PHP rather
--     than with triggers, so change_log.data is exactly the DTO the backend receives).
--   * schema_migrations is created by Infra\Migrator itself (it has to exist before 0001 runs):
--       schema_migrations(version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)
--   * Runs inside one BEGIN IMMEDIATE transaction (Migrator); no BEGIN/COMMIT/PRAGMA here.
--     Later migrations that rebuild FK-linked tables start with the line
--     "-- omw:foreign-keys=off" (see Infra\Migrator).
--   * JSON columns are re-emitted with json_decode($json, false) so "{}" stays an object, and
--     owner rows are serialized through one DTO mapper per entity (NULL column -> null; the
--     contracts accept null for every optional output field).

-- ---------------------------------------------------------------------------------------------
-- Instance metadata. feed_id identifies this database's change feed (contracts ChangesResponse.feedId).
-- The restore/reinstall procedure MUST rotate it:
--   UPDATE meta SET value = lower(hex(randomblob(16))) WHERE key = 'feed_id';
-- so a backend whose cursor belongs to another feed rebuilds its mirror instead of skipping
-- changes (a restored backup rewinds change_log.seq).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
INSERT INTO meta (key, value) VALUES ('feed_id', lower(hex(randomblob(16))));

-- ---------------------------------------------------------------------------------------------
-- Capture mirror (primary copy: backend). Written only by PUT /api/v1/backend/captures/{sourceKey}
-- (contract CaptureMirror); owner data about a capture lives in annotations.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE captures (
    source_key       TEXT PRIMARY KEY,                    -- "wa:<msgId>" (D4; never published)
    public_id        TEXT NOT NULL UNIQUE,                -- "e_" + 12 base32 chars (D4)
    kind             TEXT NOT NULL CHECK (kind IN ('photo', 'video', 'gif', 'voice', 'text', 'unsupported')),
    occurred_at      TEXT NOT NULL,                       -- ISO UTC
    tz               TEXT NOT NULL,                       -- IANA zone at capture time
    local_date       TEXT NOT NULL CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    caption          TEXT,                                -- WhatsApp caption (read-only for the owner)
    text_json        TEXT CHECK (text_json IS NULL OR json_valid(text_json)),   -- CaptureMirror.text (text statuses: body, colours, font)
    media_json       TEXT CHECK (media_json IS NULL OR json_valid(media_json)), -- CaptureMirror.media {w,h,duration,color,thumbhash}
    media_state      TEXT NOT NULL DEFAULT 'none' CHECK (media_state IN ('none', 'pending', 'ok', 'lost')), -- CaptureMirror.mediaState
    preview_path     TEXT,                                -- STORED private preview, relative to var/previews/ (previewUrl only when set)
    poster_path      TEXT,                                -- STORED private poster (video/gif), relative to var/previews/
    revoked_at       TEXT,                                -- deleted on WhatsApp (ISO UTC) or NULL; sticky: COALESCE(revoked_at, :new)
    contract_version INTEGER NOT NULL DEFAULT 1,
    mirrored_at      TEXT NOT NULL,                       -- first PUT
    updated_at       TEXT NOT NULL                        -- last PUT that changed something
);
CREATE INDEX captures_local_date ON captures (local_date, occurred_at);
CREATE INDEX captures_occurred_at ON captures (occurred_at);

-- ---------------------------------------------------------------------------------------------
-- Owner content (primary copy: this API). Mirrored to the backend through change_log.
-- ---------------------------------------------------------------------------------------------

-- Owner annotation of one capture (contract Annotation). Deliberately no foreign key to captures:
-- the mirror may be wiped and re-pushed by the backend, owner data must survive that.
CREATE TABLE annotations (
    source_key          TEXT PRIMARY KEY,
    description         TEXT CHECK (description IS NULL OR json_valid(description)),  -- I18nText
    orig_locale         TEXT,
    visibility          TEXT CHECK (visibility IS NULL OR visibility IN ('public', 'hidden', 'pending')), -- NULL = publish policy decides (D11)
    local_date_override TEXT CHECK (local_date_override IS NULL OR local_date_override GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);
CREATE INDEX annotations_local_date_override ON annotations (local_date_override) WHERE local_date_override IS NOT NULL;

-- Owner-authored notes and stories (contract Post).
CREATE TABLE posts (
    public_id   TEXT PRIMARY KEY CHECK (public_id GLOB 'p_?*'),
    kind        TEXT NOT NULL CHECK (kind IN ('note', 'story')),
    occurred_at TEXT NOT NULL,                                -- ISO UTC
    tz          TEXT NOT NULL,
    local_date  TEXT NOT NULL CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    content     TEXT NOT NULL CHECK (json_valid(content)),    -- {"de": {"title"?: "...", "body": "..."}, "en": {...}}
    orig_locale TEXT NOT NULL,
    visibility  TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'hidden', 'pending')),
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX posts_local_date ON posts (local_date, occurred_at);

-- Trips (contract Trip).
CREATE TABLE trips (
    slug             TEXT PRIMARY KEY CHECK (slug <> '' AND slug NOT GLOB '*[^a-z0-9-]*'),
    title            TEXT NOT NULL CHECK (json_valid(title)),                          -- I18nText
    description      TEXT CHECK (description IS NULL OR json_valid(description)),      -- I18nText
    orig_locale      TEXT,
    start_date       TEXT NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    end_date         TEXT NOT NULL CHECK (end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    cover_source_key TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    CHECK (end_date >= start_date)
);

-- Owner metadata of one local day (contract Day). A row exists only once the owner edited the day;
-- GET /admin/days lists days with content anyway (contract AdminDaySummary).
-- Trip membership comes from trips.start_date/end_date only (contracts policy tripForDate); the API
-- rejects overlapping trip ranges. tz is the owner's time-zone fix for the day (contracts policy).
CREATE TABLE days (
    local_date       TEXT PRIMARY KEY CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    title            TEXT CHECK (title IS NULL OR json_valid(title)),      -- I18nText
    summary          TEXT CHECK (summary IS NULL OR json_valid(summary)),  -- I18nText
    orig_locale      TEXT,
    place_name       TEXT,
    country_code     TEXT CHECK (country_code IS NULL OR (length(country_code) = 2 AND country_code NOT GLOB '*[^A-Z]*')), -- ISO 3166-1 alpha-2
    lat              REAL CHECK (lat IS NULL OR lat BETWEEN -90 AND 90),
    lng              REAL CHECK (lng IS NULL OR lng BETWEEN -180 AND 180),
    cover_source_key TEXT,
    tz               TEXT,                                 -- IANA zone or NULL (no fix)
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

-- Settings (contract Settings): one row per key, value JSON-encoded.
CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL CHECK (json_valid(value)),
    updated_at TEXT NOT NULL
);

-- Change feed for the backend (GET /api/v1/backend/changes?after=<seq>, contract ChangeItem).
-- seq is global and strictly increasing (AUTOINCREMENT: never reused, even after deletes/compaction).
-- data: the entity DTO as the backend receives it (camelCase, as in the contract); NULL for deletes.
-- For settings, entity_key is the setting name and data is {"value": <JSON value>} (contract ChangeItem).
-- Rows are written only through Domain\ChangeLog::append(), which validates data against
-- api/schemas in the same transaction. Domain\ChangeLog::compact() deletes superseded rows (the
-- latest row per entity+key, tombstones included, always survives).
CREATE TABLE change_log (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    entity     TEXT NOT NULL CHECK (entity IN ('post', 'annotation', 'day', 'trip', 'setting')),
    entity_key TEXT NOT NULL,
    op         TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
    data       TEXT CHECK (data IS NULL OR json_valid(data)),
    created_at TEXT NOT NULL,
    CHECK (op = 'delete' OR data IS NOT NULL)
);
CREATE INDEX change_log_entity ON change_log (entity, entity_key, seq);

-- ---------------------------------------------------------------------------------------------
-- Auth
-- ---------------------------------------------------------------------------------------------

-- The owner (bin/create-admin.php). Passwords: Argon2id, bcrypt where Argon2 is unavailable.
CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name  TEXT,
    role          TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    last_login_at TEXT
);

-- Bearer/session tokens "omw_<base64url>", stored only as lowercase hex sha256 of the full token.
--   session: admin login (cookie), always bound to a user. The CSRF token is DERIVED from the
--            session token (Domain\Auth\Csrf), so nothing CSRF-related is stored.
--   backend:  the Node backend (scope "backend"), bin/create-token.php
--   app:      future native apps (scope "admin"), bound to a user
-- Scopes are fixed per kind (contracts TOKEN_KIND_SCOPES), enforced by the CHECK below.
CREATE TABLE api_tokens (
    id           INTEGER PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('session', 'backend', 'app')),
    name         TEXT NOT NULL DEFAULT '',
    user_id      INTEGER REFERENCES users (id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
    token_hint   TEXT NOT NULL,                                       -- first characters, for listings
    scopes       TEXT NOT NULL CHECK (json_valid(scopes)),            -- JSON array of strings
    created_at   TEXT NOT NULL,
    expires_at   TEXT,
    last_used_at TEXT,
    last_used_ip TEXT,
    revoked_at   TEXT,
    CHECK (kind = 'backend' OR user_id IS NOT NULL),
    CHECK ((kind = 'backend' AND scopes = '["backend"]') OR (kind IN ('session', 'app') AND scopes = '["admin"]'))
);
CREATE INDEX api_tokens_user ON api_tokens (user_id);

-- Login rate limiting.
CREATE TABLE login_attempts (
    id           INTEGER PRIMARY KEY,
    email        TEXT COLLATE NOCASE,
    ip           TEXT NOT NULL,
    success      INTEGER NOT NULL CHECK (success IN (0, 1)),
    attempted_at TEXT NOT NULL
);
CREATE INDEX login_attempts_ip ON login_attempts (ip, attempted_at);
CREATE INDEX login_attempts_email ON login_attempts (email, attempted_at);

-- ---------------------------------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------------------------------

-- Last heartbeat of the backend (single row, id = 1; contract Heartbeat).
-- received_at is the API's own clock: alerting must not trust the backend's clock.
CREATE TABLE backend_status (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    heartbeat       TEXT NOT NULL CHECK (json_valid(heartbeat)),
    wa_state        TEXT,
    backend_version TEXT,
    received_at     TEXT NOT NULL
);

-- Last deploy report per publish target (contract PublishedReport).
CREATE TABLE publish_status (
    target               TEXT PRIMARY KEY,
    report               TEXT NOT NULL CHECK (json_valid(report)),
    version              INTEGER,
    ok                   INTEGER NOT NULL CHECK (ok IN (0, 1)),
    at                   TEXT NOT NULL,
    last_ok_at           TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    received_at          TEXT NOT NULL
);

-- Alert state for bin/cron.php (contract Alert): at most one open alert per kind; re-notified until resolved,
-- then a "resolved" notice is sent once.
-- kind: heartbeat_stale | wa_logged_out | wa_banned | publish_failing | disk_low | media_lost | ...
CREATE TABLE alerts (
    id                   INTEGER PRIMARY KEY,
    kind                 TEXT NOT NULL,
    severity             TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('warning', 'critical')),
    state                TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
    message              TEXT NOT NULL,
    details              TEXT CHECK (details IS NULL OR json_valid(details)),
    opened_at            TEXT NOT NULL,
    last_notified_at     TEXT,
    notify_count         INTEGER NOT NULL DEFAULT 0,
    resolved_at          TEXT,
    resolved_notified_at TEXT
);
CREATE UNIQUE INDEX alerts_one_open_per_kind ON alerts (kind) WHERE state = 'open';
CREATE INDEX alerts_state ON alerts (state, opened_at);

-- ---------------------------------------------------------------------------------------------
-- Default settings (D11 + plan B), announced on the change feed so a fresh backend mirrors them.
-- alerts.email / alerts.ntfy_url are optional and therefore not seeded. publish.mode_since is
-- maintained by the API: every change of publish.mode sets it to the change time.
-- ---------------------------------------------------------------------------------------------
INSERT INTO settings (key, value, updated_at) VALUES
    ('publish.mode',                     '"instant"',       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('publish.mode_since',               '"1970-01-01T00:00:00.000Z"', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('publish.delay_minutes',            '720',             strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('ingest.on_revoke',                 '"hide"',          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('timezone.current',                 '"Europe/Berlin"', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('site.title',                       '"On My Way"',     strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('site.locales',                     '["de","en"]',     strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('site.default_locale',              '"de"',            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('site.indexable',                   'false',           strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('alerts.heartbeat_stale_minutes',   '15',              strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO change_log (entity, entity_key, op, data, created_at)
SELECT 'setting', key, 'upsert', json_object('value', json(value)), updated_at
FROM settings
ORDER BY key;
