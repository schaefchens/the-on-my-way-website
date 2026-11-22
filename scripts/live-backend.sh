#!/usr/bin/env bash
# Runs the LIVE backend on this Mac with Node (owner decision 2026-11-23: started by hand, not
# Docker, not launchd). It pulls the traveler app's moments from the live API into the home archive,
# publishes them on the gated site (APP_PUBLISH=true since 2026-11-23: only approved followers see
# them, following the publish settings), mirrors the owner's content and publishes the site.
# WhatsApp stays off (WA_MODE=off).
#
#   scripts/live-backend.sh            start (foreground; Ctrl-C stops it cleanly)
#   scripts/live-backend.sh <command>  any backend CLI command with the same configuration, e.g.
#                                      status | generate | publish [--force] | help
#
# Private values come from .secrets/live-backend.env (git-ignored, mode 600; KEY=value lines, read
# literally, never sourced):
#   SITE_PUBLIC_URL  https://<site host>/<content folder>/   (gate mode: the secret folder)
#   API_BASE_URL     https://<api host>
#   ACCESS_STORE_DIR the store path exactly as Apache sees it (docs/HOSTING.md §11.4)
#   CONTROL_TOKEN    >= 16 characters (control UI on 127.0.0.1:8787)
# and the backend API token from .secrets/api-backend-token.
# State lives in backend/data/ (archive, site output, publish targets incl. SFTP credentials in
# backend/data/config/targets.json): git-ignored and never touched by scripts/clean.sh.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.secrets/live-backend.env"
TOKEN_FILE="$ROOT/.secrets/api-backend-token"
[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE (see the header of this script)" >&2; exit 1; }
[[ -f "$TOKEN_FILE" ]] || { echo "missing $TOKEN_FILE" >&2; exit 1; }

# The old fixture preview (.cache/live-preview) publishes to the same target: never both at once.
if pgrep -f "$ROOT/.cache/live-preview" > /dev/null 2>&1; then
  echo "the fixture preview backend (.cache/live-preview) is running; stop it first" >&2
  exit 1
fi

value() { # KEY: its value from the env file, read literally
  awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' "$ENV_FILE"
}
for key in SITE_PUBLIC_URL API_BASE_URL ACCESS_STORE_DIR CONTROL_TOKEN; do
  [[ -n "$(value "$key")" ]] || { echo "$key is missing in $ENV_FILE" >&2; exit 1; }
done

cd "$ROOT"
mkdir -p "$ROOT/.cache/tmp" "$ROOT/.cache/home"
exec env -i PATH="$PATH" HOME="$ROOT/.cache/home" TMPDIR="$ROOT/.cache/tmp" TSX_DISABLE_CACHE=1 \
  NODE_ENV=production WA_MODE=off APP_PUBLISH=true LOG_LEVEL=info \
  DATA_DIR="$ROOT/backend/data/state" ARCHIVE_DIR="$ROOT/backend/data/archive" OUT_DIR="$ROOT/backend/data/out" \
  CONFIG_DIR="$ROOT/backend/data/config" MEDIA_DIR="$ROOT/backend/data/media" GATE_OUT_DIR="$ROOT/backend/data/out-gate" \
  ACCESS_MODE=gate ACCESS_COOKIE_MODE=headers ACCESS_HTTPS_REDIRECT=true \
  SITE_PUBLIC_URL="$(value SITE_PUBLIC_URL)" API_BASE_URL="$(value API_BASE_URL)" \
  API_PUBLIC_URL="$(value API_BASE_URL)/" API_TOKEN="$(tr -d '\n' < "$TOKEN_FILE")" \
  ACCESS_STORE_DIR="$(value ACCESS_STORE_DIR)" CONTROL_TOKEN="$(value CONTROL_TOKEN)" CONTROL_PORT=8787 \
  node --conditions=@omw/source --import tsx backend/src/cli.ts "${@:-start}"
