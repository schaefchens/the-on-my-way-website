/**
 * Go helper (whatsmeow) <-> Node protocol (D9).
 *
 * THIS FILE IS THE ONLY AUTHORITY FOR D9. backend/wa-helper/NOTES.md (§10, §11) and older
 * revisions of main.go described a provisional protocol (capture/connected/… events,
 * status.json/revoke.json files); both are superseded by the schemas below.
 *
 * Files (durable source of truth; events are only notifications):
 * - `inbox/<msgId>/meta.json` (InboxMeta) and `inbox/_revokes/<msgId>.json` (RevokeRecord) are
 *   written atomically (write temp, fsync, rename, fsync dir) BEFORE the matching event and,
 *   for live statuses, before whatsmeow acks the message (persist-before-ack).
 * - `<msgId>` is always the id of the STATUS (WhatsApp message id). For a revoke that is the
 *   revoked status (ProtocolMessage.key.id), never the id of the revoke message itself.
 * - MsgId must start with [A-Za-z0-9], so it can never collide with `_revokes`; the helper
 *   uses the identical regex and drops (counts) statuses whose id does not match.
 * - meta.json is created once. The helper rewrites it only to update `download` (and
 *   `media` facts learned while downloading); a redelivered or history-synced duplicate never
 *   replaces an existing meta.json.
 * - `rawProtoB64` = base64(proto.Marshal(evt.RawMessage)), a waE2E.Message, for live AND
 *   history statuses (ParseWebMessage sets RawMessage = webMsg.GetMessage()). It is required for
 *   every non-fixture status: it carries the media keys (mediaKey, directPath, fileEncSHA256)
 *   needed for redownload, media retry after a restart and `backend reprocess`.
 * - `sender.jid` = Info.Sender.ToNonAD().String() (e.g. "123456789@lid"): the exact JID the
 *   stanza used; SendMediaRetryReceipt needs it as `participant`. Required for non-fixture.
 * - width/height/seconds are omitted when WhatsApp sends 0 (nil-safe getters return 0).
 *
 * Media download lifecycle (download.state in meta.json):
 *   pending  -> ok                     downloaded and verified against FileSHA256
 *   pending  -> retrying               CDN copy gone (403/404/410): media-retry receipt sent to
 *                                      the observer phone (retryRequestedAt), waiting for
 *                                      events.MediaRetry
 *   pending|retrying -> failed         with `reason` and `permanent`
 *     permanent=true:  expired (retry answered NOT_FOUND), not_on_phone
 *                      (ErrMediaNotAvailableOnPhone), hash_mismatch
 *     permanent=false: network, timeout, unknown
 * Rules:
 *   1. On start the helper rescans every inbox/<msgId>/meta.json and resumes `pending` and `retrying`
 *      downloads (re-sending the media-retry receipt when needed); retry state is never kept
 *      only in memory.
 *   2. Node sends `redownload` only for state failed && !permanent.
 *   3. Node marks a capture media_lost when permanent === true, or when a non-permanent failure
 *      (or a retrying state) is older than MEDIA_GIVE_UP_HOURS.
 *   4. Node never deletes or moves inbox/<msgId>/ while the download is not terminal (ok, or
 *      failed && permanent), and only ever COPIES out of it (archive = copy + fsync).
 *
 * Traveler identity: the helper matches Info.Sender/SenderAlt against TRAVELER_PHONE and the
 * traveler's LID. When it learns the LID (from SenderAlt, the LID map, or an active
 * GetUserInfo lookup after the first Connected) it emits `traveler {pn, lid}`; Node persists the
 * lid (store meta) and passes it back as `-traveler-lid` on every spawn.
 *
 * whatsmeow event -> WaEvent mapping (helper supervisor policy in brackets):
 *   QR channel code                  -> qr {code, expiresAt = now + item.Timeout}
 *   PairPhone result                 -> pair_code {code}
 *   QR channel success / PairSuccess -> state pairing (reason pair_success)
 *   QR channel timeout               -> state closed (reason pair_timeout)   [Node may restart]
 *   QR channel error / PairError     -> state error (reason pair_error, detail)
 *   Connected                        -> state open (+jid)
 *   Disconnected                     -> state closed (reason disconnected)  [whatsmeow reconnects]
 *   KeepAliveTimeout                 -> state closed (reason keepalive_timeout, code=ErrorCount)
 *   KeepAliveRestored                -> state open (reason keepalive_restored)
 *   TemporaryBan                     -> state banned (reason temporary_ban, code, until)
 *                                       [no reconnect; Node waits until `until`]
 *   LoggedOut                        -> state logged_out (code=Reason); helper exits
 *                                       [Node restarts it for a fresh QR, alerts]
 *   StreamReplaced                   -> state stream_replaced; helper exits
 *                                       [never restart in a tight loop; alert]
 *   ClientOutdated                   -> state error (reason client_outdated) [bump whatsmeow pin]
 *   ConnectFailure                   -> state error (reason connect_failure, code, detail)
 *   fatal startup/runtime error      -> state error (reason fatal, detail); helper exits non-zero
 *   UndecryptableMessage (status)    -> stats counter "undecryptable"
 *   MediaRetry                       -> media event of the affected status
 *   unmatched senders                -> stats counters "other_senders", "unmatched_lid"
 *
 * Events: one JSON object per line on the helper's stdout (WaEvent); unknown keys are ignored.
 * Commands: one JSON object per line on the helper's stdin (WaCommand). Invalid or inapplicable
 * commands produce a `warning` event; the helper never exits because of a command line.
 *
 * Helper exit codes (backend/wa-helper/README.md): 0 clean shutdown (shutdown command, stdin EOF,
 * SIGTERM/SIGINT), 1 fatal error, 2 invalid configuration, 3 logged out (relink: fresh QR on the
 * next start), 4 stream replaced, 5 client outdated, 6 temporary ban, 7 pairing ended without a
 * link (QR timeout or pair error), 8 connect failure. After 4 and 6 the helper itself refuses to
 * connect again before a cooldown / the ban's end (it waits, connected to nothing), so a restart
 * can never cause a reconnect loop.
 */
import { z } from 'zod';
import { Base64, CaptureKind, Count, IsoUtc, Sha256Hex } from './common.js';

// ---------------------------------------------------------------------------------------------
// Text-status fonts (D10): WAProto ExtendedTextMessage.FontType

export const FONT_NAMES = [
  'SYSTEM',
  'SYSTEM_TEXT',
  'FB_SCRIPT',
  'SYSTEM_BOLD',
  'MORNINGBREEZE_REGULAR',
  'CALISTOGA_REGULAR',
  'EXO2_EXTRABOLD',
  'COURIERPRIME_BOLD',
] as const;
export const FontName = z.enum(FONT_NAMES);
export type FontName = z.infer<typeof FontName>;

/** FontName -> WAProto FontType number. */
export const FONT_TYPE_NUMBERS: Readonly<Record<FontName, number>> = {
  SYSTEM: 0,
  SYSTEM_TEXT: 1,
  FB_SCRIPT: 2,
  SYSTEM_BOLD: 6,
  MORNINGBREEZE_REGULAR: 7,
  CALISTOGA_REGULAR: 8,
  EXO2_EXTRABOLD: 9,
  COURIERPRIME_BOLD: 10,
};

/** WAProto FontType number -> FontName (null for unknown numbers). */
export function fontNameFromType(type: number | null | undefined): FontName | null {
  if (type === null || type === undefined) return null;
  for (const name of FONT_NAMES) if (FONT_TYPE_NUMBERS[name] === type) return name;
  return null;
}

/** WhatsApp ARGB uint32 (as sent in backgroundArgb/textArgb) -> "#rrggbbaa". */
export function argbToRgbaHex(argb: number): string {
  if (!Number.isInteger(argb) || argb < 0 || argb > 0xffffffff) {
    throw new RangeError(`Invalid ARGB value: ${argb}`);
  }
  const a = Math.floor(argb / 0x1000000) & 0xff;
  const rgb = argb % 0x1000000;
  return `#${rgb.toString(16).padStart(6, '0')}${a.toString(16).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// Identifiers and enums

/**
 * WhatsApp message id as used for inbox directory names (path-safe). The leading [A-Za-z0-9]
 * keeps it apart from "_revokes"; the Go helper uses the identical regex.
 */
export const MsgId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, {
  message: 'Expected a path-safe message id',
});
export type MsgId = z.infer<typeof MsgId>;

/** Phone number digits in international format without "+", e.g. "4915112345678". */
export const PhoneDigits = z.string().regex(/^[1-9]\d{5,15}$/, { message: 'Expected E.164 digits' });
/** WhatsApp LID user part (digits). */
export const LidDigits = z.string().regex(/^\d{1,32}$/, { message: 'Expected LID digits' });

export const WaState = z.enum([
  'connecting',
  'qr',
  'pairing',
  'open',
  'closed',
  'logged_out',
  'stream_replaced',
  'banned',
  'error',
]);
export type WaState = z.infer<typeof WaState>;

/** Structured cause of a WaStateEvent (see the mapping table in the header). */
export const WaStateReason = z.enum([
  'pair_success',
  'pair_timeout',
  'pair_error',
  'disconnected',
  'keepalive_timeout',
  'keepalive_restored',
  'temporary_ban',
  'client_outdated',
  'connect_failure',
  'fatal',
]);
export type WaStateReason = z.infer<typeof WaStateReason>;

/** How a status reached the helper. */
export const StatusSource = z.enum(['live', 'history', 'fixture']);
export type StatusSource = z.infer<typeof StatusSource>;

// ---------------------------------------------------------------------------------------------
// Events (helper stdout)

export const WaReadyEvent = z.object({ type: z.literal('ready'), version: z.string().min(1) });
export const WaStateEvent = z.object({
  type: z.literal('state'),
  state: WaState,
  reason: WaStateReason.optional(),
  /** Numeric code from whatsmeow (ban code, ConnectFailureReason, keepalive error count). */
  code: z.int().optional(),
  /** End of a temporary ban (state "banned"). */
  until: IsoUtc.optional(),
  /** Human-readable detail for logs; never parse it. */
  detail: z.string().optional(),
  jid: z.string().optional(),
  at: IsoUtc,
});
export const WaQrEvent = z.object({ type: z.literal('qr'), code: z.string().min(1), expiresAt: IsoUtc });
export const WaPairCodeEvent = z.object({ type: z.literal('pair_code'), code: z.string().min(1) });
/** Emitted AFTER inbox/<msgId>/meta.json is fsynced. */
export const WaStatusEvent = z.object({ type: z.literal('status'), msgId: MsgId, source: StatusSource });
/** Why a media download failed (see the download lifecycle in the header). */
export const DownloadFailureReason = z.enum([
  'expired',
  'not_on_phone',
  'hash_mismatch',
  'network',
  'timeout',
  'unknown',
]);
export type DownloadFailureReason = z.infer<typeof DownloadFailureReason>;

/**
 * Emitted after a download attempt changed meta.json (already updated atomically): ok, retrying
 * (media-retry receipt sent) or failed (with reason + permanent).
 */
export const WaMediaEvent = z.object({
  type: z.literal('media'),
  msgId: MsgId,
  state: z.enum(['ok', 'retrying', 'failed']),
  reason: DownloadFailureReason.optional(),
  permanent: z.boolean().optional(),
  error: z.string().optional(),
});
/**
 * Emitted after inbox/_revokes/<msgId>.json was written. msgId = the REVOKED status
 * (ProtocolMessage.key.id), not the revoke message's own id.
 */
export const WaRevokeEvent = z.object({ type: z.literal('revoke'), msgId: MsgId, at: IsoUtc });
/** The traveler's identity as learned by the helper. */
export const WaTravelerEvent = z.object({
  type: z.literal('traveler'),
  pn: PhoneDigits,
  lid: LidDigits.optional(),
});
/**
 * Counters since helper start. Known names: captured, other_senders, unmatched_lid,
 * undecryptable, status_stanzas, media_ok, media_failed, media_retry, invalid_id; also revokes,
 * history_statuses, persist_failed, handler_panics, media_retry_answers, invalid_commands and
 * the gauge media_active (unfinished downloads). Emitted every 60 s, on `stats` and at exit.
 */
export const WaStatsEvent = z.object({
  type: z.literal('stats'),
  counters: z.record(z.string(), z.number()),
});
/**
 * Non-fatal problem for Node's log; the helper keeps running. Codes: invalid_command (the stdin
 * line is not a valid WaCommand), command_rejected (valid, but not applicable now, e.g. mark_read
 * while read receipts are disabled, redownload of a download that is not failed), command_failed
 * (the WhatsApp call behind a valid command failed). Never parse `detail`.
 */
export const WaWarningEvent = z.object({
  type: z.literal('warning'),
  code: z.enum(['invalid_command', 'command_rejected', 'command_failed']),
  /** The WaCommand type the warning refers to, when known. */
  command: z.string().max(32).optional(),
  msgId: MsgId.optional(),
  detail: z.string().optional(),
});

export const WaEvent = z.discriminatedUnion('type', [
  WaReadyEvent,
  WaStateEvent,
  WaQrEvent,
  WaPairCodeEvent,
  WaStatusEvent,
  WaMediaEvent,
  WaRevokeEvent,
  WaTravelerEvent,
  WaStatsEvent,
  WaWarningEvent,
]);
export type WaEvent = z.infer<typeof WaEvent>;
export type WaEventType = WaEvent['type'];

export type ParsedLine<T> = { ok: true; value: T } | { ok: false; error: string; line: string };

/** Parses one stdout line of the helper. Never throws. */
export function parseWaEventLine(line: string): ParsedLine<WaEvent> {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${(err as Error).message}`, line };
  }
  const result = WaEvent.safeParse(json);
  if (!result.success) return { ok: false, error: z.prettifyError(result.error), line };
  return { ok: true, value: result.data };
}

// ---------------------------------------------------------------------------------------------
// Commands (helper stdin)

export const WaCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pair_code'), phone: PhoneDigits }),
  z.object({ type: z.literal('logout') }),
  z.object({ type: z.literal('mark_read'), msgId: MsgId }),
  z.object({ type: z.literal('redownload'), msgId: MsgId }),
  z.object({ type: z.literal('stats') }),
  z.object({ type: z.literal('shutdown') }),
]);
export type WaCommand = z.infer<typeof WaCommand>;

/** Serializes a command as one JSON line (validates first). */
export function serializeWaCommand(command: WaCommand): string {
  return `${JSON.stringify(WaCommand.parse(command))}\n`;
}

// ---------------------------------------------------------------------------------------------
// Inbox files

export const INBOX_META_FILE = 'meta.json';
export const INBOX_REVOKES_DIR = '_revokes';

/** Same values as CaptureKind. */
export const InboxKind = CaptureKind;
export type InboxKind = CaptureKind;

const Argb = z.int().min(0).max(0xffffffff);

export const InboxText = z.object({
  body: z.string(),
  bgArgb: Argb.nullable(),
  textArgb: Argb.nullable(),
  font: FontName.nullable(),
});
export type InboxText = z.infer<typeof InboxText>;

export const InboxMedia = z.object({
  mimetype: z.string().min(1),
  /** FileSHA256 from the message (sha256 of the decrypted file), base64. */
  fileSha256B64: Base64,
  fileLength: Count,
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
  seconds: z.number().min(0).optional(),
  ptt: z.boolean().optional(),
  gifPlayback: z.boolean().optional(),
  /** Voice waveform as sent by WhatsApp (usually 64 bytes, 0–100), base64. */
  waveformB64: Base64.optional(),
});
export type InboxMedia = z.infer<typeof InboxMedia>;

export const DownloadState = z.enum(['pending', 'retrying', 'ok', 'failed', 'not_applicable']);
export type DownloadState = z.infer<typeof DownloadState>;

export const InboxDownload = z.object({
  state: DownloadState,
  /** File name inside the message directory, e.g. "original.jpg". */
  file: z
    .string()
    .regex(/^original\.[a-z0-9]{1,8}$/)
    .optional(),
  /** sha256 of the downloaded file, lowercase hex. */
  sha256Hex: Sha256Hex.optional(),
  attempts: Count,
  /** Required for state "failed". */
  reason: DownloadFailureReason.optional(),
  /** Required for state "failed": true = the media can never be downloaded again. */
  permanent: z.boolean().optional(),
  /** When the media-retry receipt was (last) sent to the observer phone. */
  retryRequestedAt: IsoUtc.optional(),
  /** Free text for logs. */
  error: z.string().optional(),
});
export type InboxDownload = z.infer<typeof InboxDownload>;

/** "<user>@s.whatsapp.net" or "<user>@lid" (non-AD, no device part). */
export const SenderJid = z
  .string()
  .regex(/^\d{1,32}@(?:s\.whatsapp\.net|lid)$/, { message: 'Expected a non-AD user JID' });

export const InboxSender = z.object({
  pn: PhoneDigits.optional(),
  lid: LidDigits.optional(),
  /** Info.Sender.ToNonAD().String(): the identity the stanza used (needed for media retry). */
  jid: SenderJid.optional(),
  pushName: z.string().optional(),
});
export type InboxSender = z.infer<typeof InboxSender>;

export const MEDIA_KINDS: ReadonlySet<CaptureKind> = new Set<CaptureKind>(['photo', 'video', 'gif', 'voice']);

/** True for kinds that carry a downloadable media file. */
export function isMediaKind(kind: CaptureKind): boolean {
  return MEDIA_KINDS.has(kind);
}

/** inbox/<msgId>/meta.json */
export const InboxMeta = z
  .object({
    schema: z.literal(1),
    msgId: MsgId,
    source: StatusSource,
    receivedAt: IsoUtc,
    sender: InboxSender,
    /** Message timestamp (when the traveler posted it), ISO UTC. */
    timestamp: IsoUtc,
    kind: InboxKind,
    caption: z.string().optional(),
    text: InboxText.optional(),
    media: InboxMedia.optional(),
    download: InboxDownload,
    /** For kind "unsupported": the WAProto message field that was present. */
    unsupportedType: z.string().optional(),
    /** base64(proto.Marshal(evt.RawMessage)) (waE2E.Message); required unless source "fixture". */
    rawProtoB64: Base64.optional(),
    /** Info.AddressingMode of the stanza (live statuses only). */
    addressingMode: z.enum(['pn', 'lid']).optional(),
    /** Info.StanzaTag: "status" (new <status> stanza) or "message" (live statuses only). */
    stanzaTag: z.string().max(32).optional(),
  })
  .superRefine((meta, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
    const media = MEDIA_KINDS.has(meta.kind);
    const state = meta.download.state;
    if (meta.kind === 'text' && !meta.text) issue(['text'], 'kind "text" requires text');
    if (meta.kind !== 'text' && meta.text) issue(['text'], 'only kind "text" may carry text');
    if (media && !meta.media) issue(['media'], `kind "${meta.kind}" requires media`);
    if (!media && meta.media) issue(['media'], `kind "${meta.kind}" must not carry media`);
    if (media && state === 'not_applicable') issue(['download', 'state'], 'media kinds need a download state');
    if (!media && state !== 'not_applicable')
      issue(['download', 'state'], `kind "${meta.kind}" has nothing to download`);
    if (state === 'ok' && (!meta.download.file || !meta.download.sha256Hex)) {
      issue(['download'], 'download.state "ok" requires file and sha256Hex');
    }
    if (state === 'failed' && (meta.download.reason === undefined || meta.download.permanent === undefined)) {
      issue(['download'], 'download.state "failed" requires reason and permanent');
    }
    if (meta.source !== 'fixture') {
      if (!meta.rawProtoB64) issue(['rawProtoB64'], 'rawProtoB64 is required for live and history statuses');
      if (!meta.sender.jid) issue(['sender', 'jid'], 'sender.jid is required for live and history statuses');
    }
  });

/** True when the download can no longer change (Node may then copy the original and clean up). */
export function isTerminalDownload(download: InboxDownload): boolean {
  return (
    download.state === 'ok' ||
    download.state === 'not_applicable' ||
    (download.state === 'failed' && download.permanent === true)
  );
}
export type InboxMeta = z.infer<typeof InboxMeta>;

/** inbox/_revokes/<msgId>.json; msgId = the revoked status (ProtocolMessage.key.id). */
export const RevokeRecord = z.object({ schema: z.literal(1), msgId: MsgId, at: IsoUtc });
export type RevokeRecord = z.infer<typeof RevokeRecord>;
