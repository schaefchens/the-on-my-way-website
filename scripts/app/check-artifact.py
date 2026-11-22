#!/usr/bin/env python3
"""Checks a release AAB or APK of the traveler app (stdlib only, read-only).

    python3 -I scripts/app/check-artifact.py <file.aab|file.apk> [--json OUT]

- 16 KB page size (Play requirement for targetSdk 35+ on 64-bit ABIs, enforced from 2025-11-01;
  app-plan §7): every native library of a 64-bit ABI (arm64-v8a, x86_64) must have ELF LOAD
  segments aligned to at least 16 KiB (p_align >= 0x4000). In an APK the library must also be
  stored uncompressed at a 16 KiB-aligned zip offset (or compressed, which the installer extracts).
- no VIBRATE, no location, no READ_MEDIA_* in the manifest (checked as strings in the binary
  manifest; the authoritative check is `aapt2 dump permissions` on an APK).
- sizes: the file, the native libraries per ABI, the dex files, the JS bundle.

Exit status: 0 = all checks pass, 1 = a check failed, 2 = usage / unreadable file.
"""

from __future__ import annotations

import json
import struct
import sys
import zipfile

PAGE_16K = 0x4000
ABIS_64 = ("arm64-v8a", "x86_64")
FORBIDDEN_PERMISSIONS = (
    "android.permission.VIBRATE",
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.ACCESS_MEDIA_LOCATION",
    "android.permission.READ_MEDIA_IMAGES",
    "android.permission.READ_MEDIA_VIDEO",
    "android.permission.READ_EXTERNAL_STORAGE",
    "android.permission.SYSTEM_ALERT_WINDOW",
)


def elf_load_alignments(data: bytes) -> list[int]:
    """p_align of every PT_LOAD segment of a 32- or 64-bit little-endian ELF file."""
    if data[:4] != b"\x7fELF":
        raise ValueError("not an ELF file")
    is64 = data[4] == 2
    if data[5] != 1:
        raise ValueError("big-endian ELF")
    if is64:
        e_phoff = struct.unpack_from("<Q", data, 0x20)[0]
        e_phentsize, e_phnum = struct.unpack_from("<HH", data, 0x36)
    else:
        e_phoff = struct.unpack_from("<I", data, 0x1C)[0]
        e_phentsize, e_phnum = struct.unpack_from("<HH", data, 0x2A)
    out = []
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        p_type = struct.unpack_from("<I", data, off)[0]
        if p_type != 1:  # PT_LOAD
            continue
        p_align = struct.unpack_from("<Q", data, off + 0x30)[0] if is64 else struct.unpack_from("<I", data, off + 0x1C)[0]
        out.append(p_align)
    return out


def data_offset(zf: zipfile.ZipFile, info: zipfile.ZipInfo) -> int:
    """Offset of an entry's data in the zip (local header + name + extra)."""
    fp = zf.fp
    assert fp is not None
    fp.seek(info.header_offset)
    header = fp.read(30)
    name_len, extra_len = struct.unpack_from("<HH", header, 26)
    return info.header_offset + 30 + name_len + extra_len


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    path = argv[1]
    json_out = argv[argv.index("--json") + 1] if "--json" in argv else None
    try:
        zf = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as e:
        print(f"cannot read {path}: {e}", file=sys.stderr)
        return 2
    is_aab = any(n.startswith("base/") for n in zf.namelist())
    lib_prefix = "base/lib/" if is_aab else "lib/"
    report: dict = {"file": path, "kind": "aab" if is_aab else "apk", "bytes": 0, "abis": {}, "problems": []}
    import os

    report["bytes"] = os.path.getsize(path)
    dex = 0
    bundle = 0
    for info in zf.infolist():
        name = info.filename
        if name.endswith(".dex"):
            dex += info.file_size
        if name.endswith("index.android.bundle"):
            bundle = info.file_size
        if not (name.startswith(lib_prefix) and name.endswith(".so")):
            continue
        abi = name[len(lib_prefix) :].split("/", 1)[0]
        entry = report["abis"].setdefault(abi, {"libs": 0, "bytes": 0, "unaligned": []})
        entry["libs"] += 1
        entry["bytes"] += info.file_size
        data = zf.read(name)
        try:
            aligns = elf_load_alignments(data)
        except ValueError as e:
            report["problems"].append(f"{name}: {e}")
            continue
        if abi in ABIS_64 and (not aligns or min(aligns) < PAGE_16K):
            entry["unaligned"].append(f"{name.rsplit('/', 1)[-1]} (p_align {hex(min(aligns)) if aligns else 'none'})")
        if not is_aab and abi in ABIS_64 and info.compress_type == zipfile.ZIP_STORED:
            off = data_offset(zf, info)
            if off % PAGE_16K != 0:
                entry["unaligned"].append(f"{name.rsplit('/', 1)[-1]} (zip offset {off} not 16 KiB aligned)")
    for abi, entry in report["abis"].items():
        if abi in ABIS_64 and entry["unaligned"]:
            report["problems"].append(f"{abi}: {len(entry['unaligned'])} libraries not 16 KB ready: {', '.join(entry['unaligned'])}")
    manifest_name = "base/manifest/AndroidManifest.xml" if is_aab else "AndroidManifest.xml"
    try:
        manifest = zf.read(manifest_name)
    except KeyError:
        manifest = b""
        report["problems"].append(f"{manifest_name} missing")
    # Binary manifests keep strings as UTF-16 (APK) or UTF-8 (AAB protobuf): look for both.
    for perm in FORBIDDEN_PERMISSIONS:
        if perm.encode() in manifest or perm.encode("utf-16-le") in manifest:
            report["problems"].append(f"forbidden permission in the manifest: {perm}")
    report["dexBytes"] = dex
    report["jsBundleBytes"] = bundle
    report["page16k"] = not any("16 KB" in p for p in report["problems"])
    report["ok"] = not report["problems"]

    mib = lambda b: f"{b / 1048576:.1f} MiB"  # noqa: E731
    print(f"{report['kind'].upper()} {path}: {mib(report['bytes'])}")
    for abi, entry in sorted(report["abis"].items()):
        status = "16 KB ok" if abi in ABIS_64 and not entry["unaligned"] else ("n/a (32-bit)" if abi not in ABIS_64 else "NOT 16 KB ready")
        print(f"  lib/{abi}: {entry['libs']} libraries, {mib(entry['bytes'])} uncompressed, {status}")
    print(f"  dex: {mib(dex)}, JS bundle (Hermes bytecode): {mib(bundle)}")
    for p in report["problems"]:
        print(f"  PROBLEM: {p}")
    print("  result: " + ("ok" if report["ok"] else "FAILED"))
    if json_out:
        with open(json_out, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
            f.write("\n")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
