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
