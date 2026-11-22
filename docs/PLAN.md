> **Status 2026-11-21:** plan approved · Step 0 done · waves 1–4 committed · wave 5 (approval-only followers, access gate, data rights, safety options, password change) built and tested locally, live deploy pending · Phase 0 (WhatsApp capture on the real phone) not started

# Plan: "On My Way": WhatsApp status → static travel timeline

## Context

The traveler shares their adventures through WhatsApp **status** posts. These vanish after 24 h and only contacts can see them. The goal is a system that:

- **automatically archives every status**: photos, videos, GIFs, text statuses and voice statuses, stored permanently;
- **publishes them as a lovely, multilingual timeline website**. You can scroll and zoom it from years down to days, and lock it to a single day to *watch that day's journey* as a stories-like slideshow;
- lets the owner **add short notes, long stories and descriptions** (web admin now, native apps later). These are mixed chronologically with the WhatsApp content.

**Key architectural choice (from the user):**
- The public timeline is a set of **pre-generated static files**. It is dynamic only through client-side JS, so it runs on **any static web hosting**.
- The **Node backend** generates the site and **pushes it via SFTP**.
- Dynamic features (owner edits now; visitor features later) go through a separate **API (PHP), possibly on another server**.

The project directory is empty (greenfield). All project files stay inside it.

### Decisions made

| Topic | Decision |
|---|---|
| WhatsApp access | A **separate observer number** (a second WhatsApp account on a spare phone at home) has the traveler as a contact. The backend is a *linked device* of that account and keeps only statuses whose sender is the traveler. The traveler's own account is never touched. |
| WhatsApp library | **whatsmeow (Go) as a tiny helper binary inside the Node backend container.** WhatsApp is rolling out a new `<status>` stanza for contacts' statuses. Baileys (Node) can't decrypt it yet ([#2858](https://github.com/WhiskeySockets/Baileys/issues/2858) is open, fixes unmerged). whatsmeow fixed it on 2026-11-16 ([#1323](https://github.com/tulir/whatsmeow/issues/1323), commit `06b1c29`). |
| Backend | A **Node.js (TypeScript) service in Docker**: capture → media processing → static site generation → SFTP publishing. It runs on this Mac first and moves to dedicated hosting later. All connections are outbound, so it works behind home NAT. |
| Public site | **Static files on any static host**: HTML per route, JSON data, media and JS/CSS. React + TypeScript (Vite) gives the dynamic behaviour in the browser. |
| Dynamic API | **PHP 8.3+ with Slim 4 + SQLite**, deployable on any PHP host and separate from the static host if wanted. It holds the owner's content and the admin, sends alerts, and later serves visitor features. **Nobody needs it to view the site.** |
| Publishing | **Instant** by default ("delayed" and "review first" are settings). Any item can be hidden at any time; hidden items and their media are removed from the static host. |
| Languages | **de + en** at launch, **RTL-ready** for ar/he/fa later. |
| Project dir | Renamed to `the-on-my-way-website` (Step 0). |

### Decisions of wave 5 (owner, 2026-11-20: approval-only followers)

| Topic | Decision |
|---|---|
| Who sees the site (D1–D3) | **Only people the traveler invited.** No public layer, no shared password; without access nothing personal or fetchable leaks (link previews, robots, sitemap and error pages included): one neutral page. |
| Gate (Q0 → b) | **Strictly API-only:** the site host runs only Apache + `.htaccess`, which checks the device's cookie against an empty session file in a hidden store; the PHP API does all logic and writes the store (directly when it shares the site's filesystem, else SFTP, else the Mac). Cookies are set by Apache via `mod_headers` (`__Host-`), with the `CO` flag (F1) and a parent-domain cookie (F2) as tested fallbacks. Live: `direct` + `headers` (host probe P0b, 2026-11-20, 13/13). |
| Followers (D6, D2, D8) | A stable, never reused random id per person; devices and sessions are its children. Revoking a device or a person ends access only; data stays. |
| Further devices (Q3 → c) | The first device of a person joins with the personal link; **every further device waits for the owner's OK** (pending list, push without names). Up to 5 active devices per person. Residual: whoever opens a fresh link first gets the first device. |
| Lock (Q6 → a) | One admin login (no co-admin, Q8 a). A lock switch in the admin, an optional panic link (locks without login) and a lock button on the Mac. |
| Information first (D11, Q7 → configurable) | The invite link opens an information screen first; joining = "Weiter" (never pre-ticked). Responsible person, contact and texts (de/en) are owner settings, versioned; every confirmation is recorded; a changed text is confirmed again. Templates marked "not legal advice". |
| Data rights (D12) | "Your data" on the site: view, export, "delete me" with a deliberate confirmation; leaves a nameless tombstone and a notice to the owner. The admin has the same delete action. |
| Release timing (Q1 → configurable) | Unchanged default (instant). New settings, all off: release slots (e.g. twice a day) and a departure hold (≤ 7 days, "she moved on" tap). |
| Here-now badge (Q2 → a + hide) | City + "here now" badge as before, with the choice city without badge / country only / nothing; times optionally only as part of day. |
| Domain (Q9 → configurable) | Nothing hardcodes a host; the existing domain stays for now. Only the parent-domain fallback needs site and API on one registrable domain; any domain change loses every cookie (people reopen their links). |
| Owner password | Change in the admin (≥ 12 characters, ends every other session); recovery with `deploy-api.ts --reset-admin-password`. |
| Wave 6 (not built) | Request-access form + inbox, follower messages (no replies, Q5 a), optional e-mail notifications with double opt-in (Q4), reactions (counts only for followers), first-party views and activity overview (D7, D9, D10). |

---

## Step 0: Housekeeping (first actions after approval)

Verified: neither target path exists. The Claude data for this project is one session transcript, its session folder and an empty `memory/`.

1. Write memories into the current memory folder so they move along: the user's stack and hosting preferences, and the feedback "stay inside the project dir".
2. `mv /Users/css/Projects/schaefchens/be-on-my-way-website /Users/css/Projects/schaefchens/the-on-my-way-website`
3. `mv ~/.claude/projects/-Users-css-Projects-schaefchens-be-on-my-way-website ~/.claude/projects/-Users-css-Projects-schaefchens-the-on-my-way-website`
4. The running session's working directory is now gone, so ask the user to restart with `cd /Users/css/Projects/schaefchens/the-on-my-way-website && claude --continue`.
5. In the resumed session:
   - remove any stub folder recreated at the old Claude path, after checking it;
   - `git init`;
   - copy this plan into `docs/PLAN.md`;
   - add `.gitignore` and `README.md`.

---

## Architecture

```
Traveler's phone ─ status ─▶ WhatsApp ─▶ Observer number (spare phone at home = primary device)
                                              │ linked device
┌───────────── Backend · Node + TS · Docker (this Mac → dedicated host later) ─────────────────┐
│ wa-helper (Go · whatsmeow) ── JSON lines ──▶ capture outbox → archive → media pipeline       │
│ content store (SQLite): captures [primary] + owner-content mirror [pulled from API]          │
│ static generator → data/out/  (HTML per route · JSON data · media · assets)                  │
│ publisher: incremental SFTP sync ─────────────────────────────────────────┐                  │
│ API sync: push capture mirror, previews, heartbeat · pull owner changes    │                  │
│ control UI 127.0.0.1:8787: pairing · health · queue · publish targets      │                  │
└───────────────┬────────────────────────────────────────────────────────────┼──────────────────┘
                │ HTTPS (outbound)                                           │ SFTP (outbound)
                ▼                                                            ▼
┌── Dynamic API · PHP 8.3 · Slim 4 · SQLite (any PHP host) ──┐   ┌── Static host (any) ───────────┐
│ owner content [primary] · capture mirror · private previews│   │ /de/… /en/… (index.html/route) │
│ admin API + admin PWA at /admin (same origin)               │   │ /data/*.json · /media/*        │
│ change feed for the backend · heartbeat → alerts (cron)     │   │ /assets/* (hashed Vite build)  │
│ later: visitor features (hearts, comments) via CORS         │   └──────────────▲─────────────────┘
└─────────────────────────────────────────────────────────────┘                  │ visitors (static + JS)
```

### Data ownership (exactly one primary per datum, so there are no conflicts)

| Data | Primary | Mirror |
|---|---|---|
| Captured WhatsApp facts: kind, time, caption, text style, media, revoked | **Backend** | API (so the admin can browse and annotate) |
| Owner content: notes, stories, descriptions, visibility overrides, day moves, day titles/places, trips, settings | **API** | Backend (via the change feed) |

| Followers, devices, personal-link hashes, consents, privacy notice versions, lock, tombstones (wave 5) | **API** | Session-file store on the site host (a projection: empty session files, lock, tombstones that survive an API restore); the backend never receives names |

The generator merges both. This has three consequences:
- The site **keeps publishing new statuses even if the API is down**, using the last-known settings.
- Owner edits are accepted while the backend sleeps, and they go live when it returns.
- With no API configured at all, the backend still publishes a captures-only site. That is a useful MVP.

**With the access gate (wave 5)** the static host serves two trees: the gate tree at the web root
(root `.htaccess`, neutral page, the `/_/` join/info/wait/ended/your-data/panic pages and their
small vanilla-TS bundle) and the timeline under `/<secret>/` with the same gate block. Viewing
still never needs the API; joining, approving, revoking and "Your data" do (followers call the
API's public routes with CORS, owner actions go through the admin). Details:
[HOSTING.md §11](HOSTING.md#11-access-gate-wave-5-approval-only-followers),
[PRIVACY.md](PRIVACY.md).

### Repository layout

```
the-on-my-way-website/
├─ docs/                PLAN.md · OBSERVER.md · HOSTING.md (static + PHP host, access gate) · OPERATIONS.md · PRIVACY.md
├─ packages/contracts/  zod 4: static data files (manifest, timeline, day, trip) + backend↔API sync + admin API
│                       → TS types + exported JSON Schema (PHP validates with opis/json-schema)
├─ backend/
│  ├─ wa-helper/        Go module (whatsmeow pinned to a master commit ≥ 06b1c29)
│  ├─ src/              capture/ · pipeline/ · store/ · sync/ · generator/ · publisher/ · ui/
│  ├─ Dockerfile        multi-stage: go build → Vite site build → node:24-trixie-slim + ffmpeg 7.1
│  ├─ compose.yaml
│  └─ data/             (git-ignored bind mount) archive/ · out/ (generated site) · config/ (publish targets, SSH keys)
├─ frontend/            site/ (public timeline SPA, built into the backend image) · admin/ (admin PWA, deployed with the API) · shared/
├─ api/                 PHP Slim app = the deploy unit for the PHP host
│  ├─ public/           index.php · .htaccess · admin/ (built admin PWA)
│  ├─ src/              Http/{Backend,Admin,Public} · Domain/ · Infra/ (Db, Migrator, Mailer)
│  ├─ migrations/       schemas/ (generated) · bin/ (migrate, create-admin, create-token, doctor, cron)
│  ├─ var/              (git-ignored) app.sqlite · previews/ · backups/ · logs/
│  └─ tests/            PHPUnit
├─ fixtures/            sanitized recorded statuses + media (shared by Go, Vitest and PHPUnit tests)
└─ package.json · pnpm-workspace.yaml (contracts, backend, frontend) · README.md
```

---

## A. Backend (Node orchestrator + whatsmeow helper, one Docker image)

### A1. `wa-helper` (Go, about 500 lines)

- **Session and linking:** whatsmeow `sqlstore` in `/data/wa/session.db`. Linking by QR (`GetQRChannel`) or pairing code (`PairPhone`), emitted as JSON lines. Device name "On My Way".
- **Capture:**
  - Accept `events.Message` where `Info.Chat == types.StatusBroadcastJID` and the sender is the traveler.
  - Match `Info.Sender` / `Info.SenderAlt` against the configured phone number or its learned LID (LID store), and persist the LID once learned.
  - Senders that don't match are counted only, never stored.
  - Statuses already live at link time come from history sync (`StatusV3Messages`).
  - A `ProtocolMessage` REVOKE becomes a revoke event.
- **Persist before ack:**
  - Use synchronous ack plus a handler that reports success, so WhatsApp's server ack goes out only after `/data/inbox/<msgId>/meta.json` (with the raw proto and media keys) is fsynced.
  - Enable the decrypted-event buffer.
  - Exact option names get verified in Phase 0.
- **Media:**
  - `client.Download` into `original.<ext>`, verified against `FileSHA256`.
  - On 403/404/410: send a media-retry receipt, wait for `events.MediaRetry`, decrypt the notification and download again.
- **Behaviour:**
  - Never sends presence, so the observer phone keeps its notifications.
  - Optional status read receipt as a "captured ✓" signal (off by default).
  - Emits state events: connected, disconnected, logged_out, stream_replaced, temporary_ban, keepalive_timeout.
  - stdin commands: `pair_code`, `logout`, `mark_read`, `redownload`, `stats`.

### A2. Capture and processing (Node)

**Helper supervision.** `helper.ts` spawns `wa-helper` and restarts it with backoff. It exposes a typed `WaSource` interface; `FixtureSource` replays recorded statuses, so development and tests need no phone. `WA_MODE=self` (link the traveler's own account) is a cheap built-in option.

**Outbox.** better-sqlite3 (WAL) on a named volume, tracking `captures` and `files`.
- States: `received → archived → processed → stored`, plus `revoke_pending`. Terminal: `media_lost`.
- Retries use backoff and raise alerts.

**Archive.** `data/archive/YYYY/MM/DD/<msgId>.<ext>` plus `.json` (normalized metadata and the raw proto). It is self-describing, so `backend reprocess` can rebuild everything from it. It is the home backup copy.

**Pipeline** (two workers):

| Kind | Processing |
|---|---|
| Photo | sharp: rotate, strip metadata. AVIF (q≈50) + WebP (q≈75) at 320/640/1080/1600 without upscaling. thumbhash, dominant colour, OG JPEG 1200×630 ≤300 KB. |
| Video | ffprobe. If already H.264/AAC: remux `+faststart`. Otherwise x264 crf 23 + AAC. Poster frame gets the photo treatment. GIF playback: muted loop. |
| Voice | AAC m4a 64 kbps mono + 64 waveform peaks. |
| Text status | Text + `#AARRGGBB` colours + WhatsApp font enum. |
| Unknown | Stored as `unsupported` and hidden. Nothing is dropped silently. |

**Time and day assignment.** Each capture stores UTC plus `tz`, taken from the mirrored `timezone.current` setting (the owner sets it with one tap on the phone). `local_date` is derived from those. Owner overrides (timezone fix for a day, moving an item to another day) come from the API.

### A3. Content store (`store.db`, SQLite)

- **Captures (primary):** `source_key` (`wa:<msgId>`), kind, occurred_at, tz, local_date, caption, text_style, media metadata (variants, w/h, duration, thumbhash, colour, waveform), revoked_at.
- **Owner mirror**, applied from the API change feed: notes/stories (`content` JSON per locale), annotations (description per locale, visibility override, local-date override), days (title/summary per locale, place, country, lat/lng, cover), trips, settings.
- **Sync state:** `feed_cursor`, plus outgoing sync queues (capture mirror, previews, revokes, heartbeat).
- **Deploy state:** the last deployed manifest (path → sha256, size) for each target.

### A4. Static site generator

**Output** (`data/out/`; directory routes with `index.html` work on every static host):

```
/index.html                        language pick: JS (navigator.languages / cookie) + meta refresh to default + noscript links
/{de,en}/index.html                timeline (home)
/{de,en}/day/2026-11-18/index.html day journey (deep link)
/{de,en}/day/…/story/<id>/index.html   long-form story (only when one exists)
/{de,en}/trip/<slug>/index.html
/404.html · /robots.txt · /sitemap.xml (only if indexable) · optional /.htaccess (Apache: MIME types for avif/webp/m4a)
/data/manifest.json                {version, generatedAt, timeline: <hash>}
/data/timeline.json                trips + day index; each day/trip entry carries its file hash `v` (split per year if > ~1 MB)
/data/days/2026-11-18.json         that day's public entries, with every locale of the owner's text
/data/trips/<slug>.json
/media/<aa>/<sha>_<variant>.<ext>  content-addressed, immutable, public items only
/assets/<hash>.{js,css,woff2}      the Vite site build that ships inside the image
```

**Each HTML page is real content, not an empty shell:**
- `<html lang dir>`, title, description, canonical, hreflang, OG/Twitter tags (`og:image` = the cover's OG JPEG), and `robots noindex` unless `site.indexable` is on.
- A CSP `<meta>` tag, because headers can't be relied on at static hosts.
- Inline critical CSS.
- A pre-rendered first screen: day header, cover as a real `<img>`, caption text, links to the previous/next day for no-JS readers.
- A small page-specific boot JSON, safely escaped.
- Vite manifest tags.
- React then mounts with `createRoot` and replaces the first screen. There is no hydration, so there are no mismatch risks.
- The first-screen templates are TS string templates in the generator. Escaping is enforced, and Tailwind `@source` includes them.

**Caching that works on any host, without header control:**
- Media and assets have content-hashed names.
- The client fetches `manifest.json` with `cache:'no-store'` plus a timestamp query, then requests data files as `…json?v=<hash>`.
- HTML follows the host's defaults.

**Incremental builds:**
- A dependency map decides what to regenerate. A change on day D affects: `days/D.json`, D's HTML in each locale, `timeline.json`, `manifest.json`, the home HTML (latest-day preview), and the trip files when D belongs to a trip.
- Changes are debounced (3 s, at most 30 s).
- A new frontend version, meaning a new image, triggers a full HTML regeneration.
- Visibility rules: `publish.mode`, `publish_at`, and the owner's visibility overrides. Hidden items and their media never appear in the output.

### A5. Publisher (incremental SFTP)

**Targets.** Configured in the control UI and stored in `data/config/`; secrets never leave the backend.
- Fields: host, port, user, SSH key (recommended) or password, pinned host-key fingerprint, remote root path, public base URL.
- There is a "Test connection" button.
- A `local` target (folder) for development.
- A `Publisher` interface leaves room for FTPS, S3, rsync or Netlify/Cloudflare Pages later.

**Algorithm.** It compares the desired manifest against the last deployed one (`ssh2-sftp-client` 12.x).
1. Upload new immutable files: media and assets.
2. Upload changed data JSON, then HTML.
3. Upload `manifest.json` last: write it to a temporary name, then `posixRename` (fallback: delete + rename).
4. Delete obsolete files last:
   - media of hidden or revoked items **immediately** (privacy);
   - old asset versions after 7 days.

**Robustness.**
- One deploy at a time.
- Retries with backoff.
- A partial deploy is always consistent, because referenced files always exist before anything references them.
- A copy of the deploy manifest lives on the server (`/.omw-deploy.json`) so the backend can recover if it loses its local state.
- After each deploy, an HTTP check fetches the public `manifest.json` and compares the version. That catches wrong paths and stale CDNs.
- The result (version, time, files, errors) is reported to the API.

### A6. API sync client

- **Pushes:**
  - capture mirror (metadata) via `PUT /captures/{sourceKey}`;
  - private admin previews (640w WebP, poster for videos);
  - revokes;
  - heartbeat every 60 s: WhatsApp state, last status, queue, stanza stats, disk, publish state;
  - publish reports.
- **Pulls:** the owner change feed `GET /changes?after=<seq>` every 15 s, and immediately after its own writes. Changes go into the mirror and trigger the generator.
- Fully queued: if the API is unreachable, capture and publishing go on with the last-known owner content.

### A7. Control UI, configuration, Docker

**Control UI.** Fastify on `127.0.0.1:8787`, protected by a token. It shows:
- health and the traveler match;
- live QR (SSE) and the pairing-code form;
- the queue (retry/skip);
- publish targets, "rebuild all" and "publish now";
- the last deploy result and a log tail.

**Env** (validated with zod): `WA_MODE`, `TRAVELER_PHONE`, `API_BASE_URL`/`API_TOKEN` (optional), `SEND_READ_RECEIPT=false`, `CONTROL_TOKEN`, `NTFY_URL` (local alerts when the API is absent), `LOG_LEVEL`.

**Docker**
- Multi-arch image (arm64 for this Mac, amd64 for a server later).
- compose: `restart: unless-stopped`, `init: true`, healthcheck, port `127.0.0.1:8787`.
- Storage: a named volume `/data` for the databases, session and inbox (WAL needs it), and a bind mount `backend/data/` for the archive, generated output and config.

**Running on the Mac**
- Docker Desktop or OrbStack starts at login.
- Prevent sleep while on power (`pmset -c sleep 0` or a `caffeinate -s` LaunchAgent).
- Statuses posted during sleep arrive later as offline messages, but their media may expire about 24 h after posting. So the Mac must never sleep longer than about 12 h. Move to an always-on host early.

### A8. Observer setup (`docs/OBSERVER.md`)
1. Get a second number (SIM or eSIM) and install WhatsApp on a spare phone.
2. The traveler and the observer save each other's numbers, and the traveler's status audience must include the observer.
3. Keep the observer phone on charger and Wi-Fi, turn battery optimisation off, and open WhatsApp weekly (14-day rule for linked devices).
4. Link: control UI QR → observer phone: Linked devices → Link a device. The pairing code is the alternative.
5. Smoke test: the traveler posts a status. The control UI shows it within seconds, and the static site within about a minute.

---

## B. Dynamic API (PHP 8.3+ · Slim 4 · SQLite)

**Role.**
- Primary store for owner content; mirror of captures; admin backend; alerts; later, visitor features.
- Runs on any PHP host, the same as the static host or a different one.

**Requirements and dependencies.**
- PHP: pdo_sqlite, mbstring, fileinfo; Apache mod_rewrite (or an nginx snippet); cron.
- Composer: `slim/slim` 4.15, `slim/psr7`, `php-di/php-di`, `vlucas/phpdotenv`, `monolog/monolog`, `opis/json-schema`, `symfony/mailer`. Dev: phpunit, phpstan.

**Database** (PDO)
- Always `busy_timeout=5000`, `foreign_keys=ON`, and `BEGIN IMMEDIATE` for writes.
- `DB_JOURNAL_MODE` is WAL or DELETE, because WAL fails on NFS-backed hosting. `doctor` tests which one works.

| Table | Key columns |
|---|---|
| `captures` (mirror) | `source_key` PK, kind, occurred_at, tz, local_date, caption, text_style, media meta, preview paths, revoked_at |
| `annotations` | `source_key` PK, `description` JSON per locale, `visibility` (public, hidden, pending), `local_date_override`, cover flag |
| `posts` | owner-authored notes and stories: `public_id`, kind (note, story), occurred_at, tz, local_date, `content` JSON per locale `{de:{title,body},en:{…}}`, `original_locale`, visibility |
| `days` · `trips` | Days: title/summary per locale, place, country, lat/lng, cover. Trips: slug, title/description per locale, date range, cover. |
| `settings` | `publish.mode`, `publish.delay_minutes`, `ingest.on_revoke=hide`, `timezone.current`, `site.title`, `site.locales`, `site.default_locale`, `site.indexable=false`, alert targets |
| `change_log` | a global `seq` with (table, key, op). Feeds `GET /changes`, including tombstones. |
| `users` · `api_tokens` | The owner (password via Argon2id, falling back to bcrypt). Tokens look like `omw_…` and are stored as sha256. Kinds: session, backend, app. Each has scopes, `last_used_at`, `revoked_at`. |
| `backend_status` · `publish_status` · `alerts` · `login_attempts` · `schema_migrations` | heartbeat snapshot · last deploy · alert state · login rate limiting · applied migrations |

**Endpoints**

| Group | Endpoints |
|---|---|
| Backend (Bearer token, `backend` scope) | `PUT /api/v1/backend/captures/{sourceKey}` (idempotent; never touches owner data) · `POST …/{sourceKey}/preview` (small multipart files) · `POST …/{sourceKey}/revoke` · `GET /api/v1/backend/changes?after=` · `POST /api/v1/backend/heartbeat` · `POST /api/v1/backend/published` · `GET /api/v1/backend/backup/latest` |
| Admin (session token in a `__Host-` cookie + CSRF header; Bearer for future apps) | captures (list, filter), annotate/hide/move, posts CRUD, days, trips, settings, backend and publish status, private previews |
| Later, public (CORS for the static site's origin) | hearts, comments, subscriptions |

**Admin PWA.** Served from `/admin/` on the API host. Being same-origin with the API means first-party cookies and no CORS for owner actions.

**Cron** (`bin/cron.php`, every 5 min, with `flock`):
- alerts by email and/or ntfy when the heartbeat is older than 15 min, WhatsApp reports logged_out/banned, or publishing keeps failing;
- they repeat until resolved, then send a "resolved" notice;
- nightly `VACUUM INTO var/backups/…`, which the backend pulls home;
- cleanup of old previews and backups.

**`bin/doctor.php`** checks the PHP version and extensions, writable directories, whether WAL works, upload limits, and free disk.

---

## C. Frontend (React + TypeScript)

**Stack** (current majors as of Nov 2026; pin exact versions at scaffold time):
- React 19, Vite 8.
- **TanStack Router** (typed search params for zoom state, `trailingSlash: 'always'` to match the static directories), **TanStack Query**, **TanStack Virtual**.
- **Motion** (`motion/react`), **Tailwind CSS 4.3** with logical utilities.
- **Lingui 6** (ICU compiled at build time).
- thumbhash; markdown-it with raw HTML disabled.
- A small in-house `usePinchZoom` (pointer events, ctrl+wheel, Safari gesture events).

**Builds.**
- `site` goes into the backend image; the generator copies it to `/assets/`.
- `admin` is deployed with the API.

**Data (site).**
- Read-only, from static JSON: `manifest.json` (no-store), then `timeline.json?v=…`, then `days/D.json?v=…`.
- Prefetch on intent, and prefetch day N±1 in the player.
- Every 5 min, poll `manifest.json`; if it changed, show a "new moments ✨" toast.
- No API calls are needed for viewing.

**Routes.** Matching the generated pages:
- `/$locale/` is the timeline; the search params `{z: trips|months|days, d}` hold the zoom level and focused date.
- `/$locale/day/$date/` is the journey player: an overlay above the mounted timeline, with Back to close.
- `/$locale/day/$date/story/$id/` and `/$locale/trip/$slug/`.
- History: zoom and focus changes *replace* the entry; opening the player *pushes*.

**Semantic zoom levels.**
1. **Years & trips:** year markers; trip cards with collage covers, dates and flags.
2. **Months:** month headers plus week rows of day tiles.
3. **Days:** a sticky day header ("Di., 18. Nov. · Hội An 🇻🇳 · 12 Momente"); a horizontal filmstrip of photos, video posters, text-status chips and note cards; the dotted route thread; a passport stamp when the country changes; a "▶ Tag ansehen" button.
4. **Journey (locked to one day):** the player.

**Zoom mechanics.**
- Each level's row model has deterministic heights, prefix-summed so `estimateSize` is exact.
- Zooming keeps the date under the pointer fixed:
  - compute where that date lands in the next level;
  - mount the next level at that offset;
  - crossfade and scale it around the pointer.
- `layoutId` goes only on the anchor item, which morphs tile → header → first slide.
- Pinch: a preview scale between 0.85 and 1.2; it commits one level at |ln s| > 0.18.
- Other inputs: ctrl+wheel, a zoom pill (Jahre · Monate · Tage), keys +/− and 1–3.
- No scroll-snap on the virtualized list; snapping only inside filmstrips.

**Journey player.**
- **State machine:**
  - `loading → ready → playing ⇄ paused`, where paused tracks its reasons: user, hold, sheet, hidden;
  - `buffering` when a video stalls;
  - `itemEnd` → next item or day end;
  - `error` auto-skips after 3 s.
- **How long each item shows:**

  | Item | Duration |
  |---|---|
  | Photo | 5–12 s depending on caption length, with a subtle Ken Burns |
  | Text status | 3 s + 45 ms per character, at most 10 s; in its WhatsApp colours and font |
  | Note | 6–10 s, as a washi-tape card |
  | Story | 6 s as a card; "Read the story" opens a sheet that pauses playback |
  | Video, voice | their real duration (voice shows a waveform) |

- **Playback:**
  - A requestAnimationFrame clock drives the progress bars through MotionValues.
  - Preload the next two items (`decode()`) and the WhatsApp fonts.
  - Pool of two `<video muted playsinline>` elements; tap to unmute.
  - Data-saver toggle, Wake Lock, Media Session, pause when the tab is hidden.
- **Gestures (Instagram-like):** tapping the start 30 % goes back, the end 70 % goes forward; back on a day's first moment goes to the previous day's last moment; hold pauses; swipe up goes to the next day; swipe down anywhere closes (the stage lifts with the finger, a short pull snaps back); keys: arrows, PageUp/PageDown, Esc.
- **Day end:** a card with a 3 s countdown to the next day.
- **Accessibility:** an always-visible pause button (WCAG 2.2.2), a dialog with focus trap, live-region announcements, and alt text from the description, falling back to the caption.

**RTL readiness.**
- Motion's x/drag offsets and swipe thresholds are physical, so multiply them by `fwd = rtl ? -1 : 1`.
- Logical CSS everywhere; progress bars use `origin-left rtl:origin-right`; only chevrons flip; `scrollLeft` is negative in RTL.
- User text gets `dir="auto"`, `lang` and `unicode-bidi: plaintext`; place names inside sentences go in `<bdi>`.
- Calendar and digits are chosen per locale on purpose (`fa` defaults to the Persian calendar).
- A **dev-only pseudo-`ar` locale** exists from day one.

**i18n.**
- Lingui PO catalogs per app × locale, lazy-loaded.
- Owner content falls back to the original language with "Original: Vietnamesisch" (`Intl.DisplayNames`) and a toggle. *(v1 decision: the original language is always one of the app locales, e.g. "Original: Englisch"; originals in other languages are out of scope, see `packages/contracts/src/i18n.ts`.)*
- The generator uses the same catalogs for meta tags and first-screen strings.

**Design system.**
- **Light "dawn" palette:** cream `#FFF8F6`; plum ink `#3B2341` (13.3:1); muted `#6A4E6F`; rose-600 `#BE4A74` for buttons (white text 4.75:1); rose-700 `#9C3A5E`; violet-700 `#5D3FA0`; focus ring `#8E6BD6`; blush `#FCE7EE`/`#F7D0DD`; lilac `#EEE6FA`/`#CDB8F0`.
- **Night "dusk" palette:** `#1B1322` background; surfaces `#251A2E`/`#30243B`; ink `#F7ECF2`; muted `#C9B6CC`; rose `#F4A3BC`; violet `#BCA4F2`.
- **Type:**
  - Fraunces (display, with its SOFT axis) and Nunito (body).
  - **Playpen Sans**, including its Arabic and Hebrew cuts, for handwritten notes. Caveat lacks Vietnamese.
  - Vazirmatn and Rubik for RTL scripts.
  - Self-hosted subsets.
  - WhatsApp fonts are mapped to Calistoga, Exo 2, Courier Prime, system-ui, serif and a script substitute.
- **Motion:** spring presets soft (0.35 s, bounce 0.15), snappy (0.2 s) and float (0.8 s). `reducedMotion="user"`; reduced motion also turns off Ken Burns, route drawing and autoplay.
- **Signature touches:**
  - a route thread drawn on scroll, with a paper plane at trip boundaries;
  - a passport stamp when the country changes;
  - washi-tape note cards;
  - a day glow from the cover's colour;
  - a pulsing "here now" chip;
  - subtle paper grain.

**Performance budget.**
- JavaScript and CSS: initial JS ≤150 KB gzipped (Motion lazy), player chunk ≤45 KB, CSS ≤25 KB.
- Targets at the 75th percentile on mobile: LCP ≤2.0 s (helped by the pre-rendered first screen), INP ≤200 ms, CLS ≤0.05.
- Image sizes: tiles 320w, filmstrip 640w, player 1080w/1600w via `<picture>` with AVIF then WebP.
- Videos: none in the timeline, at most two in the player.

**Admin PWA** (`/admin` on the API host, mobile-first, installable).
- Setup: vite-plugin-pwa with injectManifest, scoped to `/admin/`. The admin API is never cached. The Query cache is persisted to IndexedDB, and offline mutations resume.
- Screens:
  - **Home:** backend health, last capture, last publish, alerts.
  - **Inbox:** new captures with previews; swipe to hide/show; describe; set as cover; undo.
  - **Days:** list with badges for a missing title or place; day editor with title per locale, place and country, cover and timezone fix.
  - **Composer:** note ≤280 characters, or story with title and markdown; de/en tabs; autosave.
  - **Item sheet:** WhatsApp caption read-only, description per locale, visibility, move to another day.
  - **Trips.**
  - **Settings:** one-tap "timezone from this device", publish mode, languages, tokens.
- Each item shows "Live ✓ / publishing…", based on the backend's publish report.

---

## D. One contract, three runtimes

- `packages/contracts` (zod 4) defines the **static data files**, the **backend↔API sync** and the **admin API**.
- The backend (generator), the site, the admin and a future Expo app import the TS types.
- `z.toJSONSchema` generates `api/schemas/*.json`, which PHP validates against with opis/json-schema. CI fails if the export drifts.
- Shared fixtures are checked by both Vitest and PHPUnit.
- A `contractVersion` bump means deploying the API first.

---

## Phases

| Phase | Deliverables | Done when |
|---|---|---|
| **0 Spike (go/no-go)** | wa-helper prototype plus a minimal Node runner; observer linked. The traveler posts a photo, video, GIF, text in several fonts and voice (Android and iOS if possible), plus one deleted status. Container stopped for 2 h and for 26 h. | 100 % of the test statuses captured, including `<status>`-stanza ones; 0 undecryptable; live statuses arrive at link time; LID/phone matching works; media availability after both gaps measured; fixtures recorded |
| **1 Capture → static MVP** | Monorepo, contracts, outbox/archive/pipeline, content store, generator v0 (day list + basic player), local and SFTP publishers, control UI, Docker on this Mac | A real status appears on the static host about 1 min after posting. `kill -9` during a deploy leaves the site consistent and the next deploy completes it. Hiding (manual DB flag for now) deletes the remote media. |
| **2 Public site** | Full design system, Lingui de/en + pseudo-ar, three zoom levels, journey player, pre-rendered first screens, OG, "new moments" toast | Playwright against the generated `out/`: zoom anchoring, player touch and keyboard, RTL mirroring. Lighthouse budget met. Deep links work on a plain static server. |
| **3 Dynamic API + sync** | Slim API, migrations, tokens, capture mirror, previews, change feed, heartbeat, alerts, backups, doctor; the backend's sync client | PHPUnit green (idempotent mirror, feed ordering and tombstones, overrides, publish modes, local_date across timezones and DST). API down → statuses still published; backend down → edits queue and publish later. |
| **4 Admin PWA** | Login, home, inbox, days, composer, item sheet, trips, settings | A note written on the phone is live on the static site in under a minute; hiding removes the item and its media from the static host; owner edits survive a re-capture |
| **5 Ops hardening** | `HOSTING.md`/`OPERATIONS.md` runbooks (static + PHP host setup, relink, moving the backend to a dedicated host, restore), backup pulls, monitoring | Stopping the backend triggers an alert; restore drill from archive + API snapshot works; backend moved to a second machine with the same compose file |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| WhatsApp protocol changes or a ban | whatsmeow (maintained; Beeper's bridge depends on it); purely passive helper (no sends, no presence); real SIM; deliberate pin updates; `WaSource` interface allows a Baileys fallback |
| 14-day linked-device logout | Observer phone always on and opened weekly; a 401 alerts within minutes; relink runbook |
| Status privacy hides statuses from the observer | Both numbers saved on both sides; the traveler's audience includes the observer; verified in Phase 0 |
| Mac sleep / media expiring on WhatsApp's CDN | Keep the Mac awake; download immediately; media retry; `media_lost` alerts; move to an always-on host early |
| Partial or interrupted SFTP deploys | Ordered uploads (referenced files first, manifest last via rename), deletes last, remote deploy manifest for recovery, post-deploy HTTP check |
| Static host quirks (MIME types, 404 handling, caching, CDN) | Optional `.htaccess`; AVIF→WebP `<picture>` fallback; hash-busted data URLs; manifest fetched with no-store |
| SFTP credentials leaking | Stored only in the backend's config volume; SSH key auth; pinned host key; never sent to the API |
| Many small files make full uploads slow | Hash-diff incremental sync; small dependency sets per change; full HTML regeneration only on frontend releases |
| Live location exposed by instant publishing | The delayed publish mode is one setting away; `noindex` by default |
| Disk growth (estimated ~10 GB/year of media) | Variants only on the static host; originals in the home archive; disk alerts |

## End-to-end verification

1. **Fixtures, no phone:** `docker compose up` (backend with `FixtureSource`, `local` target), then serve `backend/data/out/` with any static server. Zoom through every level, play a day, check the pseudo-ar mirroring, and check that deep links work on reload.
2. **Real capture:** link the observer. The traveler posts a photo and a voice status. Both appear in the control UI, then on the SFTP static host within about a minute. Delete one on WhatsApp and it disappears, media included.
3. **Owner flow:** in the admin PWA on a phone, add a note, a story and a description, hide an item, and set the timezone. Each change is live on the static site in under a minute, in de and en.
4. **Resilience:**
   - Stop the API: new statuses still get published.
   - Stop the backend for 20 min: an alert arrives; edits made meanwhile publish after restart.
   - `kill -9` during a deploy: the site stays consistent.
5. **Quality:** Playwright, PHPUnit, Vitest and Go tests pass; Lighthouse mobile meets the budget.

## Later (out of scope for v1)

- Visitor features through the API: hearts, comments, e-mail/web-push subscriptions.
- More publish targets (FTPS, S3, Netlify, Cloudflare Pages).
- Manual photo/video uploads in the admin, processed by the backend.
- Remote pairing from the admin.
- An Expo app (reads the static JSON, writes via the API) with a share extension.
- Map view and GPS check-ins.
- "Play the whole trip".
- Launching real RTL locales with font QA.
