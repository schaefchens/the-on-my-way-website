#!/usr/bin/env bash
# Rebuilds the Playpen Sans subsets in frontend/shared/fonts/playpen-sans (see README.md here).
#
#   scripts/fonts/subset-playpen.sh            # rebuild, then: pnpm --filter @omw/ui fonts
#   scripts/fonts/subset-playpen.sh --check    # CI-style: fails if the committed files differ
#
# Uses a private venv with the pinned fonttools + brotli (requirements.txt) in .cache/venv-fonts.
# Python: $OMW_FONTS_PYTHON, else the first of python3.13/3.12/3.14/python3 found (brotli needs a
# wheel for that version or a C compiler). Nothing is installed outside the repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV="$ROOT/.cache/venv-fonts"
REQS="$ROOT/scripts/fonts/requirements.txt"
export PIP_CACHE_DIR="$ROOT/.cache/pip-cache"
export PIP_DISABLE_PIP_VERSION_CHECK=1

pick_python() {
  if [[ -n "${OMW_FONTS_PYTHON:-}" ]]; then
    echo "$OMW_FONTS_PYTHON"
    return
  fi
  for candidate in python3.13 python3.12 python3.14 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return
    fi
  done
  echo "No python3 found (set OMW_FONTS_PYTHON)." >&2
  exit 1
}

# (Re)create the venv when it is missing or the pinned requirements changed.
STAMP="$VENV/.requirements.sha256"
WANT="$(shasum -a 256 "$REQS" | cut -d' ' -f1)"
if [[ ! -x "$VENV/bin/python" || ! -f "$STAMP" || "$(cat "$STAMP")" != "$WANT" ]]; then
  PY="$(pick_python)"
  echo "Creating $VENV with $("$PY" --version 2>&1) ..."
  rm -rf "$VENV"
  "$PY" -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --require-virtualenv --only-binary=:all: -r "$REQS"
  echo "$WANT" >"$STAMP"
fi

# -I: isolated mode (no user site-packages, no script-dir imports from the current directory).
exec "$VENV/bin/python" -I "$ROOT/scripts/fonts/subset-playpen.py" "$@"
