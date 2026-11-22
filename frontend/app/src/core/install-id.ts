/**
 * The app install's random id (AppPairRequest.installId): made once, kept in the app's settings
 * (no backups), sent with every pairing. When the same install pairs again (a Disconnect after a
 * false alarm, an expired token), the API hands the new token the install's earlier entries, so
 * moments that were on their way continue. Framework-free.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 16 random bytes as unpadded base64url: 22 characters. */
export function makeInstallId(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(16);
  if (bytes.length !== 16) throw new RangeError('makeInstallId needs 16 random bytes');
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += ALPHABET[(value >> bits) & 63];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (6 - bits)) & 63];
  return out;
}

export const INSTALL_ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;
