/**
 * The server side of the traveler app (app-plan §3.6–3.7, owner decisions Q2 c, Q4 a, Q8 a):
 * the bodies of the API's transit inbox that ./app (the phone's wire format) does not cover.
 *
 *   App (Bearer capture token, see ./app):
 *     PUT    /app/visibility/{sourceKey}            AppVisibilityRequest -> AppEntryState
 *                                                   tighten only, own app entries only (Q4 a)
 *     DELETE /app/uploads/{uploadId}                tus termination of an "original" slot -> 204
 *                                                   (she frees the space without backing it up)
 *   Admin (session):
 *     POST   /admin/app-pairings                    ./app AppPairingCreate -> AppPairingCreated (201)
 *     GET    /admin/app-phones                      -> AppPhoneListResponse
 *     DELETE /admin/app-phones/{id}                 "Disconnect" -> 204 (also when already disconnected)
 *     GET    /admin/app-entries/{sourceKey}         -> AppEntryAdminInfo (the App badge's details)
 *   Backend (Bearer backend token):
 *     GET    /backend/app/entries?archiveOnly=0|1   -> AppInboxResponse; the query reports the
 *                                                   backend's archive-only switch (AppHints)
 *     GET    /backend/app/uploads/{uploadId}/content  the committed file; Range: bytes=N- -> 206;
 *                                                   takes the transfer slot (503 + Retry-After)
 *     POST   /backend/app/entries/{entryId}/ack     AppInboxAck -> 204 (idempotent)
 *     POST   /backend/app/entries/{entryId}/reject  AppInboxReject -> 204 (idempotent)
 *
 * Capture tokens live in their own table (api `app_phones`), never in `api_tokens`: they can
 * not reach the admin or backend routes by construction, and the wave-5 token work stays
 * independent. Their scope is always ["capture"] (./app APP_TOKEN_SCOPE).
 */
import { z } from 'zod';
import { AppEntry, AppEntryId, AppEntryServerState, AppFileRole, AppUploadId, AppVisibilityChoice } from './app.js';
import { Count, IsoUtc, SourceKey } from './common.js';

// ---------------------------------------------------------------------------------------------
// App

/**
 * "Hold back" or "Only for me" for one of her own app entries. The server only tightens (as usual
 * < pending < hidden) and never changes what the owner decided in the admin (403 owner_decided);
 * loosening needs the owner (403 needs_owner). WhatsApp captures and other phones' entries: 403.
 */
export const AppVisibilityRequest = z.object({
  visibility: AppVisibilityChoice,
});
export type AppVisibilityRequest = z.infer<typeof AppVisibilityRequest>;

// ---------------------------------------------------------------------------------------------
// Admin: "Connect a phone"

export const AppPhone = z.object({
  id: z.int().positive(),
  /** deviceName from the pairing, e.g. "Pixel 8a". */
  name: z.string().max(100),
  platform: z.enum(['android', 'ios']),
  appVersion: z.string().max(40),
  createdAt: IsoUtc,
  lastUsedAt: IsoUtc.nullable(),
  /** Sliding expiry (about 180 days, extended on use). */
  expiresAt: IsoUtc.nullable(),
  /** Set once the owner disconnected the phone. */
  revokedAt: IsoUtc.nullable(),
  entries: z.object({
    /** Entries this phone created. */
    total: Count,
    /** Entries still in the API's inbox (receiving, uploaded, fetching). */
    inInbox: Count,
  }),
});
export type AppPhone = z.infer<typeof AppPhone>;

export const AppPhoneListResponse = z.object({
  /** Connected phones first (newest first), then disconnected ones. */
  items: z.array(AppPhone),
  /** The unused pairing code, if one is open (creating a new one cancels it). */
  openPairing: z.object({ expiresAt: IsoUtc }).nullable(),
  /** What the API's inbox holds and may hold (APP_INBOX_MAX_BYTES). */
  inbox: z.object({ usedBytes: Count, maxBytes: Count }),
  /** The backend's archive-only switch as last reported (true until it reported). */
  archiveOnly: z.boolean(),
});
export type AppPhoneListResponse = z.infer<typeof AppPhoneListResponse>;

/** Details for the admin's App badge (GET /admin/app-entries/{sourceKey}). */
export const AppEntryAdminInfo = z.object({
  sourceKey: SourceKey,
  state: AppEntryServerState,
  phone: z.object({ id: z.int().positive(), name: z.string().max(100), revoked: z.boolean() }),
  receivedAt: IsoUtc,
  /** The phone's clock could not be trusted; the receive time was used. */
  clamped: z.boolean(),
  /** Arrived more than 30 days after "Share": accepted as "Hold back" (app-plan §3.3). */
  heldBack: z.boolean(),
  /** What the app set at "Share" or later (an app-set annotation), null = "As usual". */
  appVisibility: AppVisibilityChoice.nullable(),
  /** The untouched original is in the home archive (Q2 c). */
  originalArchived: z.boolean(),
  rejectReason: z.string().max(200).nullable(),
});
export type AppEntryAdminInfo = z.infer<typeof AppEntryAdminInfo>;

// ---------------------------------------------------------------------------------------------
// Backend: the pull side of the inbox

export const AppInboxFileState = z.enum([
  /** Still uploading. */
  'open',
  /** Complete and sha256-verified: the backend may download it. */
  'committed',
  /** The backend acked it; the API deleted the bytes. */
  'archived',
  /** The phone gave up on it (DELETE /app/uploads/{id}, originals only). */
  'abandoned',
  /** Deleted with its entry (withdrawn, rejected or expired). */
  'deleted',
]);
export type AppInboxFileState = z.infer<typeof AppInboxFileState>;

export const AppInboxFile = z.object({
  uploadId: AppUploadId,
  role: AppFileRole,
  mimetype: z.string().min(1).max(100),
  bytes: z.int().min(1),
  sha256Hex: z.string().regex(/^[0-9a-f]{64}$/),
  state: AppInboxFileState,
});
export type AppInboxFile = z.infer<typeof AppInboxFile>;

/**
 * One entry the backend has to act on:
 * - state uploaded|fetching: download the committed files (sha256-check them), archive, ack;
 * - state archived with a committed original: download and archive the original (Q2 c), ack it;
 * - withdrawnAt set: she withdrew it after the backend may have archived it: revoke the capture
 *   (ingest.on_revoke applies), then ack with `withdrawal: true`.
 */
export const AppInboxItem = z.object({
  entryId: AppEntryId,
  sourceKey: SourceKey,
  state: AppEntryServerState,
  /** After the server's correction (correctAppOccurredAt); entry.occurredAt is the phone's. */
  occurredAt: IsoUtc,
  receivedAt: IsoUtc,
  clamped: z.boolean(),
  heldBack: z.boolean(),
  phone: z.object({ id: z.int().positive(), name: z.string().max(100) }),
  /** The entry exactly as the phone sent it. */
  entry: AppEntry,
  files: z.array(AppInboxFile),
  withdrawnAt: IsoUtc.nullable(),
});
export type AppInboxItem = z.infer<typeof AppInboxItem>;

export const AppInboxResponse = z.object({
  /** Oldest first, at most `limit` (default 20). */
  items: z.array(AppInboxItem),
  /** More items wait (ask again right after this page). */
  hasMore: z.boolean(),
  serverNow: IsoUtc,
});
export type AppInboxResponse = z.infer<typeof AppInboxResponse>;

/**
 * The backend archived these roles (sha256 verified, files fsynced in ARCHIVE_DIR): the API deletes
 * them. Acking "media" (or any ack of a text entry) makes the entry "archived". `withdrawal`
 * confirms that a withdrawal (AppInboxItem.withdrawnAt) was applied. Replays change nothing.
 */
export const AppInboxAck = z.object({
  roles: z.array(AppFileRole).max(3),
  withdrawal: z.boolean().optional(),
});
export type AppInboxAck = z.infer<typeof AppInboxAck>;

/** The backend cannot use the entry (e.g. a file that never matches its sha256): "Needs you". */
export const AppInboxReject = z.object({
  reason: z.string().min(1).max(200),
});
export type AppInboxReject = z.infer<typeof AppInboxReject>;

/** Defaults of the API's inbox (app-plan §3.6; the operator tunes them per host). */
export const APP_INBOX_DEFAULTS = {
  /** APP_INBOX_MAX_BYTES: at most 10 % of the account quota; 1 GiB until the quota is known. */
  maxBytes: 1024 * 1024 * 1024,
  /** APP_TRANSFER_SLOTS: concurrent PATCH bodies + backend downloads (the host's PHP workers). */
  transferSlots: 1,
  /** Upload slots of entries that never complete are deleted after this many hours. */
  staleSlotHours: 72,
  /** Sliding expiry of a capture token. */
  tokenDays: 180,
  /** GET /backend/app/entries page size. */
  pageSize: 20,
} as const;

// ---------------------------------------------------------------------------------------------
// JSON Schema export registry (merged into api/schemas by ./json-schema)

export const APP_INBOX_SCHEMAS = {
  AppVisibilityRequest: [AppVisibilityRequest, 'input'],
  AppPhone: [AppPhone, 'output'],
  AppPhoneListResponse: [AppPhoneListResponse, 'output'],
  AppEntryAdminInfo: [AppEntryAdminInfo, 'output'],
  AppInboxItem: [AppInboxItem, 'output'],
  AppInboxResponse: [AppInboxResponse, 'output'],
  AppInboxAck: [AppInboxAck, 'input'],
  AppInboxReject: [AppInboxReject, 'input'],
} as const satisfies Record<string, readonly [z.ZodType, 'input' | 'output']>;
export type AppInboxSchemaName = keyof typeof APP_INBOX_SCHEMAS;
