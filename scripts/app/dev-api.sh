#!/usr/bin/env bash
# Runs the PHP API locally for the traveler app (php -S on 127.0.0.1), with its own throwaway
# state, so the app on the emulator (or a USB phone) talks to it through `adb reverse` and no
# traffic ever reaches the live hosts.
#
#   scripts/app/dev-api.sh [--port 8080] [--state DIR] [--pair] [--reverse] [--reset]
#
#   --pair      also print a fresh pairing link + typed code ("Connect a phone"; single use, 1 h)
#   --reverse   run `adb reverse tcp:PORT tcp:PORT` on our emulator first, under the shared
#               emulator lock (scripts/app/with-emulator.sh; boots the emulator if it is not up)
#   --reset     start from an empty database and inbox
#   --state     keep the state in DIR instead (e.g. a second API for a test next to the one the
#               emulator uses; OMW_APP_DEV_STATE works too)
#
# State: <checkout>/.cache/app-dev-api/ (git-ignored): var/ (database, var/app-inbox, logs),
# admin-password and backend-token (mode 600, created once; never printed). The owner account is
# owner@example.org. A local backend connects with
#   API_BASE_URL=http://127.0.0.1:PORT API_TOKEN="$(cat .cache/app-dev-api/backend-token)"
# The app's debug build already points at http://127.0.0.1:8080 (frontend/app app.config.ts);
# `adb reverse` maps the device's 127.0.0.1:8080 to this server.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
API="$ROOT/api"
STATE="${OMW_APP_DEV_STATE:-$ROOT/.cache/app-dev-api}"
PORT="${OMW_API_PORT:-8080}"
PAIR=0
REVERSE=0
RESET=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --state) STATE="$2"; shift 2 ;;
    --pair) PAIR=1; shift ;;
    --reverse) REVERSE=1; shift ;;
    --reset) RESET=1; shift ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || { echo "--port must be a number" >&2; exit 2; }
command -v php >/dev/null || { echo "php (8.3+) is needed" >&2; exit 1; }
[[ -f "$API/vendor/autoload.php" ]] || { echo "api/vendor missing: run scripts/composer install first" >&2; exit 1; }

if [[ $RESET -eq 1 ]]; then
  rm -rf "$STATE/var" "$STATE/admin-password" "$STATE/backend-token"
fi
mkdir -p "$STATE/var"
chmod 700 "$STATE"

# Only this process's environment: nothing from the repo's .env, no live host anywhere. api/.env (if
# a checkout has one) only fills variables that are unset, so the ones that could point somewhere
# real are set to empty values here instead of being unset.
export APP_ENV=development DEV_INSECURE_COOKIE=true APP_DEBUG=true LOG_LEVEL=debug
export VAR_DIR="$STATE/var" DB_PATH="$STATE/var/app.sqlite" LOG_PATH="$STATE/var/logs/app.log"
export MAIL_DSN='' APP_URL="http://127.0.0.1:$PORT"
export SITE_ORIGIN='' NTFY_TOKEN='' CRON_KEY='' BASE_PATH=''

cd "$API"
php bin/migrate.php >&2

if ! php -r '$db = new PDO("sqlite:" . getenv("DB_PATH")); exit($db->query("SELECT COUNT(*) FROM users")->fetchColumn() > 0 ? 0 : 1);'; then
  (umask 077; php -r 'echo rtrim(strtr(base64_encode(random_bytes(18)), "+/", "-_"), "="), "\n";' > "$STATE/admin-password")
  tr -d '\n' < "$STATE/admin-password" | php bin/create-admin.php --email=owner@example.org --name=Owner --password-stdin >&2
fi
if [[ ! -s "$STATE/backend-token" ]]; then
  (umask 077; php bin/create-token.php --kind=backend --name=local-backend > "$STATE/backend-token")
fi

if [[ $PAIR -eq 1 ]]; then
  php bin/app-pairing.php --ttl-minutes=60
fi

if [[ $REVERSE -eq 1 ]]; then
  "$HERE/with-emulator.sh" -- adb reverse "tcp:$PORT" "tcp:$PORT" >&2
fi

cat >&2 <<EOF

API for the traveler app: http://127.0.0.1:$PORT  (admin: http://127.0.0.1:$PORT/admin/, owner@example.org,
password in $STATE/admin-password)
Emulator/phone: scripts/app/with-emulator.sh -- adb reverse tcp:$PORT tcp:$PORT   (or start with --reverse)
New pairing code: (cd api && VAR_DIR=$STATE/var DB_PATH=$STATE/var/app.sqlite php bin/app-pairing.php)
Local backend:    API_BASE_URL=http://127.0.0.1:$PORT API_TOKEN="\$(cat $STATE/backend-token)"

EOF

# Several workers, so a slow chunk upload never blocks the JSON routes (the transfer slot is 1).
export PHP_CLI_SERVER_WORKERS="${PHP_CLI_SERVER_WORKERS:-4}"
exec php -d post_max_size=9M -d upload_max_filesize=9M -S "127.0.0.1:$PORT" -t public public/index.php
