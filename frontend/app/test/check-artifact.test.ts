/**
 * scripts/app/check-artifact.py, the release check after every build: 64-bit native libraries need
 * 16 KiB-aligned ELF LOAD segments (Play's 16 KB page-size rule) and the manifest must not ask for
 * the permissions the app blocks. Fake APK/AAB files are built with Python's zipfile.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../../scripts/app/check-artifact.py', import.meta.url));
const hasPython = spawnSync('python3', ['--version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'omw-check-artifact-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Writes a fake bundle: one arm64 library with the given p_align and a manifest with `perms`. */
function fake(name: string, kind: 'apk' | 'aab', align: number, perms: string[]): string {
  const out = join(dir, name);
  const py = `
import struct, sys, zipfile
out, kind, align, perms = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4:]
# ELF64 little-endian header + one PT_LOAD program header
eh = b"\\x7fELF" + bytes([2, 1, 1]) + bytes(9)
eh += struct.pack("<HHIQQQIHHHHHH", 3, 183, 1, 0, 64, 0, 0, 64, 56, 1, 0, 0, 0)
ph = struct.pack("<IIQQQQQQ", 1, 5, 0, 0, 0, 0x100, 0x100, align)
lib = eh + ph
prefix = "base/" if kind == "aab" else ""
manifest = " ".join(perms)
manifest = manifest.encode() if kind == "aab" else manifest.encode("utf-16-le")
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr(prefix + "lib/arm64-v8a/libfake.so", lib)
    z.writestr(prefix + "lib/armeabi-v7a/libfake.so", lib)
    z.writestr((prefix + "manifest/AndroidManifest.xml") if kind == "aab" else "AndroidManifest.xml", manifest)
    z.writestr(prefix + "dex/classes.dex" if kind == "aab" else "classes.dex", b"dex")
`;
  const r = spawnSync('python3', ['-I', '-c', py, out, kind, String(align), ...perms]);
  expect(r.status, r.stderr.toString()).toBe(0);
  return out;
}

function check(file: string) {
  const r = spawnSync('python3', ['-I', SCRIPT, file], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout };
}

describe.skipIf(!hasPython)('check-artifact.py', () => {
  it('passes 16 KiB-aligned libraries and a clean manifest (APK and AAB)', () => {
    for (const kind of ['apk', 'aab'] as const) {
      const r = check(fake(`ok.${kind}`, kind, 0x4000, ['android.permission.CAMERA', 'android.permission.INTERNET']));
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('lib/arm64-v8a: 1 libraries');
      expect(r.out).toContain('16 KB ok');
      expect(r.out).toContain('n/a (32-bit)');
    }
  });

  it('fails a 64-bit library aligned to 4 KiB', () => {
    const r = check(fake('4k.aab', 'aab', 0x1000, ['android.permission.CAMERA']));
    expect(r.status).toBe(1);
    expect(r.out).toContain('NOT 16 KB ready');
    expect(r.out).toContain('libfake.so (p_align 0x1000)');
  });

  it('fails a manifest that asks for a blocked permission', () => {
    for (const perm of ['android.permission.VIBRATE', 'android.permission.SYSTEM_ALERT_WINDOW']) {
      const r = check(fake('perm.apk', 'apk', 0x4000, [perm]));
      expect(r.status).toBe(1);
      expect(r.out).toContain(`forbidden permission in the manifest: ${perm}`);
    }
  });
});
