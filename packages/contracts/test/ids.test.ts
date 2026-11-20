import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base32Lower,
  bytesToHex,
  hexToBytes,
  isCapturePublicId,
  isPostPublicId,
  isSourceKey,
  parseSourceKey,
  publicIdForSourceKey,
  publicIdFromSha256Hex,
  sha256Hex,
  waSourceKey,
} from '../src/ids.js';

/** Independent reference implementation: bit string -> 5-bit groups. */
function referenceBase32(bytes: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const bits = [...bytes].map((b) => b.toString(2).padStart(8, '0')).join('');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

const enc = (s: string) => new TextEncoder().encode(s);

describe('base32Lower', () => {
  it('matches the RFC 4648 test vectors (lowercase, no padding)', () => {
    expect(base32Lower(enc(''))).toBe('');
    expect(base32Lower(enc('f'))).toBe('my');
    expect(base32Lower(enc('fo'))).toBe('mzxq');
    expect(base32Lower(enc('foo'))).toBe('mzxw6');
    expect(base32Lower(enc('foob'))).toBe('mzxw6yq');
    expect(base32Lower(enc('fooba'))).toBe('mzxw6ytb');
    expect(base32Lower(enc('foobar'))).toBe('mzxw6ytboi');
  });

  it('agrees with a reference implementation on digests', () => {
    for (let i = 0; i < 50; i++) {
      const digest = createHash('sha256').update(`k${i}`).digest();
      expect(base32Lower(digest)).toBe(referenceBase32(digest));
    }
  });
});

describe('hex helpers', () => {
  it('round-trips', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    expect(bytesToHex(bytes)).toBe('00017f80ff');
    expect([...hexToBytes('00017f80ff')]).toEqual([...bytes]);
    expect(() => hexToBytes('abc')).toThrow(RangeError);
  });
});

describe('sha256Hex (Web Crypto)', () => {
  it('matches node:crypto for strings and bytes', async () => {
    for (const s of ['', 'abc', 'wa:3EB0C767D26A1D8B7A3B', 'Hội An · 09:12']) {
      const expected = createHash('sha256').update(s, 'utf8').digest('hex');
      expect(await sha256Hex(s)).toBe(expected);
      expect(await sha256Hex(enc(s))).toBe(expected);
    }
  });
});

describe('publicIdForSourceKey (D4)', () => {
  it('is "e_" + first 12 base32 chars of sha256(sourceKey)', async () => {
    const key = 'wa:3EB0C767D26A1D8B7A3B';
    const digest = createHash('sha256').update(key).digest();
    const expected = `e_${referenceBase32(digest).slice(0, 12)}`;
    expect(await publicIdForSourceKey(key)).toBe(expected);
    expect(publicIdFromSha256Hex(digest.toString('hex'))).toBe(expected);
  });

  it('is deterministic and pinned (PHP must produce the same values)', async () => {
    expect(await publicIdForSourceKey('wa:3EB0C767D26A1D8B7A3B')).toBe(
      await publicIdForSourceKey('wa:3EB0C767D26A1D8B7A3B'),
    );
    expect(await publicIdForSourceKey('wa:ABC123')).toMatchInlineSnapshot(`"e_uyhb2dbiu56w"`);
    expect(await publicIdForSourceKey('wa:3EB0C767D26A1D8B7A3B')).toMatchInlineSnapshot(`"e_j6gd4lgqgjff"`);
  });

  it('produces valid, distinct capture ids', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = await publicIdForSourceKey(waSourceKey(`MSG${i}`));
      expect(isCapturePublicId(id)).toBe(true);
      ids.add(id);
    }
    expect(ids.size).toBe(500);
  });

  it('rejects invalid keys and digests', async () => {
    await expect(publicIdForSourceKey('3EB0')).rejects.toThrow(RangeError);
    await expect(publicIdForSourceKey('wa:../etc')).rejects.toThrow(RangeError);
    expect(() => publicIdFromSha256Hex('xyz')).toThrow(RangeError);
  });
});

describe('source keys and id predicates', () => {
  it('builds and parses source keys', () => {
    expect(waSourceKey('3EB0C767D26A1D8B7A3B')).toBe('wa:3EB0C767D26A1D8B7A3B');
    expect(parseSourceKey('wa:3EB0')).toEqual({ ns: 'wa', id: '3EB0' });
    expect(() => waSourceKey('../x')).toThrow(RangeError);
    expect(() => parseSourceKey('nope')).toThrow(RangeError);
    expect(isSourceKey('wa:AB_c-1')).toBe(true);
    expect(isSourceKey('WA:AB')).toBe(false);
  });

  it('classifies public ids', () => {
    expect(isCapturePublicId('e_abcdefgh2345')).toBe(true);
    expect(isCapturePublicId('e_abcdefgh2341')).toBe(false); // 1 is not base32
    expect(isCapturePublicId('e_ABCDEFGH2345')).toBe(false);
    expect(isPostPublicId('p_01HX7Z')).toBe(true);
    expect(isPostPublicId('p_')).toBe(false);
  });
});
