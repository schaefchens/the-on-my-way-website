/**
 * Shared primitives used by every contract module.
 *
 * Rules (see docs/PLAN.md, decisions D3–D6):
 * - Instants are ISO-8601 UTC strings ending in "Z" (no offsets, no z.date()).
 * - Local dates are "YYYY-MM-DD" calendar dates.
 * - Paths inside static data files are relative to the site root, without a leading slash.
 * - No transforms/defaults in schemas, so `z.toJSONSchema` can export them for PHP.
 */
import { z } from 'zod';
import { isValidLocalDate, isValidTimeZone } from './time.js';

/** Bump only together with a coordinated API-first deploy (plan section D). */
export const contractVersion = 1 as const;
export const CONTRACT_VERSION = contractVersion;
export const ContractVersion = z.literal(contractVersion);

/** ISO-8601 instant in UTC, e.g. "2026-11-18T02:12:00Z" or "2026-11-18T02:12:00.000Z". */
export const IsoUtc = z.iso.datetime({ offset: false, local: false });
export type IsoUtc = z.infer<typeof IsoUtc>;

/** Calendar date "YYYY-MM-DD" (validated to be a real date). */
export const LocalDate = z.iso.date().refine(isValidLocalDate, { message: 'Invalid calendar date' });
export type LocalDate = z.infer<typeof LocalDate>;

/** IANA time zone name, e.g. "Asia/Ho_Chi_Minh". Offsets like "+07:00" are rejected. */
export const TimeZone = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_+\-/]*$/, { message: 'Expected an IANA time zone name' })
  .refine(isValidTimeZone, { message: 'Unknown IANA time zone' });
export type TimeZone = z.infer<typeof TimeZone>;

/** Opaque colour "#rrggbb" (lowercase). */
export const HexColor = z.string().regex(/^#[0-9a-f]{6}$/, { message: 'Expected #rrggbb' });
export type HexColor = z.infer<typeof HexColor>;

/** Colour with alpha "#rrggbbaa" (lowercase). */
export const RgbaColor = z.string().regex(/^#[0-9a-f]{8}$/, { message: 'Expected #rrggbbaa' });
export type RgbaColor = z.infer<typeof RgbaColor>;

/** Standard base64 (with padding). */
export const Base64 = z.base64();

/** Lowercase hex sha256 digest. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, { message: 'Expected sha256 hex' });

/**
 * Path relative to the static site root (D3): no leading slash, no "..", no query/fragment.
 * Example: "media/ab/ab12cd34ef56ab78_w640.avif".
 */
export const RelPath = z
  .string()
  .min(1)
  .max(512)
  .regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._~\-/]+$/, { message: 'Expected a relative site path' });
export type RelPath = z.infer<typeof RelPath>;

/** Short content hash used as cache buster (`?v=`) for data files. */
export const ContentHash = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/, {
  message: 'Expected a short content hash',
});

/** URL-safe slug, e.g. "vietnam-2026". */
export const Slug = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'Expected a lowercase slug' });
export type Slug = z.infer<typeof Slug>;

/** Stable key of a captured item, namespace + id. WhatsApp: "wa:<msgId>" (D4). */
export const SourceKey = z
  .string()
  .max(160)
  .regex(/^[a-z]+:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, { message: 'Expected "<ns>:<id>"' });
export type SourceKey = z.infer<typeof SourceKey>;

/** Public id of a capture: "e_" + 12 lowercase base32 chars (D4). */
export const CapturePublicId = z.string().regex(/^e_[a-z2-7]{12}$/, {
  message: 'Expected e_ + 12 base32 chars',
});
/** Public id of an owner post as issued by the API: "p_…". */
export const PostPublicId = z.string().regex(/^p_[A-Za-z0-9_-]{4,64}$/, {
  message: 'Expected p_ + id',
});
/** Any public entry id (capture or post). */
export const EntryId = z.union([CapturePublicId, PostPublicId]);
export type EntryId = z.infer<typeof EntryId>;

/** ISO-3166-1 alpha-2 country code, uppercase. */
export const CountryCode = z.string().regex(/^[A-Z]{2}$/, { message: 'Expected ISO-3166 alpha-2' });
export type CountryCode = z.infer<typeof CountryCode>;

export const Latitude = z.number().min(-90).max(90);
export const Longitude = z.number().min(-180).max(180);

/** Visibility of an item (D11). */
export const Visibility = z.enum(['public', 'hidden', 'pending']);
export type Visibility = z.infer<typeof Visibility>;

/** Kinds of captured WhatsApp statuses. */
export const CaptureKind = z.enum(['photo', 'video', 'gif', 'voice', 'text', 'unsupported']);
export type CaptureKind = z.infer<typeof CaptureKind>;

/** Kinds of owner-authored posts. */
export const PostKind = z.enum(['note', 'story']);
export type PostKind = z.infer<typeof PostKind>;

/** Non-negative safe integer. */
export const Count = z.int().min(0);
