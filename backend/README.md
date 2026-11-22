# Backend (`@omw/backend`)

Node 24 + TypeScript service with a small Go helper ([whatsmeow](https://github.com/tulir/whatsmeow)).
It captures the traveler's WhatsApp statuses, processes the media, generates the static site,
publishes it over SFTP, syncs with the optional PHP API and serves a local control UI.

```
WaSource (helper | fixtures) ─▶ Ingest (inbox → archive → media pipeline → store)
                                   │ onChange(dates)                ▲ owner mirror
                                   ▼                                │
  API change feed ─▶ Sync ──onOwnerChange(dates)──▶ BuildScheduler ─▶ Generator ─▶ PublishRunner ─▶ Publisher
        ▲              │  (debounce 3 s / max 30 s,      (OUT_DIR mutex: never generate     │
        └── outbox ◀───┘   persisted, retried)            and deploy at the same time)     ▼
   (capture mirror, previews, revokes, publish reports, heartbeat)          Sync.reportPublished
```

| Module | Path | What |
|---|---|---|
| App / orchestrator | `src/app.ts` | Wires everything, debounced generate, single-flight publish with retry, delayed-publish timer, graceful shutdown, process lock |
| CLI / entry | `src/cli.ts`, `src/main.ts` | `backend <command>`; `main.ts` = `backend start` |
| Capture | `src/capture/` | WaSource (Go helper supervisor or fixture replay) and Ingest; `app-source.ts` pulls the traveler app's entries from the API inbox (archive: `app-archive.ts`) |
| Pipeline | `src/pipeline/` | sharp / ffmpeg media variants; the portrait's round crop (`avatar.ts`, made by the generator run) |
| Store | `src/store/` | SQLite (WAL): captures, owner mirror, outbox, sync state, deploy manifests, events |
| Generator | `src/generator/` | store → `OUT_DIR` (HTML per route, JSON, media links, site assets) |
| Publisher | `src/publisher/` | incremental, crash-safe deploys to `local` and `sftp` targets |
| Sync | `src/sync/` | PHP API client: outbox push, change-feed pull, heartbeat, publish reports |
| Control UI | `src/ui/` | Fastify on `127.0.0.1:8787`, server-rendered HTML + `static/app.js` |
| Helper | `wa-helper/` | Go, see `wa-helper/NOTES.md`; protocol in `packages/contracts/src/wa.ts` |

## Run it

```sh
pnpm install                                  # once, from the repo root
pnpm fixtures                                 # once: synthetic statuses in fixtures/generated (needs ffmpeg)
pnpm --filter @omw/contracts build            # the built backend imports contracts/dist
pnpm --filter @omw/site build                 # the site build the generator ships (frontend/site/dist)

pnpm --filter @omw/backend dev                # tsx --watch; WA_MODE=fixture by default
open http://127.0.0.1:8787                    # token in dev: omw-dev-control-token
```

Built: `pnpm --filter @omw/backend build && pnpm --filter @omw/backend start`.
Real WhatsApp on the Mac: build the helper (`make -C backend/wa-helper build`) and start with
`WA_MODE=observer TRAVELER_PHONE=49151…` (see [docs/OBSERVER.md](../docs/OBSERVER.md)).
Outside Docker nothing reads the repo's `.env`: pass variables on the command line.

## Docker

[Dockerfile](Dockerfile) (build context = repository root) and [compose.yaml](compose.yaml);
running it day to day: [docs/OPERATIONS.md](../docs/OPERATIONS.md).

- Image `node:24-trixie-slim` (Debian 13) + Debian's ffmpeg 7.1 + tini, runs as `node` (uid 1000),
  keeps the repository layout under `/app`, ships the Go helper (`/app/backend/wa-helper/bin/wa-helper`,
  built with `golang:1.26-trixie`), the built site and a `backend` CLI wrapper; HEALTHCHECK on
  `/healthz`. ~785 MB on arm64, dependencies from the frozen lockfile.
- Build with the project's own buildx builder (Docker Desktop's disk is shared with other
  projects; this keeps our cache separate and prunable): `docker buildx create --name omw-builder
  --driver docker-container` once, then `docker buildx build --builder omw-builder --load -f
  backend/Dockerfile -t omw-backend:dev .`. A cold build needs ~6-7 GB free in Docker's VM at its
  peak; afterwards `docker buildx prune --builder omw-builder --reserved-space 2gb -f`.
- `scripts/docker-e2e.sh` (repo root): builds `omw-backend:dev` (with `omw-builder`) and runs the
  whole fixture flow in the container (owner import, ingest, sharp/ffmpeg, generate, local publish
  to a bind mount), the generated-site Playwright spec on the host, a graceful stop (SQLite
  `integrity_check`) and an idempotent restart; compose project `omw-e2e`, no `.env`, ports
  127.0.0.1:19180/19181.
- Unit tests on Node 24 inside Linux: `docker buildx build --builder omw-builder --load -f backend/Dockerfile --target test -t omw-backend:test .`
  then `docker run --rm --tmpfs /app/.cache:exec omw-backend:test` (contracts + backend incl. the
  edge-media test; only the browser test is left out, see the Dockerfile). The test image is
  ~1.2 GB: remove it afterwards (`docker rmi omw-backend:test`).
- Bind mounts on macOS (Docker Desktop, VirtioFS): files the container writes appear as your
  user on the Mac and as uid 1000 inside; hard links between `media/` and `out/media/` work. On a
  Linux host: `sudo chown -R 1000:1000 backend/data`.

## Configuration (environment)

Validated by `src/config.ts` (zod); invalid values stop the backend with a clear message.

| Variable | Default (dev / production) | Meaning |
|---|---|---|
| `NODE_ENV` | `development` | `production` requires `CONTROL_TOKEN`, defaults `WA_MODE=observer`, `DATA_DIR=/data` |
| `LOG_LEVEL` | `debug` / `info` | pino level |
| `WA_MODE` | `fixture` / `observer` | `observer` (second number), `self` (traveler's own account), `fixture` (replay `FIXTURES_DIR`) |
| `TRAVELER_PHONE` | – | traveler's number, required for `observer` |
| `TRAVELER_LID` | – | override of the learned LID |
| `WA_HELPER_BIN` | `backend/wa-helper/bin/wa-helper` | Go helper binary |
| `SEND_READ_RECEIPT` | `false` | "captured ✓" read receipt on the traveler's status |
| `MEDIA_GIVE_UP_HOURS` | `48` | media not downloadable after this → `media_lost` |
| `WA_FIXTURE_PACE_MS` | `0` | fixture mode: delay between replayed statuses |
| `API_BASE_URL` + `API_TOKEN` | – | PHP API (backend token `omw_…`); unset = captures-only site. Production: `https://` unless the host is loopback |
| `API_BACKUP_KEEP` | `7` | daily API database backups kept in `DATA_DIR/api-backups` (`src/sync/backup.ts`) |
| `CONTROL_HOST` / `CONTROL_PORT` | `127.0.0.1` / `8787` | control UI (Docker: `0.0.0.0`, published on 127.0.0.1 only) |
| `CONTROL_TOKEN` | dev token (warns; refused unless `CONTROL_HOST` is loopback) / **required ≥ 16 chars** | control UI + CLI credential |
| `CONTROL_ALLOWED_HOSTS` | – | extra Host names for the control UI (reverse proxy / VPN name) |
| `SITE_PUBLIC_URL` | – | public URL of the static site (canonical/hreflang URLs, basePath; link previews are always neutral) |
| `DEFAULT_TIMEZONE` | `Europe/Berlin` | until the API's `timezone.current` arrives |
| `NTFY_URL` | – | local alerts (WhatsApp logged out/banned > 2 min, ≥ 3 failed deploys in a row) when NO API is configured; with an API, its cron alerts |
| `DATA_DIR` | `backend/data/state` / `/data` | `store.db`, WhatsApp session, inbox |
| `ARCHIVE_DIR`, `OUT_DIR`, `CONFIG_DIR`, `MEDIA_DIR` | `backend/data/{archive,out,config,media}` | archive (backup!), generated site, publish targets/keys, media variants (same filesystem as `OUT_DIR`) |
| `SITE_DIST_DIR` | `frontend/site/dist` | Vite build of `@omw/site` |
| `OMW_VERSION` | `package.json` version | reported in heartbeat and UI |
| `SFTP_HOST`, `SFTP_USER`, `SFTP_PASSWORD`, `SFTP_PORT`, `SITE_BASE_URL`, … | – | bootstrap ONE sftp target when `CONFIG_DIR/targets.json` does not exist (see `src/publisher/targets.ts`) |
| `APP_PUBLISH` | `false` | traveler app entries may be published; off = archive-only (owner decision Q8 a): they are archived, processed and shown in the admin, but no `app:` capture reaches the site |
| `APP_INBOX_POLL_SECONDS` | `60` | how often the API's app inbox is asked for new entries (again within seconds while there is work; only with an API) |

### Access gate (wave 5, `ACCESS_MODE=gate`)

Gate mode (live hosting) generates a second tree, the **gate tree** (`GATE_OUT_DIR`): the root
`.htaccess` that checks every request against the session-file store, the neutral page, the
`/_/` gate pages (join, info, wait, ended, your data, panic) with the gate bundle
(`frontend/site/dist/gate`), `robots.txt`, `favicon.svg` and `/_/403.txt`. The content tree
(`OUT_DIR`) is published to `/<secret>/` with the same gate block in its own `.htaccess`, private
caching, `Boot.access`, and a CSP with the API origin in `connect-src` and `worker-src 'none'`;
no `robots.txt`/`sitemap.xml`, never indexable. `open` (default: dev, fixtures, Docker e2e) is
today's single tree with the wave-5 privacy fixes. Spec: `.cache/design-w5/spec-wave5.md` §5.

| Variable | Default | Meaning |
|---|---|---|
| `ACCESS_MODE` | `open` | `gate` turns on the gate tree, the two-root publisher and the post-deploy gate check |
| `SITE_PUBLIC_URL` | – | gate mode: `https://<site host>/<secret>/`, `<secret>` = `[a-z0-9]{20}`, exactly one path segment. Generate it once: `node -e "const a='abcdefghijklmnopqrstuvwxyz0123456789';console.log(Array.from(crypto.getRandomValues(new Uint8Array(20)),(b)=>a[b%36]).join(''))"` |
| `API_PUBLIC_URL` | `API_BASE_URL` | the API base the browser calls (`<API_PUBLIC_URL>api/v1/public/`); its origin is the CSP's `connect-src`. Required in gate mode |
| `ACCESS_STORE_DIR` | – | the session-file store as Apache sees it (absolute, `[A-Za-z0-9._/-]`, no `..`, no `//`); baked into both `.htaccess` files and reported in the heartbeat. Required in gate mode |
| `ACCESS_COOKIE_MODE` | `headers` | `headers` (`__Host-` cookies set by `mod_headers`), `co` (F1: the `CO` flag), `parent` (F2: the API sets parent-domain cookies). Must equal the API's |
| `ACCESS_COOKIE_DOMAIN` | – | `co`: the site host; `parent`: the shared parent domain |
| `ACCESS_HTTPS_REDIRECT` | `false` | emit the http→https redirect (only after the host probe showed `%{HTTPS}=on`) |
| `GATE_OUT_DIR` | `backend/data/out-gate` | where the gate tree is generated (a sibling of `OUT_DIR`, never inside it) |

The whole configuration is checked with `siteAccessProblems()` (`@omw/contracts/access`). Nothing
in `backend/src` names a real host (a test greps for it): every origin comes from here (Q9).

Publish targets in gate mode need the **web root** (`gateRoot` for SFTP, usually `/`; `gateDir`
for a local folder), and the content root must be web root + `/<secret>` (`remoteRoot` / `dir`).
Each deploy uploads the gate tree first (`/.htaccess` last, only when it changed; record
`/.omw-gate.json`), then the content, then runs the anonymous-must-be-refused check (at most 5
requests, 2 s apart; skipped when nothing changed and the last check passed < 6 h ago). A
connection without `posix-rename@openssh.com` is refused. A target with `accessStoreRoot` /
`accessStoreDir` (optionally store-only: "deploy the site here" off) is used by the **Mac fallback
store writer** (when the API's change feed says `needsWriter`) and the control UI's
**"Website sperren"** button. The one-off move of a live open-mode site:
`backend publish --migrate-to-gate <target>` (lists the old root files) and again with
`--confirm` (deletes them). `generator serve` in gate mode serves both trees **without** the gate;
the gate is tested only with Apache: `pnpm --filter @omw/backend test:apache` (local httpd on
127.0.0.1, store on a case-sensitive disk image on macOS; not part of `pnpm test`).

## CLI

`node dist/cli.js <command>` (`pnpm --filter @omw/backend cli <command>`, `cli:dev` for tsx; in
Docker: `docker compose exec backend backend <command>`).

| Command | What |
|---|---|
| `start` (default) | run the backend |
| `generate [--full]` | regenerate the site |
| `publish [--target ID] [--force]` | deploy to every enabled target, or one (also a disabled one); `--force` overrides the mass-delete guard (a deploy deleting half of the target or every day is refused otherwise) |
| `publish --migrate-to-gate ID [--confirm]` | gate mode, one-off: generate, deploy gate + content trees, gate check, list the legacy root files (deleted only with `--confirm`); the backend must not be running |
| `reprocess [SOURCE_KEY]` | re-run the media pipeline from the archive (all, or `wa:<msgId>`) |
| `status [--json]` | health summary |
| `pair-code PHONE` | pairing code for the observer phone (backend must be running) |
| `owner-import FILE [--locales=de,en,ar] [--force]` | DEV/OFFLINE: apply an owner change feed (API `changes` page, or a file with a `changes` member such as `fixtures/generated/owner.json`) to the owner mirror; `--locales` also sets `site.locales` (RTL test deployment). Refused while the backend runs, and while an API is configured unless `--force` (the API owns that content; its first pull rebuilds the mirror). |

One-shot commands use the running backend's control API when one answers on
`CONTROL_HOST:CONTROL_PORT` (Bearer `CONTROL_TOKEN`); otherwise they run in-process and hold
`DATA_DIR/backend.lock` (also held by `start`, so two processes never write `OUT_DIR` at once).
The lock's mtime is a heartbeat (every 10 s): a lock written under another host name (another
container) counts as held while it is younger than 30 s, so `docker compose run` next to the
running daemon refuses instead of taking it over.
Exit codes: 0 ok, 1 failure, 2 usage/configuration error.

## Control UI

`http://127.0.0.1:8787` — log in with `CONTROL_TOKEN` (cookie session, 30 days, HttpOnly,
SameSite=Strict). Pages: **Overview** (WhatsApp state, traveler match, captures, site, publish,
API sync), **Link WhatsApp** (live QR via SSE, pairing code, helper restart), **Queue** (captures
not ready with retry/skip, failing API pushes, change-feed quarantine, reprocess), **Publish**
(rebuild all, publish now, last deploy, targets add/edit/test/remove; secrets write-only),
**Logs** (live log tail from an in-memory ring buffer, event log).

Security: strict CSP (`script-src 'self'`, no inline script/style), CSRF token on every
cookie-authenticated POST plus same-origin `Origin`/`Sec-Fetch-Site` checks, Host header
allow-list (loopback + `CONTROL_ALLOWED_HOSTS`, against DNS rebinding), login rate limit.

JSON API (`Authorization: Bearer $CONTROL_TOKEN`, or the cookie + `X-CSRF-Token`):

| Route | |
|---|---|
| `GET /healthz` | public, `{ok, app: "omw-backend", version}` (Docker healthcheck) |
| `GET /api/status` | everything the overview shows (`AppStatus` in `src/ui/types.ts`) |
| `GET /api/wa` · `GET /api/wa/stream` | WhatsApp snapshot · SSE (`state`, `qr` with SVG, `pair_code`; `?once=1`) |
| `GET /api/logs?after=ID` · `GET /api/events?limit=&type=` | log tail · event log |
| `GET /api/queue` | captures not ready, failing outbox items, quarantine |
| `POST /api/rebuild {full?}` | generate now (default full) |
| `POST /api/publish {targetId?, force?}` | deploy now (`force`: override the mass-delete guard) |
| `POST /api/reprocess {sourceKey?}` | reprocess from the archive |
| `POST /api/pair-code {phone}` | pairing code (422 invalid phone, 409 already linked, 503 helper down, 504 timeout) |
| `POST /api/captures/:sourceKey/retry` · `…/skip` | resume a failed capture · give up (→ `media_lost`) |
| `POST /api/sync/pull` · `POST /api/sync/resync` | pull the change feed now · queue every capture for the API again |
| `POST /api/wa/restart` | restart the helper |
| `GET /api/targets` · `POST /api/targets` · `DELETE /api/targets/:id` · `POST /api/targets/:id/test` | publish targets (`PublishTargetInput` in `src/publisher/types.ts`) |

## API sync (`src/sync/`)

- **Outbox** (`sync_outbox`, coalesced per kind+key): capture mirror (`PUT …/captures/{sourceKey}`,
  always the current row), previews (multipart), revokes, publish reports. The ingest queues the
  capture items in the same transaction as the state change. Backoff 5 s × 2ⁿ (max 15 min) with
  ±50 % jitter; `Retry-After` wins; 429/503 pause every push for that delay (the rest of the batch
  is not sent into the rate limit); 404 `capture_not_mirrored` retries after ~30 s; other 4xx
  retry hourly (never dropped); 401/403 pause all API traffic for 5 min and show in the UI.
- **Change feed**: `GET …/changes?after=` every 15 s and right after own pushes, page by page;
  items are validated one by one by the store (invalid → quarantine, unknown → ignored, their
  kind remembered); a 409 `feed_reset` or a new `feedId` rebuilds the owner mirror from seq 0 and
  re-pushes every capture (the API was restored). At startup, items an older version ignored
  whose kind this version knows (e.g. new settings) replay the feed once the same way.
- **Heartbeat** every 60 s (contracts `Heartbeat`), sent directly, never queued.
- **Publish reports** carry the change-feed cursor and capture watermark of the generate that
  produced the deployed files (`sync_state.last_generate`), not of "now".
- Without `API_BASE_URL` everything above is off and nothing is queued.

## Local end-to-end run (fixtures, no phone, no API)

Capture → pipeline → generator → local publish → static server → Playwright, with an explicit
environment (`env -i`, so no `SFTP_*`/`API_*` value from a shell or `.env` reaches the backend):

```sh
# 1. dirs + a local publish target (CONFIG_DIR/targets.json, mode 0600)
E=$PWD/.cache/e2e; mkdir -p $E/config
cat > $E/config/targets.json <<JSON
{ "format": 1, "targets": [ { "id": "local-e2e", "kind": "local", "enabled": true,
  "publicBaseUrl": "http://127.0.0.1:4173/", "dir": "$E/site",
  "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" } ] }
JSON
chmod 600 $E/config/targets.json
# 2. the environment (every backend command below runs with it)
b() { env -i PATH="$PATH" HOME="$PWD/.cache/home" TMPDIR="$PWD/.cache/tmp" TSX_DISABLE_CACHE=1 \
  WA_MODE=fixture DATA_DIR="$E/state" ARCHIVE_DIR="$E/archive" OUT_DIR="$E/out" CONFIG_DIR="$E/config" \
  MEDIA_DIR="$E/media" SITE_PUBLIC_URL=http://127.0.0.1:4173/ CONTROL_TOKEN="<16+ chars>" \
  node --conditions=@omw/source --import tsx backend/src/cli.ts "$@"; }
# 3. owner content (trip, notes, story) + the RTL pseudo-locale, then start
b owner-import "$PWD/fixtures/generated/owner.json" --locales=de,en,ar
b start &         # keeps running: ingests 18 fixture statuses, generates, publishes to $E/site (~10 s)
# 4. once "deployed" is logged: Playwright against the published folder (serves it on 127.0.0.1:4173 itself)
OMW_GENERATED_DIR=$E/site pnpm exec playwright test -c frontend/site/playwright.generated.config.ts
kill %1           # stop the backend (graceful)
```

The spec (`frontend/site/e2e/generated.spec.ts`) covers de/en/ar homes and all zoom levels, the
player (autoplay, video, AVIF variants), the story sheet, the trip dialog, deep-link reloads of
every route type, 404s, the language picker and the "new moments" baseline; every test fails on
console errors, failed requests, HTTP errors and CSP violations. For the compiled build use
`node backend/dist/cli.js` with `NODE_ENV=production` instead of tsx. Screenshots:
`node --import tsx frontend/site/e2e/shots.ts --base http://127.0.0.1:4173 --out .cache/shots/x /de/ …`.

## Local end-to-end run with the PHP API

The full owner flow (backend ⇄ API sync, admin edits, change feed → generated site, "Live ✓",
API outage and catch-up) is an automated Playwright run that starts the PHP API, this backend
(fixture mode, `API_BASE_URL=http://127.0.0.1:8080`) and a static server itself:
`pnpm --filter @omw/admin e2e:stack` (see [api/README.md](../api/README.md#end-to-end-test-of-the-whole-stack)).
By hand: start the API as in `api/README.md`, then run the backend with the environment above
plus `API_BASE_URL=http://127.0.0.1:8080 API_TOKEN=<backend token>` (no `owner-import`: the API
owns the owner content).

When the API was unreachable (network error, timeout, 502/503/504), the first successful request
afterwards makes every push that failed during the outage due at once, so the capture mirror and
publish reports catch up within seconds instead of after their backoff (up to 15 min).

## Traveler app entries (`src/capture/app-source.ts`)

With an API configured, the backend polls `GET /backend/app/entries` and reconciles every item with
the archive and the store, so a crash just repeats a step: committed files are downloaded with Range
resume into `DATA_DIR/inbox-app/`, sha256-checked, copied into
`ARCHIVE_DIR/app/YYYY/MM/DD/app-<ULID>.{json,jpg|mp4|m4a,preview.jpg,original.<ext>}` (record type
`omw.app-entry`; the original of photos and videos too, Q2 c), inserted as the capture
`app:<ULID>` (source `app`, store migration v2) and acked, after which the API deletes its copy.
The ingest's workers then run the usual pipeline on the media file (EXIF/GPS stripped, variants,
admin preview); `reprocess` works from the record. A withdrawal she makes after the archive sets
`revokedAt` (`ingest.on_revoke` applies). A file that never matches its sha256 (3 downloads)
rejects the entry. Records missing from the store are restored at start. While `APP_PUBLISH` is
off, the generator leaves every `app:` capture out (also as the portrait); the switch is reported
with every poll, so the app shows "Archived ✓" and the admin's chip says "Archive only". The
generator has one output for all targets, so the local preview leaves them out too; set
`APP_PUBLISH=true` on a local backend to see them rendered.

`test/capture/app-source.test.ts` runs the source against a fake inbox;
`test/capture/app-stack.test.ts` runs it against the real PHP API (`scripts/app/dev-api.sh` on a
free port with a throwaway state, a scripted phone using the tus subset). It is skipped without
`php` 8.3+ or `api/vendor`.

## Tests

```sh
pnpm --filter @omw/backend exec vitest run test/sync test/ui test/app
```

`test/sync` runs the real fetch/FormData code against a fake API (`node:http`, port 18720/18721),
`test/ui` uses `fastify.inject` plus one live SSE test (port 18730), `test/app` drives the
orchestrator with fake modules.
