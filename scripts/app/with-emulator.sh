#!/usr/bin/env bash
# Runs a command against the app's Android emulator, holding the shared emulator lock.
#
#   scripts/app/with-emulator.sh [--stop-after] [--] <command> [args…]
#   scripts/app/with-emulator.sh --status     # lock holder, emulator state, disk
#   scripts/app/with-emulator.sh --stop       # stop our emulator (takes the lock first)
#   scripts/app/with-emulator.sh --create     # only create the AVD (no boot)
#
# What it does:
# 1. Takes the lock .cache/android-emulator.lock (mkdir is atomic; the holder's pid inside; a
#    stale lock of a dead pid is removed). Waits up to OMW_EMULATOR_LOCK_TIMEOUT seconds (1800).
#    Nested calls from inside the command reuse the caller's lock (OMW_EMULATOR_LOCK_HELD).
# 2. Creates our AVD "omw-app" under $ANDROID_AVD_HOME (worktree .cache/android-avd) if needed:
#    android-36, arm64, AOSP image by default (OMW_AVD_TAG=google_apis_playstore for Play), data
#    partition 2 GB, 2 GB RAM. No avdmanager needed. ~/.android/avd is never touched.
# 3. Boots it headless with quickboot snapshots (-no-window, port 5580 => serial emulator-5580),
#    unless it already runs, and waits for sys.boot_completed (OMW_EMULATOR_BOOT_TIMEOUT, 600 s).
#    Refuses to start while another emulator runs (one emulator at a time on this Mac).
# 4. Runs the command with ANDROID_SERIAL=emulator-5580, then releases the lock. The emulator
#    keeps running for later callers; --stop-after (or OMW_EMULATOR_STOP=1) stops it after saving
#    the quickboot snapshot "default_boot" (~2.4 GB; installed apps survive either way). The
#    snapshot is skipped (and an old one deleted) below 10 GB free or with OMW_EMULATOR_NO_SNAPSHOT=1.
#    Exit status = the command's.
#
# OMW_EMULATOR_REDUCED_MOTION=1 switches the system animations off (= reduced motion for the app).
#
# Never touches other AVDs or the shared SDK (no installs, no updates).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "$HERE/env.sh"

AVD_NAME="${OMW_AVD_NAME:-omw-app}"
PORT="${OMW_EMULATOR_PORT:-5580}"
SERIAL="emulator-$PORT"
TAG="${OMW_AVD_TAG:-default}"
API="${OMW_AVD_API:-36}"
LOCK="$OMW_ROOT/.cache/android-emulator.lock"
LOG_DIR="$OMW_ROOT/.cache/logs"
EMULATOR="$ANDROID_HOME/emulator/emulator"
ADB="$ANDROID_HOME/platform-tools/adb"

log() { printf '[with-emulator] %s\n' "$*" >&2; }

# ---- lock -------------------------------------------------------------------------------------

LOCK_OWNED=0

release_lock() {
  if [[ "$LOCK_OWNED" == 1 ]]; then
    rm -rf "$LOCK"
    LOCK_OWNED=0
  fi
}

acquire_lock() {
  if [[ -n "${OMW_EMULATOR_LOCK_HELD:-}" && "$(cat "$LOCK/pid" 2>/dev/null || true)" == "$OMW_EMULATOR_LOCK_HELD" ]]; then
    return 0 # a caller up the process tree holds it
  fi
  mkdir -p "$(dirname "$LOCK")"
  local deadline=$((SECONDS + ${OMW_EMULATOR_LOCK_TIMEOUT:-1800})) said=0 pid
  while ! mkdir "$LOCK" 2>/dev/null; do
    pid="$(cat "$LOCK/pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      log "removing a stale lock of pid $pid ($(cat "$LOCK/owner" 2>/dev/null || echo '?'))"
      rm -rf "$LOCK"
      continue
    fi
    if ((SECONDS >= deadline)); then
      log "timed out waiting for the lock: $(cat "$LOCK/owner" 2>/dev/null || echo "pid ${pid:-?}")"
      exit 75
    fi
    if [[ "$said" == 0 ]]; then
      log "waiting for the emulator lock: $(cat "$LOCK/owner" 2>/dev/null || echo "pid ${pid:-?}")"
      said=1
    fi
    sleep 3
  done
  LOCK_OWNED=1
  trap release_lock EXIT
  trap 'release_lock; exit 130' INT TERM
  echo "$$" >"$LOCK/pid"
  printf '%s pid=%s cwd=%s cmd=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "$PWD" "${*:-}" >"$LOCK/owner"
  export OMW_EMULATOR_LOCK_HELD="$$"
}

# ---- AVD --------------------------------------------------------------------------------------

create_avd() {
  local avd_dir="$ANDROID_AVD_HOME/$AVD_NAME.avd"
  local sysdir="system-images/android-$API/$TAG/arm64-v8a/"
  if [[ -f "$avd_dir/config.ini" ]]; then return 0; fi
  if [[ ! -f "$ANDROID_HOME/$sysdir/system.img" ]]; then
    log "system image $sysdir is missing in the shared SDK (not installing it automatically)"
    exit 2
  fi
  log "creating AVD $AVD_NAME ($sysdir) in $ANDROID_AVD_HOME"
  mkdir -p "$avd_dir"
  cat >"$ANDROID_AVD_HOME/$AVD_NAME.ini" <<EOF
avd.ini.encoding=UTF-8
path=$avd_dir
path.rel=$AVD_NAME.avd
target=android-$API
EOF
  local display="Default Android System Image" playstore=false
  if [[ "$TAG" == google_apis_playstore ]]; then display="Google Play"; playstore=true; fi
  cat >"$avd_dir/config.ini" <<EOF
AvdId=$AVD_NAME
avd.ini.displayname=On My Way app (API $API)
avd.ini.encoding=UTF-8
PlayStore.enabled=$playstore
abi.type=arm64-v8a
hw.cpu.arch=arm64
hw.cpu.ncore=4
image.sysdir.1=$sysdir
tag.id=$TAG
tag.display=$display
target=android-$API
disk.dataPartition.size=2G
hw.ramSize=2048
vm.heapSize=256
hw.lcd.width=1080
hw.lcd.height=2400
hw.lcd.density=420
hw.keyboard=yes
hw.mainKeys=no
hw.camera.back=emulated
hw.camera.front=emulated
hw.gpu.enabled=yes
hw.gpu.mode=swiftshader_indirect
hw.audioInput=yes
hw.audioOutput=no
showDeviceFrame=no
fastboot.forceColdBoot=no
fastboot.forceFastBoot=yes
EOF
}

# ---- emulator ---------------------------------------------------------------------------------

our_emulator_running() {
  "$ADB" devices 2>/dev/null | awk -v s="$SERIAL" '$1==s && $2!="offline" {found=1} END {exit !found}'
}

other_emulators() {
  "$ADB" devices 2>/dev/null | awk -v s="$SERIAL" 'NR>1 && $1 ~ /^emulator-/ && $1!=s {print $1}'
}

boot_emulator() {
  "$ADB" start-server >/dev/null 2>&1 || true
  if our_emulator_running; then
    wait_for_boot
    return 0
  fi
  local others
  others="$(other_emulators)"
  if [[ -n "$others" && "${OMW_ALLOW_OTHER_EMULATOR:-0}" != 1 ]]; then
    log "another emulator is running ($others): only one emulator at a time. Stop it first."
    exit 3
  fi
  local free_gb
  free_gb="$(df -g / | awk 'NR==2 {print $4}')"
  if ((free_gb < 5)); then
    log "only ${free_gb} GB free on /: not booting (needs at least 5 GB)"
    exit 4
  fi
  create_avd
  mkdir -p "$LOG_DIR"
  log "booting $AVD_NAME headless on port $PORT (log: .cache/logs/emulator.log)"
  nohup "$EMULATOR" -avd "$AVD_NAME" -port "$PORT" -no-window -no-audio -no-boot-anim \
    -gpu swiftshader_indirect -camera-back emulated -camera-front emulated \
    -netdelay none -netspeed full -no-metrics \
    >"$LOG_DIR/emulator.log" 2>&1 </dev/null &
  echo $! >"$OMW_ROOT/.cache/android-emulator.pid"
  wait_for_boot
}

wait_for_boot() {
  local deadline=$((SECONDS + ${OMW_EMULATOR_BOOT_TIMEOUT:-600}))
  until [[ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; do
    if ((SECONDS >= deadline)); then
      log "the emulator did not boot in time (see .cache/logs/emulator.log)"
      exit 5
    fi
    sleep 2
  done
  # System animations: on by default, so tests see the app's real motion. OMW_EMULATOR_REDUCED_MOTION=1
  # switches them off, which Android (and Reanimated's ReduceMotion.System) treat as reduced motion.
  local scale=1
  [[ "${OMW_EMULATOR_REDUCED_MOTION:-0}" == 1 ]] && scale=0
  for key in window_animation_scale transition_animation_scale animator_duration_scale; do
    "$ADB" -s "$SERIAL" shell settings put global "$key" "$scale" >/dev/null 2>&1 || true
  done
  "$ADB" -s "$SERIAL" shell input keyevent 82 >/dev/null 2>&1 || true # unlock
}

stop_emulator() {
  if our_emulator_running; then
    # Save the quickboot snapshot explicitly: the emulator's own "save on exit" may be switched
    # off in the shared emulator settings, which we don't touch. The next boot loads it (~5 s
    # instead of a ~35 s cold boot). A snapshot holds the whole RAM (~2.4 GB), so it is only
    # kept while at least OMW_EMULATOR_SNAPSHOT_MIN_GB (10) stay free; otherwise it is removed
    # after the exit, so the next cold boot starts from the current disk state.
    local free_gb keep=0
    free_gb="$(df -g / | awk 'NR==2 {print $4}')"
    if [[ "${OMW_EMULATOR_NO_SNAPSHOT:-0}" != 1 ]] && ((free_gb >= ${OMW_EMULATOR_SNAPSHOT_MIN_GB:-10})); then
      keep=1
      log "saving the quickboot snapshot of $SERIAL"
      "$ADB" -s "$SERIAL" emu avd snapshot save default_boot >/dev/null 2>&1 || log "snapshot save failed (next boot is a cold boot)"
    fi
    log "stopping $SERIAL"
    "$ADB" -s "$SERIAL" emu kill >/dev/null 2>&1 || true
    local deadline=$((SECONDS + 60))
    while our_emulator_running && ((SECONDS < deadline)); do sleep 1; done
    local pid
    pid="$(cat "$OMW_ROOT/.cache/android-emulator.pid" 2>/dev/null || true)"
    while [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && ((SECONDS < deadline)); do sleep 1; done
    if [[ "$keep" == 0 ]]; then
      log "not keeping a snapshot (${free_gb} GB free): the next boot is a cold boot"
      rm -rf "$ANDROID_AVD_HOME/$AVD_NAME.avd/snapshots/default_boot"
    fi
  fi
  rm -f "$OMW_ROOT/.cache/android-emulator.pid"
}

status() {
  echo "lock:     $(cat "$LOCK/owner" 2>/dev/null || echo free)"
  if our_emulator_running; then echo "emulator: $SERIAL running"; else echo "emulator: $SERIAL not running"; fi
  local others
  others="$(other_emulators | tr '\n' ' ')"
  [[ -n "$others" ]] && echo "others:   $others"
  echo "avd:      $ANDROID_AVD_HOME/$AVD_NAME.avd ($(du -sh "$ANDROID_AVD_HOME" 2>/dev/null | cut -f1 || echo none))"
  df -h / | awk 'NR==2 {print "disk:     " $4 " free on /"}'
}

# ---- main -------------------------------------------------------------------------------------

STOP_AFTER="${OMW_EMULATOR_STOP:-0}"
case "${1:-}" in
  --status) status; exit 0 ;;
  --create) create_avd; exit 0 ;;
  --stop) acquire_lock --stop; stop_emulator; exit 0 ;;
  --stop-after) STOP_AFTER=1; shift ;;
esac
[[ "${1:-}" == -- ]] && shift
if [[ $# -eq 0 ]]; then
  echo "usage: $0 [--stop-after] [--] <command> [args…] | --status | --stop | --create" >&2
  exit 64
fi

acquire_lock "$@"
boot_emulator
export ANDROID_SERIAL="$SERIAL"
set +e
"$@"
rc=$?
set -e
if [[ "$STOP_AFTER" == 1 ]]; then stop_emulator; fi
exit "$rc"
