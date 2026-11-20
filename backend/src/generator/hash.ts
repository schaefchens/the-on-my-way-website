/**
 * Hashing helpers of the generator.
 *
 * - canonicalJson(): JSON with recursively sorted keys (undefined members dropped), so hashes do
 *   not depend on key order. Same definition as frontend/site/scripts/make-dev-data.ts.
 * - contentHash(): the `v` cache buster of data files (D3): first 16 hex chars of
 *   sha256(canonicalJson(body)), where `body` is the file without its own `v`.
 *   Timeline: manifest.timeline.v = contentHash({ trips, days }), plus `profile` only when the
 *   timeline has one (generatedAt and contractVersion are not part of it).
 */
import { createHash } from 'node:crypto';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Short (16 hex) sha256 of file bytes, used in the generator state. */
export function shortSha(data: string | Uint8Array): string {
  return sha256Hex(data).slice(0, 16);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Content hash used as `v` (16 hex chars; matches ContentHash in @omw/contracts). */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value)).slice(0, 16);
}

/** CSP source expression for an inline <script>/<style> body: 'sha256-<base64>'. */
export function cspHash(text: string): string {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}
