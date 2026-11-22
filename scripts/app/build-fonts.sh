#!/usr/bin/env bash
# Rebuilds frontend/app/assets/fonts (TTF) from the site's font files; see build-fonts.py.
#
#   scripts/app/build-fonts.sh            # rebuild (after bumping a @fontsource package)
#   scripts/app/build-fonts.sh --check    # fails when the committed fonts are stale
#
# Python: $OMW_FONTS_PYTHON, else the fonts venv of this checkout or of the main checkout
# (created by scripts/fonts/subset-playpen.sh with the pinned fonttools + brotli).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MAIN="$(git -C "$ROOT" worktree list --porcelain 2>/dev/null | awk 'NR==1 && $1=="worktree" {print $2}')"
PY="${OMW_FONTS_PYTHON:-}"
if [[ -z "$PY" ]]; then
  for venv in "$ROOT/.cache/venv-fonts" "${MAIN:-$ROOT}/.cache/venv-fonts"; do
    if [[ -x "$venv/bin/python" ]]; then PY="$venv/bin/python"; break; fi
  done
fi
if [[ -z "$PY" ]]; then
  echo "No fonts venv found: run scripts/fonts/subset-playpen.sh --check once, or set OMW_FONTS_PYTHON." >&2
  exit 1
fi
# -I: isolated (no user site, no cwd imports); -B: never write bytecode into a shared venv.
exec "$PY" -I -B "$ROOT/scripts/app/build-fonts.py" "$@"
