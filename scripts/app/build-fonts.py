"""Builds the traveler app's TTF fonts (frontend/app/assets/fonts) from the site's font files.

Run through scripts/app/build-fonts.sh (it picks the pinned fonttools + brotli venv).

Android needs TTF/OTF, the site ships WOFF2 subsets. For every face the app uses, this script
- decompresses the site's latin, latin-ext and vietnamese WOFF2 subsets,
- cuts a static instance at the site's axes (varLib.instancer) when the source is variable,
- merges the three subsets into one TTF (fontTools.merge),
- writes it with a stable name and records sizes and hashes in fonts.json.

So the app draws the same outlines at the same weights as the site (app-plan §4 "Fonts"). The
OFL-1.1 texts are copied next to the files (licenses/). --check rebuilds in a temp dir and fails
when the committed files differ.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
from pathlib import Path

from fontTools.merge import Merger
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parents[2]
SHARED = ROOT / "frontend" / "shared"
OUT = ROOT / "frontend" / "app" / "assets" / "fonts"
SUBSETS = ("latin", "latin-ext", "vietnamese")


def fontsource(pkg: str, pattern: str) -> list[Path]:
    base = SHARED / "node_modules" / pkg / "files"
    return [base / pattern.format(subset=s) for s in SUBSETS]


def playpen(weight: int) -> list[Path]:
    base = SHARED / "fonts" / "playpen-sans"
    return [base / f"playpen-sans-{s}-{weight}.woff2" for s in SUBSETS]


# file stem -> (family, weight, sources, axes for variable sources, license file)
FACES: dict[str, tuple[str, int, list[Path], dict[str, float], Path]] = {
    "fraunces_600": (
        "Fraunces",
        600,
        fontsource("@fontsource-variable/fraunces", "fraunces-{subset}-soft-normal.woff2"),
        {"wght": 600, "SOFT": 100},
        SHARED / "node_modules/@fontsource-variable/fraunces/LICENSE",
    ),
    **{
        f"nunito_{w}": (
            "Nunito",
            w,
            fontsource("@fontsource-variable/nunito", "nunito-{subset}-wght-normal.woff2"),
            {"wght": w},
            SHARED / "node_modules/@fontsource-variable/nunito/LICENSE",
        )
        for w in (400, 700, 800)
    },
    **{
        f"playpen_sans_{w}": (
            "Playpen Sans",
            w,
            playpen(w),
            {},
            SHARED / "fonts/playpen-sans/OFL.txt",
        )
        for w in (400, 500)
    },
    "exo2_800": (
        "Exo 2",
        800,
        fontsource("@fontsource-variable/exo-2", "exo-2-{subset}-wght-normal.woff2"),
        {"wght": 800},
        SHARED / "node_modules/@fontsource-variable/exo-2/LICENSE",
    ),
    "calistoga_400": (
        "Calistoga",
        400,
        fontsource("@fontsource/calistoga", "calistoga-{subset}-400-normal.woff2"),
        {},
        SHARED / "node_modules/@fontsource/calistoga/LICENSE",
    ),
    "courier_prime_700": (
        "Courier Prime",
        700,
        # Courier Prime has no vietnamese subset on fontsource.
        fontsource("@fontsource/courier-prime", "courier-prime-{subset}-700-normal.woff2")[:2],
        {},
        SHARED / "node_modules/@fontsource/courier-prime/LICENSE",
    ),
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def static_ttf(src: Path, axes: dict[str, float], dst: Path) -> None:
    font = TTFont(src)
    if "fvar" in font:
        present = {a.axisTag for a in font["fvar"].axes}
        missing = set(axes) - present
        if missing:
            raise SystemExit(f"{src.name}: axes {sorted(missing)} not in {sorted(present)}")
        # Pin every axis (unlisted ones at their default) so the result is fully static.
        limits = {a.axisTag: axes.get(a.axisTag, a.defaultValue) for a in font["fvar"].axes}
        font = instancer.instantiateVariableFont(font, limits, updateFontNames=False)
    elif axes:
        raise SystemExit(f"{src.name} is static, but axes {axes} were requested")
    font.flavor = None
    font.recalcTimestamp = False
    font.save(dst)


def set_names(font: TTFont, family: str, weight: int) -> None:
    """Stable names: family "OMW <family> <weight>", subfamily Regular (one face per file)."""
    full = f"OMW {family} {weight}"
    ps = full.replace(" ", "")
    name = font["name"]
    for rec in list(name.names):
        if rec.nameID in (1, 2, 3, 4, 6, 16, 17, 21, 22, 25):
            name.removeNames(nameID=rec.nameID)
    for name_id, value in ((1, full), (2, "Regular"), (3, f"{ps};omw-app"), (4, full), (6, ps)):
        name.setName(value, name_id, 3, 1, 0x409)
        name.setName(value, name_id, 1, 0, 0)
    font["OS/2"].usWeightClass = weight


def build(out: Path) -> dict[str, object]:
    out.mkdir(parents=True, exist_ok=True)
    (out / "licenses").mkdir(exist_ok=True)
    manifest: dict[str, object] = {}
    with tempfile.TemporaryDirectory() as tmp:
        for stem, (family, weight, sources, axes, license_file) in FACES.items():
            for src in sources:
                if not src.is_file():
                    raise SystemExit(f"Missing source {src} (run pnpm install first)")
            parts = []
            for i, src in enumerate(sources):
                part = Path(tmp) / f"{stem}-{i}.ttf"
                static_ttf(src, axes, part)
                parts.append(str(part))
            merged = Merger().merge(parts)
            set_names(merged, family, weight)
            # Reproducible output: the first source's timestamps instead of "now" (the merger and
            # TTFont.save would otherwise stamp the build time).
            stamp = TTFont(sources[0])["head"].created
            merged.recalcTimestamp = False
            merged["head"].created = stamp
            merged["head"].modified = stamp
            dst = out / f"{stem}.ttf"
            merged.save(dst)
            lic_name = f"{family.lower().replace(' ', '-')}-OFL.txt"
            shutil.copyfile(license_file, out / "licenses" / lic_name)
            manifest[stem] = {
                "family": family,
                "weight": weight,
                "axes": axes,
                "bytes": dst.stat().st_size,
                "sha256": sha256(dst),
                "license": f"licenses/{lic_name}",
                "sources": {str(s.relative_to(ROOT)): sha256(s) for s in sources},
            }
    (out / "fonts.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="rebuild in a temp dir and compare")
    args = parser.parse_args()
    if not args.check:
        manifest = build(OUT)
        total = sum(int(v["bytes"]) for v in manifest.values())  # type: ignore[index]
        print(f"Wrote {len(manifest)} fonts ({total / 1024:.0f} KiB) to {OUT.relative_to(ROOT)}")
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        fresh = build(Path(tmp))
        committed = json.loads((OUT / "fonts.json").read_text())
        if fresh != committed:
            print("frontend/app/assets/fonts is stale: run scripts/app/build-fonts.sh", file=sys.stderr)
            return 1
    print("frontend/app/assets/fonts is up to date.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
