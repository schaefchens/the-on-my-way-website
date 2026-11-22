# Hosting: static site + PHP API

Two independent web spaces (plan B and A5):

| Host | Serves | Deployed by |
|---|---|---|
| **Static host** | the generated timeline (`/de/…`, `/en/…`, `/data/*.json`, `/media/*`, `/assets/*`); with the access gate (§11, wave 5) only behind Apache `.htaccess` rules: the gate tree at the web root, the timeline under `/<secret>/` | the Node backend's publisher (SFTP, incremental, `/.omw-deploy.json.gz` deploy record; gate tree: `/.omw-gate.json`) |
| **PHP host** | the dynamic API (`/api/v1/…`) and the admin PWA (`/admin/`); with the gate also the followers' public routes (`/api/v1/public/…`) and the writer of the session-file store | `scripts/deploy-api.ts` (SFTP, incremental, `/.omw-deploy.json` manifest) |

Nobody needs the API to *view* the site (joining it does, §11). They can be the same Hetzner account with two (sub)domains; each needs its own document root.

Live setup (2026-11): both are Hetzner shared hosting ("Webhosting", konsoleH): Apache + `.htaccess`, PHP-FPM 8.5.13, `pdo_sqlite` with SQLite 3.40.1 (WAL works), `upload_max_filesize`/`post_max_size` 50M, `memory_limit` 128M, `max_execution_time` 60, no SSH shell. **The SFTP root `/` is the document root** on both.

---

## 1. Static host

1. In konsoleH create the (sub)domain for the site and enable a TLS certificate (Let's Encrypt).
2. Note the SFTP host, user, password (or upload an SSH key) and the host-key fingerprint.
3. Add a publish target in the backend's control UI (`http://127.0.0.1:8787`, page *Publish*): host, port, user, key or password, **pinned host-key fingerprint**, remote root (`/`), public base URL. Press **Test** next to the target, then **Publish now**.
4. Pages are `noindex` until the setting `site.indexable` is switched on in the admin.

The generator writes an optional `/.htaccess` with MIME types (avif, webp, m4a); hashed `media/` and `assets/` never change, data files are cache-busted with `?v=<hash>`, `manifest.json` is fetched with `no-store`, so no server cache configuration is required.

With the access gate (`ACCESS_MODE=gate`, §11) the target also needs the **web root** (`gateRoot`, `/`) and the content root becomes `/<secret>` (`remoteRoot`); the generated `.htaccess` files are then the gate itself and must never be edited by hand.

---

## 2. PHP host (API + admin)

### Requirements

- PHP **8.3 or newer** with `pdo_sqlite`, `mbstring`, `fileinfo`, `json` (and `curl` for ntfy alerts and the doctor's HTTP self-check). Argon2id support is used when available (bcrypt otherwise).
- `expose_php = Off` in the PHP configuration where the host lets you set it (it is a `php.ini`-only setting). The API does not depend on it: `public/index.php` removes the `X-Powered-By: PHP/x.y.z` header from every response it sends.
- Apache with `mod_rewrite` and `.htaccess` (`AllowOverride All`); `mod_headers` recommended. nginx: see below.
- HTTPS. The admin session cookie is `__Host-omw_session` (`Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`), so the API must live at the **root of its own (sub)domain**, e.g. `https://api.example.org/`.

### Hetzner konsoleH

1. Create a subdomain (or domain) for the API and enable TLS (Let's Encrypt) for it.
2. **PHP version:** *Services > Server configuration / PHP configuration* for that (sub)domain: choose PHP 8.3+ (the live host runs 8.5.13). FPM is fine.
3. Document root: leave it at the SFTP root `/`. The deploy unit's root `.htaccess` routes every request into `public/` and denies everything else (`.env`, `var/`, `src/`, `vendor/`, `bin/`, `migrations/`, `schemas/`, `composer.*`); `var/`, `src/`, `bin/`, `migrations/`, `schemas/`, `tests/` and `vendor/` additionally carry deny-all `.htaccess` files. If your host lets you point the document root at `public/`, do that instead; both layouts work. `/.well-known/` (ACME http-01 challenges, see below) is served from the document root itself in both layouts.
4. Put the credentials into the repo's `.env` (never committed): `API_SITE_BASE_URL`, `API_SFTP_HOST`, `API_SFTP_PORT`, `API_SFTP_USER`, `API_SFTP_PASSWORD`, `API_SFTP_REMOTE_ROOT` (`/`), plus `SITE_BASE_URL` (its origin becomes `SITE_ORIGIN` for CORS). Recommended: `OMW_ADMIN_EMAIL`, an address nobody can guess (otherwise the first admin is the public placeholder `owner@on-my-way.invalid`). It can be changed later, see §7.
5. Pin the host key: `scripts/deploy-api.ts` accepts only the fingerprints in `PINNED_HOST_KEYS` (www99.your-server.de: ED25519 `SHA256:1ckzga7xTCnKZNsqpWVAh4K85X9HmVe+5Ki1PW7tOQs`, RSA `SHA256:gQnQinEqX7NMlkAYbI8WiXGzkSfQWisi2SxHo7B2ebQ`). For another server, add its fingerprints there first.

### nginx (when you are not on Apache)

```nginx
root /srv/omw-api/public;
location / { try_files $uri $uri/ /index.php?$query_string; }
location /admin/ { try_files $uri $uri/ /admin/index.html; }
location ^~ /admin/assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; try_files $uri =404; }
location ~ ^/admin/(sw\.js|index\.html|manifest\.webmanifest)?$ { add_header Cache-Control "no-cache"; try_files $uri /admin/index.html; }
location ~ \.php$ { include fastcgi_params; fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name; fastcgi_pass unix:/run/php/php-fpm.sock; }
location ^~ /.well-known/ { try_files $uri =404; }
location ~ /\. { deny all; }
```

(The nginx snippet is not tested; the Apache layouts are, see below.)

### `/.well-known/` and TLS certificates

ACME http-01 challenges (Let's Encrypt and other webroot clients) are requested over plain http as `http://<api>/.well-known/acme-challenge/<token>`, and a webroot client writes the token to `<document root>/.well-known/acme-challenge/<token>`. The `.htaccess` files therefore:

- exempt `/.well-known/` from the http -> https redirect (in `public/.htaccess` also as `/public/.well-known/`, the URI after the root rewrite);
- serve `/.well-known/` from the **document root itself** (`RewriteRule ^\.well-known(?:/|$) - [L]` before the rewrite into `public/`), so with the api/ folder as document root the token comes from `api/.well-known/…`, not from `public/`;
- keep every other dotfile forbidden (`.env`, `.git`, `.htaccess`, `.maintenance`, `.omw-deploy.json`, …); the `FilesMatch "^\.(?!well-known$)"` rule allows only the `.well-known` directory itself, so a missing challenge file is a **404** (not a 403 and not a `301` to `https://…/public/…`).

Verified locally with Apache 2.4 for both layouts (token file 200 over http, missing file 404, all private paths unchanged). `deploy-api.ts` checks the missing-file case after every deploy (and with `--checks-only`). Hetzner issues the certificates of its shared hosting itself; whether it uses this path is not known, but the rule is harmless either way. The deploy never uploads or deletes anything in `/.well-known/`.

---

## 3. Deploying the API

```sh
pnpm --filter @omw/admin build                                          # optional: admin PWA -> api/public/admin
TSX_DISABLE_CACHE=1 node --import tsx scripts/deploy-api.ts --dry-run    # plan only (one SFTP login, no changes)
TSX_DISABLE_CACHE=1 node --import tsx scripts/deploy-api.ts              # deploy + HTTPS checks + smoke round-trips
```

Options: `--no-smoke`, `--skip-composer` (reuse `.cache/api-build/vendor`), `--reset-admin-password`, `--rotate-feed-id`, `--set-admin-email=NEW` (§7), `--set-env-file=FILE` (merges the `ACCESS_*` keys of a local file into the remote `/.env` before the upload; prints key names only, never values; §11.5), `--concurrency=N`, `--skip-http-checks` (SFTP only; the result is reported as UNVERIFIED), `--checks-only` (no staging, no SFTP: just the HTTPS checks and, unless `--no-smoke`, the smoke round-trips; use it after `--skip-http-checks`).

What happens:

1. **Stage** a clean copy of `api/` in `.cache/api-build` (no tests, no `var/` contents, no `.env`, no dev configs, no source maps) and run `composer install --no-dev --classmap-authoritative` there (through `scripts/composer`, caches stay in `.cache/`). The admin PWA is included when `api/public/admin` is built; otherwise the script warns.
2. **Connect once.** Host key pinned; an authentication failure aborts immediately and is **never retried** (the host may ban repeated failures).
3. **Compare** with the remote manifest `/.omw-deploy.json` (path -> sha256). Only changed files are uploaded, each as temp file + rename. Order: `vendor/`, `src/`, … first; admin shell, `public/index.php` and the root `.htaccess` last. While PHP files change, `/.maintenance` makes the API answer `503 maintenance` and makes cron skip its jobs; it is removed only after every file is in place (a failed upload leaves it up, so nothing runs on a half-updated code base: re-run the deploy). Obsolete files are deleted last; hashed admin assets of the previous build are kept for 7 days (open tabs can still load their chunks). Files the manifest does not list are never deleted.
4. **Never touched:** the remote `var/**` (database, previews, backups, logs) except creating `var/` and uploading `var/bootstrap.json`, and the remote `/.env` once it exists (except the `ACCESS_*` lines `--set-env-file` merges in when passed; every other line stays byte for byte).
5. **First deploy:** creates `/.env` (`APP_ENV=production`, `APP_URL`, `SITE_ORIGIN`, `DB_PATH=var/app.sqlite`, random `CRON_KEY`, empty `MAIL_DSN`) and, while no database exists, an admin login and a backend API token. The clear texts are written to `.secrets/api-admin.txt`, `.secrets/api-backend-token` and `.secrets/api-cron-key` (mode 600, never printed). The server only receives hashes in `var/bootstrap.json` (Argon2id + bcrypt fallback for the password, sha256 for the token).
6. **Zero-shell setup on the server:** the first request after a deploy applies pending migrations (cheap stamp check `var/cache/schema.stamp`, exclusive `flock` on `var/cache/setup.lock`, never concurrent; waiting requests get `503` + `Retry-After` after 20 s) and consumes `var/bootstrap.json` once (then deletes it).
7. **Checks over HTTPS:** `GET /api/v1/health` is 200 JSON; `/.env`, `/var/app.sqlite`, `/var/bootstrap.json`, `/composer.json`, `/src/App.php`, `/vendor/autoload.php`, … are **not** 200; `/admin/` and an SPA deep link are 200 (when built); over plain `http://` a missing `/.well-known/acme-challenge/…` file is `404`; `http://` redirects to `https://`. Then (unless `--no-smoke`): admin login -> `GET /me` -> create and delete a hidden test note -> CSRF is enforced -> logout; backend token -> heartbeat -> change feed -> no-token 401. The exit code is non-zero when any check fails.

Note: the smoke heartbeat (`backendVersion: "deploy-smoke"`, WhatsApp state `closed`) is recorded like a real one. Until the real backend sends heartbeats, cron raises a `heartbeat_stale` alert after `alerts.heartbeat_stale_minutes` (silent while no alert channel is configured).

### Environment check

- Admin: `GET /api/v1/admin/doctor` (logged in) runs the checks **in the web SAPI** (PHP version and extensions, SQLite + JSON1, Argon2id, writable `var/`, WAL, upload limits, memory, disk, migrations, admin user and backend token, mail, cron freshness) plus an HTTP self-check that private files are not reachable.
- CLI (where a shell exists): `php bin/doctor.php [--json]`.

---

## 4. Cron (alerts, backups, cleanup)

Every 5 minutes one of:

- **Hetzner Cronjob-Manager** (konsoleH, *Services > Cronjob manager*): type *PHP script*, script `bin/cron.php` of the API's folder, PHP version as above, interval every 5 minutes.
- **Any web-cron service** (cron-job.org, an uptime monitor, …) calling `GET https://<api>/api/v1/cron` with the header `X-Cron-Key: <CRON_KEY>` (preferred), or `GET https://<api>/api/v1/cron?key=<CRON_KEY>` when the service cannot send headers (the key then appears in access logs). `CRON_KEY` is in `.secrets/api-cron-key` and the remote `.env` (at least 24 characters; the endpoint is 404 without it, 403 for a wrong key; compared in constant time).
- **Enoch** (the Schaefchens cron multiplexer, *Scheduled maintenance*): add a request with URL `https://<api>/api/v1/cron`, method `GET`, interval 5 minutes, and the contents of `.secrets/api-cron-key` as its **Bearer token**. Enoch sends `Authorization: Bearer <CRON_KEY>`, which the endpoint accepts like `X-Cron-Key`. It allows about 8 s per call, doesn't follow redirects, and counts only HTTP 2xx as success. A normal run takes well under a second; if Enoch gives up early, the run still finishes on the server.
- A real crontab where available: `*/5 * * * * php /path/to/api/bin/cron.php`.

Both entry points run the same jobs (a non-blocking `flock` on `var/cache/cron.lock` skips overlapping runs; while `/.maintenance` exists, a deploy or a restore is in progress and both skip everything):

- **alerts:** `heartbeat_stale` (no heartbeat for `alerts.heartbeat_stale_minutes`), `wa_logged_out`, `wa_banned`, `publish_failing` (`PUBLISH_FAIL_THRESHOLD` consecutive failed deploys of a target). A publish target the backend no longer reports (its last report is more than 7 days older than another target's newest one: removed or renamed in the control UI) is left out of `publish_failing` and of the admin status; an alert that was open only because of it resolves with the note "Target no longer reported: …". Repeated every `ALERT_REPEAT_MINUTES` (60) until resolved, then one "resolved" notice. Undeliverable notifications are retried on the next run. Open and recently resolved alerts are shown in the admin (`GET /api/v1/admin/status`).
- **backup:** once per local day (`timezone.current`) after `BACKUP_HOUR` (3): `VACUUM INTO var/backups/app-<UTC>.sqlite` (+ `.json` sidecar with sha256), newest `BACKUP_KEEP` (14) kept. **Download `var/backups/` over SFTP regularly**: the snapshots live on the same host as the database. The backend does not fetch them yet (the API offers `GET /api/v1/backend/backup/latest` with a backend token, ETag = sha256, for a future puller); the backend keeps its own data, see [OPERATIONS.md](OPERATIONS.md#backups).
- **cleanup:** change-feed compaction (rows superseded for > 24 h; the latest row per key, tombstones included, always stays), login attempts and dead sessions older than 30 days, previews and posters of statuses deleted on WhatsApp (while `ingest.on_revoke` is `hide`; normally they go at the revoke already), preview files no capture references, `publish_status` rows of targets no longer reported, 30 days after their last report, log files older than 30 days.

## 5. Alert channels

Recipients are settings in the admin: `alerts.email` and/or `alerts.ntfy_url` (an ntfy topic URL).

ntfy access token: `NTFY_TOKEN` in the remote `.env`, for the server `NTFY_SERVER` (default `https://ntfy.sh`; set it for a self-hosted ntfy, e.g. `NTFY_SERVER=https://ntfy.example.org`). The token is sent **only** when `alerts.ntfy_url` is on exactly that origin (scheme, host, port); alerts to any other server go out without it, so whoever can edit the setting cannot make the API hand the token to their own server. In production the API also refuses alert URLs whose host is or resolves to a loopback, private (RFC 1918), link-local, carrier-grade NAT, unique-local (`fc00::/7`), unspecified or other non-public address (every A and AAAA record is checked, the connection is pinned to the checked addresses, redirects are never followed): the admin gets a `422` when saving such a URL, and a URL stored earlier fails at delivery with "ntfy: refused: … a loopback address …" in `var/logs/cron-*.log` (or `app-*.log` for the web-cron). URLs must not contain a user name or password.

E-mail needs a transport in the remote `.env` (edit it over SFTP; the deploy script never overwrites it):

```dotenv
# Hetzner mailbox (konsoleH > Mail): SMTP with STARTTLS
MAIL_DSN=smtp://alerts%40example.org:PASSWORD@mail.your-server.de:587
MAIL_FROM="On My Way <alerts@example.org>"
# or PHP's sendmail_path:
# MAIL_DSN=native://default
```

URL-encode `@`, `:` and `/` inside user and password. Symfony Mailer DSN reference: <https://symfony.com/doc/current/mailer.html#transport-setup>.

---

## 6. Connecting the backend

The Node backend needs `API_BASE_URL=https://<api>` and `API_TOKEN=<contents of .secrets/api-backend-token>`. More backend tokens can be created (and revoked) in the admin under Settings > Tokens (`POST /api/v1/admin/tokens`, kind `backend`).

### Publish mode switches (`publish.mode_since`)

The API maintains `publish.mode_since`, the cut-off before which captures count as "instant" (contracts policy rule 3). It moves only when a change could otherwise turn a public status back to pending; with t = the time of the change, s0 = the old cut-off, d0 = the old delay:

| Change | `publish.mode_since` | Effect |
|---|---|---|
| instant -> delayed or review | t | everything so far stays public; new statuses wait |
| delayed -> review | max(s0, t - d0 + 1 ms) | what was public stays public; what was waiting stays waiting (now for review) |
| delayed, delay changed | max(s0, t - d0 + 1 ms) | a longer delay never hides what is online; a shorter one releases what is older than the new delay |
| review -> delayed | s0 (unchanged) | the review backlog older than the new delay is published (the admin asks first) |
| any -> instant | unchanged | everything still waiting is published |

A change is written (settings rows and change-feed items, one transaction) in the order `publish.mode_since`, `publish.delay_minutes`, `publish.mode`, so a backend that has applied only part of the feed never judges captures by the new mode with the old cut-off. Time-zone names (`timezone.current`, a day's time-zone fix, a post's `tz`) are stored in the zone database's spelling (`asia/saigon` -> `Asia/Saigon`).

## 7. Admin login

`.secrets/api-admin.txt` holds URL, e-mail and password of the first admin. **Change the password** in the admin: Settings → *Passwort ändern* (current password + a new one of at least 12 characters with a strength hint; every other session ends, app tokens too when the box stays ticked; backend tokens never). **Recovery** when the password is lost: `scripts/deploy-api.ts --reset-admin-password` generates a new random password (32 characters), ships only its hash through `var/bootstrap.json` (`reset: true`; all sessions of that user are revoked) and writes the clear text to `.secrets/api-admin.txt`.

**Change the login e-mail** (do this when the admin still uses the placeholder `owner@on-my-way.invalid`: a known e-mail lets anyone trigger the per-e-mail login block):

- Hetzner (no shell): `TSX_DISABLE_CACHE=1 node --import tsx scripts/deploy-api.ts --set-admin-email=new@example.org`. It reads the current e-mail from `.secrets/api-admin.txt`, uploads a `bootstrap.json` with `{"adminEmail": {"from": …, "to": …}}`, which the app applies on the next request (the deploy's own checks make one; the smoke login then uses the new e-mail), and writes the new e-mail into `.secrets/api-admin.txt`. It runs only when the flag is passed, needs an existing database (for the first deploy use `OMW_ADMIN_EMAIL`) and can be combined with `--reset-admin-password`. If the change cannot apply (no user with the old e-mail, the new one taken), the app logs it and skips it.
- With a shell: `php bin/set-admin-email.php --to=new@example.org` (`--from=…` when there is more than one user).

Both validate the address, refuse one another user has, and keep the password, all sessions and app tokens; the successful-login history moves along (known devices, below).

**Login limits:** 10 failed logins per 15 minutes per IP, and 30 per hour per e-mail across all IPs (`429` + `Retry-After`). The check and the bookkeeping are one atomic step, so parallel requests cannot exceed them. The per-e-mail block does **not** apply to a *known device*: an IP that logged in successfully as that e-mail within the last 30 days (the per-IP limit still applies to it). Guessing from elsewhere therefore cannot lock you out at home; from a new network you may have to wait up to an hour while someone is guessing. Existing sessions (30 days, sliding) are never affected.

---

## 8. Restore

Backups: nightly snapshots in `var/backups/` on the API host, the copies you downloaded from there over SFTP (§4; the backend does not fetch them), and the backend's own archive (captures can always be re-pushed from it; owner content lives only in the API database and its backups).

1. **Maintenance on:** upload an empty file named `.maintenance` to the API root (SFTP). The API answers `503` from now on, and cron (`bin/cron.php` as well as the web-cron) skips all jobs, so nothing opens the database while you swap it.
2. **Keep a copy** of the current `var/app.sqlite` (and `-wal`/`-shm` if present) by downloading them.
3. **Delete** `var/app.sqlite-wal` and `var/app.sqlite-shm`. A WAL of the old database must never be applied to the restored file.
4. **Upload** the snapshot as `var/app.sqlite.new`, then rename it to `var/app.sqlite`.
5. **Rotate the feed id**, so the backend rebuilds its owner mirror instead of skipping or mixing changes (a restore rewinds `change_log.seq`): upload a file `var/bootstrap.json` containing `{"version": 1, "rotateFeedId": true}`. Do this while maintenance is still on: whichever request comes first afterwards (even the backend's next pull) consumes it before anything is served. (`scripts/deploy-api.ts --rotate-feed-id` uploads the same file, but it refuses to run while `/.maintenance` exists.)
6. **Maintenance off:** delete `/.maintenance`.
7. The next request notices the new database file (new inode), applies pending migrations and rotates `meta.feed_id`. The backend's next pull sees the new `feedId`, resets its cursor and re-reads the feed from seq 0 (contracts `ChangesResponse`). Captures newer than the snapshot are missing from the restored capture mirror until the backend pushes them again. That happens automatically: on `409 feed_reset` or a new `feedId` the backend's sync rebuilds its owner mirror and queues every capture (and its previews) for the API again (`resyncAllCaptures`; `PUT /api/v1/backend/captures/{sourceKey}` is idempotent). The control UI's **Push all captures to the API again** (page *Queue*) does the same by hand.
8. Verify: admin doctor, admin home, backend control UI (sync state), then a publish.

With a shell: stop writes, `cp` the snapshot over `var/app.sqlite` after removing `-wal`/`-shm`, then `sqlite3 var/app.sqlite "UPDATE meta SET value = lower(hex(randomblob(16))) WHERE key = 'feed_id'"` (and, with the access gate, `UPDATE access_state SET epoch = lower(hex(randomblob(8)))`).

**Access gate after a database restore (§11):** the `rotateFeedId` bootstrap step also gives the access state a new epoch. Until the "restored" reconcile has compared the database with the session-file store (next cron run, or at once when the owner opens People in the admin), joins, device approvals and resumes answer "not available right now", and the admin shows "Restore: checking access…". The reconcile keeps revoked people out and deleted people deleted (store tombstones survive the restore), removes the sessions of devices that joined after the backup (the database no longer knows their keys) and turns every unknown person id into a nameless tombstone, so an id is never handed out twice. While it has not run yet, "Your data" refuses too (`me/hello`, `me/notice`, `me/consent` answer "not available right now", `me/data`, `me/export`, `me/signout` and `me/delete` answer `503`): a device removed after the backup is "active" again in the restored rows. The reconcile also **resets every personal link and the panic link**: the store keeps no record of a link rotation, so a link you replaced after the backup (often because it leaked) would otherwise work again. Connected devices keep working with their device keys.

**After any restore:**
1. Open Admin → People and read the "after a restore" card. It lists the devices that have to join again and every person without a link: **create a new personal link** on the person's page and send it to whoever wants to add a device (people created after the backup need a new invitation).
2. If you had a panic link, **create it again** (Admin → Settings → Safety).
3. If you changed the admin password after the backup, the restored database has the old one again (and sessions you ended since are valid again): run `scripts/deploy-api.ts --reset-admin-password` (ends every session of that user) and change the password in the admin. Revoke again any API token you revoked after the backup.

**Webspace restore of the site host** (old store files back): the store marker's op counter is behind the database, so the next reconcile (≤ 5 min with `direct`) deletes every revived session and rewrites tombstones and the lock. A restore from before the store existed removes the marker: every writer stops (alert "access store unverified") until the owner runs "Website-Speicher einrichten" again; devices then resume with their device key.

**Downloaded backup copies** contain follower names, devices and consent records (privacy notice: "deleted after at most `BACKUP_KEEP` days"): delete downloaded copies older than `BACKUP_KEEP` (14) days, and keep them private.

---

## 9. Security notes

- **Secrets** stay in the repo's `.env` and `.secrets/` (both git-ignored; `.secrets/*` mode 600) and in the remote `/.env` (mode 600, never served). The deploy script parses `.env` literally (no shell `source`) and never prints passwords or tokens.
- **Tokens** (`omw_` + 43 base64url chars) are stored only as sha256; backend tokens have scope `backend`, app tokens scope `admin`; revoke them in the admin. Session tokens are stored the same way and slide for `SESSION_DAYS` (30).
- **Admin requests:** `__Host-` cookie (`Secure`, `HttpOnly`, `SameSite=Strict`) plus an `X-CSRF-Token` header derived from the session on every mutating request; JSON bodies only (`415` for forms). The http development cookie (`DEV_INSECURE_COOKIE`, see `api/README.md`) is refused unless `APP_ENV=development` and only works on PHP's built-in server for loopback clients, so it cannot be enabled on a web host. Logins: generic `401` for every failure, Argon2id, constant-time path for unknown e-mails, atomic rate limits (10 failures / 15 min per IP, 30 / hour per e-mail across IPs except from known devices, `429` + `Retry-After`; §7). Use an admin e-mail nobody can guess (§7).
- **Alert URLs** (`alerts.ntfy_url`) are admin input: `NTFY_TOKEN` only goes to `NTFY_SERVER`, and in production only public destinations are allowed (§5).
- **Headers:** no `X-Powered-By` (removed in `public/index.php`; also set `expose_php = Off` where possible), HSTS (1 year), `nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, CSP `default-src 'none'` for API responses and a same-origin CSP with `frame-ancestors 'none'` for the admin PWA. CORS is only enabled for `SITE_ORIGIN` on the followers' `/api/v1/public/*` routes (simple `text/plain` requests without cookies; credentials only in cookie mode `parent`, §11.7); they are rate-limited per IP, link, device key and globally, and every answer carries the CORS headers (429 and 503 included).
- **Private data:** previews are served only to the logged-in admin (`Cache-Control: private`). When a status is deleted on WhatsApp (and `ingest.on_revoke` is `hide`, the default) its private preview and poster are deleted from the API host too, and later uploads for it are discarded. Database, backups and logs live in `var/` (deny-all). Backups contain password and token hashes: keep downloaded copies private.
- **Uploads:** previews are limited to 512 KiB, MIME type sniffed server-side (WebP/JPEG only), stored under content-hashed names.
- **Web-cron key:** rotate it by editing `CRON_KEY` in the remote `.env` (and `.secrets/api-cron-key`, and the cron service).

## 10. Troubleshooting

- **Everything answers `503 maintenance`:** a deploy was interrupted or its upload failed (re-run it; it replaces and removes its own flag), or someone left a manual `/.maintenance` (delete it over SFTP; the deploy script refuses to run while a manual flag exists). Cron does not run while the flag exists.
- **Connections to the host time out after probing many private URLs:** the shared host may block a client IP for a while (observed 2026-11-20 right after ~25 rapid requests to `/.env`, `/var/…`, `/vendor/…` from one IP; HTTPS to every site on that server timed out afterwards, cause not confirmed by the host). Only the web ports are blocked (SFTP on port 22 kept working, 2026-11-20 04:00–05:00 CET, still blocked ≥ 3 h after it started). Wait it out; the deploy script spaces its private-path checks 5 s apart (about a minute for all of them) to avoid such bursts. If you must deploy meanwhile, use `--skip-http-checks` and run `--checks-only` once HTTPS answers again (the site publisher's own HTTP check reports `error` during the block; the files are deployed regardless).
- **`500` errors:** download `var/logs/app-*.log` (and `cron-*.log`) over SFTP. Temporarily `APP_DEBUG=true` in the remote `.env` adds details to 5xx responses (turn it off again).
- **`503` + `Retry-After` on the first request:** migrations are still running in another request; retry.
- **`database is locked` / WAL errors on a network filesystem:** set `DB_JOURNAL_MODE=DELETE` in the remote `.env` (the doctor tests WAL).
- **The backend gets `401`:** its token was revoked or mistyped; create a new one in the admin.

---

## 11. Access gate (wave 5: approval-only followers)

Only people the traveler invited see the site (owner decisions D1–D12, Q0 b). The site host stays
static: **Apache + `.htaccess`, no PHP**. The API does all the logic and writes one empty file
per signed-in device into a hidden **session-file store**; the generated `.htaccess` lets a
request through only when the device's cookie names such a file and the site is not locked.
Everyone else gets one neutral page ("Privat · Private") for pages and a fixed `403 Forbidden`
for data, media and dot paths, byte-identical for existing and missing paths (no existence
oracle, no link-preview content, no robots/sitemap). Build spec:
`.cache/design-w5/spec-wave5.md` (not committed); the follower and owner flows are in
[OPERATIONS.md](OPERATIONS.md#followers-and-access), what is stored where in [PRIVACY.md](PRIVACY.md).

### 11.1 Layout on the site host

```
/.htaccess          root gate rules + cookie handoff (generated; uploaded LAST in the gate tree)
/index.html, /_/n/  the neutral page            /_/403.txt     "Forbidden\n"
/_/join/ /_/info/ /_/wait/ /_/ended/ /_/me/ /_/panic/   static gate pages + /_/assets/gate-*.js
/robots.txt         Disallow: /                 /favicon.svg   a neutral dot
/.omw-gate.json     gate-tree deploy record     (dot path → 403)
/<secret>/          the timeline (OUT_DIR), with its own .htaccess carrying the SAME gate block
<account home>/omw-store/site1/    the store, OUTSIDE every docroot (never served)
```

`<secret>` (`[a-z0-9]{20}`, part of the backend's `SITE_PUBLIC_URL`) only keeps hostname scanners
away; the gate is the store check. Followers who open `/` are redirected to `/<secret>/`, so
bookmarks survive a later change of `<secret>`.

### 11.2 Requirements (all verified on the live host by the probe, §11.4)

- Apache 2.4 with `mod_rewrite` and `mod_headers`, `AllowOverride All`, and these directives
  allowed in `.htaccess`: `RewriteOptions InheritDownBefore`, `DirectorySlash Off`, the `END`
  flag, `<If>` blocks, `Header always add Set-Cookie "…%{ENV}e…"`.
- `RewriteCond <store>/s/… -f` must see files the API writes (same filesystem, Apache can traverse
  0711 directories and `stat` 0600 files).
- The site's SFTP login supports `posix-rename@openssh.com` (atomic replace): a gate deploy is
  refused without it, because a `.htaccess` must never be missing for a moment.
- HTTPS on both hosts; `%{HTTPS}` is `on` behind Hetzner's TLS (enables the http→https redirect).
- Outbound HTTPS from the API's PHP to the site (optional probe, §11.9).

### 11.3 The session-file store

| Path (relative to the store) | Meaning |
|---|---|
| `.omw-store.json` | marker `{format, storeId, epoch, op, at}`: identity + restore detection; the only file ever rewritten |
| `s/<fid>/<did>.<sid>` | a device's current session (empty file; **the file name is the secret**) |
| `h/<did>` | one handoff may still be completed (≤ 10 min) |
| `locked` | the site is locked for everyone |
| `t/<fid>`, `t/<fid>.<did>` | tombstones of ended or deleted people / removed devices (survive an API restore) |

Directories `0711`, files `0600`, created exclusively and never rewritten (except the marker).
The `direct` writer creates the store folder and, on a fresh account, its parent `omw-store/`
itself (the account home is not reachable over SFTP); a deeper missing path is refused.
**Initialise once** in the admin: *Einstellungen → Menschen & Zugang → "Website-Speicher
einrichten"*. It creates the store id and writes the marker only if none exists. Every writer
(API or Mac) refuses to write a folder whose marker is missing or has another store id (alert
"access store unverified"), so a wrong path fails closed instead of filling a second folder.
Whoever can list `s/` can mint cookies: that equals access to the hosting account, which exposes
the content anyway (accepted).

### 11.4 Host probe answers (P0b, 2026-11-20) and the resulting configuration

13/13 site tests passed; no fallback is needed.

| Question | Answer | Configuration |
|---|---|---|
| Can the API's PHP write a folder Apache reads (same owner, outside the docroot, no `open_basedir`)? | yes; a new file is visible at once, a deleted one gone at once | `ACCESS_STORE_MODE=direct`, `ACCESS_STORE_DIR=<account home>/omw-store/site1` (the same absolute string for the backend) |
| Modes 0711/0600 readable by Apache? | yes | defaults (`ACCESS_STORE_DIR_MODE=0711`, `ACCESS_STORE_FILE_MODE=0600`) |
| `__Host-` cookies from `mod_headers` at the handoff? | yes (also the `CO` flag) | `ACCESS_COOKIE_MODE=headers` |
| PHP → site over HTTPS? | yes | `ACCESS_GATE_PROBE=true` |
| `%{HTTPS}` = `on`? | yes | `ACCESS_HTTPS_REDIRECT=true` (backend) |
| Site SFTP `posix-rename`? | yes | gate deploys allowed |
| `fastcgi_finish_request`, `max_execution_time` | yes, 60 s | owner notices right after the response |
| SFTP logins | chrooted to their docroot | the API needs no SFTP credentials (`direct`); the site login cannot reach the store (see §11.6) |

Never put the absolute host paths into committed files; they live only in the remote `/.env`,
the local `--set-env-file` input and the backend's `.env`.

### 11.5 Configuration

**API** (remote `/.env`; merge with `scripts/deploy-api.ts --set-env-file=<file>`, the file kept
outside git, e.g. under `.secrets/`):

```dotenv
ACCESS_STORE_MODE=direct
ACCESS_STORE_DIR=<account home>/omw-store/site1
ACCESS_COOKIE_MODE=headers
ACCESS_GATE_PROBE=true
# ACCESS_MAX_DEVICES=5   (active devices per person; every further device waits for the owner anyway)
```

`SITE_ORIGIN` (already set on the first deploy) is the personal-link base and the only CORS
origin. Other writers: `sftp` (phpseclib; a **dedicated** SFTP account restricted to the store
folder, key auth, pinned host keys; the site's own login only with
`ACCESS_STORE_SFTP_ALLOW_SITE_LOGIN=true`, which lets a leaked API `.env` rewrite the gate) and
`none` (the Mac writes, §11.6). All keys: `api/.env.example`.

**Backend** (repository-root `.env`, read by Docker compose; `backend/README.md` has the table):

```dotenv
ACCESS_MODE=gate
SITE_PUBLIC_URL=https://<site host>/<secret>/
API_PUBLIC_URL=https://<api host>/
ACCESS_STORE_DIR=<account home>/omw-store/site1
ACCESS_COOKIE_MODE=headers
ACCESS_HTTPS_REDIRECT=true
```

**Publish target** (control UI → Publish → edit the SFTP target): *Web root* (`gateRoot`) `/`,
*Remote root* `/<secret>`, *Public base URL* `https://<site host>/<secret>/`. The gate bundle
must be in the image (`frontend/site/dist/gate`; the Dockerfile's `web` stage fails without it).

### 11.6 Writers and how fast a change takes effect

| Writer | Revoke / lock / unlock in effect | Notes |
|---|---|---|
| `direct` (live) | < 1 s after the admin's tap reaches the API | measured by the probe: a new file is visible and a deleted one gone at the first request |
| `sftp` | 1–3 s (phpseclib with `sodium` + `gmp`) | needs a restricted SFTP account |
| `none` → the Mac | ≤ 15–20 s while the backend runs, never while it is off | the admin shows "Noch nicht wirksam ⏳" until the Mac acknowledges |

A failing writer keeps the op pending: cron retries every 5 minutes, the Mac takes over after 60 s
(when it has a store target), alert "access store failing" after 10 minutes. The Mac fallback
writer and the control UI's **"Website sperren"** button need a publish target with
`accessStoreRoot` (the store as that SFTP login sees it). The live site login is chrooted to its
docroot and cannot reach a store outside it, so on the live host both are **unavailable until a
login that can reach `<account home>/omw-store/site1` is configured** (e.g. as a store-only
target); locking then goes through the admin or the panic link (both need the API).

Revocation is never retroactive: Apache refuses the device's **next** request (a navigation, a new
day file, the 5-minute manifest poll); what an open tab already shows stays until then.

### 11.7 Cookies (modes and trade-offs)

| Mode | Cookies | Cost |
|---|---|---|
| `headers` (live) | `__Host-omw` (session, HttpOnly, `SameSite=Lax`, 400 days rolling), `__Host-omw_k` (device key, `Strict`, JS-readable), short-lived `__Host-omw_s` (120 s transfer), `__Host-omw_h`, `__Host-omw_r`; set by Apache at the fixed handoff path `/_/h/`, no secret in any URL | none beyond the design: the device key is readable by the site's JS (it only proves the device to the API) |
| `co` (fallback F1) | `omw*` with `domain=<site host>` from Apache's `CO` flag | no `__Host-` protection: a sibling host under the same parent domain could shadow the cookies (denial of service) or plant Strict cookies |
| `parent` (fallback F2) | the API sets `omw`/`omw_k` for the shared parent domain | the session cookie goes to every host under that domain; requires site and API on one registrable domain; breaks when the site moves |

`Lax` on the session cookie is required (a tap in WhatsApp is a cross-site navigation); the
handoff needs the `Strict` key cookie, so a cross-site link to `/_/h/` can never sign anyone in.
Refusals of a stale cookie send `Clear-Site-Data: "cache", "storage"` (never `"cookies"`, never
during a lock). Local http development on a loopback host uses `omw*` without `Secure`.

### 11.8 Domains (Q9)

Nothing hardcodes a host: backend `SITE_PUBLIC_URL`, `API_PUBLIC_URL`, `ACCESS_COOKIE_*`; API
`SITE_ORIGIN`, `APP_URL`, `ACCESS_COOKIE_*`. With `headers` or `co`, site and API may live on
different registrable domains (the device key travels in the request body). Only `parent` needs
one shared registrable domain. **Any domain change loses every cookie** (they are host-bound):
tell followers before switching; each reopens their personal link; a person's first device
rejoins without approval only if she never had one, so approve the others in People afterwards.
The backend's heartbeat reports its site origin; a mismatch with `SITE_ORIGIN` raises
"site origin mismatch".

### 11.9 Checks and alerts

- **After every gate deploy** the publisher runs at most 5 anonymous requests, 2 s apart: a data
  URL and a missing data URL must be the identical `403`, a page the neutral page, and a fresh
  service session must open the manifest while the previous one is refused (proves that both
  writing and deleting reach the folder Apache reads). `gate_open` re-uploads both `.htaccess`
  files once and otherwise fails the deploy (alert "publish failing", critical); a blocked Mac IP
  gives `error`, never a false alarm; the admin says when no check has succeeded for 24 h.
- **API probe** (`ACCESS_GATE_PROBE=true`, cron): once per hour an anonymous data request must be
  `403`; every 6 h the store proof with a rotated service session (`direct`/`sftp` only). At most
  three requests per hour from the API host, none to a dot path.
- Alerts (no names in any message): `devices_pending`, `access_store_failing`,
  `access_store_unverified`, `access_store_mismatch`, `site_origin_mismatch`, `public_flood`,
  `site_gate_open`.

### 11.10 One-off migration of the live preview

The live site still serves the open preview at the web root. With the backend stopped:
`backend publish --migrate-to-gate <target>` generates in gate mode, uploads the gate tree
(`/.htaccess` last: from then on every old root path answers the neutral page), deploys the
content into `/<secret>/` with a fresh deploy record, runs the gate check and **lists** the legacy
root files (old `de/`, `en/`, `data/`, `media/`, `assets/`, `404.html`, …). Check the list, then run
it again with `--confirm` to delete them and the legacy record. It never touches `/.well-known/`
or the store.

### 11.11 Go-live order and acceptance checklist

Order (each step only after the previous one is green):

1. **API**: `pnpm --filter @omw/admin build`, then `scripts/deploy-api.ts --set-env-file=<access env>`
   (migrations `0002_settings_w5` and `0003_access` run on the first request; the change feed
   announces the new settings). Then `--checks-only` once HTTPS answers.
2. **Backend**: rebuild the image (in `backend/`: `docker compose build --builder omw-builder`; a
   cold build needs ~6–7 GB free in Docker's VM, check `docker system df` first), set the backend
   variables (§11.5) but keep the target's web/remote roots unchanged yet; start it; it mirrors
   the new settings. Until step 4 its deploys stop with `gate_config` (expected: nothing is
   uploaded, the old preview stays as it is).
3. **Admin**: publish the privacy notice version 1 (Einstellungen → Datenschutzhinweise: name and
   e-mail of the person responsible; joins are refused until then), then *Menschen & Zugang →
   Website-Speicher einrichten* ("Wirksam ✓").
4. **Gate migration** (§11.10): stop the backend, edit the target (web root `/`, remote root
   `/<secret>`, public URL), `--migrate-to-gate`, check, `--confirm`, start the backend.

Acceptance (by hand, from a network the host does not block, e.g. Brave's Tor window, **≥ 8 s
between requests**):

- (a) anonymous: a day URL gives the neutral page, a data URL `403 Forbidden`; their headers match
  the local Apache tests (`pnpm --filter @omw/backend test:apache`);
- (b) real phones join: iOS Safari, iOS tap from WhatsApp, Android Chrome from WhatsApp; note how
  many devices each path creates (in-app browsers have their own cookie jars);
- (c) revoke latency against §11.6 for the chosen writer;
- (d) lock / unlock;
- (e) delete-me end to end (tombstone and owner notice);
- (f) a restore drill on a copy (epoch rotation → "restoring" → reconcile);
- (g) the post-deploy gate check (#1–#5) and the API's store proof (`ACCESS_GATE_PROBE`) pass once
  (admin → Einstellungen → Sicherheit: "Zugang geprüft am …").
