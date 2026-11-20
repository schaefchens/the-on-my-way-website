/**
 * Backend <-> API sync bodies, owner entities and admin API DTOs (plan B, A6).
 * Every schema listed in API_SCHEMAS is exported as JSON Schema (draft 2020-12) to
 * api/schemas/<Name>.json by `pnpm schemas`; PHP validates against those files.
 *
 * Conventions:
 * - PATCH bodies: absent field = unchanged, null = clear.
 * - Timestamps are ISO UTC strings; dates are "YYYY-MM-DD".
 * - Output fields that map to nullable DB columns accept null AND omission (`.nullish()`), so a
 *   PHP serializer may emit NULL columns as null. Consumers treat null like absent.
 * - Optimistic concurrency: PATCH/PUT bodies may carry `ifUpdatedAt` (the updatedAt the client
 *   last saw). The API answers 409 ApiError "conflict" when the stored updatedAt differs (or the
 *   row does not exist although ifUpdatedAt was sent). Omit it to overwrite unconditionally.
 * - Idempotent creates: posts get a client-chosen publicId (e.g. "p_" + ULID); POST /posts with
 *   a known publicId returns the existing post (200) instead of inserting again.
 *   DELETE /posts/{id} answers 204 also when the post is already gone.
 *
 * Rules the exported JSON Schema cannot express (zod refinements here; PHP must enforce them
 * with the same semantics before any DB write and answer 422 "validation_failed"):
 * - IANA time zones: same rule as isValidTimeZone() in ./time (name syntax + known to the zone
 *   database). PHP: preg_match + in_array($tz, DateTimeZone::listIdentifiers()) or 'UTC'.
 * - Settings: site.default_locale ∈ site.locales; site.locales unique (see settingsProblems()).
 * - TripUpsert: endDate >= startDate; ranges of different trips must not overlap
 *   (overlappingTrips() in ./policy).
 * - PostCreate: content has at least one locale and contains origLocale.
 *
 * API error codes (ApiError.error.code): validation_failed (422), conflict (409), feed_reset (409),
 * not_found (404), capture_not_mirrored (404), unsupported_media_type (415), payload_too_large
 * (413), unauthorized (401), forbidden / csrf (403), rate_limited (429), internal (500).
 */
import { z } from 'zod';
import {
  Base64,
  CaptureKind,
  CapturePublicId,
  ContractVersion,
  Count,
  CountryCode,
  HexColor,
  IsoUtc,
  Latitude,
  LocalDate,
  Longitude,
  PostPublicId,
  Slug,
  SourceKey,
  TimeZone,
  Visibility,
} from './common.js';
import { I18nText, LocaleCode } from './i18n.js';
import { TextStyle } from './site.js';
import { WaState } from './wa.js';

/** change_log seq of an entity's latest write (0 = never written). */
export const ChangeSeq = z.int().min(0);

// ---------------------------------------------------------------------------------------------
// Backend -> API

export const PreviewRole = z.enum(['preview', 'poster']);
export type PreviewRole = z.infer<typeof PreviewRole>;

/**
 * POST /api/v1/backend/captures/{sourceKey}/preview — multipart/form-data with the fields
 * `role` (PreviewRole) and `file` (640w WebP; JPEG accepted). Answers 204; 404
 * "capture_not_mirrored" before the first PUT of that capture (the backend outbox sends the
 * capture before its previews and retries); 413/415 for size/type. Re-uploading replaces the
 * file. The API serves previewUrl/posterUrl only for files it actually stored.
 */
export const PREVIEW_UPLOAD = {
  fields: { role: 'role', file: 'file' },
  mimeTypes: ['image/webp', 'image/jpeg'],
  maxBytes: 512 * 1024,
  width: 640,
} as const;

export const CaptureMedia = z.object({
  w: z.int().positive().optional(),
  h: z.int().positive().optional(),
  /** Seconds (video, gif, voice). */
  duration: z.number().min(0).optional(),
  color: HexColor.optional(),
  thumbhash: Base64.optional(),
});
export type CaptureMedia = z.infer<typeof CaptureMedia>;

/**
 * Media availability of a capture for the admin: none (text/unsupported), pending (download or
 * processing not finished), ok (processed), lost (media_lost: can never be downloaded).
 */
export const MediaState = z.enum(['none', 'pending', 'ok', 'lost']);
export type MediaState = z.infer<typeof MediaState>;

/** PUT /api/v1/backend/captures/{sourceKey} — idempotent, never touches owner data. */
export const CaptureMirror = z.object({
  contractVersion: ContractVersion,
  sourceKey: SourceKey,
  publicId: CapturePublicId,
  kind: CaptureKind,
  occurredAt: IsoUtc,
  tz: TimeZone,
  localDate: LocalDate,
  caption: z.string().nullish(),
  text: TextStyle.nullish(),
  media: CaptureMedia.nullish(),
  mediaState: MediaState,
  /**
   * Sticky: a later PUT with null/absent revokedAt never clears it
   * (API: revoked_at = COALESCE(revoked_at, :revokedAt)). POST …/revoke sets it too.
   */
  revokedAt: IsoUtc.nullish(),
});
export type CaptureMirror = z.infer<typeof CaptureMirror>;

/** POST /api/v1/backend/captures/{sourceKey}/revoke */
export const CaptureRevoke = z.object({ contractVersion: ContractVersion, at: IsoUtc });
export type CaptureRevoke = z.infer<typeof CaptureRevoke>;

/** Opaque id of the API's change feed (meta.feed_id, rotated on every restore/reinstall). */
export const FeedId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, { message: 'Expected a feed id' });

/** POST /api/v1/backend/heartbeat (every 60 s). */
export const Heartbeat = z.object({
  contractVersion: ContractVersion,
  at: IsoUtc,
  backendVersion: z.string().min(1),
  wa: z.object({
    state: WaState,
    jid: z.string().optional(),
    lastStatusAt: IsoUtc.optional(),
    /**
     * pn is null when no traveler phone is configured (fixture mode). The backend sends it masked
     * (country code + last two digits, "+49…78") and leaves jid out: the API only needs to know
     * whether a traveler is configured (the full values stay in the local control UI).
     */
    traveler: z.object({ pn: z.string().nullable(), lidKnown: z.boolean() }),
  }),
  /** API sync outbox. */
  queue: z.object({ pending: Count, failed: Count, oldestAt: IsoUtc.optional() }),
  /** Owner change feed as applied by the backend (admin shows the sync lag). */
  sync: z.object({
    feedId: FeedId.nullable(),
    feedSeq: Count,
    lastPullAt: IsoUtc.nullable(),
    /** Feed items the backend could not apply (kept out of the mirror, see control UI). */
    quarantined: Count,
  }),
  /** Capture pipeline problems. */
  captures: z.object({ awaitingMedia: Count, failed: Count, mediaLost: Count }),
  stats: z.record(z.string(), z.number()),
  disk: z.object({ freeBytes: Count }),
  publish: z.object({
    lastVersion: z.int().min(0).optional(),
    lastAt: IsoUtc.optional(),
    lastError: z.string().optional(),
  }),
});
export type Heartbeat = z.infer<typeof Heartbeat>;

/** POST /api/v1/backend/published */
export const PublishedReport = z.object({
  contractVersion: ContractVersion,
  version: z.int().min(0),
  at: IsoUtc,
  /** Publish target name, e.g. "local" or "sftp-main". */
  target: z.string().min(1).max(64),
  ok: z.boolean(),
  uploaded: Count,
  deleted: Count,
  /** Change-feed cursor whose owner content this deploy contains (0 = none). */
  feedSeq: Count,
  /**
   * Capture watermark: every capture with occurredAt <= capturesThrough that was ready and
   * public at build time is in this deploy (null = no capture yet). The backend computes it as
   * just before the oldest capture still in the pipeline (received/archived/processed), else the
   * newest occurredAt of any capture. A capture still waiting for its media download does not
   * hold it back: it is not ready, so it is not in the deploy whatever the watermark says, and
   * clients show it as waiting from its mirror mediaState 'pending'.
   */
  capturesThrough: IsoUtc.nullable(),
  error: z.string().optional(),
});
export type PublishedReport = z.infer<typeof PublishedReport>;

// ---------------------------------------------------------------------------------------------
// Owner entities (API is primary; the backend mirrors them via the change feed)

/** Note text per locale: plain text (<= 280 chars by UI convention). */
export const NoteLocaleContent = z.object({ body: z.string().max(100_000) });
/** Story per locale: a non-blank title and markdown. */
export const StoryLocaleContent = z.object({
  title: z.string().min(1).max(200).regex(/\S/, { message: 'Title must not be blank' }),
  body: z.string().max(100_000),
});

const atLeastOneLocale = (value: Record<string, unknown>) => Object.keys(value).length > 0;
export const NotePostContent = z
  .partialRecord(LocaleCode, NoteLocaleContent)
  .refine(atLeastOneLocale, { message: 'At least one locale' })
  .meta({ minProperties: 1 });
export const StoryPostContent = z
  .partialRecord(LocaleCode, StoryLocaleContent)
  .refine(atLeastOneLocale, { message: 'At least one locale' })
  .meta({ minProperties: 1 });
/** Either shape; PostUpdate.content is checked against the stored kind by the API. */
export const PostContent = z.union([NotePostContent, StoryPostContent]);
export type PostContent = z.infer<typeof PostContent>;

const PostFields = {
  publicId: PostPublicId,
  occurredAt: IsoUtc,
  tz: TimeZone,
  localDate: LocalDate,
  origLocale: LocaleCode,
  visibility: Visibility,
  updatedAt: IsoUtc,
};
export const NotePost = z.object({ ...PostFields, kind: z.literal('note'), content: NotePostContent });
export const StoryPost = z.object({ ...PostFields, kind: z.literal('story'), content: StoryPostContent });
export const Post = z.discriminatedUnion('kind', [NotePost, StoryPost]);
export type Post = z.infer<typeof Post>;

export const Annotation = z.object({
  sourceKey: SourceKey,
  description: I18nText.nullish(),
  origLocale: LocaleCode.nullish(),
  /** null/absent = follow the publish policy (D11). */
  visibility: Visibility.nullish(),
  /** null/absent = the capture's own local date (see Placement in ./policy). */
  localDateOverride: LocalDate.nullish(),
  updatedAt: IsoUtc,
});
export type Annotation = z.infer<typeof Annotation>;

/** Owner metadata of a local day. Trip membership comes from trip date ranges (./policy). */
export const Day = z.object({
  localDate: LocalDate,
  title: I18nText.nullish(),
  summary: I18nText.nullish(),
  origLocale: LocaleCode.nullish(),
  placeName: z.string().max(200).nullish(),
  countryCode: CountryCode.nullish(),
  lat: Latitude.nullish(),
  lng: Longitude.nullish(),
  coverSourceKey: SourceKey.nullish(),
  /**
   * Time-zone fix: items whose stored localDate is this day (and that have no
   * localDateOverride) are re-dated in this zone (see Placement in ./policy).
   */
  tz: TimeZone.nullish(),
  updatedAt: IsoUtc,
});
export type Day = z.infer<typeof Day>;

export const Trip = z.object({
  slug: Slug,
  title: I18nText,
  description: I18nText.nullish(),
  origLocale: LocaleCode.nullish(),
  startDate: LocalDate,
  endDate: LocalDate,
  coverSourceKey: SourceKey.nullish(),
  updatedAt: IsoUtc,
});
export type Trip = z.infer<typeof Trip>;

export const PublishMode = z.enum(['instant', 'delayed', 'review']);
export type PublishMode = z.infer<typeof PublishMode>;
export const OnRevoke = z.enum(['hide', 'keep']);
export type OnRevoke = z.infer<typeof OnRevoke>;

const uniqueStrings = (values: readonly string[]) => new Set(values).size === values.length;

/** http(s) URL with a host; exported as a JSON Schema pattern so PHP enforces the scheme too. */
const HTTP_URL_RE = /^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/;

const SettingsShape = {
  'publish.mode': PublishMode,
  /** Set by the API whenever publish.mode changes (not writable via SettingsPatch). */
  'publish.mode_since': IsoUtc,
  'publish.delay_minutes': z.int().min(0).max(525_600),
  'ingest.on_revoke': OnRevoke,
  'timezone.current': TimeZone,
  'site.title': z.string().min(1).max(120),
  /** Locales the site is generated for; "ar" (dev-only pseudo-locale) is allowed for RTL tests. */
  'site.locales': z
    .array(LocaleCode)
    .min(1)
    .refine(uniqueStrings, { message: 'Locales must be unique' })
    .meta({ uniqueItems: true }),
  'site.default_locale': LocaleCode,
  'site.indexable': z.boolean(),
  'alerts.email': z.email().max(254).optional(),
  'alerts.ntfy_url': z
    .url({ protocol: /^https?$/ })
    .regex(HTTP_URL_RE)
    .optional(),
  'alerts.heartbeat_stale_minutes': z.int().min(1).max(10_080),
};

export const Settings = z.object(SettingsShape);
export type Settings = z.infer<typeof Settings>;
export type SettingKey = keyof Settings;
export const SETTING_KEYS = Object.keys(SettingsShape) as SettingKey[];
export const SettingKeySchema = z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]);

export function isSettingKey(value: unknown): value is SettingKey {
  return typeof value === 'string' && (SETTING_KEYS as readonly string[]).includes(value);
}

const DEFAULTS: Settings = {
  'publish.mode': 'instant',
  'publish.mode_since': '1970-01-01T00:00:00.000Z',
  'publish.delay_minutes': 720,
  'ingest.on_revoke': 'hide',
  'timezone.current': 'Europe/Berlin',
  'site.title': 'On My Way',
  'site.locales': ['de', 'en'],
  'site.default_locale': 'de',
  'site.indexable': false,
  'alerts.heartbeat_stale_minutes': 15,
};
export const SETTINGS_DEFAULTS: Readonly<Settings> = Object.freeze(DEFAULTS);

/** Cross-field problems of a complete settings object (the API checks the merged result). */
export function settingsProblems(settings: Settings): string[] {
  const problems: string[] = [];
  if (!settings['site.locales'].includes(settings['site.default_locale'])) {
    problems.push('site.default_locale must be one of site.locales');
  }
  if (!uniqueStrings(settings['site.locales'])) problems.push('site.locales must be unique');
  return problems;
}

/**
 * Merges partial (e.g. mirrored) settings over the defaults. Never throws: invalid values are
 * ignored and an inconsistent default locale falls back to the first site locale.
 */
export function withSettingsDefaults(partial: Partial<Record<string, unknown>> | null | undefined): Settings {
  const out: Record<string, unknown> = { ...SETTINGS_DEFAULTS };
  if (partial) {
    for (const key of SETTING_KEYS) {
      if (!(key in partial)) continue;
      const parsed = SettingsShape[key].safeParse(partial[key]);
      if (parsed.success && parsed.data !== undefined) out[key] = parsed.data;
    }
  }
  const settings = Settings.parse(out);
  if (!settings['site.locales'].includes(settings['site.default_locale'])) {
    const [first] = settings['site.locales'];
    if (first) settings['site.default_locale'] = first;
  }
  return settings;
}

/** Validates one setting value against its key's schema (throws on invalid values). */
export function parseSettingValue<K extends SettingKey>(key: K, value: unknown): Settings[K] {
  return SettingsShape[key].parse(value) as Settings[K];
}

/** Non-throwing variant of parseSettingValue. */
export function safeParseSettingValue<K extends SettingKey>(
  key: K,
  value: unknown,
): { ok: true; value: Settings[K] } | { ok: false; error: string } {
  const result = SettingsShape[key].safeParse(value);
  return result.success
    ? { ok: true, value: result.data as Settings[K] }
    : { ok: false, error: z.prettifyError(result.error) };
}

// ---------------------------------------------------------------------------------------------
// Change feed: GET /api/v1/backend/changes?after=<seq>&limit=<n>
//
// - Items are ascending by seq; `data` is present exactly for op "upsert".
// - The API answers 409 "feed_reset" when `after` > max(seq): the backend then resets its
//   cursor and rebuilds its owner mirror from seq 0. A changed feedId means the same.
// - The restore/reinstall procedure of the API rotates meta.feed_id.
// - Old rows of a key may be compacted away; the latest row per (entity, key), tombstones
//   included, always survives, so any cursor stays correct.
// - Consumers must parse items ONE BY ONE (parseChangeItem): an item of an unknown entity or
//   setting key (newer API) is skipped, an invalid item is quarantined; neither may block the
//   feed. Older backends therefore keep working when the API adds entities or setting keys.

export const CHANGE_ENTITIES = ['post', 'annotation', 'day', 'trip', 'setting'] as const;
export const ChangeEntity = z.enum(CHANGE_ENTITIES);
export type ChangeEntity = z.infer<typeof ChangeEntity>;
export const ChangeOp = z.enum(['upsert', 'delete']);
export type ChangeOp = z.infer<typeof ChangeOp>;

const Seq = z.int().min(1);
export const SettingChangeData = z.object({ value: z.unknown() });

function changeVariants<E extends ChangeEntity, K extends z.ZodType, D extends z.ZodType>(entity: E, key: K, data: D) {
  return z.discriminatedUnion('op', [
    z.object({ seq: Seq, entity: z.literal(entity), key, op: z.literal('upsert'), data }),
    z.object({ seq: Seq, entity: z.literal(entity), key, op: z.literal('delete') }),
  ]);
}

export const ChangeItem = z.discriminatedUnion('entity', [
  changeVariants('post', PostPublicId, Post),
  changeVariants('annotation', SourceKey, Annotation),
  changeVariants('day', LocalDate, Day),
  changeVariants('trip', Slug, Trip),
  changeVariants('setting', SettingKeySchema, SettingChangeData),
]);
export type ChangeItem = z.infer<typeof ChangeItem>;

const NextSeq = z.int().min(0);

/** What the API returns (PHP validates its output against this). */
export const ChangesResponse = z.object({
  feedId: FeedId,
  /** Ascending by seq. */
  items: z.array(ChangeItem),
  /** Cursor for the next request (= last seq, or the request's `after` when empty). */
  nextSeq: NextSeq,
  hasMore: z.boolean(),
});
export type ChangesResponse = z.infer<typeof ChangesResponse>;

/** What the backend parses first: the envelope only; items go through parseChangeItem(). */
export const ChangesPage = z.object({
  feedId: FeedId,
  items: z.array(z.unknown()),
  nextSeq: NextSeq,
  hasMore: z.boolean(),
});
export type ChangesPage = z.infer<typeof ChangesPage>;

export type ParsedChangeItem =
  | { status: 'ok'; item: ChangeItem }
  | { status: 'unknown_entity'; seq: number | null; entity: string | null }
  | { status: 'unknown_key'; seq: number | null; entity: 'setting'; key: string }
  | { status: 'invalid'; seq: number | null; entity: string | null; key: string | null; error: string };

/**
 * Classifies one raw feed item. "ok" guarantees a valid item (for settings: a valid value for
 * that key). Never throws.
 */
export function parseChangeItem(raw: unknown): ParsedChangeItem {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const seq = obj && Number.isInteger(obj.seq) && (obj.seq as number) >= 1 ? (obj.seq as number) : null;
  const entity = obj && typeof obj.entity === 'string' ? obj.entity : null;
  const key = obj && typeof obj.key === 'string' ? obj.key : null;
  if (!obj) return { status: 'invalid', seq, entity, key, error: 'Not an object' };
  if (entity !== null && !(CHANGE_ENTITIES as readonly string[]).includes(entity)) {
    return { status: 'unknown_entity', seq, entity };
  }
  if (entity === 'setting' && key !== null && !isSettingKey(key)) {
    return { status: 'unknown_key', seq, entity, key };
  }
  const parsed = ChangeItem.safeParse(raw);
  if (!parsed.success) return { status: 'invalid', seq, entity, key, error: z.prettifyError(parsed.error) };
  const item = parsed.data;
  if (item.entity === 'setting' && item.op === 'upsert') {
    const value = safeParseSettingValue(item.key, item.data.value);
    if (!value.ok) return { status: 'invalid', seq, entity, key, error: `${item.key}: ${value.error}` };
    return { status: 'ok', item: { ...item, data: { value: value.value } } };
  }
  return { status: 'ok', item };
}

// ---------------------------------------------------------------------------------------------
// Admin API DTOs

/** POST /api/v1/admin/session. The owner logs in with the e-mail address of users.email. */
export const LoginRequest = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(1000),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/** GET /api/v1/admin/me (and the login response). */
export const Me = z.object({
  email: z.email().max(254),
  displayName: z.string().nullable(),
  /**
   * Echo in the X-CSRF-Token header on mutating requests. Derived from the session token
   * (base64url(sha256("omw-csrf:" + sessionToken))), so it is stable for the whole session and
   * identical in every tab; nothing is stored server-side.
   */
  csrfToken: z.string().min(1),
});
export type Me = z.infer<typeof Me>;

/** GET /api/v1/health */
export const Health = z.object({
  ok: z.literal(true),
  version: z.string().min(1),
  contractVersion: ContractVersion,
});
export type Health = z.infer<typeof Health>;

/**
 * Query of GET /api/v1/admin/captures (sent as query string; PHP converts `limit` to an int
 * before validating). Results are newest first; nextCursor is opaque.
 */
export const CaptureListQuery = z.object({
  /** Effective local date. */
  date: LocalDate.optional(),
  visibility: Visibility.optional(),
  kind: CaptureKind.optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.int().min(1).max(200).optional(),
});
export type CaptureListQuery = z.infer<typeof CaptureListQuery>;

/** Query of GET /api/v1/admin/posts (same conventions as CaptureListQuery). */
export const PostListQuery = z.object({
  date: LocalDate.optional(),
  kind: z.enum(['note', 'story']).optional(),
  visibility: Visibility.optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.int().min(1).max(200).optional(),
});
export type PostListQuery = z.infer<typeof PostListQuery>;

export const CaptureListItem = CaptureMirror.omit({ contractVersion: true }).extend({
  annotation: Annotation.nullable(),
  /** Set only when the API stored that preview file. */
  previewUrl: z.string().nullable(),
  posterUrl: z.string().nullable(),
  effectiveVisibility: Visibility,
  effectiveLocalDate: LocalDate,
  effectiveTz: TimeZone,
  /** change_log seq of the annotation (0 = never annotated). */
  changeSeq: ChangeSeq,
});
export type CaptureListItem = z.infer<typeof CaptureListItem>;

export const CaptureListResponse = z.object({
  items: z.array(CaptureListItem),
  nextCursor: z.string().nullable(),
});
export type CaptureListResponse = z.infer<typeof CaptureListResponse>;

/** PATCH /api/v1/admin/captures/{sourceKey} -> CaptureListItem */
export const AnnotationPatch = z.object({
  description: I18nText.nullable().optional(),
  origLocale: LocaleCode.nullable().optional(),
  visibility: Visibility.nullable().optional(),
  localDateOverride: LocalDate.nullable().optional(),
  /** Annotation.updatedAt last seen; omit for a capture that was never annotated. */
  ifUpdatedAt: IsoUtc.optional(),
});
export type AnnotationPatch = z.infer<typeof AnnotationPatch>;

const PostCreateFields = {
  /** Client-chosen ("p_" + ULID): makes creating idempotent (offline replay, autosave). */
  publicId: PostPublicId,
  /** Defaults to now. */
  occurredAt: IsoUtc.optional(),
  /** Defaults to settings "timezone.current". */
  tz: TimeZone.optional(),
  origLocale: LocaleCode,
  /** Defaults to "public". */
  visibility: Visibility.optional(),
};
/** POST /api/v1/admin/posts -> AdminPost (200 with the existing post for a known publicId). */
export const PostCreate = z
  .discriminatedUnion('kind', [
    z.object({ ...PostCreateFields, kind: z.literal('note'), content: NotePostContent }),
    z.object({ ...PostCreateFields, kind: z.literal('story'), content: StoryPostContent }),
  ])
  .superRefine((post, ctx) => {
    if (!(post.origLocale in post.content)) {
      ctx.addIssue({ code: 'custom', path: ['content'], message: 'content must contain origLocale' });
    }
  });
export type PostCreate = z.infer<typeof PostCreate>;

/** PATCH /api/v1/admin/posts/{publicId} -> AdminPost. kind cannot change. */
export const PostUpdate = z.object({
  occurredAt: IsoUtc.optional(),
  tz: TimeZone.optional(),
  /** Replaces all locales; must match the stored kind (note vs story shape). */
  content: PostContent.optional(),
  origLocale: LocaleCode.optional(),
  visibility: Visibility.optional(),
  ifUpdatedAt: IsoUtc.optional(),
});
export type PostUpdate = z.infer<typeof PostUpdate>;

export const AdminPost = z.discriminatedUnion('kind', [
  NotePost.extend({ changeSeq: ChangeSeq }),
  StoryPost.extend({ changeSeq: ChangeSeq }),
]);
export type AdminPost = z.infer<typeof AdminPost>;

export const PostListResponse = z.object({ items: z.array(AdminPost), nextCursor: z.string().nullable() });
export type PostListResponse = z.infer<typeof PostListResponse>;

/** PATCH /api/v1/admin/days/{localDate} -> AdminDayDetail (creates the days row if needed). */
export const DayPatch = z.object({
  title: I18nText.nullable().optional(),
  summary: I18nText.nullable().optional(),
  origLocale: LocaleCode.nullable().optional(),
  placeName: z.string().max(200).nullable().optional(),
  countryCode: CountryCode.nullable().optional(),
  lat: Latitude.nullable().optional(),
  lng: Longitude.nullable().optional(),
  coverSourceKey: SourceKey.nullable().optional(),
  /** Time-zone fix of the day (null = remove the fix). */
  tz: TimeZone.nullable().optional(),
  /** Day.updatedAt last seen; omit for a day without a days row. */
  ifUpdatedAt: IsoUtc.optional(),
});
export type DayPatch = z.infer<typeof DayPatch>;

/**
 * One row of GET /api/v1/admin/days: every local date that has content (captures by effective
 * date ∪ posts ∪ days rows), ascending. `day` is null until the owner edits the day.
 */
export const AdminDaySummary = z.object({
  localDate: LocalDate,
  day: Day.nullable(),
  counts: z.object({ captures: Count, posts: Count, public: Count, hidden: Count, pending: Count }),
  /** null for a day that has a days row but no items. */
  firstAt: IsoUtc.nullable(),
  lastAt: IsoUtc.nullable(),
  /** Effective cover: Day.coverSourceKey, else the first public photo/video of the day. */
  coverSourceKey: SourceKey.nullable(),
  coverPreviewUrl: z.string().nullable(),
  /** tripForDate() of this date. */
  trip: Slug.nullable(),
  /** change_log seq of the days row (0 = never edited). */
  changeSeq: ChangeSeq,
});
export type AdminDaySummary = z.infer<typeof AdminDaySummary>;

export const DayListResponse = z.object({ items: z.array(AdminDaySummary) });
export type DayListResponse = z.infer<typeof DayListResponse>;

/** GET /api/v1/admin/days/{localDate}: 200 even for a day the owner never edited (day: null). */
export const AdminDayDetail = z.object({
  localDate: LocalDate,
  day: Day.nullable(),
  /** Items placed on this date (effective local date), chronological. */
  captures: z.array(CaptureListItem),
  posts: z.array(AdminPost),
  trip: Slug.nullable(),
  changeSeq: ChangeSeq,
});
export type AdminDayDetail = z.infer<typeof AdminDayDetail>;

/** PUT /api/v1/admin/trips/{slug} -> AdminTrip */
export const TripUpsert = z
  .object({
    slug: Slug,
    title: I18nText,
    description: I18nText.optional(),
    origLocale: LocaleCode.optional(),
    startDate: LocalDate,
    endDate: LocalDate,
    coverSourceKey: SourceKey.nullable().optional(),
    ifUpdatedAt: IsoUtc.optional(),
  })
  .refine((t) => t.endDate >= t.startDate, { path: ['endDate'], message: 'endDate must not be before startDate' });
export type TripUpsert = z.infer<typeof TripUpsert>;

export const AdminTrip = Trip.extend({ changeSeq: ChangeSeq });
export type AdminTrip = z.infer<typeof AdminTrip>;

export const TripListResponse = z.object({ items: z.array(AdminTrip) });
export type TripListResponse = z.infer<typeof TripListResponse>;

/** PATCH /api/v1/admin/settings -> Settings. "publish.mode_since" is maintained by the API. */
export const SettingsPatch = Settings.omit({ 'publish.mode_since': true })
  .partial()
  .extend({
    'alerts.email': z.email().max(254).nullable().optional(),
    'alerts.ntfy_url': z
      .url({ protocol: /^https?$/ })
      .regex(HTTP_URL_RE)
      .nullable()
      .optional(),
  });
export type SettingsPatch = z.infer<typeof SettingsPatch>;

// Tokens (Settings screen). Session tokens are never listed or created here.

export const TokenKind = z.enum(['backend', 'app']);
export type TokenKind = z.infer<typeof TokenKind>;
export const TokenScope = z.enum(['backend', 'admin']);
export type TokenScope = z.infer<typeof TokenScope>;
/** Scopes are fixed per kind (api_tokens CHECK constraint). */
export const TOKEN_KIND_SCOPES = {
  session: ['admin'],
  backend: ['backend'],
  app: ['admin'],
} as const satisfies Record<'session' | TokenKind, readonly TokenScope[]>;

export const ApiTokenInfo = z.object({
  id: z.int().positive(),
  kind: TokenKind,
  name: z.string().max(100),
  /** First characters of the token, e.g. "omw_AbC12…". */
  hint: z.string().min(1).max(32),
  scopes: z.array(TokenScope),
  createdAt: IsoUtc,
  expiresAt: IsoUtc.nullable(),
  lastUsedAt: IsoUtc.nullable(),
  revokedAt: IsoUtc.nullable(),
});
export type ApiTokenInfo = z.infer<typeof ApiTokenInfo>;

/** GET /api/v1/admin/tokens (active tokens, newest first). */
export const TokenListResponse = z.object({ items: z.array(ApiTokenInfo) });
export type TokenListResponse = z.infer<typeof TokenListResponse>;

/** POST /api/v1/admin/tokens -> TokenCreated (201). DELETE …/tokens/{id} revokes (204). */
export const TokenCreate = z.object({
  kind: TokenKind,
  name: z.string().min(1).max(100),
  expiresAt: IsoUtc.nullable().optional(),
});
export type TokenCreate = z.infer<typeof TokenCreate>;

export const TokenCreated = z.object({
  /** Shown exactly once. */
  token: z.string().regex(/^omw_[A-Za-z0-9_-]{43}$/),
  info: ApiTokenInfo,
});
export type TokenCreated = z.infer<typeof TokenCreated>;

export const Alert = z.object({
  kind: z.string().min(1),
  severity: z.enum(['warning', 'critical']),
  message: z.string(),
  since: IsoUtc,
  resolvedAt: IsoUtc.nullable(),
});
export type Alert = z.infer<typeof Alert>;

/** Last report of one publish target plus the API's bookkeeping. */
export const TargetPublishStatus = PublishedReport.extend({
  lastOkAt: IsoUtc.nullable(),
  consecutiveFailures: Count,
  receivedAt: IsoUtc,
});
export type TargetPublishStatus = z.infer<typeof TargetPublishStatus>;

export const StatusResponse = z.object({
  backend: Heartbeat.nullable(),
  lastSeenAt: IsoUtc.nullable(),
  /** One entry per publish target, ordered by target name. */
  publish: z.array(TargetPublishStatus),
  alerts: z.array(Alert),
});
export type StatusResponse = z.infer<typeof StatusResponse>;

export const ApiError = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

// ---------------------------------------------------------------------------------------------
// "Live ✓ / publishing…" (plan C): pure, shared by admin and future apps.

export type ItemPublishState = 'live' | 'publishing' | 'not_public';

export interface PublishStateInput {
  visibility: Visibility;
  /** change_log seq of the item's owner data (0 = none). */
  changeSeq: number;
  /** Captures only: the capture must be covered by the report's capturesThrough. */
  occurredAt?: string | undefined;
  /**
   * Captures only (CaptureListItem.mediaState): 'pending' (WhatsApp has not delivered the media
   * yet) is always 'publishing', 'lost' (never published) is 'not_public'.
   */
  mediaState?: MediaState | undefined;
  /**
   * Captures only, optional: when the capture became public by the publish policy (ISO UTC,
   * e.g. occurredAt + delay in delayed mode; policy.ts capturePublishAt). A deploy built before
   * that instant cannot contain it, so only a report whose `at` is not earlier covers it.
   * Undefined = no such constraint (instant mode, an explicit "public", posts).
   */
  publishAt?: string | undefined;
}

/** `at` (deploy time) is optional, so callers that pass only the watermark keep working. */
type PublishReportLike = Pick<PublishedReport, 'ok' | 'feedSeq' | 'capturesThrough'> &
  Partial<Pick<PublishedReport, 'at'>>;

/** Live when every publish target's last report contains the item; no targets = publishing. */
export function itemPublishState(item: PublishStateInput, reports: readonly PublishReportLike[]): ItemPublishState {
  if (item.visibility !== 'public' || item.mediaState === 'lost') return 'not_public';
  if (reports.length === 0 || item.mediaState === 'pending') return 'publishing';
  const covered = (r: PublishReportLike) =>
    r.ok &&
    item.changeSeq <= r.feedSeq &&
    (item.occurredAt === undefined ||
      (r.capturesThrough !== null && Date.parse(item.occurredAt) <= Date.parse(r.capturesThrough))) &&
    (item.publishAt === undefined || (r.at !== undefined && Date.parse(item.publishAt) <= Date.parse(r.at)));
  return reports.every(covered) ? 'live' : 'publishing';
}

// ---------------------------------------------------------------------------------------------
// JSON Schema export registry (api/schemas/<Name>.json)

export type SchemaIo = 'input' | 'output';

/** name -> [schema, io]: request bodies use "input", responses/entities "output". */
export const API_SCHEMAS = {
  // backend sync
  CaptureMirror: [CaptureMirror, 'input'],
  CaptureRevoke: [CaptureRevoke, 'input'],
  Heartbeat: [Heartbeat, 'input'],
  PublishedReport: [PublishedReport, 'input'],
  ChangeItem: [ChangeItem, 'output'],
  ChangesResponse: [ChangesResponse, 'output'],
  // entities
  Post: [Post, 'output'],
  Annotation: [Annotation, 'output'],
  Day: [Day, 'output'],
  Trip: [Trip, 'output'],
  Settings: [Settings, 'output'],
  // public
  Health: [Health, 'output'],
  // admin
  LoginRequest: [LoginRequest, 'input'],
  Me: [Me, 'output'],
  CaptureListQuery: [CaptureListQuery, 'input'],
  CaptureListItem: [CaptureListItem, 'output'],
  CaptureListResponse: [CaptureListResponse, 'output'],
  AnnotationPatch: [AnnotationPatch, 'input'],
  PostListQuery: [PostListQuery, 'input'],
  PostCreate: [PostCreate, 'input'],
  PostUpdate: [PostUpdate, 'input'],
  AdminPost: [AdminPost, 'output'],
  PostListResponse: [PostListResponse, 'output'],
  DayPatch: [DayPatch, 'input'],
  AdminDaySummary: [AdminDaySummary, 'output'],
  AdminDayDetail: [AdminDayDetail, 'output'],
  DayListResponse: [DayListResponse, 'output'],
  TripUpsert: [TripUpsert, 'input'],
  AdminTrip: [AdminTrip, 'output'],
  TripListResponse: [TripListResponse, 'output'],
  SettingsPatch: [SettingsPatch, 'input'],
  TokenCreate: [TokenCreate, 'input'],
  TokenCreated: [TokenCreated, 'output'],
  ApiTokenInfo: [ApiTokenInfo, 'output'],
  TokenListResponse: [TokenListResponse, 'output'],
  Alert: [Alert, 'output'],
  TargetPublishStatus: [TargetPublishStatus, 'output'],
  StatusResponse: [StatusResponse, 'output'],
  ApiError: [ApiError, 'output'],
} as const satisfies Record<string, readonly [z.ZodType, SchemaIo]>;
export type ApiSchemaName = keyof typeof API_SCHEMAS;
