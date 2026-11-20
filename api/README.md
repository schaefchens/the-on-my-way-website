# API (`omw/api`)

PHP 8.3+ · Slim 4 · SQLite. Owner content, the capture mirror, the admin PWA at `/admin/`,
the backend's change feed and heartbeat, alerts. Hosting, deploy, cron and restore are in
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
