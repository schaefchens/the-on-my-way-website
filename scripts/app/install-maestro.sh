#!/usr/bin/env bash
# Installs the pinned Maestro CLI into <checkout>/.cache/maestro (no global install, no ~/.maestro
# binaries). Idempotent: does nothing when the pinned version is already there.
#
#   scripts/app/install-maestro.sh
#   .cache/maestro/bin/maestro --version
#
# The zip (~350 MB) is checked against the pinned sha256 and deleted after unpacking (~380 MB).
set -euo pipefail
VERSION="2.12.1"
SHA256="54dbb0716425626604973cbb374c585ca30272375d9ce15177a1152765ddd9d7"
URL="https://github.com/mobile-dev-inc/Maestro/releases/download/cli-$VERSION/maestro.zip"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="$ROOT/.cache/maestro"
STAMP="$DEST/.version"

if [[ -x "$DEST/bin/maestro" && "$(cat "$STAMP" 2>/dev/null)" == "$VERSION" ]]; then
  echo "Maestro $VERSION is installed in .cache/maestro"
  exit 0
fi
free_gb="$(df -g / | awk 'NR==2 {print $4}')"
if ((free_gb < 6)); then
  echo "Only ${free_gb} GB free: not downloading Maestro (needs ~1 GB, keeps 5 GB free)." >&2
  exit 4
fi

work="$(mktemp -d "$ROOT/.cache/maestro-download.XXXXXX")"
trap 'rm -rf "$work"' EXIT
echo "Downloading Maestro $VERSION ..."
curl -fSL --retry 3 -o "$work/maestro.zip" "$URL"
got="$(shasum -a 256 "$work/maestro.zip" | cut -d' ' -f1)"
if [[ "$got" != "$SHA256" ]]; then
  echo "sha256 mismatch: got $got, want $SHA256" >&2
  exit 1
fi
mkdir -p "$work/unpacked"
unzip -q "$work/maestro.zip" -d "$work/unpacked"
rm -f "$work/maestro.zip"
rm -rf "$DEST"
mv "$work/unpacked/maestro" "$DEST"
echo "$VERSION" >"$STAMP"
echo "Maestro $VERSION installed in .cache/maestro ($(du -sh "$DEST" | cut -f1))"
