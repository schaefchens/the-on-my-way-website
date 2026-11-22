/**
 * Public ids (D4).
 *
 *   capture publicId = "e_" + base32(sha256(utf8(sourceKey)))[0..12], lowercase
 *
 * - base32 = RFC 4648 alphabet (a–z, 2–7), no padding, applied to the 32 raw digest bytes;
 *   12 chars = 60 bits.
 * - sourceKey for WhatsApp = "wa:<msgId>". WhatsApp message ids never appear in static output.
 * - Posts keep the publicId issued by the API ("p_…") inside the API and the admin; the static
 *   site publishes a derived id instead (wave 5, E16), so the API's ids (ULIDs, which carry their
 *   creation time) never appear in static output:
 *
 *     published post id = "p_" + base32(sha256(utf8("post:" + publicId)))[0..16], lowercase
 *
 *   16 chars = 80 bits; it matches the PostPublicId pattern, so story routes and NoteEntry /
 *   StoryEntry ids keep their schema.
 *
 * Hashing choice: Web Crypto (`globalThis.crypto.subtle`), which exists in Node >= 20 and in
 * browsers, so this module never imports `node:crypto` and is safe in every bundle. Web Crypto
 * is async; callers that already hold a digest (e.g. from node:crypto `createHash`) can use the
 * synchronous `publicIdFromSha256Hex`.
 */

export const CAPTURE_ID_PREFIX = 'e_';
export const POST_ID_PREFIX = 'p_';
export const WA_SOURCE_NS = 'wa';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lowercase, without padding. */
export function base32Lower(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) throw new RangeError('Invalid hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** sha256 of a UTF-8 string or bytes, lowercase hex (Web Crypto, async). */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return bytesToHex(new Uint8Array(digest));
}

/** Derives the capture publicId from an already computed sha256 hex digest of the sourceKey. */
export function publicIdFromSha256Hex(digestHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(digestHex)) throw new RangeError('Expected a sha256 hex digest');
  return CAPTURE_ID_PREFIX + base32Lower(hexToBytes(digestHex)).slice(0, 12);
}

/** Public id for a capture sourceKey, e.g. "wa:3EB0…" -> "e_k3j…" (async, Web Crypto). */
export async function publicIdForSourceKey(sourceKey: string): Promise<string> {
  if (!isSourceKey(sourceKey)) throw new RangeError(`Invalid sourceKey: ${sourceKey}`);
  return publicIdFromSha256Hex(await sha256Hex(sourceKey));
}

/** Published id of an owner post from an already computed sha256 hex digest of "post:" + publicId. */
export function publishedPostIdFromSha256Hex(digestHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(digestHex)) throw new RangeError('Expected a sha256 hex digest');
  return POST_ID_PREFIX + base32Lower(hexToBytes(digestHex)).slice(0, 16);
}

/** Published id of an owner post: "p_" + base32(sha256("post:" + publicId))[0..16] (E16; async, Web Crypto). */
export async function publishedPostId(publicId: string): Promise<string> {
  if (!isPostPublicId(publicId)) throw new RangeError(`Invalid post publicId: ${publicId}`);
  return publishedPostIdFromSha256Hex(await sha256Hex(`post:${publicId}`));
}

const SOURCE_KEY_RE = /^([a-z]+):([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;
const MSG_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isSourceKey(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_KEY_RE.test(value);
}

/** "wa:<msgId>" (D4). */
export function waSourceKey(msgId: string): string {
  if (!MSG_ID_RE.test(msgId)) throw new RangeError(`Invalid WhatsApp msgId: ${msgId}`);
  return `${WA_SOURCE_NS}:${msgId}`;
}

export function parseSourceKey(sourceKey: string): { ns: string; id: string } {
  const m = SOURCE_KEY_RE.exec(sourceKey);
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new RangeError(`Invalid sourceKey: ${sourceKey}`);
  }
  return { ns: m[1], id: m[2] };
}

export function isCapturePublicId(value: unknown): value is string {
  return typeof value === 'string' && /^e_[a-z2-7]{12}$/.test(value);
}

export function isPostPublicId(value: unknown): value is string {
  return typeof value === 'string' && /^p_[A-Za-z0-9_-]{4,64}$/.test(value);
}
