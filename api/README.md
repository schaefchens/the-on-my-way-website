# API (`omw/api`)

PHP 8.3+ · Slim 4 · SQLite. Owner content, the capture mirror, the admin PWA at `/admin/`,
the backend's change feed and heartbeat, alerts, and (wave 5) the access gate's logic: invited
people, personal links, devices and approvals, the privacy notice and consent records, "Your
data" / delete me, lock and panic link, and the site store the site host's `.htaccess` checks. Hosting, deploy, cron and restore are in
[docs/HOSTING.md](../docs/HOSTING.md); routes and auth in [src/Http/Routes.php](src/Http/Routes.php);
data shapes in `packages/contracts` (exported to `schemas/`).

## Checks

`scripts/composer` runs a project-local Composer, `.cache/bin/composer.phar` (all Composer caches
stay in `.cache/`). On a fresh clone that file does not exist yet: the first `../scripts/composer …`
prints the install steps and exits 1. They download the official installer, compare its SHA-384
with <https://composer.github.io/installer.sig> and install `composer.phar` into `.cache/bin/`.
Run them once (copy them from that message; they contain your absolute paths), then:

```sh
cd api
../scripts/composer install      # once (caches stay in .cache/)
../scripts/composer test         # PHPUnit
../scripts/composer stan         # PHPStan
```

## Local development (http, PHP's built-in server)

The admin session cookie is `__Host-omw_session`, which is `Secure`: browsers store it only
for https pages (Chromium and Firefox also for `http://localhost`, Safari never). For plain http
on this machine there is a development fallback, `omw_dev_session` (HttpOnly, SameSite=Strict,
not Secure). It is used only when **all** of these hold, so it cannot be switched on in
production:

1. `DEV_INSECURE_COOKIE=true`, which the config accepts **only** with `APP_ENV=development`
   (any other `APP_ENV` refuses to start);
2. the request is served by PHP's built-in web server (`php -S`, SAPI `cli-server`); Apache,
   nginx and PHP-FPM never use it;
3. the request came over http, from a loopback address (127.0.0.0/8, ::1).

CSRF protection is unchanged. Implementation and tests: `src/Http/SessionCookie.php`,
`tests/Http/DevSessionCookieTest.php`.

```sh
pnpm --filter @omw/admin build                 # the admin PWA -> api/public/admin

cd api
export APP_ENV=development DEV_INSECURE_COOKIE=true   # plus VAR_DIR=… for a separate database
php bin/migrate.php
php bin/create-admin.php --email=owner@example.org --name=Owner      # prompts for the password (or --password-stdin)
mkdir -p ../.secrets && (umask 077; php bin/create-token.php --kind=backend --name=local > ../.secrets/local-api-backend-token)
php -S 127.0.0.1:8080 -t public public/index.php                     # PHP_CLI_SERVER_WORKERS=4 for parallel requests
open http://127.0.0.1:8080/admin/
```

The token is printed once, on stdout only, so it lands in the file (mode 600 thanks to the
`umask`, like the other files in `.secrets/`); stderr just says which token was created.

Change the admin's login e-mail (sessions and app tokens stay valid; on the shared host, without a
shell, use `scripts/deploy-api.ts --set-admin-email=…`, see [docs/HOSTING.md](../docs/HOSTING.md)):

```sh
php bin/set-admin-email.php --to=new@example.org        # --from=old@example.org when there is more than one user
```

Real environment variables win over `api/.env` (git-ignored; see `.env.example`). With the admin
dev server (`pnpm --filter @omw/admin dev`, http://127.0.0.1:5174/admin/) requests are proxied to
`127.0.0.1:8080`, so the same fallback applies.

Connect a local backend: `API_BASE_URL=http://127.0.0.1:8080 API_TOKEN=$(cat .secrets/local-api-backend-token)`
(see [backend/README.md](../backend/README.md)).

## Traveler app (app inbox)

The On My Way app (`frontend/app`) talks only to this API, with a phone token of scope `capture`
(app-plan §3.4–3.6, owner decisions Q2 c, Q4 a, Q8 a). Wire format: `packages/contracts/src/app.ts`
(phone) and `app-inbox.ts` (admin, backend); code: `src/Domain/App/`, `src/Http/App/` (routes in
`AppRoutes.php`, registered with one line in `Routes.php`); tables: `migrations/0050_app_inbox.sql`
(only new `app_*` tables; numbered 0050 so it sorts after the wave-5 files and applies in either order)
and `0051_app_phone_install.sql` (`app_phones.install_hash`).

| Route | Who | What |
|---|---|---|
| `POST /api/v1/app/pair` | anyone (rate-limited per IP) | redeem a one-time code, get the phone token (shown once) |
| `POST/GET/DELETE /api/v1/app/entries…`, `POST …/{id}/commit` | phone | create (idempotent per entry ULID + hash), state, withdraw, commit |
| `HEAD/PATCH/DELETE /api/v1/app/uploads/{id}` | phone | tus 1.0 subset: chunks with `Upload-Checksum: sha256`, resumable; `POST` + `X-HTTP-Method-Override` works too |
| `PUT /api/v1/app/visibility/{sourceKey}`, `GET /api/v1/app/hints` | phone | "Hold back"/"Only for me" on its own entries only; inbox facts |
| `GET /api/v1/backend/app/entries`, `GET …/uploads/{id}/content` (Range), `POST …/ack`, `POST …/reject` | backend | the home computer pulls, verifies, archives and acks; the API then deletes its copy |
| `POST /admin/app-pairings`, `GET /admin/app-phones`, `DELETE /admin/app-phones/{id}`, `GET /admin/app-entries/{key}` | admin | "Connect a phone" (code valid 1 h, at most 24 h, single use), Disconnect, the App badge |

- Phone tokens live in `app_phones`, never in `api_tokens`: they cannot reach the admin or backend
  routes. They can create, upload, withdraw and tighten the visibility of their own entries, nothing
  else. Pairing alerts the owner through the alert channels ("A phone was connected").
- The app sends a random install id with the pairing (`installId`, only its sha256 is stored). When
  the same install pairs again (a Disconnect after a false alarm, a token that expired after 180
  days), the new token takes over the install's earlier entries and the earlier connections are
  closed, so the moments that were on their way continue (same slots, same offsets). Another
  install, or a build without `installId`, still sees only its own entries.
- An entry id keeps its first content for good, also once withdrawn (`409 entry_conflict`): the app
  sends a moment that goes out again with other content (Undo, edit, Share) or after a permanent
  refusal under a new id, and withdraws the old one.
- Bytes wait in `var/app-inbox/<entryId>/` (denied by `var/.htaccess`) until the backend acks them.
  `APP_INBOX_MAX_BYTES` (default 1 GiB, at most ~10 % of the account quota) caps them: media and
  previews are reserved at create, originals count as they arrive; above it uploads get 507. One
  file may use at most half of it (413 at create, so the phone keeps that original).
- `APP_TRANSFER_SLOTS` (default 1) chunk uploads and backend downloads run at once (`flock`); more
  get 503 + `Retry-After`. JSON requests never take a slot. `APP_CHUNK_MAX_BYTES` (default 8 MiB,
  never above `post_max_size`) is the largest chunk announced to the phone.
- Housekeeping runs with the backend's polls and creates (at most every 15 min): entries still
  receiving whose uploads saw no request for 72 h are given up (rows, slots and bytes removed), so
  what a reset, lost or newly connected phone left behind never keeps its reservation (a phone that
  comes back gets 404 and sends the same create again); other partial uploads (originals) untouched
  for 72 h start again from 0; finished entry directories are removed.
- `AppHints.archiveOnly` is what the backend reports with every poll (`APP_PUBLISH` there); true
  until it reported.

Local development with the app on the emulator or a USB phone (no live host involved):
`scripts/app/dev-api.sh --pair` starts this API on `127.0.0.1:8080` with its own state in
`.cache/app-dev-api/` (`--state DIR` for a second one, `--reset` to start empty) and prints a pairing link; `scripts/app/with-emulator.sh -- adb reverse
tcp:8080 tcp:8080` makes it reachable from the device. More codes: `php bin/app-pairing.php`
(`--list`, `--disconnect=ID`).

## End-to-end test of the whole stack

`frontend/admin/e2e/stack/` starts everything itself (fresh database, admin, backend token,
`php -S` on 8080, the backend in fixture mode on 8787 syncing with it, the published site on
4173), drives the built admin in Chromium and checks the generated site:

```sh
pnpm --filter @omw/admin build && pnpm --filter @omw/site build
PLAYWRIGHT_BROWSERS_PATH=$PWD/.cache/ms-playwright pnpm --filter @omw/admin e2e:stack
```

The same command also runs the access-gate flow (`access-flow.stack.ts`, wave-5 spec §8.7) on a
second stack in gate mode: API on 8081 (`ACCESS_STORE_MODE=direct`, then a second run with `none`
where the backend writes the store), backend control UI on 8788, and a local **Apache** (macOS
`/usr/sbin/httpd`, 127.0.0.1 only) serving the generated gate and content trees on 4174 with
their `.htaccess` files and the store in `.cache/e2e-stack-gate*/store`. It is skipped when no
Apache binary with `mod_rewrite` and `mod_headers` is found. Ports are configurable
(`OMW_STACK_{API,CONTROL,SITE}_PORT`, `OMW_GATE_{API,CONTROL,SITE}_PORT`), e.g. when another
project already uses 8080/8081.

## Access gate (wave 5)

The site host runs no PHP: Apache lets a request through when the device's cookie names an
existing session file in the **site store**. This API owns everything else and keeps that store
in sync (wave-5 spec §3; operations in [docs/HOSTING.md](../docs/HOSTING.md) and
[docs/OPERATIONS.md](../docs/OPERATIONS.md)):

- Public routes for the site's static gate pages: `POST /api/v1/public/{join/check, join,
  device/poll, me/hello, me/notice, me/consent, me/data, me/export, me/signout, me/delete, panic}`.
  Bodies are `text/plain` JSON (CORS simple requests for `SITE_ORIGIN`, no cookies); the device
  proves itself with its personal link secret or its device key in the body. Rate limits in
  `src/Infra/RateLimiter.php`; who may read or delete a person's data only in
  `FollowerData::rightsOf()`.
- Admin routes: people (`/admin/followers…`), devices (`/admin/devices/{did}/…`), the site's access
  (`/admin/access…`: lock, retry, "Website-Speicher einrichten", panic link), the privacy notice
  (`/admin/privacy…`), owner notices, and `PUT /admin/me/password`.
- Backend routes for the Mac as fallback store writer: `/backend/access/{claim, renew, listing,
  ack, service-session}`.
- Store writes go through an outbox (`store_ops`) and `Domain\Access\StoreApplier` (non-blocking
  lock, one short transaction per op, never a transaction across file or SFTP I/O). The writer is
  `ACCESS_STORE_MODE` (`.env.example`): `direct`, `sftp` (phpseclib, host-key pinned, an auth
  failure blocks until the owner presses "Retry") or `none` (the Mac). Cron's `access` job applies,
  reconciles and expires; after a database restore the reconcile re-imports the store's
  tombstones before anyone may join again.

Change the admin password in the admin (Settings) or recover it with
`scripts/deploy-api.ts --reset-admin-password`; new passwords need at least 12 characters.
