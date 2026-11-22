#!/usr/bin/env bash
# End-to-end proof of the traveler app v0.5 in ARCHIVE-ONLY mode (owner decision Q8 a), on our
# emulator, against the local stack only (never a live host, never WhatsApp):
#
#   app (release APK, API http://127.0.0.1:8080 on the phone)
#     -> adb reverse -> e2e-proxy (127.0.0.1:18090: throttle, delay, drops, offline; logs requests)
#     -> PHP API (php -S 127.0.0.1:18080, throwaway state)
#     <- backend (fixture mode, APP_PUBLISH=false, one local target) pulls, archives, acks
#
#   scripts/app/e2e.sh [--apk PATH] [--kill-wait SECONDS] [--keep-app]
#
#   --apk        the emulator release APK (default: the newest .cache/app-release/*-emulator.apk;
#                built with scripts/app/release.sh --apk --api-base-url http://127.0.0.1:8080)
#   --kill-wait  how long to wait for the system to restart a killed upload by itself before the
#                app is opened (default 120; the WorkManager backup is due after 15 minutes)
#   --keep-app   leave the e2e app installed (default: uninstalled at the end, so a debug build
#                with another signature installs cleanly)
#
# Steps (each check is logged PASS/FAIL; the exit status is the number of failed checks, capped):
#   1. stack: API with a fresh state, the proxy, the emulator (lock: with-emulator.sh), a fresh
#      install of the APK, adb reverse 8080 -> proxy
#   2. pair with a code the owner creates in the admin (POST /admin/app-pairings, like the
#      "Connect a phone" screen)
#   3. mobile data only, "Wi-Fi only" (the default): capture a photo, a text status, a voice note
#      and a trimmed, muted video -> nothing is sent; the queue says "Waiting for Wi-Fi"
#   4. Wi-Fi on a bad link: 64 kbit/s, 300 ms delay, a drop every 1 MB (proxy) plus the emulator's
#      own gsm speed / gprs delay -> uploads progress through drops, the chunk size falls to
#      256 KiB (watched for up to OMW_E2E_SLOW_SECONDS, 420); the link stays that slow for 5-7
#   5. kill -9 the app mid-upload -> it resumes from the server's offset, not from 0
#   6. airplane mode on (proxy offline too) -> nothing is sent; off -> resumes from the offset
#   7. Wi-Fi off mid-upload (mobile data) -> waits; Wi-Fi on -> resumes
#   8. full speed -> every entry and original is "uploaded"; the app says so
#   9. manual mode: a new moment waits as "Ready to upload" until "Upload now"
#  9b. Undo after the API has it: a text status goes up, "Undo" 3 s later brings back the draft
#      and the uploader withdraws it on the API (DELETE, durable); she fixes the typo and shares
#      again: the edited status goes out under a new id (no entry_conflict) and is archived, the
#      typo never is
#  10. the backend (archive-only) pulls everything: sha256 of every archived file = the phone's
#      file = the declared hash; originals of the photo and the video are there; the trimmed
#      video is shorter than its original and silent; nothing reaches the site; the API's inbox
#      is empty; the app shows "All safe"
#  11. request budget over the whole run: never more than 10 requests in any 10 s window
#
# Output: .cache/app-e2e/<run id>/ (e2e.log, summary.md, proxy.jsonl, screenshots, logs).
# Note: adb reverse traffic does not pass the emulator's radio, so the emulator's network speed and
# delay do not shape it; the proxy is the bad link. Airplane mode and Wi-Fi/mobile data are the
# emulator's own (the uploader decides from Android's network state).
set -euo pipefail
# The whole script is one compound command, so bash reads it completely before it runs: editing
# this file during a run (~30 min) can not change the run.
{

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "$HERE/env.sh"

# Hold the shared emulator lock for the whole run (boots the emulator when needed).
if [[ -z "${OMW_EMULATOR_LOCK_HELD:-}" ]]; then
  exec "$HERE/with-emulator.sh" -- "$0" "$@"
fi
: "${ANDROID_SERIAL:?}"

APK=""
KILL_WAIT=120
KEEP_APP=0
SLOW_SECONDS="${OMW_E2E_SLOW_SECONDS:-420}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apk) APK="$2"; shift 2 ;;
    --kill-wait) KILL_WAIT="$2"; shift 2 ;;
    --keep-app) KEEP_APP=1; shift ;;
    -h|--help) sed -n '2,43p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 64 ;;
  esac
done

PKG=app.omw.traveler
API_PORT=18080
PROXY_PORT=18090
CONTROL_PORT=18091
BACKEND_CONTROL_PORT=18787
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RUN="$OMW_ROOT/.cache/app-e2e/$RUN_ID"
SHOTS="$RUN/shots"
LOG="$RUN/e2e.log"
PROXY_LOG="$RUN/proxy.jsonl"
DB="$RUN/api/var/app.sqlite"
MAESTRO="$MAESTRO_HOME/bin/maestro"
FLOWS="$OMW_ROOT/frontend/app/.maestro/e2e"
mkdir -p "$RUN"/{api,shots,logs,maestro,backend/{state,archive,out,config,media,site,home,tmp}}
: >"$LOG"

PIDS=()
PASSED=0
FAILED=0

say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }
check() { # check <name> <ok:0|1> <detail>
  if [[ "$2" == 0 ]]; then
    PASSED=$((PASSED + 1)); say "PASS  $1 — $3"
  else
    FAILED=$((FAILED + 1)); say "FAIL  $1 — $3"
  fi
}
die() { say "ABORT $*"; exit 70; }
need() { command -v "$1" >/dev/null || die "$1 is needed"; }

cleanup() {
  set +e
  say "cleanup"
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
  sleep 1
  for p in "${PIDS[@]}"; do kill -9 "$p" 2>/dev/null; done
  # php -S runs workers next to its master: free the ports by listener.
  for port in $API_PORT $PROXY_PORT $CONTROL_PORT $BACKEND_CONTROL_PORT; do
    lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null
  done
  adb shell cmd connectivity airplane-mode disable >/dev/null 2>&1
  adb shell svc wifi enable >/dev/null 2>&1
  adb shell svc data enable >/dev/null 2>&1
  adb emu network speed full >/dev/null 2>&1
  adb emu network delay none >/dev/null 2>&1
  adb reverse --remove "tcp:8080" >/dev/null 2>&1
  [[ "$KEEP_APP" == 1 ]] || adb uninstall "$PKG" >/dev/null 2>&1
  adb unroot >/dev/null 2>&1
  adb wait-for-device >/dev/null 2>&1
}
trap cleanup EXIT

# ---- helpers ----------------------------------------------------------------------------------

# Read-write handle on purpose (SELECTs only): php -S closes the WAL database after each request,
# which removes its -shm file, and a read-only handle can't open a WAL database without it.
sql() { sqlite3 -noheader -cmd '.timeout 5000' "$DB" "$1"; }
proxy() { curl -fsS -X POST "http://127.0.0.1:$CONTROL_PORT/config" -H 'content-type: application/json' -d "$1" >/dev/null; }
proxy_seq() { curl -fsS "http://127.0.0.1:$CONTROL_PORT/stats" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["seq"])'; }
# mark: logs a marker row in the proxy log and prints its seq (the "since" of uploads_since).
mark() { proxy '{}'; proxy_seq; }
# upload requests (create, PATCH/HEAD, commit, delete) STARTED after the marker <seq>; a request
# that started before (e.g. on Wi-Fi) and ended later does not count.
uploads_since() {
  python3 -I - "$PROXY_LOG" "$1" <<'PY'
import json, sys
path, since = sys.argv[1], int(sys.argv[2])
rows = [json.loads(line) for line in open(path)]
t0 = next((r["t"] for r in rows if r["seq"] == since), None)
if t0 is None:
    t0 = max((r["t"] for r in rows if r["seq"] <= since), default=0)
n = 0
for r in rows:
    if r["method"] == "CONFIG" or r["t"] - r.get("ms", 0) < t0:
        continue
    p = r["path"]
    if p.startswith("/api/v1/app/uploads/") or (p.startswith("/api/v1/app/entries") and r["method"] in ("POST", "DELETE")):
        n += 1
print(n)
PY
}
# the first PATCH for upload <id> STARTED after the marker <seq>: "<method> <Upload-Offset or ->"
first_upload_request() {
  python3 -I - "$PROXY_LOG" "$1" "$2" <<'PY'
import json, sys
path, since, uid = sys.argv[1], int(sys.argv[2]), sys.argv[3]
rows = [json.loads(line) for line in open(path)]
t0 = next((r["t"] for r in rows if r["seq"] == since), None)
if t0 is None:
    t0 = max((r["t"] for r in rows if r["seq"] <= since), default=0)
starts = [(r["t"] - r.get("ms", 0), r) for r in rows if r["method"] == "PATCH" and r["path"] == f"/api/v1/app/uploads/{uid}"]
for start, r in sorted(starts, key=lambda x: x[0]):
    if start >= t0:
        print(r["method"], r.get("uploadOffset", "-"))
        break
PY
}
maestro_flow() { # maestro_flow <flow.yaml> [-e K=V …]
  local flow="$1"; shift
  (cd "$SHOTS" && "$MAESTRO" test --no-ansi --debug-output "$RUN/maestro" --flatten-debug-output --test-output-dir "$RUN/maestro" "$@" "$FLOWS/$flow") \
    >>"$RUN/logs/maestro.log" 2>&1
}
default_net() { # wifi | cellular | none (validated default network)
  local agents
  agents="$(adb shell dumpsys connectivity 2>/dev/null | grep -E 'NetworkAgentInfo\{' || true)"
  if grep -E 'WIFI.*IS_VALIDATED' <<<"$agents" >/dev/null; then echo wifi
  elif grep -E '(MOBILE|CELLULAR).*IS_VALIDATED' <<<"$agents" >/dev/null; then echo cellular
  else echo none; fi
}
wait_net() { # wait_net <wifi|cellular|none> [timeout]
  local want="$1" deadline=$((SECONDS + ${2:-90}))
  while [[ "$(default_net)" != "$want" ]]; do
    ((SECONDS < deadline)) || return 1
    sleep 2
  done
}
app_pid() { adb shell pidof "$PKG" 2>/dev/null | tr -d '\r' || true; }
open_upload() { # the upload in flight: the last one PATCHed that is still open with 0 < offset < bytes
  local last row
  last="$(python3 -I - "$PROXY_LOG" <<'PY'
import json, sys
uid = ""
for line in open(sys.argv[1]):
    r = json.loads(line)
    if r["method"] == "PATCH" and r.get("status") == 204 and r["path"].startswith("/api/v1/app/uploads/"):
        uid = r["path"].rsplit("/", 1)[1]
print(uid)
PY
)"
  if [[ -n "$last" ]]; then
    row="$(sql "SELECT upload_id, upload_offset, bytes FROM app_uploads WHERE upload_id='$last' AND state='open' AND upload_offset > 0 AND upload_offset < bytes;" | tr '|' ' ')"
    [[ -n "$row" ]] && { echo "$row"; return 0; }
  fi
  sql "SELECT upload_id, upload_offset, bytes FROM app_uploads WHERE state='open' AND upload_offset > 0 AND upload_offset < bytes ORDER BY bytes - upload_offset DESC LIMIT 1;" | tr '|' ' '
}
wait_open_upload() { # waits until open_upload has an answer (max <timeout> s)
  local deadline=$((SECONDS + ${1:-300})) row
  while :; do
    row="$(open_upload)"
    [[ -n "$row" ]] && { echo "$row"; return 0; }
    ((SECONDS < deadline)) || return 1
    sleep 3
  done
}
server_offset() { sql "SELECT upload_offset FROM app_uploads WHERE upload_id='$1';"; }

# ---- 0. preflight -----------------------------------------------------------------------------

for t in php sqlite3 node curl python3 ffprobe; do need "$t"; done
[[ -x "$MAESTRO" ]] || die "Maestro missing: scripts/app/install-maestro.sh"
[[ -f "$OMW_ROOT/api/vendor/autoload.php" ]] || die "api/vendor missing: scripts/composer install"
[[ -f "$OMW_ROOT/fixtures/generated/index.json" ]] || die "fixtures/generated missing: pnpm fixtures"
if [[ -z "$APK" ]]; then
  APK="$(ls -t "$OMW_ROOT"/.cache/app-release/*-emulator.apk 2>/dev/null | head -1 || true)"
fi
[[ -f "$APK" ]] || die "no emulator APK: scripts/app/release.sh --apk --api-base-url http://127.0.0.1:8080"
free_gb="$(df -g / | awk 'NR==2 {print $4}')"
((free_gb >= 5)) || die "only ${free_gb} GB free (needs 5)"
for port in $API_PORT $PROXY_PORT $CONTROL_PORT $BACKEND_CONTROL_PORT; do
  ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || die "port $port is busy"
done
say "run $RUN_ID: APK ${APK#"$OMW_ROOT"/}, emulator $ANDROID_SERIAL, ${free_gb} GB free"

# ---- 1. stack ---------------------------------------------------------------------------------

"$HERE/dev-api.sh" --port "$API_PORT" --state "$RUN/api" --reset >"$RUN/logs/api.log" 2>&1 &
PIDS+=($!)
node "$HERE/e2e-proxy.mjs" --listen "$PROXY_PORT" --upstream "$API_PORT" --control "$CONTROL_PORT" --log "$PROXY_LOG" \
  >"$RUN/logs/proxy.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$API_PORT/api/v1/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$API_PORT/api/v1/health" >/dev/null || die "the API did not start (logs/api.log)"
curl -fsS "http://127.0.0.1:$PROXY_PORT/api/v1/health" >/dev/null || die "the proxy does not forward (logs/proxy.log)"
: >"$PROXY_LOG"

adb root >/dev/null 2>&1 || true # userdebug image: lets the run kill the app like the system does
sleep 2
adb wait-for-device
for _ in $(seq 1 30); do [[ "$(adb shell id -u 2>/dev/null | tr -d '\r')" == 0 ]] && break; sleep 1; done
adb shell cmd connectivity airplane-mode disable >/dev/null 2>&1 || true
adb emu network speed full >/dev/null 2>&1 || true
adb emu network delay none >/dev/null 2>&1 || true
# shellcheck source=../../frontend/app/modules/omw-native/android/harness/emulator-net.sh
source "$OMW_ROOT/frontend/app/modules/omw-native/android/harness/emulator-net.sh"
omw_require_wifi 90 || die "no validated Wi-Fi on the emulator"
adb uninstall "$PKG" >/dev/null 2>&1 || true
adb install "$APK" >/dev/null || die "install failed"
adb reverse "tcp:8080" "tcp:$PROXY_PORT" >/dev/null
check "install" 0 "fresh install of $(basename "$APK"), adb reverse 8080 -> proxy -> API"

# ---- 2. pair with the admin's code ------------------------------------------------------------

JAR="$RUN/api/cookies.txt"
csrf="$(curl -fsS -c "$JAR" -H 'content-type: application/json' \
  --data-binary @- "http://127.0.0.1:$API_PORT/api/v1/admin/session" <<EOF | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["csrfToken"])'
{"email":"owner@example.org","password":"$(tr -d '\n' <"$RUN/api/admin-password")"}
EOF
)"
code="$(curl -fsS -b "$JAR" -H 'content-type: application/json' -H "X-CSRF-Token: $csrf" -d '{"ttlMinutes":60}' \
  "http://127.0.0.1:$API_PORT/api/v1/admin/app-pairings" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["typedCode"])')"
[[ "$code" =~ ^[0-9A-Z]{4}-[0-9A-Z]{4}$ ]] || die "no pairing code from the admin"
maestro_flow pair.yaml -e "CODE=$code" && ok=0 || ok=1
phones="$(sql "SELECT COUNT(*) FROM app_phones WHERE revoked_at IS NULL;")"
[[ "$phones" == 1 ]] || ok=1
check "pair" "$ok" "admin code typed in the app; app_phones: $phones (scope capture)"

# ---- 3. mobile data only + Wi-Fi only: capture, nothing is sent ------------------------------

adb shell svc wifi disable >/dev/null
wait_net cellular 90 || die "the emulator found no validated mobile data"
s3="$(mark)"
maestro_flow capture-all.yaml && ok=0 || ok=1
check "capture" "$ok" "photo (virtual camera), text status, voice note, trimmed + muted video shared on mobile data"
sleep 30
sent="$(uploads_since "$s3")"
entries="$(sql "SELECT COUNT(*) FROM app_entries;")"
[[ "$sent" == 0 && "$entries" == 0 ]] && ok=0 || ok=1
check "wifi-only holds mobile data" "$ok" "$sent upload requests, $entries entries on the API after 30+ s on mobile data"
maestro_flow queue.yaml -e "EXPECT=Waiting for Wi-Fi" -e WAIT_MS=20000 -e SHOT=e2e-03-waiting-for-wifi && ok=0 || ok=1
check "queue: waiting for Wi-Fi" "$ok" "the queue sheet says \"Waiting for Wi-Fi\""
# The phone's own files (hashes taken on the phone before anything is sent).
adb shell "cd /data/user/0/$PKG/files/outbox 2>/dev/null && find . -type f ! -name '*.json' -exec sha256sum {} +" \
  | tr -d '\r' >"$RUN/phone-sha256.txt" || true
phone_files="$(wc -l <"$RUN/phone-sha256.txt" | tr -d ' ')"
say "      the phone's outbox holds $phone_files files (hashes in phone-sha256.txt)"

# ---- 4. a bad Wi-Fi link ----------------------------------------------------------------------

proxy '{"kbps":64,"delayMs":300,"dropEveryBytes":1000000}'
adb emu network speed gsm >/dev/null 2>&1 || true
adb emu network delay gprs >/dev/null 2>&1 || true
s4="$(proxy_seq)"
adb shell svc wifi enable >/dev/null
wait_net wifi 120 || die "Wi-Fi did not come back"
slow_stats() { # "<patches> <ok> <dropped> <full chunks: first> <latest> <min>" since s4
  python3 -I - "$PROXY_LOG" "$s4" "$DB" <<'PY'
import json, sqlite3, sys
rows = [json.loads(l) for l in open(sys.argv[1])]
rows = [r for r in rows if r["seq"] > int(sys.argv[2]) and r["method"] == "PATCH"]
db = sqlite3.connect(sys.argv[3], timeout=5)
size = dict(db.execute("SELECT upload_id, bytes FROM app_uploads"))
ok = [r for r in rows if r.get("status") == 204]
# A full chunk is one that is not the tail of its file: it shows the chunk size the phone chose.
full = [r.get("contentLength") or 0 for r in rows
        if (r.get("uploadOffset") or 0) + (r.get("contentLength") or 0) < size.get(r["path"].rsplit("/", 1)[1], 0)]
drops = sum(1 for r in rows if r.get("status") == "dropped")
print(len(rows), len(ok), drops, full[0] if full else 0, full[-1] if full else 0, min(full) if full else 0)
PY
}
deadline=$((SECONDS + SLOW_SECONDS))
while ((SECONDS < deadline)); do
  read -r patches okp drops firstc lastc minc <<<"$(slow_stats)"
  [[ "$drops" -ge 1 && "$okp" -ge 3 && "$lastc" -gt 0 && "$lastc" -le 262144 ]] && break
  sleep 5
done
progress="$(sql "SELECT COALESCE(SUM(upload_offset),0) FROM app_uploads;")"
[[ "$okp" -gt 0 && "$progress" -gt 0 && "$drops" -ge 1 ]] && ok=0 || ok=1
check "slow link: progress" "$ok" "64 kbit/s + 300 ms + a drop every 1 MB: $patches PATCHes ($okp ok, $drops cut by a drop), $progress bytes on the server after $((SECONDS - deadline + SLOW_SECONDS)) s"
[[ "$lastc" -gt 0 && "$lastc" -le 262144 ]] && ok=0 || ok=1
check "slow link: chunks shrink" "$ok" "chunk size of non-tail PATCHes $firstc first, $lastc latest, $minc smallest (the contract starts at 1 MiB; floor 256 KiB; aim <= 15 s per PATCH)"
# The link stays this slow for steps 5-7: they mostly pause it, and an offset needs one chunk.

# ---- 5. kill mid-upload -----------------------------------------------------------------------

row="$(wait_open_upload 300)" || die "no upload in flight to kill"
read -r uid off bytes <<<"$row"
pid="$(app_pid)"
s5="$(mark)"
off="$(server_offset "$uid")"
adb shell kill -9 "$pid" >/dev/null 2>&1 || adb shell am crash "$PKG" >/dev/null 2>&1 || true
sleep 2
[[ "$(app_pid)" != "$pid" ]] && ok=0 || ok=1
check "kill" "$ok" "kill -9 of the app (pid $pid) while $uid was at $off of $bytes bytes"
how="by itself, without opening the app"
deadline=$((SECONDS + KILL_WAIT))
first=""
while ((SECONDS < deadline)); do
  first="$(first_upload_request "$s5" "$uid")"
  [[ -n "$first" ]] && break
  sleep 3
done
if [[ -z "$first" ]]; then
  how="after the app was opened (no restart by the system within ${KILL_WAIT} s)"
  adb shell am start -n "$PKG/.MainActivity" >/dev/null
  deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do
    first="$(first_upload_request "$s5" "$uid")"
    [[ -n "$first" ]] && break
    sleep 3
  done
fi
resumed_at="$(awk '{print $2}' <<<"$first")"
[[ -n "$first" && "$resumed_at" =~ ^[0-9]+$ && "$resumed_at" -gt 0 && "$resumed_at" -ge "$off" ]] && ok=0 || ok=1
check "resume after kill" "$ok" "resumed $how; first PATCH for $uid at Upload-Offset ${resumed_at:-none} (server had $off before the kill, not 0)"

# ---- 6. airplane mode -------------------------------------------------------------------------

row="$(wait_open_upload 240)" || row=""
adb shell cmd connectivity airplane-mode enable >/dev/null
proxy '{"offline":true}'
sleep 8
s6="$(mark)"
sleep 40
sent="$(uploads_since "$s6")"
[[ "$sent" == 0 ]] && ok=0 || ok=1
check "airplane mode" "$ok" "$sent upload requests reached the link in 40 s of airplane mode"
s6b="$(mark)"
read -r uid off bytes <<<"${row:-x 0 0}"
off_before="$(server_offset "$uid" 2>/dev/null || echo 0)"
proxy '{"offline":false}'
adb shell cmd connectivity airplane-mode disable >/dev/null
wait_net wifi 120 || die "Wi-Fi did not come back after airplane mode"
deadline=$((SECONDS + 180)); first=""
while ((SECONDS < deadline)) && [[ -n "${row:-}" ]]; do
  first="$(first_upload_request "$s6b" "$uid")"
  [[ -n "$first" ]] && break
  sleep 3
done
resumed_at="$(awk '{print $2}' <<<"$first")"
[[ -n "$first" && "$resumed_at" -gt 0 && "$resumed_at" -ge "${off_before:-0}" ]] && ok=0 || ok=1
check "resume after airplane mode" "$ok" "first PATCH for ${uid:-?} at Upload-Offset ${resumed_at:-none} (server had ${off_before:-?})"

# ---- 7. Wi-Fi off mid-upload: mobile data waits -----------------------------------------------

row="$(wait_open_upload 240)" || row=""
if [[ -n "$row" ]]; then
  read -r uid off bytes <<<"$row"
  s7w="$(mark)"
  adb shell svc wifi disable >/dev/null
  wait_net cellular 90 || true
  sleep 8
  s7="$(mark)"
  sleep 40
  sent="$(uploads_since "$s7")"
  [[ "$sent" == 0 ]] && ok=0 || ok=1
  # The PATCH in flight when Wi-Fi went away (adb reverse keeps its socket alive; the app has to stop it).
  cut="$(python3 -I - "$PROXY_LOG" "$s7w" <<'PY'
import json, sys
rows = [json.loads(line) for line in open(sys.argv[1])]
t0 = next((r["t"] for r in rows if r["seq"] == int(sys.argv[2])), 0)
for r in rows:
    if r["method"] == "PATCH" and r["t"] - r.get("ms", 0) < t0 <= r["t"]:
        print(f"the PATCH in flight ended {(r['t'] - t0) / 1000:.0f} s after Wi-Fi went off ({r.get('status')})")
        break
else:
    print("no PATCH was in flight")
PY
)"
  check "wifi-only mid-upload" "$ok" "no request started in 40 s on mobile data with Wi-Fi only on ($sent); $cut"
  s7b="$(mark)"; off_before="$(server_offset "$uid")"
  adb shell svc wifi enable >/dev/null
  wait_net wifi 120 || die "Wi-Fi did not come back"
  deadline=$((SECONDS + 180)); first=""
  while ((SECONDS < deadline)); do
    first="$(first_upload_request "$s7b" "$uid")"
    [[ -n "$first" ]] && break
    sleep 3
  done
  resumed_at="$(awk '{print $2}' <<<"$first")"
  [[ -n "$first" && "$resumed_at" -gt 0 && "$resumed_at" -ge "$off_before" ]] && ok=0 || ok=1
  check "resume on Wi-Fi" "$ok" "first PATCH for $uid at Upload-Offset ${resumed_at:-none} (server had $off_before)"
else
  check "wifi-only mid-upload" 1 "nothing was in flight any more (the link was too fast)"
fi

# ---- 8. full speed: everything uploaded --------------------------------------------------------

proxy '{"kbps":0,"delayMs":0,"dropEveryBytes":0}'
adb emu network speed full >/dev/null 2>&1 || true
adb emu network delay none >/dev/null 2>&1 || true
deadline=$((SECONDS + 600))
while ((SECONDS < deadline)); do
  open="$(sql "SELECT COUNT(*) FROM app_uploads WHERE state='open';")"
  done_entries="$(sql "SELECT COUNT(*) FROM app_entries WHERE state='uploaded';")"
  [[ "$open" == 0 && "$done_entries" == 4 ]] && break
  sleep 5
done
originals="$(sql "SELECT COUNT(*) FROM app_uploads WHERE role='original' AND state='committed';")"
[[ "$done_entries" == 4 && "$open" == 0 ]] && ok=0 || ok=1
check "all uploaded" "$ok" "$done_entries of 4 entries uploaded, $open upload slots still open, $originals originals committed"
sleep 65 # the app asks the server at most once a minute
maestro_flow queue.yaml -e "EXPECT=Uploaded" -e WAIT_MS=60000 -e SHOT=e2e-05-uploaded-waiting-for-home && ok=0 || ok=1
check "queue: uploaded" "$ok" "the queue says \"Uploaded\" while the home computer is off"

# ---- 9. manual mode + Upload now ---------------------------------------------------------------

s9="$(mark)"
maestro_flow manual.yaml && ok=0 || ok=1
check "manual: waits" "$ok" "\"Upload automatically\" off: the new text status says \"Ready to upload\""
sleep 30
sent="$(uploads_since "$s9")"
[[ "$sent" == 0 ]] && ok=0 || ok=1
check "manual: nothing sent" "$ok" "$sent upload requests in 30+ s while it waits for the tap"
maestro_flow upload-now.yaml && ok=0 || ok=1
deadline=$((SECONDS + 120))
while ((SECONDS < deadline)); do
  [[ "$(sql "SELECT COUNT(*) FROM app_entries WHERE state='uploaded';")" == 5 ]] && break
  sleep 3
done
n="$(sql "SELECT COUNT(*) FROM app_entries WHERE state='uploaded';")"
[[ "$n" == 5 ]] || ok=1
check "manual: Upload now" "$ok" "after \"Upload now\": $n of 5 entries uploaded; automatic mode is on again"

# ---- 9b. Undo after the upload, edit, share again ---------------------------------------------

TYPO="Arived in Hoi An"
FIXED="Arrived in Hoi An"
s9b="$(mark)"
maestro_flow undo-reshare.yaml -e "TYPO=$TYPO" -e "FIXED=$FIXED" && flow_ok=0 || flow_ok=1
body_sql() { sql "SELECT $1 FROM app_entries WHERE kind='text' AND json_extract(entry_json, '\$.text.body') = '$2';"; }
# The shared-again status: the text status received after the typo (its exact text depends on
# where the tap put the cursor in the editor; the check is about its id and its way home).
again_sql() { sql "SELECT $1 FROM app_entries WHERE kind='text' AND received_at > (SELECT received_at FROM app_entries WHERE entry_id = '${typo_id:-none}') ORDER BY received_at LIMIT 1;"; }
deadline=$((SECONDS + 120))
while ((SECONDS < deadline)); do
  typo_id="$(body_sql entry_id "$TYPO")"
  [[ "$(body_sql state "$TYPO")" == withdrawn && "$(again_sql state)" == uploaded ]] && break
  sleep 2
done
typo_id="$(body_sql entry_id "$TYPO")"
typo_state="$(body_sql state "$TYPO")"
fixed_id="$(again_sql entry_id)"
fixed_state="$(again_sql state)"
fixed_body="$(again_sql "json_extract(entry_json, '\$.text.body')")"
read -r deletes conflicts < <(python3 -I - "$PROXY_LOG" "$s9b" "${typo_id:-none}" <<'PY'
import json, sys
path, since, typo = sys.argv[1], int(sys.argv[2]), sys.argv[3]
rows = [json.loads(line) for line in open(path)]
after = [r for r in rows if r["seq"] > since and r["method"] != "CONFIG"]
deletes = sum(1 for r in after if r["method"] == "DELETE" and r["path"] == f"/api/v1/app/entries/{typo}" and r.get("status") == 204)
conflicts = sum(1 for r in after if r.get("status") == 409 and r["path"] == "/api/v1/app/entries")
print(deletes, conflicts)
PY
)
[[ "$flow_ok" == 0 && "$typo_state" == withdrawn && "$deletes" -ge 1 ]] && ok=0 || ok=1
check "undo after upload" "$ok" "the typo reached the API (${typo_id:-never}) and Undo brought back the draft; the uploader withdrew it: ${deletes:-0} DELETE answered 204, state ${typo_state:-none}"
[[ "$flow_ok" == 0 && "$fixed_state" == uploaded && -n "$fixed_id" && "$fixed_id" != "$typo_id" && "$fixed_body" == *"$FIXED"* && "$conflicts" == 0 ]] && ok=0 || ok=1
check "share again: new id" "$ok" "the edited status (\"${fixed_body:-?}\") went out as ${fixed_id:-nothing} (${fixed_state:-none}), not as ${typo_id:-?}; entry_conflict answers: ${conflicts:-?}"

# ---- 10. the home backend archives (archive-only) ---------------------------------------------

cat >"$RUN/backend/config/targets.json" <<JSON
{ "format": 1, "targets": [ { "id": "local-e2e", "kind": "local", "enabled": true,
  "publicBaseUrl": "http://127.0.0.1:4173/", "dir": "$RUN/backend/site",
  "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" } ] }
JSON
chmod 600 "$RUN/backend/config/targets.json"
(
  cd "$OMW_ROOT"
  exec env -i PATH="$PATH" HOME="$RUN/backend/home" TMPDIR="$RUN/backend/tmp" TSX_DISABLE_CACHE=1 \
    WA_MODE=fixture DATA_DIR="$RUN/backend/state" ARCHIVE_DIR="$RUN/backend/archive" OUT_DIR="$RUN/backend/out" \
    CONFIG_DIR="$RUN/backend/config" MEDIA_DIR="$RUN/backend/media" SITE_PUBLIC_URL=http://127.0.0.1:4173/ \
    CONTROL_TOKEN="e2e-control-token-$RUN_ID" CONTROL_PORT="$BACKEND_CONTROL_PORT" \
    API_BASE_URL="http://127.0.0.1:$API_PORT" API_TOKEN="$(cat "$RUN/api/backend-token")" \
    APP_PUBLISH=false APP_INBOX_POLL_SECONDS=10 \
    node --conditions=@omw/source --import tsx backend/src/cli.ts start
) >"$RUN/logs/backend.log" 2>&1 &
PIDS+=($!)
backend_start=$SECONDS
archived_after=""
deadline=$((SECONDS + 420))
while ((SECONDS < deadline)); do
  archived="$(sql "SELECT COUNT(*) FROM app_entries WHERE state='archived';")"
  [[ "$archived" == 6 && -z "$archived_after" ]] && archived_after=$((SECONDS - backend_start))
  # payload files only (.slots/ holds the transfer-slot lock files)
  # (find may fail on a file the backend's ack deletes meanwhile: never fatal under pipefail)
  left="$( (find "$RUN/api/var/app-inbox" -type f ! -path '*/.slots/*' 2>/dev/null || true) | wc -l | tr -d ' ')"
  [[ "$archived" == 6 && "$left" == 0 ]] && grep -q 'deployed' "$RUN/logs/backend.log" && break
  sleep 3
done
used="$(curl -fsS -b "$JAR" "http://127.0.0.1:$API_PORT/api/v1/admin/app-phones" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["inbox"]["usedBytes"])' 2>/dev/null || echo '?')"
typo_archived="$( (grep -rls -- "${typo_id:-none}" "$RUN/backend/archive" 2>/dev/null || true) | wc -l | tr -d ' ')"
check "archived" "$([[ "$archived" == 6 && "$typo_archived" == 0 ]] && echo 0 || echo 1)" "$archived of 6 entries archived by the home backend, ${archived_after:-?} s after it started; the undone typo in the archive: $typo_archived files"
check "inbox freed" "$([[ "$left" == 0 && "$used" == 0 ]] && echo 0 || echo 1)" "$left payload files left in the API's app inbox, usedBytes $used (admin); upload slots: $(sql "SELECT group_concat(state || ':' || n, ' ') FROM (SELECT state, COUNT(*) n FROM app_uploads GROUP BY state);")"
sleep 5 # let the generator finish its run after the last capture

python3 -I - "$RUN" <<'PY' >"$RUN/archive-check.txt"
import glob, hashlib, json, os, subprocess, sys
run = sys.argv[1]
phone = {}
for line in open(os.path.join(run, "phone-sha256.txt")):
    parts = line.split()
    if len(parts) == 2:
        phone[parts[0]] = parts[1]
records = sorted(glob.glob(os.path.join(run, "backend/archive/app/**/app-*.json"), recursive=True))
problems, lines = [], []
kinds = {}
for rec_path in records:
    rec = json.load(open(rec_path))
    entry = rec["entry"]
    kinds[entry["kind"]] = kinds.get(entry["kind"], 0) + 1
    declared = {f["role"]: f["sha256Hex"] for f in entry.get("files", [])}
    d = os.path.dirname(rec_path)
    for role, f in rec["files"].items():
        h = hashlib.sha256(open(os.path.join(d, f["file"]), "rb").read()).hexdigest()
        on_phone = h in phone
        ok = h == f["sha256Hex"] == declared.get(role)
        if not ok:
            problems.append(f"{f['file']}: sha256 differs (archive {h[:12]}, record {f['sha256Hex'][:12]}, declared {str(declared.get(role))[:12]})")
        if role in ("media", "original") and not on_phone:
            problems.append(f"{f['file']}: not one of the phone's outbox files")
        lines.append(f"{entry['kind']:5} {role:8} {f['bytes']:>9} B  sha256 {h[:16]}…  declared=archive={'yes' if ok else 'NO'}  phone={'yes' if on_phone else 'n/a' if role == 'preview' else 'NO'}")
    if entry["kind"] in ("photo", "video") and "original" not in rec["files"]:
        problems.append(f"{entry['kind']} {entry['entryId']}: no original archived (Q2 c)")
    if entry["kind"] == "video":
        def probe(p, *args):
            return subprocess.run(["ffprobe", "-v", "error", *args, p], capture_output=True, text=True).stdout.strip()
        media = os.path.join(d, rec["files"]["media"]["file"])
        orig = os.path.join(d, rec["files"]["original"]["file"]) if "original" in rec["files"] else None
        dm = float(probe(media, "-show_entries", "format=duration", "-of", "csv=p=0") or 0)
        do = float(probe(orig, "-show_entries", "format=duration", "-of", "csv=p=0") or 0) if orig else 0
        audio = probe(media, "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0")
        size = probe(media, "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0")
        lines.append(f"video: media {dm:.2f} s ({size}), original {do:.2f} s, audio streams in media: {audio or 'none'}")
        if not (0 < dm < do):
            problems.append(f"video not trimmed: media {dm:.2f} s, original {do:.2f} s")
        if audio:
            problems.append("video media still has an audio track (muted on the phone)")
print(json.dumps({"records": len(records), "kinds": kinds, "problems": problems}))
for l in lines:
    print(l)
PY
summary="$(head -1 "$RUN/archive-check.txt")"
probs="$(python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); print(len(d["problems"]))' "$summary")"
check "archive: sha256 + originals" "$([[ "$probs" == 0 ]] && echo 0 || echo 1)" "$(python3 -I -c 'import json,sys; d=json.loads(sys.argv[1]); print(d["records"], "records", d["kinds"], "; problems:", d["problems"] or "none")' "$summary")"
tail -n +2 "$RUN/archive-check.txt" | sed 's/^/      /' | tee -a "$LOG" >&2

ids="$(sql "SELECT entry_id FROM app_entries;" | tr '\n' ' ')"
pubs="$(python3 -I -c 'import glob,json,sys; print(" ".join(json.load(open(p))["publicId"] for p in glob.glob(sys.argv[1]+"/backend/archive/app/**/app-*.json", recursive=True)))' "$RUN")"
leaks=0
for needle in $ids $pubs; do
  if grep -rqs -- "$needle" "$RUN/backend/site" "$RUN/backend/out"; then leaks=$((leaks + 1)); say "      leak: $needle"; fi
done
site_files="$(find "$RUN/backend/site" -type f | wc -l | tr -d ' ')"
fixture_pages="$(find "$RUN/backend/site" -name '*.html' | wc -l | tr -d ' ')"
app_caps="$(sqlite3 -cmd '.timeout 5000' "$RUN/backend/state/store.db" "SELECT COUNT(*) FROM captures WHERE source='app';" 2>/dev/null || echo '?')"
[[ "$leaks" == 0 && "$fixture_pages" -gt 0 ]] && ok=0 || ok=1
check "nothing published" "$ok" "0 of $(wc -w <<<"$ids$pubs" | tr -d ' ') app ids/publicIds in the published site ($site_files files, $fixture_pages pages from the WhatsApp fixtures); leaks: $leaks; app captures in the home store: $app_caps"

sleep 65
maestro_flow archived.yaml && ok=0 || ok=1
check "app: all safe" "$ok" "the queue is empty, \"Safe at home today\", the pill says \"All safe\""

# ---- 11. request budget -----------------------------------------------------------------------

python3 -I - "$PROXY_LOG" <<'PY' >"$RUN/budget.txt"
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1])]
reqs = sorted((r["t"] - r.get("ms", 0)) for r in rows if r["method"] != "CONFIG")
worst, j = 0, 0
for i, t in enumerate(reqs):
    while reqs[j] < t - 10000:
        j += 1
    worst = max(worst, i - j + 1)
by = {}
for r in rows:
    if r["method"] == "CONFIG":
        continue
    p = r["path"]
    key = r["method"] + " " + ("/api/v1/app/uploads/*" if p.startswith("/api/v1/app/uploads/") else "/api/v1/app/entries/*/commit" if p.endswith("/commit") else p)
    by[key] = by.get(key, 0) + 1
print(len(reqs), worst)
for k, v in sorted(by.items(), key=lambda kv: -kv[1]):
    print(f"{v:5}  {k}")
PY
read -r total worst <"$RUN/budget.txt"
check "request budget" "$([[ "$worst" -le 10 ]] && echo 0 || echo 1)" "$total requests in the run; at most $worst in any 10 s window (limit 10)"
tail -n +2 "$RUN/budget.txt" | sed 's/^/      /' | tee -a "$LOG" >&2

# ---- summary ----------------------------------------------------------------------------------

find "$RUN/maestro" -name 'e2e-*.png' -exec cp {} "$SHOTS/" \; 2>/dev/null || true

{
  echo "# Traveler app e2e run $RUN_ID"
  echo
  echo "APK: \`$(basename "$APK")\` · emulator $ANDROID_SERIAL (API $(adb shell getprop ro.build.version.sdk | tr -d '\r'))"
  echo
  echo "**$PASSED passed, $FAILED failed**"
  echo
  echo '```'
  cat "$LOG"
  echo '```'
} >"$RUN/summary.md"
say "result: $PASSED passed, $FAILED failed — $RUN/summary.md"
exit $((FAILED > 60 ? 60 : FAILED))
}
