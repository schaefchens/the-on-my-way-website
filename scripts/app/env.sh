#!/usr/bin/env bash
# Toolchain environment for the traveler app (frontend/app). Source it, don't run it:
#
#   source scripts/app/env.sh
#
# It only exports variables (no installs, no network). Approved toolchain (owner, 2026-11-20):
# - Android SDK: the shared $HOME/Library/Android/sdk. Never delete or upgrade packages there;
#   install a missing package only when strictly needed, and say so.
# - JDK 17: the Gradle-provisioned Temurin in ~/.gradle/jdks. Gradle's caches stay in ~/.gradle.
# - AVDs: only ours, under <worktree>/.cache/android-avd (never ~/.android/avd).
# - pnpm: the main checkout's shared store/cache/state, also from git worktrees.
# Every value can be overridden by setting it before sourcing.

_omw_here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
OMW_ROOT="$(cd "$_omw_here/../.." && pwd)"
export OMW_ROOT

# The main checkout: the first entry of `git worktree list` (falls back to this checkout).
if [[ -z "${OMW_MAIN_ROOT:-}" ]]; then
  OMW_MAIN_ROOT="$(git -C "$OMW_ROOT" worktree list --porcelain 2>/dev/null | awk 'NR==1 && $1=="worktree" {print $2}')"
  [[ -n "$OMW_MAIN_ROOT" ]] || OMW_MAIN_ROOT="$OMW_ROOT"
fi
export OMW_MAIN_ROOT

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export JAVA_HOME="${JAVA_HOME:-$HOME/.gradle/jdks/eclipse_adoptium-17-aarch64-os_x.2/jdk-17.0.20.1+1/Contents/Home}"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-$OMW_ROOT/.cache/android-avd}"
# ANDROID_EMULATOR_HOME stays the default (~/.android): the emulator injects the adb key from
# there, so a private one would leave our emulator "unauthorized" for adb.

# pnpm: share the main checkout's store (env beats the relative paths in .npmrc).
export npm_config_store_dir="${npm_config_store_dir:-$OMW_MAIN_ROOT/.cache/pnpm-store}"
export npm_config_cache_dir="${npm_config_cache_dir:-$OMW_MAIN_ROOT/.cache/pnpm-cache}"
export npm_config_state_dir="${npm_config_state_dir:-$OMW_MAIN_ROOT/.cache/pnpm-state}"
if [[ -d "$OMW_MAIN_ROOT/.cache/composer" ]]; then
  export COMPOSER_HOME="${COMPOSER_HOME:-$OMW_MAIN_ROOT/.cache/composer}"
  export COMPOSER_CACHE_DIR="${COMPOSER_CACHE_DIR:-$OMW_MAIN_ROOT/.cache/composer/cache}"
fi

# Metro's cache and the app's own tool caches stay in the checkout's git-ignored .cache/.
export OMW_METRO_CACHE="${OMW_METRO_CACHE:-$OMW_ROOT/.cache/metro}"
export MAESTRO_HOME="${MAESTRO_HOME:-$OMW_ROOT/.cache/maestro}"
# Maestro writes its logs and screenshots under ~/.maestro unless told otherwise.
export MAESTRO_CLI_NO_ANALYTICS=1
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
export EXPO_NO_TELEMETRY=1
# Builds only for the emulator's and current phones' ABI (halves native compile time).
export ORG_GRADLE_PROJECT_reactNativeArchitectures="${ORG_GRADLE_PROJECT_reactNativeArchitectures:-arm64-v8a}"

_omw_path_add() { case ":$PATH:" in *":$1:"*) ;; *) PATH="$1:$PATH" ;; esac; }
_omw_path_add "$ANDROID_HOME/platform-tools"
_omw_path_add "$ANDROID_HOME/emulator"
_omw_path_add "$JAVA_HOME/bin"
[[ -x "$MAESTRO_HOME/bin/maestro" ]] && _omw_path_add "$MAESTRO_HOME/bin"
export PATH
unset -f _omw_path_add
unset _omw_here
