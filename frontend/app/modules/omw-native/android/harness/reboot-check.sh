#!/usr/bin/env bash
# Reboot check of the native uploader on our emulator (app-plan §6.2 done-when 4):
#
#   scripts/app/with-emulator.sh -- frontend/app/modules/omw-native/android/harness/reboot-check.sh
#
# 1. installs the instrumented test APK and runs RebootCheck#a_prepare: a video job waits for
#    Wi-Fi as a persisted UIDT job (Wi-Fi off, mobile data on);
# 2. reboots the emulator (`adb reboot`) and waits for the boot;
# 3. runs RebootCheck#b_resume: the job is still scheduled and, once Wi-Fi is back, uploads by
#    itself (nothing schedules it again);
# 4. uninstalls the test APK. The radios are switched back on in every case.
# Needs ANDROID_SERIAL (with-emulator.sh sets it). Log: <repo>/.cache/logs/omw-native-reboot.log
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../../../../.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT/scripts/app/env.sh"
# shellcheck source=emulator-net.sh
source "$HERE/emulator-net.sh"
: "${ANDROID_SERIAL:?run this through scripts/app/with-emulator.sh}"
LOG="$ROOT/.cache/logs/omw-native-reboot.log"
APK="$ROOT/.cache/omw-native-harness/core/outputs/apk/androidTest/debug/core-debug-androidTest.apk"
PKG=app.omw.omwnative.test
RUNNER="$PKG/androidx.test.runner.AndroidJUnitRunner"
mkdir -p "$(dirname "$LOG")"
: >"$LOG"

say() { printf '[reboot-check] %s\n' "$*" | tee -a "$LOG" >&2; }

restore_radios() {
  adb shell svc data enable >/dev/null 2>&1 || true
  adb shell svc wifi enable >/dev/null 2>&1 || true
}

cleanup() {
  restore_radios
  adb uninstall "$PKG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_boot() {
  local deadline=$((SECONDS + 600))
  adb wait-for-device
  until [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; do
    ((SECONDS < deadline)) || { say "the emulator did not come back in time"; exit 5; }
    sleep 2
  done
  adb shell input keyevent 82 >/dev/null 2>&1 || true
}

run_test() {
  say "running RebootCheck#$1"
  local out
  out="$(adb shell am instrument -w -r -e omwReboot 1 -e class "app.omw.omwnative.RebootCheck#$1" "$RUNNER" 2>&1 | tr -d '\r')"
  printf '%s\n' "$out" >>"$LOG"
  if ! grep -q '^OK (1 test)' <<<"$out"; then
    say "RebootCheck#$1 failed (see $LOG)"
    grep -E 'INSTRUMENTATION_STATUS: stack=|AssertionError|Exception' <<<"$out" | head -5 >&2 || true
    exit 1
  fi
}

say "building the test APK"
"$HERE/gradle.sh" --offline -q :core:assembleDebugAndroidTest >>"$LOG" 2>&1
adb shell am force-stop dev.mobile.maestro >/dev/null 2>&1 || true # holds UiAutomation (svc wifi/data)
adb install -r -t "$APK" >>"$LOG" 2>&1
omw_require_wifi 60 || exit 3 # b_resume uploads over Wi-Fi after the reboot

run_test a_prepare
# JobScheduler writes persisted jobs to disk about 2 s after a change (JobStore's write delay);
# a reboot right away loses the job a_prepare just scheduled (seen on the API 36 emulator).
adb shell dumpsys jobscheduler 2>/dev/null | grep -E "JOB #.*$PKG" >>"$LOG" || true
sleep 10
say "rebooting $ANDROID_SERIAL"
started=$SECONDS
adb reboot
sleep 5
wait_for_boot
say "back after $((SECONDS - started)) s"
adb shell dumpsys jobscheduler 2>/dev/null | grep -E "JOB #.*$PKG" >>"$LOG" || true
run_test b_resume
say "OK: the persisted UIDT job survived the reboot and uploaded by itself"
