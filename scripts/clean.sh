#!/bin/sh
# Frees disk space. Removes only paths git ignores, and only what builds, tests and agent runs make
# again. It never touches:
#   .secrets/ and .env                   credentials
#   .cache/wt/                           git worktrees (e.g. the traveler app on branch "app")
#   .cache/design-*/                     design specs and the owner's decisions
#   .cache/snapshots/, reports/, progress/, phase0/   backups, workflow reports, agent progress logs
#   backend/data/                        the backend's archive and runtime data
#   api/var/                             the local API database
# Outside the repository it touches nothing, except when asked: this project's own Android
# emulator (AVDs named omw*) and this project's Docker build cache (builder omw-builder).
#
#   sh scripts/clean.sh              build outputs, test results, screenshots, agent scratch in .cache/
#   sh scripts/clean.sh --caches     also download and tool caches: pnpm store, Go, Composer cache,
#                                    Playwright browsers, npm, pip, Python venvs (fetched again on use)
#   sh scripts/clean.sh --all        also node_modules, api/vendor and .cache/bin (composer.phar;
#                                    scripts/composer prints how to install it again)
#   sh scripts/clean.sh --devices    also this project's Android emulators (omw*.avd), stopped first
#   sh scripts/clean.sh --docker     also the omw-builder build cache and omw e2e containers/volumes
#   sh scripts/clean.sh -n [...]     list what would go, with sizes, and remove nothing
#   sh scripts/clean.sh --force ...  run even while processes are using .cache/
#
# After a cleanup: `pnpm install` (with --all), `scripts/composer install` (with --all),
# `pnpm fixtures` (backend tests need fixtures/generated), `pnpm build` (the site build the
# generator copies), `pnpm --filter @omw/admin build` (before an API deploy).
set -eu
cd "$(dirname "$0")/.."
root=$(pwd)

dry=0 caches=0 deps=0 devices=0 docker=0 force=0
for arg in "$@"; do
  case $arg in
    -n | --dry-run) dry=1 ;;
    --caches) caches=1 ;;
    --all) caches=1 deps=1 ;;
    --devices) devices=1 ;;
    --docker) docker=1 ;;
    --force) force=1 ;;
    -h | --help) sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "usage: sh scripts/clean.sh [-n] [--caches | --all] [--devices] [--docker] [--force]" >&2; exit 1 ;;
  esac
done

# .cache entries that are never removed (by name), and the tool caches (only with --caches/--all).
protected='wt snapshots reports progress phase0'
tool_caches='pnpm-store pnpm-cache pnpm-state go go-build composer ms-playwright playwright npm
pip-cache home fontconfig git dl maestro android-avd'
tools='bin'

# Build outputs and test leftovers in the repository (always ignored by git; checked below).
builds='packages/*/dist backend/dist frontend/*/dist frontend/site/dev-data fixtures/generated
api/public/admin backend/wa-helper/bin api/.phpunit.cache .phpunit.cache
frontend/app/android frontend/app/ios frontend/app/.expo frontend/app/modules/omw-native/android/build'
leftovers='test-results playwright-report coverage */test-results */playwright-report */*/test-results
*/*/playwright-report */coverage */*/coverage'

is_protected() { # .cache entry name
  case $1 in design-*) return 0 ;; esac
  for p in $protected; do [ "$1" = "$p" ] && return 0; done
  return 1
}
in_list() { # name, list
  for p in $2; do [ "$1" = "$p" ] && return 0; done
  case $1 in venv-*) [ "$2" = "$tool_caches" ] && return 0 ;; esac
  return 1
}

# Refuse while something is running out of .cache/ (agent runs, test servers, an emulator).
if [ $force = 0 ] && [ $dry = 0 ]; then
  busy=$(ps -axo pid=,command= | grep -F "$root/.cache" | grep -v -e "grep -F" -e "scripts/clean.sh" || true)
  if [ -n "$busy" ]; then
    echo "Processes are using .cache/ (an agent run, a test server or the emulator?):" >&2
    echo "$busy" | cut -c1-160 | head -10 >&2
    echo "Stop them first, or run with --force." >&2
    exit 2
  fi
fi

# Git worktrees are never inside anything we delete (they live in .cache/wt/, which is protected).
worktrees=$(git worktree list --porcelain | awk '/^worktree / { print substr($0, 10) }')

total=0
remove() { # path, shown as, and how to remove it if not by deleting the path
  for wt in $worktrees; do
    case $wt in "$root/$1" | "$root/$1"/*) [ "$wt" = "$root" ] || { echo "kept, contains a worktree: $1" >&2; return; } ;; esac
  done
  kb=$(du -sk "$1" 2> /dev/null | cut -f1)
  total=$((total + ${kb:-0}))
  printf '%9.1f MB  %s\n' "$(echo "${kb:-0} / 1024" | bc -l)" "$2"
  [ $dry = 1 ] && return
  if [ $# -gt 2 ]; then eval "$3"; else chmod -R u+w "$1" 2> /dev/null || true; rm -rf "$1"; fi  # Go keeps its module cache read-only
}
remove_ignored() { # path
  [ -e "$1" ] || return 0
  if ! git check-ignore -q "$1"; then
    echo "kept, not ignored by git: $1" >&2
    return 0
  fi
  remove "$1" "$1"
}

# 1. Build outputs and test leftovers.
for pattern in $builds $leftovers; do
  for path in $pattern; do remove_ignored "$path"; done
done
find . \( -path ./.cache -o -name node_modules \) -prune -o -name '*.tsbuildinfo' -print 2> /dev/null |
  while read -r f; do [ $dry = 1 ] || rm -f "$f"; done

# 2. .cache/: agent scratch always; tool caches with --caches; tools with --all; protected never.
if [ -d .cache ]; then
  for path in .cache/* .cache/.[!.]*; do
    [ -e "$path" ] || continue
    name=${path#.cache/}
    if is_protected "$name"; then continue; fi
    if in_list "$name" "$tool_caches"; then [ $caches = 1 ] && remove_ignored "$path"; continue; fi
    if in_list "$name" "$tools"; then [ $deps = 1 ] && remove_ignored "$path"; continue; fi
    remove_ignored "$path"
  done
fi

# 3. Dependencies (--all).
if [ $deps = 1 ]; then
  find . -path ./.cache -prune -o -name node_modules -type d -prune -print 2> /dev/null | sed 's#^\./##' | sort |
    while read -r path; do remove_ignored "$path"; done
  remove_ignored api/vendor
fi

# 4. This project's Android emulators (--devices): AVDs named omw* in the project's AVD homes.
stop_emulator() {
  command -v adb > /dev/null || return 0
  for serial in $(adb devices 2> /dev/null | awk '/^emulator-/ { print $1 }'); do
    [ "$(adb -s "$serial" emu avd name 2> /dev/null | head -1 | tr -d '\r')" = "$1" ] || continue
    adb -s "$serial" emu kill > /dev/null 2>&1
    for _ in 1 2 3 4 5 6 7 8 9 10; do adb devices | grep -q "^$serial" || break; sleep 2; done
  done
}
if [ $devices = 1 ]; then
  for avds in .cache/android-avd .cache/wt/*/.cache/android-avd; do
    for folder in "$avds"/omw*.avd; do
      [ -d "$folder" ] || continue
      name=$(basename "$folder" .avd)
      remove "$folder" "emulator $name ($avds)" "stop_emulator $name; rm -rf '$folder' '$avds/$name.ini'"
    done
  done
fi

# 5. This project's Docker leftovers (--docker): never a global prune.
if [ $docker = 1 ] && command -v docker > /dev/null && docker info > /dev/null 2>&1; then
  if docker buildx inspect omw-builder > /dev/null 2>&1; then
    size=$(docker buildx du --builder omw-builder 2> /dev/null | awk '/^Total/ { print $2 }')
    printf '%12s  %s\n' "${size:-?}" "build cache of builder omw-builder"
    [ $dry = 1 ] || docker buildx prune --builder omw-builder -f > /dev/null
  fi
  for c in $(docker ps -aq --filter 'name=omw-e2e'); do
    echo "    container $(docker inspect -f '{{.Name}}' "$c")"
    [ $dry = 1 ] || docker rm -f "$c" > /dev/null
  done
  for v in $(docker volume ls -q --filter 'name=omw-e2e'); do
    echo "    volume $v"
    [ $dry = 1 ] || docker volume rm "$v" > /dev/null
  done
  for i in $(docker images -q --filter 'reference=omw-backend' --filter 'dangling=true'); do
    echo "    dangling image $i (omw-backend)"
    [ $dry = 1 ] || docker rmi "$i" > /dev/null
  done
fi

verb=$([ $dry = 1 ] && echo "would free" || echo "freed")
printf '%s %.1f GB (plus Docker, if listed)\n' "$verb" "$(echo "$total / 1048576" | bc -l)"
