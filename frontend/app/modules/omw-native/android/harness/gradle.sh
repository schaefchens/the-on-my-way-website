#!/usr/bin/env bash
# Runs Gradle on the omw-native harness (no React Native, no prebuild needed):
#
#   frontend/app/modules/omw-native/android/harness/gradle.sh :core:testDebugUnitTest
#   scripts/app/with-emulator.sh -- frontend/app/modules/omw-native/android/harness/instrument.sh
#
# (instrument.sh builds :core:assembleDebugAndroidTest and runs it with `am instrument`; Gradle's
# own :core:connectedDebugAndroidTest works too, but needs the UTP artifacts in the Gradle cache.)
#
# Uses the approved toolchain (scripts/app/env.sh), the cached Gradle 9.4.1 distribution and the
# shared ~/.gradle caches; build outputs and the project cache stay in <repo>/.cache/omw-native-harness.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../../../../.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT/scripts/app/env.sh"
GRADLE="$(ls -d "$HOME"/.gradle/wrapper/dists/gradle-9.4.1-bin/*/gradle-9.4.1/bin/gradle 2>/dev/null | head -1 || true)"
if [[ -z "$GRADLE" ]]; then
  echo "gradle.sh: Gradle 9.4.1 is not in ~/.gradle/wrapper/dists (run the app build once)" >&2
  exit 2
fi
mkdir -p "$ROOT/.cache/omw-native-harness"
exec "$GRADLE" -p "$HERE" --project-cache-dir "$ROOT/.cache/omw-native-harness/gradle" -PomwRoot="$ROOT" \
  -Pkotlin.project.persistent.dir="$ROOT/.cache/omw-native-harness/kotlin" "$@"
