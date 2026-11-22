#!/usr/bin/env bash
# Runs omw-native's instrumented tests on our emulator with `am instrument` (no Gradle UTP, so
# nothing extra is downloaded): builds the test APK, installs it, runs it, prints one line per
# test and a summary, uninstalls it.
#
#   scripts/app/with-emulator.sh -- frontend/app/modules/omw-native/android/harness/instrument.sh [Class[#method]]
#
# e.g. `… instrument.sh UploaderInstrumentedTest` or `… instrument.sh MediaExportInstrumentedTest#muteRemovesTheAudioTrack`.
# The tests flip Wi-Fi and mobile data (svc wifi|data) through UiAutomation, so a leftover Maestro
# driver (which holds UiAutomation) is stopped first; Maestro starts it again on its next run.
# Needs ANDROID_SERIAL (with-emulator.sh sets it). Raw output: <repo>/.cache/logs/omw-native-instrument.log
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../../../../.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT/scripts/app/env.sh"
# shellcheck source=emulator-net.sh
source "$HERE/emulator-net.sh"
: "${ANDROID_SERIAL:?run this through scripts/app/with-emulator.sh}"
LOG="$ROOT/.cache/logs/omw-native-instrument.log"
APK="$ROOT/.cache/omw-native-harness/core/outputs/apk/androidTest/debug/core-debug-androidTest.apk"
PKG=app.omw.omwnative.test
RUNNER="$PKG/androidx.test.runner.AndroidJUnitRunner"
mkdir -p "$(dirname "$LOG")"

cleanup() {
  adb shell svc data enable >/dev/null 2>&1 || true
  adb shell svc wifi enable >/dev/null 2>&1 || true
  adb uninstall "$PKG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"$HERE/gradle.sh" --offline -q :core:assembleDebugAndroidTest
adb shell am force-stop dev.mobile.maestro >/dev/null 2>&1 || true
adb install -r -t "$APK" >/dev/null
# The uploader tests need a validated Wi-Fi network (the export tests don't).
if [[ "${1:-}" != MediaExport* ]]; then
  omw_require_wifi 60 || exit 3
fi

args=(-w -r --no-window-animation)
[[ -n "${1:-}" ]] && args+=(-e class "app.omw.omwnative.$1")
adb shell am instrument "${args[@]}" "$RUNNER" 2>&1 | tr -d '\r' >"$LOG" || true

# One line per test from the raw status codes (0 ok, -1 error, -2 failure, -3 ignored, -4 assumption).
awk '
  /^INSTRUMENTATION_STATUS: class=/ { cls = substr($0, index($0, "=") + 1); sub(/^app\.omw\.omwnative\./, "", cls) }
  /^INSTRUMENTATION_STATUS: test=/ { t = substr($0, index($0, "=") + 1) }
  /^INSTRUMENTATION_STATUS_CODE: / {
    c = $2
    if (c == 0) { print "PASS " cls "#" t; pass++ }
    else if (c == -1 || c == -2) { print "FAIL " cls "#" t; fail++ }
    else if (c == -3 || c == -4) { print "SKIP " cls "#" t; skip++ }
  }
  END { printf "summary: %d passed, %d failed, %d skipped\n", pass, fail, skip }
' "$LOG"
if grep -q '^INSTRUMENTATION_FAILED\|^INSTRUMENTATION_RESULT: shortMsg=Process crashed' "$LOG"; then
  echo "the instrumentation crashed (see $LOG)" >&2
  exit 1
fi
grep -qE '^OK \([0-9]+ tests?\)' "$LOG"
