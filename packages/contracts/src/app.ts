/**
 * Traveler app <-> API protocol (app-plan §3.3–3.6, owner decisions A1–A5, Q2 c, Q4 a, Q6 c, Q8 a).
 *
 * THIS FILE IS THE AUTHORITY for the app's wire format: the entry payload, the tus 1.0 subset for
 * the resumable uploads, pairing and the entry status vocabulary. Everything here is additive
 * (no contractVersion bump). Schemas listed in APP_SCHEMAS are exported to api/schemas/<Name>.json
 * by `pnpm schemas`, next to the API_SCHEMAS of ./api.
 *
 * WhatsApp compatibility (A2): an app entry is exactly what a WhatsApp status can be. Overlays are
 * baked into the pixels on the phone; the caption is separate text; text statuses are body + ARGB
 * colours + WhatsApp's FontType (the InboxText fields of ./wa); voice is audio. The only additive
 * metadata is the alt text (WhatsApp's own accessibilityLabel), the source marker and the private
 * original. There are NO coordinates, layers, mentions or interactive stickers in this contract.
 *
 * Identity: entryId is a client ULID made at "Share", sourceKey = "app:<ULID>" (appSourceKey), the
 * public id is the usual publicIdForSourceKey() hash. The ULID never appears in static output.
 *
 * Endpoints (prefix /api/v1, app routes need `Authorization: Bearer <app token>` with scope
 * "capture"; route names are proposals for the API agent, chosen not to collide with wave 5's
 * followers/devices/access routes):
 *
 *   POST   /app/pair                         AppPairRequest -> AppPairResponse (201), unauthenticated,
 *                                            rate-limited like login
 *   POST   /admin/app-pairings               AppPairingCreate -> AppPairingCreated (201), admin session
 *   POST   /app/entries                      AppEntryCreate -> AppEntryState (201 new, 200 replay)
 *   GET    /app/entries/{entryId}            -> AppEntryState
 *   GET    /app/entries?ids=<ULID,…>         -> AppEntryListResponse (at most 50 ids)
 *   DELETE /app/entries/{entryId}            withdraw -> 204 (also when already withdrawn)
 *   HEAD   /app/uploads/{uploadId}           tus offset probe (see APP_TUS below)
 *   PATCH  /app/uploads/{uploadId}           one chunk (see APP_TUS below)
 *   POST   /app/entries/{entryId}/commit     AppCommitRequest -> AppEntryState
 *   GET    /app/hints                        -> AppHints
 *
 * Rules the exported JSON Schema cannot express (zod refinements here; PHP must enforce them with
 * the same semantics and answer 422 "validation_failed"; fixtures/vectors/app-entries.json holds
 * accepted and rejected payloads for both runtimes):
 * - appEntryProblems(): kind <-> text/media/caption/alt/files, mimetypes per kind and role, size
 *   and duration limits (APP_LIMITS), unique file roles, unique uploadIds.
 * - IANA time zone: as in ./api (isValidTimeZone).
 * Server-side rules (vectors in fixtures/vectors/app-time.json): correctAppOccurredAt() for the
 * clock skew, the 24 h clamp and the 30-day "Hold back" rule. Idempotency: appEntryHash()
 * (canonical JSON, vectors in fixtures/vectors/app-canonical.json); a replayed create with the same
 * entryId and hash answers 200 with the current state, a different hash 409 "entry_conflict".
 */
import { z } from 'zod';
import { ContractVersion, Count, IsoUtc, LocalDate, Sha256Hex, SourceKey, TimeZone, Visibility } from './common.js';
import { bytesToHex, hexToBytes, isSourceKey, parseSourceKey, sha256Hex, WA_SOURCE_NS } from './ids.js';
import { FontName } from './wa.js';

// ---------------------------------------------------------------------------------------------
// Identity and limits

export const APP_SOURCE_NS = 'app';
export const APP_SOURCE = 'app' as const;

/** Client ULID (Crockford base32, 26 chars, uppercase), made at "Share". */
export const AppEntryId = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, { message: 'Expected a ULID' });
export type AppEntryId = z.infer<typeof AppEntryId>;

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** "app:<ULID>" */
export function appSourceKey(entryId: string): string {
  if (!ULID_RE.test(entryId)) throw new RangeError(`Invalid app entry id: ${entryId}`);
  return `${APP_SOURCE_NS}:${entryId}`;
}

export function isAppSourceKey(value: unknown): value is string {
  return isSourceKey(value) && parseSourceKey(value).ns === APP_SOURCE_NS;
}

/** Where a capture came from. Derived from the sourceKey namespace, never stored or published. */
export const CaptureOrigin = z.enum(['whatsapp', 'app']);
export type CaptureOrigin = z.infer<typeof CaptureOrigin>;

/** "wa:…" -> whatsapp, "app:…" -> app, anything else -> null. */
export function captureOrigin(sourceKey: string): CaptureOrigin | null {
  if (!isSourceKey(sourceKey)) return null;
  const { ns } = parseSourceKey(sourceKey);
  return ns === WA_SOURCE_NS ? 'whatsapp' : ns === APP_SOURCE_NS ? 'app' : null;
}

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

/**
 * Limits of v0.5 (app-plan §3.5). The server may announce tighter per-file limits through 413/507;
 * it never accepts more than these.
 */
export const APP_LIMITS = {
  captionChars: 1024,
  textChars: 700,
  altChars: 1000,
  videoSeconds: 60,
  voiceSeconds: 60,
  photoMaxLongSide: 2880,
  photoMaxShortSide: 1600,
  videoMaxLongSide: 1920,
  /** The published artifact (JPEG/MP4/M4A). */
  mediaMaxBytes: 100 * MiB,
  /** The 640w JPEG preview the admin shows while the home computer sleeps. */
  previewMaxBytes: 512 * KiB,
  previewWidth: 640,
  /** The untouched original for the private archive (Q2 c: photos AND videos). */
  originalMaxBytes: 4 * GiB,
  /** Files per entry: media, preview, original. */
  filesPerEntry: 3,
  /** Ids per GET /app/entries?ids=… */
  listIds: 50,
} as const;

// ---------------------------------------------------------------------------------------------
// Entry payload

/** v0.5 kinds: CaptureKind without gif (v1.1) and unsupported. */
export const AppEntryKind = z.enum(['photo', 'video', 'text', 'voice']);
export type AppEntryKind = z.infer<typeof AppEntryKind>;

/** ARGB uint32 as WhatsApp sends it (backgroundArgb / textArgb). */
export const AppArgb = z.int().min(0).max(0xffffffff);
/** Fully opaque ARGB (alpha 0xff): text-status backgrounds. */
export const AppOpaqueArgb = z.int().min(0xff000000).max(0xffffffff);

/**
 * A text status: the InboxText fields of ./wa, all set. The background is opaque; the app uses
 * white text (0xffffffff) on its 12 backgrounds, but any ARGB is valid, as on WhatsApp.
 */
export const AppText = z.object({
  body: z.string().min(1).max(APP_LIMITS.textChars),
  bgArgb: AppOpaqueArgb,
  textArgb: AppArgb,
  font: FontName,
});
export type AppText = z.infer<typeof AppText>;

/**
 * Media facts of the published artifact, named like ./wa InboxMedia. The mimetype, size and hash
 * live in `files` (role "media").
 */
export const AppMedia = z.object({
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
  /** Duration in seconds (video, voice). */
  seconds: z.number().min(0).optional(),
  /** Voice notes are push-to-talk recordings, as on WhatsApp. */
  ptt: z.boolean().optional(),
  /** Alt text (WhatsApp's accessibilityLabel): pre-filled from the baked words, editable (v0.6). */
  accessibilityLabel: z.string().min(1).max(APP_LIMITS.altChars).optional(),
});
export type AppMedia = z.infer<typeof AppMedia>;

/**
 * media: the published artifact. preview: 640w JPEG for the admin. original: the untouched source
 * for the private archive (Q2 c), never published or mirrored, uploaded only on unmetered networks.
 */
export const AppFileRole = z.enum(['media', 'preview', 'original']);
export type AppFileRole = z.infer<typeof AppFileRole>;

/** Mimetype of the published artifact per kind (none for text). */
export const APP_MEDIA_MIMETYPES = {
  photo: 'image/jpeg',
  video: 'video/mp4',
  voice: 'audio/mp4',
} as const satisfies Partial<Record<AppEntryKind, string>>;

export const APP_PREVIEW_MIMETYPE = 'image/jpeg';

/** Originals as phones produce them (the archive keeps them byte for byte). */
export const APP_ORIGINAL_MIMETYPES = {
  photo: ['image/jpeg', 'image/heic', 'image/heif', 'image/png', 'image/webp', 'image/avif', 'image/dng'],
  video: ['video/mp4', 'video/quicktime', 'video/3gpp', 'video/webm'],
} as const satisfies Partial<Record<AppEntryKind, readonly string[]>>;

/** Server-chosen id of one upload slot: "u_" + 16–64 URL-safe chars. */
export const AppUploadId = z.string().regex(/^u_[A-Za-z0-9_-]{16,64}$/, { message: 'Expected u_ + id' });
export type AppUploadId = z.infer<typeof AppUploadId>;

export const AppFile = z.object({
  role: AppFileRole,
  mimetype: z.string().min(1).max(100),
  bytes: z.int().min(1),
  sha256Hex: Sha256Hex,
});
export type AppFile = z.infer<typeof AppFile>;

/** Build that made the entry, for tracing problems (private, never published). */
export const AppClient = z.object({
  /** versionName, e.g. "2026.11.20-1a2b3c4". */
  app: z.string().min(1).max(40),
  platform: z.enum(['android', 'ios']),
  /** OS version, e.g. "16". */
  os: z.string().max(32).optional(),
});
export type AppClient = z.infer<typeof AppClient>;

/** "Hold back" (pending) or "Only for me" (hidden), set by the app; "As usual" = absent. */
export const AppVisibilityChoice = z.enum(['pending', 'hidden']);
export type AppVisibilityChoice = z.infer<typeof AppVisibilityChoice>;

const AppEntryShape = z.object({
  schema: z.literal(1),
  entryId: AppEntryId,
  source: z.literal(APP_SOURCE),
  kind: AppEntryKind,
  /** The "Share" tap on the phone's clock; the API corrects it (correctAppOccurredAt). */
  occurredAt: IsoUtc,
  /** The phone's IANA zone at "Share". */
  tz: TimeZone,
  /** photo and video only (like WhatsApp). */
  caption: z.string().min(1).max(APP_LIMITS.captionChars).optional(),
  /** kind "text" only. */
  text: AppText.optional(),
  /** photo, video and voice. */
  media: AppMedia.optional(),
  /** "Put it on that day?" for an older gallery photo: written as an app-set localDateOverride. */
  localDate: LocalDate.optional(),
  /** Publish-sheet choice; absent = "As usual". Applied as an app-set annotation. */
  visibility: AppVisibilityChoice.optional(),
  /** Empty for text; media (+ preview, + original) for the other kinds. */
  files: z.array(AppFile).max(APP_LIMITS.filesPerEntry),
  client: AppClient,
});

/** Problems the JSON Schema cannot express (same messages in PHP are not required, codes are). */
export interface AppEntryProblem {
  path: (string | number)[];
  message: string;
}

const MEDIA_KINDS = new Set<AppEntryKind>(['photo', 'video', 'voice']);

/** An entry that passed the field schemas (before the cross-field rules). */
export type AppEntryFields = z.infer<typeof AppEntryShape>;

/** The cross-field rules of an app entry. Pure; PHP mirrors it (fixtures/vectors/app-entries.json). */
export function appEntryProblems(entry: AppEntryFields): AppEntryProblem[] {
  const out: AppEntryProblem[] = [];
  const add = (path: (string | number)[], message: string) => out.push({ path, message });
  const { kind, media, files } = entry;
  const isMedia = MEDIA_KINDS.has(kind);

  if (kind === 'text' && !entry.text) add(['text'], 'kind "text" requires text');
  if (kind !== 'text' && entry.text) add(['text'], 'only kind "text" may carry text');
  if (isMedia && !media) add(['media'], `kind "${kind}" requires media`);
  if (!isMedia && media) add(['media'], `kind "${kind}" must not carry media`);
  if (entry.caption !== undefined && kind !== 'photo' && kind !== 'video') {
    add(['caption'], 'only photo and video carry a caption');
  }

  if (media) {
    const visual = kind === 'photo' || kind === 'video';
    if (visual && (media.width === undefined || media.height === undefined)) {
      add(['media'], `kind "${kind}" requires width and height`);
    }
    if (kind === 'voice' && (media.width !== undefined || media.height !== undefined)) {
      add(['media'], 'voice has no width or height');
    }
    if ((kind === 'video' || kind === 'voice') && media.seconds === undefined) {
      add(['media', 'seconds'], `kind "${kind}" requires seconds`);
    }
    if (kind === 'photo' && media.seconds !== undefined) add(['media', 'seconds'], 'a photo has no duration');
    const maxSeconds = kind === 'video' ? APP_LIMITS.videoSeconds : APP_LIMITS.voiceSeconds;
    if (media.seconds !== undefined && media.seconds > maxSeconds) {
      add(['media', 'seconds'], `at most ${maxSeconds} s`);
    }
    if (media.ptt !== undefined && kind !== 'voice') add(['media', 'ptt'], 'only voice is push-to-talk');
    if (media.accessibilityLabel !== undefined && !visual) {
      add(['media', 'accessibilityLabel'], 'only photo and video carry alt text');
    }
    if (media.width !== undefined && media.height !== undefined) {
      const long = Math.max(media.width, media.height);
      const short = Math.min(media.width, media.height);
      if (kind === 'photo' && (long > APP_LIMITS.photoMaxLongSide || short > APP_LIMITS.photoMaxShortSide)) {
        add(['media'], `photo larger than ${APP_LIMITS.photoMaxLongSide}×${APP_LIMITS.photoMaxShortSide}`);
      }
      if (kind === 'video' && long > APP_LIMITS.videoMaxLongSide) {
        add(['media'], `video long side above ${APP_LIMITS.videoMaxLongSide}`);
      }
    }
  }

  const roles = new Set<AppFileRole>();
  files.forEach((file, i) => {
    if (roles.has(file.role)) add(['files', i, 'role'], `duplicate role "${file.role}"`);
    roles.add(file.role);
    if (!isMedia) {
      add(['files', i], `kind "${kind}" has no files`);
      return;
    }
    if (file.role === 'media') {
      const want = APP_MEDIA_MIMETYPES[kind as keyof typeof APP_MEDIA_MIMETYPES];
      if (file.mimetype !== want) add(['files', i, 'mimetype'], `kind "${kind}" needs ${want}`);
      if (file.bytes > APP_LIMITS.mediaMaxBytes) add(['files', i, 'bytes'], 'media file too large');
    } else if (file.role === 'preview') {
      if (kind === 'voice') add(['files', i, 'role'], 'voice has no preview');
      if (file.mimetype !== APP_PREVIEW_MIMETYPE) add(['files', i, 'mimetype'], 'preview must be image/jpeg');
      if (file.bytes > APP_LIMITS.previewMaxBytes) add(['files', i, 'bytes'], 'preview too large');
    } else {
      if (kind === 'voice') {
        add(['files', i, 'role'], 'voice has no original');
      } else {
        const allowed: readonly string[] = APP_ORIGINAL_MIMETYPES[kind as 'photo' | 'video'];
        if (!allowed.includes(file.mimetype)) add(['files', i, 'mimetype'], `unsupported original ${file.mimetype}`);
      }
      if (file.bytes > APP_LIMITS.originalMaxBytes) add(['files', i, 'bytes'], 'original too large');
    }
  });
  if (isMedia && !roles.has('media')) add(['files'], `kind "${kind}" requires a media file`);
  return out;
}

/** The entry an app uploads: WhatsApp-status fields + additive metadata. */
export const AppEntry = AppEntryShape.superRefine((entry, ctx) => {
  for (const p of appEntryProblems(entry)) ctx.addIssue({ code: 'custom', path: p.path, message: p.message });
});
export type AppEntry = z.infer<typeof AppEntry>;

/** POST /api/v1/app/entries */
export const AppEntryCreate = z.object({
  contractVersion: ContractVersion,
  /** The phone's clock when sending this request (skew correction). */
  clientNow: IsoUtc,
  entry: AppEntry,
});
export type AppEntryCreate = z.infer<typeof AppEntryCreate>;

// ---------------------------------------------------------------------------------------------
// Upload slots and the tus 1.0 subset

/**
 * tus 1.0 core subset + checksum (sha256) + an X-HTTP-Method-Override fallback. "Creation" is the
 * entry create: POST /app/entries answers one slot per declared file.
 *
 * HEAD  /app/uploads/{id}   -> 200, headers Tus-Resumable, Upload-Offset, Upload-Length,
 *                              Cache-Control: no-store. Only after a failure, never before every chunk.
 * PATCH /app/uploads/{id}   request headers Tus-Resumable: 1.0.0,
 *                              Content-Type: application/offset+octet-stream, Content-Length,
 *                              Upload-Offset (must equal the stored offset),
 *                              Upload-Checksum: "sha256 <base64 digest of this chunk>";
 *                           -> 204 with the new Upload-Offset. The chunk is appended only when the
 *                              whole body arrived and its digest matches (no partial appends).
 * Hosts that block PATCH/HEAD: POST with X-HTTP-Method-Override: PATCH | HEAD (same semantics).
 *
 * Errors (body ApiError, code in parentheses; Upload-Offset is always sent on 409/460):
 *   409 (offset_mismatch)  Upload-Offset differs: continue from the returned offset
 *   460 (checksum_mismatch) chunk digest differs: resend the chunk
 *   413 (upload_too_large) chunk above chunkMaxBytes, or offset + chunk > Upload-Length
 *   415 (unsupported_media_type) wrong Content-Type
 *   404 (not_found) unknown or expired slot (72 h) · 410 (gone) the entry was withdrawn
 *   503 (transfer_busy) + Retry-After: the single transfer slot is taken
 *   507 (inbox_full) the API's inbox budget is full: retry later (Retry-After)
 *   401 (unauthorized | token_revoked) · 403 (forbidden) wrong scope or another token's entry
 *   429 (rate_limited) + Retry-After
 * The client keeps APP_REQUEST_BUDGET and backs off on every 4xx/5xx except a 409 with an offset.
 */
export const APP_TUS = {
  version: '1.0.0',
  contentType: 'application/offset+octet-stream',
  checksumAlgorithm: 'sha256',
  headers: {
    resumable: 'Tus-Resumable',
    offset: 'Upload-Offset',
    length: 'Upload-Length',
    checksum: 'Upload-Checksum',
    methodOverride: 'X-HTTP-Method-Override',
    retryAfter: 'Retry-After',
  },
  status: {
    created: 201,
    chunkAccepted: 204,
    offsetMismatch: 409,
    gone: 410,
    tooLarge: 413,
    unsupportedType: 415,
    checksumMismatch: 460,
    busy: 503,
    inboxFull: 507,
  },
} as const;

/** Chunk bounds the server announces; the client adapts inside them (nextChunkBytes). */
export const APP_CHUNKS = {
  minBytes: 256 * KiB,
  maxBytes: 8 * MiB,
  startBytes: 1 * MiB,
  /** Aim for at most this many seconds per PATCH at the measured throughput. */
  targetSeconds: 15,
} as const;

/** At most this many requests per window, across all app routes (the host's IP-block guard). */
export const APP_REQUEST_BUDGET = {
  maxRequests: 10,
  windowSeconds: 10,
  /** Exponential backoff with full jitter on errors, honouring Retry-After when it is longer. */
  backoffBaseMs: 2000,
  backoffMaxMs: 15 * 60 * 1000,
} as const;

/** One declared file's upload slot. */
export const AppUploadSlot = z.object({
  uploadId: AppUploadId,
  role: AppFileRole,
  /** Upload-Length: the file's total size. */
  bytes: z.int().min(1),
  /** Bytes the server holds (tus Upload-Offset). */
  offset: Count,
  /** True once committed (sha256 of the whole file verified). */
  committed: z.boolean(),
  /**
   * True once the home archive verified and kept it (the backend's ack; the API deleted its copy).
   * For the original (Q2 c) this is when "free up space on the phone" may be offered.
   */
  archived: z.boolean().optional(),
});
export type AppUploadSlot = z.infer<typeof AppUploadSlot>;

/** POST /api/v1/app/entries/{entryId}/commit: verify and seal these files. */
export const AppCommitRequest = z.object({
  roles: z.array(AppFileRole).min(1).max(APP_LIMITS.filesPerEntry),
});
export type AppCommitRequest = z.infer<typeof AppCommitRequest>;
/*
 * Commit rules: every named role must be fully uploaded (offset = bytes), else 409 "incomplete".
 * The server hashes the whole file; on a mismatch it resets that slot to offset 0 and answers 422
 * "sha256_mismatch". The entry becomes "uploaded" once "media" (and "preview" when declared) are
 * committed; the "original" is committed on its own, later, on Wi-Fi. Committing a committed role
 * again changes nothing (200).
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 with padding (no atob/btoa: the module runs in Node, browsers and Hermes alike). */
function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] ?? '';
    out += B64[(n >> 12) & 63] ?? '';
    out += i + 1 < bytes.length ? (B64[(n >> 6) & 63] ?? '') : '=';
    out += i + 2 < bytes.length ? (B64[n & 63] ?? '') : '=';
  }
  return out;
}

/** "Upload-Checksum" header value for a chunk digest (lowercase hex in, base64 out). */
export function formatUploadChecksum(digestHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(digestHex)) throw new RangeError('Expected a sha256 hex digest');
  return `${APP_TUS.checksumAlgorithm} ${bytesToBase64(hexToBytes(digestHex))}`;
}

/** Parses "sha256 <base64>" into a lowercase hex digest; null for anything else. */
export function parseUploadChecksum(header: string): string | null {
  const m = /^sha256 ([A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=)$/.exec(header.trim());
  if (!m?.[1]) return null;
  const chars = m[1].slice(0, 43);
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of chars) {
    buffer = (buffer << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return bytes.length === 32 ? bytesToHex(new Uint8Array(bytes)) : null;
}

export type ChunkOutcome = { ok: true; bytes: number; ms: number } | { ok: false };

/**
 * Reference for the client's adaptive chunk size (the Kotlin uploader mirrors it; vectors in
 * fixtures/vectors/app-chunks.json): after a success, aim for targetSeconds at the measured
 * throughput but at most double; after any failure, halve. Always inside [min, max] and a
 * multiple of 64 KiB.
 */
export function nextChunkBytes(
  current: number,
  outcome: ChunkOutcome,
  bounds: { minBytes: number; maxBytes: number } = APP_CHUNKS,
): number {
  const step = 64 * KiB;
  const clamp = (n: number) => Math.min(bounds.maxBytes, Math.max(bounds.minBytes, n));
  let next: number;
  if (!outcome.ok) {
    next = current / 2;
  } else {
    const perSecond = outcome.ms > 0 ? (outcome.bytes * 1000) / outcome.ms : Number.POSITIVE_INFINITY;
    next = Math.min(current * 2, perSecond * APP_CHUNKS.targetSeconds);
  }
  return clamp(Math.floor(clamp(next) / step) * step);
}

// ---------------------------------------------------------------------------------------------
// Entry state and the status vocabulary

/**
 * Server-side state of an entry in the API's transit inbox:
 * receiving (slots open) -> uploaded (media committed; waits for the home computer) -> fetching
 * (the backend is downloading) -> archived (acked; files deleted on the API). withdrawn: deleted by
 * the app. rejected: the backend refused it (rejectReason).
 */
export const AppEntryServerState = z.enum(['receiving', 'uploaded', 'fetching', 'archived', 'withdrawn', 'rejected']);
export type AppEntryServerState = z.infer<typeof AppEntryServerState>;

/** GET /api/v1/app/entries/{entryId}, and the answer of create and commit. */
export const AppEntryState = z.object({
  entryId: AppEntryId,
  sourceKey: SourceKey,
  state: AppEntryServerState,
  /** occurredAt after the server's correction (correctAppOccurredAt). */
  occurredAt: IsoUtc,
  receivedAt: IsoUtc,
  /** The 30-day rule turned the entry into "Hold back" (app-plan §3.3). */
  heldBack: z.boolean(),
  uploads: z.array(AppUploadSlot),
  chunk: z.object({ minBytes: z.int().positive(), maxBytes: z.int().positive() }),
  /** When the home computer last talked to the API (null = never). */
  backendLastSeenAt: IsoUtc.nullable(),
  rejectReason: z.string().max(200).nullish(),
  /**
   * Publication facts once the backend mirrored the capture (null before, and always in
   * archive-only mode): effective visibility and the publish state of ./api itemPublishState.
   */
  publish: z
    .object({
      visibility: Visibility,
      state: z.enum(['live', 'publishing', 'not_public']),
      publishAt: IsoUtc.nullable(),
    })
    .nullable(),
});
export type AppEntryState = z.infer<typeof AppEntryState>;

/** GET /api/v1/app/entries?ids=… (unknown ids are left out). */
export const AppEntryListResponse = z.object({ items: z.array(AppEntryState) });
export type AppEntryListResponse = z.infer<typeof AppEntryListResponse>;

/** GET /api/v1/app/hints: what the queue and the publish sheet need to word things. */
export const AppHints = z.object({
  /** Q8 a: entries reach the home archive, nothing is published. */
  archiveOnly: z.boolean(),
  /** The site's publish delay in hours (0 = instant), for "appears in about 24 h". */
  delayHours: z.number().min(0),
  backendLastSeenAt: IsoUtc.nullable(),
  chunk: z.object({ minBytes: z.int().positive(), maxBytes: z.int().positive() }),
  /** Free bytes of the API's inbox budget (null = unknown). */
  inboxFreeBytes: Count.nullable(),
  /**
   * The largest single file the inbox accepts (half its budget, at most the role limits of
   * APP_LIMITS). Declare an original only when it fits; a larger one stays on the phone, else the
   * create answers 413 upload_too_large (nothing is stored, so it can be sent again without it).
   */
  fileMaxBytes: Count.optional(),
  serverNow: IsoUtc,
});
export type AppHints = z.infer<typeof AppHints>;

/**
 * The one status vocabulary of the app (ux.md §3.11), from "Preparing…" to "Archived ✓" / "Live ✓".
 * The app derives it from its outbox, the native uploader and AppEntryState; the labels live in
 * the app's catalogs (de/en). Order = the order of a happy path.
 */
export const APP_ENTRY_STATUSES = [
  /** Baking and encoding on the phone ("Preparing…"). */
  'preparing',
  /** Manual mode: waits for her "Upload now" ("Ready to upload"). */
  'ready',
  /** No network, or the API is unreachable ("Waiting for network"). */
  'waiting_network',
  /** Wi-Fi only (or originals/videos) on mobile data or a metered Wi-Fi ("Waiting for Wi-Fi"). */
  'waiting_wifi',
  /** Roaming and "also while roaming" is off for this SIM ("Waiting for Wi-Fi (roaming)"). */
  'waiting_roaming',
  /** Chunks in flight ("Uploading · 42 %"). */
  'uploading',
  /** The API has it; the home computer has not fetched it yet ("Uploaded"). */
  'uploaded',
  /** In the home archive; archive-only mode publishes nothing ("Archived ✓"). */
  'archived',
  /** The backend is building or deploying ("Publishing…"). */
  'publishing',
  /** Delayed by the publish policy ("Appears at 21:40"). */
  'scheduled',
  /** Hold back / review ("Waiting for your release"). */
  'held',
  /** Only for me ("Only for you"). */
  'hidden',
  /** On every publish target ("Live ✓"). */
  'live',
  /** A permanent failure that needs her ("Needs you"). */
  'needs_you',
] as const;
export const AppEntryStatus = z.enum(APP_ENTRY_STATUSES);
export type AppEntryStatus = z.infer<typeof AppEntryStatus>;

// ---------------------------------------------------------------------------------------------
// Server time rules (PHP mirrors them; vectors in fixtures/vectors/app-time.json)

export const APP_TIME_RULES = {
  /** A clock skew beyond this means the phone's clock is wrong: use the receive time. */
  maxSkewMs: 24 * 60 * 60 * 1000,
  /** Entries older than this on arrival are accepted as "Hold back" with an admin note. */
  holdBackAfterMs: 30 * 24 * 60 * 60 * 1000,
} as const;

export interface CorrectedOccurredAt {
  /** ISO UTC with milliseconds ("…T10:00:00.000Z"). */
  occurredAt: string;
  /** The phone's time could not be trusted, so the receive time was used. */
  clamped: boolean;
  /** Older than 30 days on arrival: accept as "Hold back". */
  heldBack: boolean;
}

/**
 * occurredAt := phone occurredAt + (serverNow - clientNow). A skew beyond 24 h, or a result in the
 * future, falls back to serverNow (a wrong phone clock can never backdate an entry past the delay).
 * The photo's EXIF time is never used.
 */
export function correctAppOccurredAt(input: {
  occurredAt: string;
  clientNow: string;
  serverNow: string;
}): CorrectedOccurredAt {
  const occurred = Date.parse(input.occurredAt);
  const client = Date.parse(input.clientNow);
  const server = Date.parse(input.serverNow);
  if ([occurred, client, server].some(Number.isNaN)) throw new RangeError('Invalid instant');
  const skew = server - client;
  let corrected = occurred + skew;
  let clamped = false;
  if (Math.abs(skew) > APP_TIME_RULES.maxSkewMs || corrected > server) {
    corrected = server;
    clamped = true;
  }
  return {
    occurredAt: new Date(corrected).toISOString(),
    clamped,
    heldBack: server - corrected > APP_TIME_RULES.holdBackAfterMs,
  };
}

// ---------------------------------------------------------------------------------------------
// Idempotency: canonical JSON and the entry hash (PHP mirrors it; app-canonical.json)

/**
 * Canonical JSON: object keys sorted by UTF-16 code units (PHP: ksort with SORT_STRING on the
 * UTF-8 keys gives the same order for the ASCII keys used here), no whitespace, JSON.stringify's
 * string escaping (PHP: JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE |
 * JSON_UNESCAPED_LINE_TERMINATORS), integers without a fraction, other numbers in their shortest
 * round-trip form (entries only hold integers and durations like 12.5, never exponent forms).
 * undefined members are dropped; arrays keep their order.
 */
export function appCanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('Non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : appCanonicalJson(v))).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${appCanonicalJson(v)}`).join(',')}}`;
  }
  throw new TypeError(`Not JSON: ${typeof value}`);
}

/** sha256 hex of the canonical JSON of an entry (the idempotency key next to entryId). */
export async function appEntryHash(entry: AppEntry): Promise<string> {
  return sha256Hex(appCanonicalJson(entry));
}

// ---------------------------------------------------------------------------------------------
// Pairing (Q4 a: the app token carries only the narrow "capture" scope)

/** Scope of app tokens made by pairing. Not an api.ts TokenScope yet (merged with wave 5 later). */
export const APP_TOKEN_SCOPE = 'capture' as const;
export const AppTokenScope = z.literal(APP_TOKEN_SCOPE);

/** Same alphabet as ULIDs: Crockford base32 without I, L, O, U. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const APP_PAIRING = {
  /** Custom-scheme link; the code sits in the fragment. The API base comes from the app build, never from a link. */
  linkPrefix: 'omw://pair#',
  /** 128-bit link code: 26 Crockford base32 chars. */
  linkCodeChars: 26,
  /** Typed code: 8 Crockford base32 chars, shown as "ABCD-EFGH". */
  typedCodeChars: 8,
  ttlMinutesDefault: 60,
  ttlMinutesMax: 24 * 60,
  ttlMinutesMin: 5,
} as const;

/** A normalized pairing code: the 26-char link form or the 8-char typed form. */
export const AppPairingCode = z.union([
  z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, { message: 'Expected a 26-char link code' }),
  z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/, { message: 'Expected an 8-char code' }),
]);
export type AppPairingCode = z.infer<typeof AppPairingCode>;

/**
 * Normalizes what she typed or what a link carried: trims, drops spaces and dashes, upper-cases and
 * maps Crockford's look-alikes (O -> 0, I/L -> 1). null when the result is not 8 or 26 valid chars.
 */
export function normalizeAppPairingCode(input: string): string | null {
  const s = input
    .trim()
    .toUpperCase()
    .replace(/[\s -]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length !== APP_PAIRING.typedCodeChars && s.length !== APP_PAIRING.linkCodeChars) return null;
  for (const ch of s) if (!CROCKFORD.includes(ch)) return null;
  return s;
}

/** "ABCDEFGH" -> "ABCD-EFGH" (display only). */
export function formatAppTypedPairingCode(code: string): string {
  return code.length === APP_PAIRING.typedCodeChars ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** The pairing code inside an "omw://pair#<code>" link; null for any other URL. */
export function appPairingCodeFromLink(url: string): string | null {
  const m = /^omw:\/\/pair\/?#(.+)$/i.exec(url.trim());
  if (!m?.[1]) return null;
  let raw: string;
  try {
    raw = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  const code = normalizeAppPairingCode(raw);
  return code?.length === APP_PAIRING.linkCodeChars ? code : null;
}

export function appPairingLink(linkCode: string): string {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(linkCode)) throw new RangeError('Expected a 26-char link code');
  return `${APP_PAIRING.linkPrefix}${linkCode}`;
}

/** POST /api/v1/admin/app-pairings (admin session): one single-use code, two forms. */
export const AppPairingCreate = z.object({
  ttlMinutes: z.int().min(APP_PAIRING.ttlMinutesMin).max(APP_PAIRING.ttlMinutesMax).optional(),
});
export type AppPairingCreate = z.infer<typeof AppPairingCreate>;

export const AppPairingCreated = z.object({
  /** "omw://pair#<26 chars>" */
  link: z.string().regex(/^omw:\/\/pair#[0-9A-HJKMNP-TV-Z]{26}$/),
  /** "ABCD-EFGH" */
  typedCode: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/),
  expiresAt: IsoUtc,
});
export type AppPairingCreated = z.infer<typeof AppPairingCreated>;

/**
 * POST /api/v1/app/pair (unauthenticated, rate-limited like login). Consuming the code and making
 * the token happen in one transaction; the owner gets an alert ("A phone was connected: …").
 * Errors: 401 pairing_invalid (unknown or used code), 410 pairing_expired, 429 rate_limited.
 */
export const AppPairRequest = z.object({
  contractVersion: ContractVersion,
  code: AppPairingCode,
  /** e.g. "Pixel 8a"; becomes the token's name. */
  deviceName: z.string().min(1).max(100),
  platform: z.enum(['android', 'ios']),
  appVersion: z.string().min(1).max(40),
  /**
   * Random id of this app install (base64url, made once, kept on the phone, never in a backup).
   * When the same install pairs again, the new token takes over the install's earlier entries, so
   * moments that were on their way continue (the API stores only its sha256). Optional: older
   * builds pair without it.
   */
  installId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{22,64}$/)
    .optional(),
});
export type AppPairRequest = z.infer<typeof AppPairRequest>;

export const AppTokenInfo = z.object({
  id: z.int().positive(),
  name: z.string().max(100),
  scopes: z.array(AppTokenScope).min(1),
  createdAt: IsoUtc,
  /** Sliding expiry (about 180 days, extended on use); null = none. */
  expiresAt: IsoUtc.nullable(),
});
export type AppTokenInfo = z.infer<typeof AppTokenInfo>;

export const AppPairResponse = z.object({
  /** Shown exactly once; the app keeps it in TokenVault only. */
  token: z.string().regex(/^omw_[A-Za-z0-9_-]{43}$/),
  info: AppTokenInfo,
});
export type AppPairResponse = z.infer<typeof AppPairResponse>;

// ---------------------------------------------------------------------------------------------
// Error codes of the app routes (ApiError.error.code) and their HTTP status

export const APP_ERROR_CODES = {
  validation_failed: 422,
  entry_conflict: 409,
  offset_mismatch: 409,
  incomplete: 409,
  sha256_mismatch: 422,
  checksum_mismatch: 460,
  upload_too_large: 413,
  unsupported_media_type: 415,
  not_found: 404,
  gone: 410,
  transfer_busy: 503,
  inbox_full: 507,
  unauthorized: 401,
  token_revoked: 401,
  forbidden: 403,
  rate_limited: 429,
  pairing_invalid: 401,
  pairing_expired: 410,
} as const;
export type AppErrorCode = keyof typeof APP_ERROR_CODES;

// ---------------------------------------------------------------------------------------------
// JSON Schema export registry (merged with API_SCHEMAS by ./json-schema)

export type AppSchemaIo = 'input' | 'output';

export const APP_SCHEMAS = {
  AppEntryCreate: [AppEntryCreate, 'input'],
  AppEntryState: [AppEntryState, 'output'],
  AppEntryListResponse: [AppEntryListResponse, 'output'],
  AppCommitRequest: [AppCommitRequest, 'input'],
  AppHints: [AppHints, 'output'],
  AppPairingCreate: [AppPairingCreate, 'input'],
  AppPairingCreated: [AppPairingCreated, 'output'],
  AppPairRequest: [AppPairRequest, 'input'],
  AppPairResponse: [AppPairResponse, 'output'],
} as const satisfies Record<string, readonly [z.ZodType, AppSchemaIo]>;
export type AppSchemaName = keyof typeof APP_SCHEMAS;
