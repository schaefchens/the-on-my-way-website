/**
 * SSH host key pinning. Fingerprints use the OpenSSH format "SHA256:<base64 without padding>" of
 * the raw public key blob (what `ssh-keygen -lf` and `ssh -o FingerprintHash=sha256` print).
 */
import { createHash } from 'node:crypto';

export const HOST_KEY_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

/**
 * Pinned host keys of hosts this project deploys to, used when a target has no explicit pins.
 * Hetzner shared hosting (live static site and API).
 */
export const KNOWN_HOST_KEYS: Readonly<Record<string, readonly string[]>> = {
  'www99.your-server.de': [
    'SHA256:1ckzga7xTCnKZNsqpWVAh4K85X9HmVe+5Ki1PW7tOQs', // ED25519
    'SHA256:gQnQinEqX7NMlkAYbI8WiXGzkSfQWisi2SxHo7B2ebQ', // RSA
  ],
};

/** "SHA256:…" fingerprint of a raw SSH public key blob. */
export function fingerprintOf(keyBlob: Buffer): string {
  return `SHA256:${createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '')}`;
}

/** Key type from the blob ("ssh-ed25519", "ssh-rsa", …) or null when it cannot be parsed. */
export function keyTypeOf(keyBlob: Buffer): string | null {
  if (keyBlob.length < 4) return null;
  const len = keyBlob.readUInt32BE(0);
  if (len === 0 || len > 64 || keyBlob.length < 4 + len) return null;
  const type = keyBlob.subarray(4, 4 + len).toString('latin1');
  return /^[a-z0-9@.-]+$/.test(type) ? type : null;
}

/** Default pins for a host (empty when unknown). */
export function defaultHostKeys(host: string): string[] {
  return [...(KNOWN_HOST_KEYS[host.toLowerCase()] ?? [])];
}

/** Normalizes a user-provided fingerprint list ("SHA256:a, SHA256:b" or array); throws on bad input. */
export function parseFingerprints(value: string | readonly string[]): string[] {
  const parts = (typeof value === 'string' ? value.split(/[\s,]+/) : [...value]).map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (!HOST_KEY_FINGERPRINT.test(p)) throw new RangeError(`Not an SSH SHA256 fingerprint: ${p}`);
  }
  return [...new Set(parts)];
}
