"""Subsets the handwritten font (Playpen Sans) for the site and the admin.

Run through scripts/fonts/subset-playpen.sh (it creates the fonttools venv under .cache/).

Inputs:  frontend/shared/node_modules/@fontsource-variable/playpen-sans (latin, latin-ext and
         vietnamese variable woff2 files, LICENSE, package.json)
Outputs: frontend/shared/fonts/playpen-sans/ (committed)
         playpen-sans-<subset>-<weight>.woff2, OFL.txt, subsets.json

What it does (decisions and measurements: scripts/fonts/README.md):
- One static instance per weight the CSS uses (WEIGHTS) instead of the 100-800 variable font.
- Only the code points listed in SUBSETS, split by unicode-range so that German/English pages
  never download Vietnamese or Latin Extended glyphs.
- Keeps the layout features needed for correct text (FEATURES: kerning incl. dist, mark
  positioning, Vietnamese stacked marks via ccmp/mark/mkmk, locl, liga); drops the contextual
  "handwriting" alternates (calt, about two thirds of the glyphs) and fractions.
- Deterministic: the same inputs and tool versions (requirements.txt) give byte-identical files.
  `--check` rebuilds into .cache/ and fails if the committed files differ.

The font declares no Reserved Font Name (OFL), so the subsets keep their family name.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parents[2]
PKG = "@fontsource-variable/playpen-sans"
SRC_DIR = ROOT / "frontend/shared/node_modules" / PKG
OUT_DIR = ROOT / "frontend/shared/fonts/playpen-sans"
CHECK_DIR = ROOT / ".cache/fonts-check/playpen-sans"

# The weights the hand font is rendered at (site and admin): 400 for everything, 500 for
# WhatsApp text statuses in FB_SCRIPT (@omw/ui/fonts WA_FONTS, backend generator css.ts).
WEIGHTS = (400, 500)

# OpenType layout features to keep (all of them on by default in browsers). Playpen also puts
# pair adjustments into `dist` (e.g. the space after stacked Vietnamese marks); `rvrn` swaps
# glyphs at heavy weights and is resolved by the instancer. Everything else (calt: the
# handwriting alternates, frac) is dropped together with the glyphs only those features reach.
FEATURES = ["rvrn", "ccmp", "locl", "liga", "kern", "dist", "mark", "mkmk"]


def cps(*ranges: tuple[int, int] | int) -> set[int]:
    out: set[int] = set()
    for r in ranges:
        if isinstance(r, int):
            out.add(r)
        else:
            out.update(range(r[0], r[1] + 1))
    return out


# Vietnamese letters outside Latin-1 (precomposed, NFC) plus the tone marks and the dong sign.
VIETNAMESE = cps(
    (0x0102, 0x0103),  # Ă ă
    (0x0110, 0x0111),  # Đ đ
    (0x0128, 0x0129),  # Ĩ ĩ
    (0x0168, 0x0169),  # Ũ ũ
    (0x01A0, 0x01A1),  # Ơ ơ
    (0x01AF, 0x01B0),  # Ư ư
    (0x0300, 0x0301),  # combining grave, acute
    0x0303,  # combining tilde
    0x0309,  # combining hook above
    0x0323,  # combining dot below
    (0x1EA0, 0x1EF9),  # Ạ ... ỹ
    0x20AB,  # ₫
)

# Basic Latin, Latin-1 and typographic punctuation: everything German and English text needs.
LATIN = cps(
    (0x0020, 0x007E),
    (0x00A0, 0x00FF),  # incl. · « » ß ä ö ü é ç ñ ø å æ ...
    0x0131,  # ı (Turkish names)
    (0x0152, 0x0153),  # Œ œ
    (0x02BB, 0x02BC),  # ʻ ʼ (Hawaiʻi)
    0x02C6,  # ˆ
    0x02DA,  # ˚
    0x02DC,  # ˜
    (0x0300, 0x0301),  # combining grave, acute (NFD text)
    (0x0303, 0x0304),  # combining tilde, macron
    0x0308,  # combining diaeresis (NFD umlauts)
    0x2009,  # thin space
    0x200B,  # zero width space
    (0x2013, 0x2014),  # – —
    (0x2018, 0x201A),  # ‘ ’ ‚
    (0x201C, 0x201E),  # “ ” „
    0x2022,  # •
    0x2026,  # …
    (0x2032, 0x2033),  # ′ ″
    (0x2039, 0x203A),  # ‹ ›
    0x2044,  # ⁄
    0x20AC,  # €
    0x2122,  # ™
    0x2212,  # −
    0x2215,  # ∕
)

# Latin Extended-A (Polish, Czech, Turkish, Hungarian, Baltic, ... names) without what the other
# two files carry and without the deprecated ŉ (U+0149, not in the font), plus the Romanian
# comma-below letters, the capital sharp s and the Welsh w accents.
LATIN_EXT = cps((0x0100, 0x017F), (0x0218, 0x021B), 0x1E9E, (0x1E80, 0x1E85)) - VIETNAMESE - LATIN - {0x0149}

# name -> (fontsource input file, code points). Declared in this order in fonts.css (browsers try
# the last matching @font-face first, so the overlapping combining marks come from latin).
SUBSETS: dict[str, tuple[str, set[int]]] = {
    "vietnamese": ("playpen-sans-vietnamese-wght-normal.woff2", VIETNAMESE),
    "latin-ext": ("playpen-sans-latin-ext-wght-normal.woff2", LATIN_EXT),
    "latin": ("playpen-sans-latin-wght-normal.woff2", LATIN),
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def unicode_range(codepoints: set[int]) -> str:
    """CSS unicode-range for a set of code points, as compact runs."""
    out: list[str] = []
    ordered = sorted(codepoints)
    start = prev = ordered[0]
    for cp in [*ordered[1:], None]:
        if cp is not None and cp == prev + 1:
            prev = cp
            continue
        out.append(f"U+{start:04X}" if start == prev else f"U+{start:04X}-{prev:04X}")
        if cp is not None:
            start = prev = cp
    return ",".join(out)


def to_json(value: object, indent: str = "") -> str:
    """JSON as Biome formats it (objects expanded, arrays of scalars on one line)."""
    inner = indent + "  "
    if isinstance(value, dict):
        items = [f"{inner}{json.dumps(k)}: {to_json(v, inner)}" for k, v in value.items()]
        return "{\n" + ",\n".join(items) + f"\n{indent}}}"
    if isinstance(value, list) and any(isinstance(v, (dict, list)) for v in value):
        return "[\n" + ",\n".join(inner + to_json(v, inner) for v in value) + f"\n{indent}]"
    return json.dumps(value, ensure_ascii=False, separators=(", ", ": "))


def gsub_features(font: TTFont) -> set[str]:
    if "GSUB" not in font:
        return set()
    return {fr.FeatureTag for fr in font["GSUB"].table.FeatureList.FeatureRecord}


def gpos_features(font: TTFont) -> set[str]:
    if "GPOS" not in font:
        return set()
    return {fr.FeatureTag for fr in font["GPOS"].table.FeatureList.FeatureRecord}


def build_one(src: Path, codepoints: set[int], weight: int) -> tuple[bytes, set[int], set[str]]:
    font = TTFont(src, recalcTimestamp=False)
    available = set(font.getBestCmap())
    missing = codepoints - available
    wanted = codepoints & available

    options = subset.Options()
    options.layout_features = FEATURES
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    options.name_languages = [0x0409]
    options.glyph_names = False
    options.notdef_outline = True
    options.drop_tables += ["vhea", "vmtx", "VVAR"]  # vertical metrics: horizontal text only
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=sorted(wanted))
    subsetter.subset(font)

    # A static instance at `weight` (also resolves the rvrn feature variations).
    font = instancer.instantiateVariableFont(font, {"wght": weight}, updateFontNames=True)
    font.recalcTimestamp = False
    font.flavor = "woff2"
    buf = io.BytesIO()
    font.save(buf)
    data = buf.getvalue()

    check = TTFont(io.BytesIO(data))
    cmap = set(check.getBestCmap())
    if cmap != wanted:
        raise SystemExit(f"{src.name}@{weight}: cmap differs from the requested code points")
    if "fvar" in check or "gvar" in check:
        raise SystemExit(f"{src.name}@{weight}: still variable")
    features = gsub_features(check) | gpos_features(check)
    if "calt" in features:
        raise SystemExit(f"{src.name}@{weight}: calt survived")
    for required in ("kern", "mark"):
        if required not in features:
            raise SystemExit(f"{src.name}@{weight}: {required} missing")
    if missing:
        print(f"  note: {src.name} lacks {unicode_range(missing)} (not drawn by the font)", file=sys.stderr)
    return data, cmap, features


def build(out_dir: Path) -> None:
    pkg = json.loads((SRC_DIR / "package.json").read_text("utf-8"))
    license_text = (SRC_DIR / "LICENSE").read_text("utf-8")
    # OFL: a modified version must not use a Reserved Font Name. RFNs are declared in the copyright
    # notice ("..., with Reserved Font Name X") above the license text and in the font's name ID 0.
    notice = license_text.split("This Font Software is licensed under", 1)[0]
    copyright_names = [TTFont(SRC_DIR / "files" / f)["name"].getDebugName(0) or "" for f, _cps in SUBSETS.values()]
    if any("reserved font name" in text.lower() for text in [notice, *copyright_names]):
        raise SystemExit("The font now declares a Reserved Font Name: rename the subset family first.")

    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    files = []
    sources = {}
    for name, (src_name, codepoints) in SUBSETS.items():
        src = SRC_DIR / "files" / src_name
        sources[src_name] = sha256(src.read_bytes())
        for weight in WEIGHTS:
            data, cmap, features = build_one(src, codepoints, weight)
            file_name = f"playpen-sans-{name}-{weight}.woff2"
            (out_dir / file_name).write_bytes(data)
            files.append(
                {
                    "file": file_name,
                    "subset": name,
                    "weight": weight,
                    "bytes": len(data),
                    "sha256": sha256(data),
                    "features": sorted(features),
                    "unicodeRange": unicode_range(cmap),
                }
            )
            print(f"  {file_name:40s} {len(data):7d} B  {len(cmap):4d} code points")
    (out_dir / "OFL.txt").write_text(license_text, "utf-8")
    manifest = {
        "comment": "GENERATED by scripts/fonts/subset-playpen.sh. Do not edit; fonts.css is built from it.",
        "family": "Playpen Sans Variable",
        "source": {"package": PKG, "version": pkg["version"], "files": sources},
        "weights": list(WEIGHTS),
        "features": FEATURES,
        "files": files,
    }
    (out_dir / "subsets.json").write_text(to_json(manifest) + "\n", "utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="rebuild under .cache/ and compare with the committed files")
    args = parser.parse_args()
    if not SRC_DIR.exists():
        print(f"{SRC_DIR} is missing: run `pnpm install` first.", file=sys.stderr)
        return 1
    if not args.check:
        build(OUT_DIR)
        print(f"Wrote {OUT_DIR.relative_to(ROOT)}; now run `pnpm --filter @omw/ui fonts`.")
        return 0
    build(CHECK_DIR)
    differ = []
    names = {p.name for p in OUT_DIR.glob("*")} | {p.name for p in CHECK_DIR.glob("*")}
    for name in sorted(names):
        a, b = OUT_DIR / name, CHECK_DIR / name
        if not a.exists() or not b.exists() or a.read_bytes() != b.read_bytes():
            differ.append(name)
    if differ:
        print(f"Out of date or not reproducible: {', '.join(differ)}", file=sys.stderr)
        return 1
    print("frontend/shared/fonts/playpen-sans is up to date.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
