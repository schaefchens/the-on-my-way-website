/**
 * Access gate, followers, consent and data rights (wave 5, spec-wave5.md §2–§4.1).
 *
 * Every payload between the site's gate pages and the API (public routes), the admin's access
 * screens and the API (admin routes), and the backend and the API (store writer fallback) lives
 * here, plus the pure helpers both runtimes share: cookie names and values, the personal and
 * panic link URLs, the site-store layout and the cross-field rules of the gate configuration.
 * PHP mirrors the helpers in Domain\Access\StoreLayout; fixtures/vectors/access-paths.json pins
 * them down for both runtimes.
 *
 * Identifiers (§0.3): follower id `fid` = 12 base32 chars (60 bits), device id `did` = 8 base32
 * chars, tokens (link secret `t`, session id `sid`, device key `k`, panic key) = base64url of 32
 * random bytes (43 chars, no padding). The gate cookie value is "<fid>.<did>.<sid>". No secret
 * ever travels in a URL path or query: the handoff is the fixed path "/_/h/" (§2.3.2), personal
 * and panic links carry their secret in the #fragment only.
 *
 * Rules the exported JSON Schema cannot express (zod refinements here; PHP enforces them with the
 * same semantics before any write and answers 400/422 as noted):
 * - JoinRequest (400): either a new device (`t` + `consentVersion`, optional `k`, no `resume`) or a
 *   resume (`resume: true` + `k`, no `t`, no `consentVersion`).
 * - An `active` answer (JoinResponse, DevicePollResponse) carries `session` if and only if
 *   `handoff` is "/_/h/".
 * - PrivacyNotice.texts must contain `de`, `en` and every `site.locales` locale (422
 *   notice_incomplete with the missing paths).
 * - StoreOp.path and every StoreListing path match the store layout for their op kind
 *   (isValidStoreOpPath / storePathKind below; PHP StoreLayout).
 * - ACCESS_STORE_DIR: isSafeStoreDir (character set, absolute, no ".." segment, no "//").
 */
import { z } from 'zod';
import { Count, IsoUtc, Sha256Hex } from './common.js';
import { LocaleCode } from './i18n.js';
import { AuthorName, BasePath } from './site.js';

// ---------------------------------------------------------------------------------------------
// Ids and tokens

const FID = '[a-z2-7]{12}';
const DID = '[a-z2-7]{8}';
const TOKEN = '[A-Za-z0-9_-]{43}';

export const FOLLOWER_ID_RE = new RegExp(`^${FID}$`);
export const DEVICE_ID_RE = new RegExp(`^${DID}$`);
export const ACCESS_TOKEN_RE = new RegExp(`^${TOKEN}$`);
export const GATE_SESSION_RE = new RegExp(`^${FID}\\.${DID}\\.${TOKEN}$`);

export const FollowerId = z.string().regex(FOLLOWER_ID_RE, { message: 'Expected a follower id' });
export type FollowerId = z.infer<typeof FollowerId>;
export const DeviceId = z.string().regex(DEVICE_ID_RE, { message: 'Expected a device id' });
export type DeviceId = z.infer<typeof DeviceId>;
export const AccessToken = z.string().regex(ACCESS_TOKEN_RE, { message: 'Expected a 43-char token' });
export type AccessToken = z.infer<typeof AccessToken>;
export const Epoch = z.string().regex(/^[0-9a-f]{16}$/);
export const StoreId = z.string().regex(/^[0-9a-f]{16}$/);
/** "<fid>.<did>.<sid>": the gate cookie value, the transfer cookie value, the service session. */
export const GateSession = z.string().regex(GATE_SESSION_RE);
export type GateSession = z.infer<typeof GateSession>;
/** One trimmed line, 1..60 characters (same rules as the traveler's name). */
export const FollowerName = AuthorName;
export const FollowerNote = z.string().max(200);
/** "https://host[:port]" lowercase, no path. */
export const ORIGIN_RE = /^https?:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/;
export const Origin = z.string().regex(ORIGIN_RE);
/** The API's public route base as the browser calls it, e.g. "https://api.example.org/api/v1/public/". */
export const PUBLIC_API_BASE_RE = /^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?\/api\/v1\/public\/$/;
export const PublicApiBase = z.string().regex(PUBLIC_API_BASE_RE);
/** Cookie names are generator constants; the character set keeps them safe in a cookie string. */
const CookieName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
/** Cookie Domain attribute (F1/F2): lowercase host characters only. */
const CookieDomain = z.string().regex(/^[a-z0-9.-]+$/);

// ---------------------------------------------------------------------------------------------
// Cookies, handoff, links (pure helpers; PHP mirrors them in Domain\Access\StoreLayout)

export const GATE_COOKIE_NAMES = {
  secure: {
    session: '__Host-omw',
    key: '__Host-omw_k',
    transfer: '__Host-omw_s',
    handoff: '__Host-omw_h',
    resume: '__Host-omw_r',
  },
  /** http loopback dev and F1/F2. */
  insecure: { session: 'omw', key: 'omw_k', transfer: 'omw_s', handoff: 'omw_h', resume: 'omw_r' },
} as const;
export type GateCookieRole = keyof (typeof GATE_COOKIE_NAMES)['secure'];

/** Max-Age (seconds) of each gate cookie (§2.3.1). `keyJs`: the key cookie as written by the gate JS. */
export const GATE_COOKIE_MAX_AGE = {
  session: 34_560_000,
  key: 34_560_000,
  keyJs: 1_209_600,
  transfer: 120,
  handoff: 600,
  resume: 300,
} as const;

/** The only handoff path; it never carries a secret (§2.3.2). */
export const HANDOFF_PATH = '/_/h/';
/** Where Apache sends every failed handoff. */
export const HANDOFF_FAILED_PATH = '/_/join/#handoff-failed';
export const TRANSFER_COOKIE_MAX_AGE = GATE_COOKIE_MAX_AGE.transfer;

const LOOPBACK_HOST_RE =
  /^(?:localhost|127\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d))$/;

/** True for "localhost" and 127.0.0.0/8 (the hosts where http is acceptable). */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOST_RE.test(host);
}

function parsedOrigin(origin: string): URL {
  if (!ORIGIN_RE.test(origin)) throw new RangeError(`Expected an origin "https://host[:port]", got "${origin}"`);
  return new URL(origin);
}

/** "<fid>.<did>.<sid>" (throws on a malformed part). */
export function gateCookieValue(fid: string, did: string, sid: string): string {
  if (!FOLLOWER_ID_RE.test(fid)) throw new RangeError('Invalid follower id');
  if (!DEVICE_ID_RE.test(did)) throw new RangeError('Invalid device id');
  if (!ACCESS_TOKEN_RE.test(sid)) throw new RangeError('Invalid session id');
  return `${fid}.${did}.${sid}`;
}

/** The parts of a gate cookie value, or null when it is not exactly "<fid>.<did>.<sid>". */
export function parseGateSession(value: string): { fid: string; did: string; sid: string } | null {
  if (!GATE_SESSION_RE.test(value)) return null;
  const [fid = '', did = '', sid = ''] = value.split('.');
  return { fid, did, sid };
}

/** "<origin>/_/join/#t=<t>" (throws on a malformed origin or secret). */
export function personalLinkUrl(siteOrigin: string, linkSecret: string): string {
  parsedOrigin(siteOrigin);
  if (!ACCESS_TOKEN_RE.test(linkSecret)) throw new RangeError('Invalid link secret');
  return `${siteOrigin}/_/join/#t=${linkSecret}`;
}

/** "<origin>/_/panic/#k=<k>" (throws on a malformed origin or key). */
export function panicLinkUrl(siteOrigin: string, key: string): string {
  parsedOrigin(siteOrigin);
  if (!ACCESS_TOKEN_RE.test(key)) throw new RangeError('Invalid panic key');
  return `${siteOrigin}/_/panic/#k=${key}`;
}

export type LinkFragmentMode = 'resume' | 'reconfirm' | 'view' | 'handoff-failed';
const FRAGMENT_MODES: readonly LinkFragmentMode[] = ['resume', 'reconfirm', 'view', 'handoff-failed'];

export interface LinkFragment {
  t?: string;
  k?: string;
  mode?: LinkFragmentMode;
  /** `return=<path>` (§6.2.4): a same-origin path ("/…", no "//", no "\", no scheme), decoded. */
  returnPath?: string;
}

const RETURN_PATH_RE = /^\/[A-Za-z0-9._~\-/]*$/;

/**
 * Reads a gate page fragment ("#t=…", "#k=…", "#resume", "#reconfirm&return=%2Fx%2F", …), with or
 * without the leading "#". Parts are separated by "&"; malformed tokens, unknown words and unsafe
 * return paths are ignored; the first recognised mode wins.
 */
export function parseLinkFragment(hash: string): LinkFragment {
  const out: LinkFragment = {};
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  if (body === '') return out;
  for (const part of body.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      const mode = FRAGMENT_MODES.find((m) => m === part);
      if (mode && out.mode === undefined) out.mode = mode;
      continue;
    }
    const name = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if ((name === 't' || name === 'k') && out[name] === undefined && ACCESS_TOKEN_RE.test(value)) {
      out[name] = value;
    } else if (name === 'return' && out.returnPath === undefined) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        continue;
      }
      if (RETURN_PATH_RE.test(decoded) && !decoded.includes('//')) out.returnPath = decoded;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Store layout (§2.2)

export const STORE_PATHS = {
  marker: '.omw-store.json',
  locked: 'locked',
  /** F3 only (store inside the docroot): written by the writer itself, never by an op. */
  htaccess: '.htaccess',
  session: (fid: string, did: string, sid: string) => `s/${fid}/${did}.${sid}`,
  sessionDir: (fid: string) => `s/${fid}`,
  sessionPrefix: (did: string) => `${did}.`,
  handoff: (did: string) => `h/${did}`,
  personTombstone: (fid: string) => `t/${fid}`,
  deviceTombstone: (fid: string, did: string) => `t/${fid}.${did}`,
} as const;

/** Exact bytes of the F3 store `.htaccess` (the repair job compares them). */
export const STORE_HTACCESS = 'Require all denied\nOptions -Indexes\n';

export type StorePathKind =
  | 'marker'
  | 'locked'
  | 'htaccess'
  | 'session'
  | 'sessionDir'
  | 'sessionPrefix'
  | 'handoff'
  | 'personTombstone'
  | 'deviceTombstone'
  | 'stray';

/** Store-relative paths by kind (no leading "/", no "." or ".." segment anywhere). */
export const STORE_PATH_PATTERNS: Readonly<Record<StorePathKind, RegExp>> = {
  marker: /^\.omw-store\.json$/,
  locked: /^locked$/,
  htaccess: /^\.htaccess$/,
  session: new RegExp(`^s/${FID}/${DID}\\.${TOKEN}$`),
  sessionDir: new RegExp(`^s/${FID}$`),
  sessionPrefix: new RegExp(`^s/${FID}/${DID}\\.$`),
  handoff: new RegExp(`^h/${DID}$`),
  personTombstone: new RegExp(`^t/${FID}$`),
  deviceTombstone: new RegExp(`^t/${FID}\\.${DID}$`),
  /**
   * Anything else below s/ or h/ (a listing's `strays`): one or two segments of safe characters
   * that do not start with a dot. Only `delete` and `delete_tree` may name one.
   */
  stray: /^[sh]\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99})?$/,
};

const PATH_KIND_ORDER: readonly StorePathKind[] = [
  'marker',
  'locked',
  'htaccess',
  'session',
  'sessionDir',
  'sessionPrefix',
  'handoff',
  'personTombstone',
  'deviceTombstone',
  'stray',
];

/** The kind of a store-relative path, or null when it is none of the layout's paths. */
export function storePathKind(path: string): StorePathKind | null {
  if (path.length > 200) return null;
  for (const kind of PATH_KIND_ORDER) if (STORE_PATH_PATTERNS[kind].test(path)) return kind;
  return null;
}

export const StoreOpKind = z.enum(['init', 'put', 'delete', 'delete_prefix', 'delete_tree']);
export type StoreOpKind = z.infer<typeof StoreOpKind>;

/** Which path kinds each op may name (§3.8.2). Tombstones are never deleted; the marker never. */
export const STORE_OP_PATH_KINDS: Readonly<Record<StoreOpKind, readonly StorePathKind[]>> = {
  init: ['marker'],
  put: ['marker', 'locked', 'session', 'handoff', 'personTombstone', 'deviceTombstone'],
  delete: ['locked', 'session', 'handoff', 'stray'],
  delete_prefix: ['sessionPrefix'],
  delete_tree: ['sessionDir', 'stray'],
};

/**
 * True when `op` may name `path`. A put of the marker must be non-exclusive (it is the only file
 * that is ever rewritten); every other put must be exclusive (existence files are never rewritten).
 */
export function isValidStoreOpPath(op: StoreOpKind, path: string, exclusive = true): boolean {
  const kind = storePathKind(path);
  if (kind === null || !STORE_OP_PATH_KINDS[op].includes(kind)) return false;
  if (op === 'put') return kind === 'marker' ? !exclusive : exclusive;
  return true;
}

/** ACCESS_STORE_DIR: absolute, safe inside a RewriteCond test string, no trailing slash. */
export const STORE_DIR_RE = /^\/[A-Za-z0-9._/-]*[A-Za-z0-9._-]$/;

/** STORE_DIR_RE and no ".." segment and no "//" (§2.2). */
export function isSafeStoreDir(dir: string): boolean {
  return STORE_DIR_RE.test(dir) && !dir.includes('//') && !dir.split('/').includes('..');
}

export const StoreMarker = z.object({ format: z.literal(1), storeId: StoreId, epoch: Epoch, op: Count, at: IsoUtc });
export type StoreMarker = z.infer<typeof StoreMarker>;
export const StoreTombstone = z.object({ s: z.enum(['revoked', 'deleted']), at: IsoUtc });
export type StoreTombstone = z.infer<typeof StoreTombstone>;
export const StoreLock = z.object({ at: IsoUtc, by: z.enum(['admin', 'panic', 'mac']) });
export type StoreLock = z.infer<typeof StoreLock>;

// ---------------------------------------------------------------------------------------------
// Domain / origin config (Q9)

export const AccessMode = z.enum(['open', 'gate']);
export type AccessMode = z.infer<typeof AccessMode>;
export const CookieMode = z.enum(['headers', 'co', 'parent']);
export type CookieMode = z.infer<typeof CookieMode>;

export const SiteAccessConfig = z.object({
  mode: AccessMode,
  siteOrigin: Origin,
  /** "/<secret>/" in gate mode (one segment, ^[a-z0-9]{20}$), "/" or the basePath in open mode. */
  contentPath: BasePath,
  apiPublicBase: PublicApiBase,
  cookieMode: CookieMode,
  /** co: the site host; parent: the shared parent domain. */
  cookieDomain: CookieDomain.optional(),
  /** Absolute store path as Apache sees it (gate mode); safe inside a RewriteCond test string. */
  storeDir: z.string().regex(STORE_DIR_RE).optional(),
  /** Production only: emit the http→https redirect (P0b-10). */
  httpsRedirect: z.boolean(),
});
export type SiteAccessConfig = z.infer<typeof SiteAccessConfig>;

export const CONTENT_PATH_RE = /^\/[a-z0-9]{20}\/$/;

function urlOrNull(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isDotSuffix(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Cross-field rules (backend config and the API boot call the same checks). Empty = consistent.
 * - gate ⇒ storeDir set and safe (isSafeStoreDir); contentPath is "/<20 [a-z0-9]>/"; siteOrigin and
 *   apiPublicBase are https unless their host is loopback (127.0.0.0/8, localhost);
 * - httpsRedirect ⇒ siteOrigin https;
 * - headers ⇒ no cookieDomain (both sides host-only, §2.3.1);
 * - co ⇒ cookieDomain === the site host;
 * - parent ⇒ cookieDomain is a dot-suffix of the site host AND of the API host and has ≥ 2 labels;
 *   none of the three is an IP address (its last label is not numeric: browsers ignore Domain on
 *   IP hosts);
 * - apiPublicBase carries no credentials.
 */
export function siteAccessProblems(cfg: SiteAccessConfig): string[] {
  const problems: string[] = [];
  const site = ORIGIN_RE.test(cfg.siteOrigin) ? urlOrNull(cfg.siteOrigin) : null;
  const api = PUBLIC_API_BASE_RE.test(cfg.apiPublicBase) ? urlOrNull(cfg.apiPublicBase) : null;
  if (!site) problems.push('siteOrigin must be an origin "https://host[:port]"');
  if (!api) problems.push('apiPublicBase must be an http(s) URL ending in /api/v1/public/');
  else if (api.username !== '' || api.password !== '') problems.push('apiPublicBase must not carry credentials');
  const siteHttps = site?.protocol === 'https:';

  if (cfg.mode === 'gate') {
    if (cfg.storeDir === undefined) problems.push('gate mode needs storeDir (ACCESS_STORE_DIR)');
    else if (!isSafeStoreDir(cfg.storeDir)) {
      problems.push('storeDir must be an absolute path of [A-Za-z0-9._/-] without "..", "//" or a trailing slash');
    }
    if (!CONTENT_PATH_RE.test(cfg.contentPath)) problems.push('gate mode needs contentPath "/<20 chars a-z0-9>/"');
    if (site && !siteHttps && !isLoopbackHost(site.hostname)) {
      problems.push('siteOrigin must be https (http only for localhost or 127.0.0.0/8)');
    }
    if (api && api.protocol !== 'https:' && !isLoopbackHost(api.hostname)) {
      problems.push('apiPublicBase must be https (http only for localhost or 127.0.0.0/8)');
    }
  }
  if (cfg.httpsRedirect && site && !siteHttps) problems.push('httpsRedirect needs an https siteOrigin');

  switch (cfg.cookieMode) {
    case 'headers':
      if (cfg.cookieDomain !== undefined) problems.push('cookieDomain must not be set with cookieMode "headers"');
      break;
    case 'co':
      if (site && cfg.cookieDomain !== site.hostname)
        problems.push('cookieMode "co" needs cookieDomain = the site host');
      break;
    case 'parent': {
      const d = cfg.cookieDomain;
      const labels = d?.split('.') ?? [];
      if (
        d === undefined ||
        labels.length < 2 ||
        labels.some((l) => l === '') ||
        [d, site?.hostname, api?.hostname].some((host) => host !== undefined && /(?:^|\.)\d+$/.test(host)) ||
        (site && !isDotSuffix(site.hostname, d)) ||
        (api && !isDotSuffix(api.hostname, d))
      ) {
        problems.push(
          'cookieMode "parent" needs cookieDomain = a parent domain (≥ 2 labels) of both the site host and the API host',
        );
      }
      break;
    }
  }
  return problems;
}

/**
 * The gate cookie names and the Secure attribute for a site origin and cookie mode: the
 * `__Host-` names only for https + "headers" (F1/F2 cookies carry a Domain, which `__Host-`
 * forbids); Secure whenever the origin is https. Same shape as GateBoot.cookies.
 */
export function gateCookies(
  siteOrigin: string,
  cookieMode: CookieMode,
): { session: string; key: string; transfer: string; handoff: string; resume: string; secure: boolean } {
  const secure = parsedOrigin(siteOrigin).protocol === 'https:';
  const names = secure && cookieMode === 'headers' ? GATE_COOKIE_NAMES.secure : GATE_COOKIE_NAMES.insecure;
  return { ...names, secure };
}

export const SiteHeartbeat = z.object({
  origin: Origin,
  access: AccessMode,
  cookieMode: CookieMode,
  storeDir: z.string().max(300).nullable(),
});
export type SiteHeartbeat = z.infer<typeof SiteHeartbeat>;

// ---------------------------------------------------------------------------------------------
// Gate pages (§2.6, §6.2)

export const GatePage = z.enum(['join', 'info', 'wait', 'ended', 'me', 'panic']);
export type GatePage = z.infer<typeof GatePage>;
export const GATE_BOOT_ELEMENT_ID = 'omw-gate';

export const GateBoot = z.object({
  page: GatePage,
  api: PublicApiBase,
  locales: z.array(LocaleCode).min(1),
  defaultLocale: LocaleCode,
  cookies: z.object({
    session: CookieName,
    key: CookieName,
    transfer: CookieName,
    handoff: CookieName,
    resume: CookieName,
    secure: z.boolean(),
  }),
  cookieMode: CookieMode,
  /** F1/F2: the Domain the JS must use when it writes or deletes key/transfer cookies; null = host-only. */
  cookieDomain: CookieDomain.nullable(),
  build: z.string().min(1).max(64),
});
export type GateBoot = z.infer<typeof GateBoot>;

// ---------------------------------------------------------------------------------------------
// Privacy notice (D11, Q7): plain text, paragraphs separated by a blank line, no markup

const NoticeParagraphs = z.string().min(1).max(4000);
export const NoticeTexts = z.object({
  title: z.string().min(1).max(120),
  /** What this is. */
  intro: NoticeParagraphs,
  /** What is stored under the person's id. */
  collected: NoticeParagraphs,
  /** Who sees what (the traveler sees names; followers only counts). */
  audience: NoticeParagraphs,
  /** Why. */
  purpose: NoticeParagraphs,
  /** How long (kept after access ends, until deletion; backups). */
  retention: NoticeParagraphs,
  /** Rights incl. "Delete me", where to complain. */
  rights: NoticeParagraphs,
});
export type NoticeTexts = z.infer<typeof NoticeTexts>;
export const NOTICE_TEXT_KEYS = ['title', 'intro', 'collected', 'audience', 'purpose', 'retention', 'rights'] as const;

export const NoticeController = z.object({
  name: z.string().min(1).max(120),
  email: z.email().max(254),
  address: z.string().max(300).optional(),
});
export type NoticeController = z.infer<typeof NoticeController>;

export const PrivacyNotice = z.object({
  controller: NoticeController,
  /** Every site locale must be present, and always de + en (checked by the API against site.locales). */
  texts: z
    .partialRecord(LocaleCode, NoticeTexts)
    .refine((v) => Object.keys(v).length > 0, { message: 'At least one locale' })
    .meta({ minProperties: 1 }),
});
export type PrivacyNotice = z.infer<typeof PrivacyNotice>;

export const PrivacyNoticeDraft = z.object({
  controller: z.object({
    name: z.string().max(120),
    email: z.string().max(254),
    address: z.string().max(300).optional(),
  }),
  texts: z.partialRecord(
    LocaleCode,
    z
      .object({
        title: z.string().max(120),
        intro: z.string().max(4000),
        collected: z.string().max(4000),
        audience: z.string().max(4000),
        purpose: z.string().max(4000),
        retention: z.string().max(4000),
        rights: z.string().max(4000),
      })
      .partial(),
  ),
});
export type PrivacyNoticeDraft = z.infer<typeof PrivacyNoticeDraft>;

export const PublicNotice = PrivacyNotice.extend({ version: z.int().min(1), publishedAt: IsoUtc });
export type PublicNotice = z.infer<typeof PublicNotice>;
export const NoticeVersionInfo = z.object({ version: z.int().min(1), publishedAt: IsoUtc, sha256: Sha256Hex });
export type NoticeVersionInfo = z.infer<typeof NoticeVersionInfo>;
export const PrivacyState = z.object({
  draft: PrivacyNoticeDraft,
  draftSha256: Sha256Hex,
  current: PublicNotice.nullable(),
  versions: z.array(NoticeVersionInfo),
  /** Why the draft cannot be published yet (empty = publishable). */
  problems: z.array(z.string()),
});
export type PrivacyState = z.infer<typeof PrivacyState>;
export const PrivacyPublishRequest = z.object({ ifDraftSha256: Sha256Hex });
export type PrivacyPublishRequest = z.infer<typeof PrivacyPublishRequest>;

// ---------------------------------------------------------------------------------------------
// Public routes (site → API, §3.4)

export const UnavailableReason = z.enum(['locked', 'restoring', 'notice_missing', 'too_many_pending', 'store']);
export type UnavailableReason = z.infer<typeof UnavailableReason>;
const Invalid = z.object({ status: z.literal('invalid') });
const Ended = z.object({ status: z.literal('ended') });
const Unavailable = z.object({ status: z.literal('unavailable'), reason: UnavailableReason });
const PollAfter = z.int().min(500).max(60_000);

/**
 * "/_/h/" (with `session`: write the transfer cookie, then navigate) or "/" (already has a
 * session, or F2: the cookies came with the API response).
 */
export const HandoffPath = z.enum(['/_/h/', '/']);
export type HandoffPath = z.infer<typeof HandoffPath>;

export const JoinCheckRequest = z.object({ t: AccessToken, k: AccessToken.optional() });
export type JoinCheckRequest = z.infer<typeof JoinCheckRequest>;
export const JoinCheckResponse = z.discriminatedUnion('status', [
  Invalid,
  Unavailable,
  z.object({ status: z.literal('known_device'), noticeRequired: z.boolean() }),
  z.object({ status: z.literal('pending_device') }),
  z.object({
    status: z.literal('ok'),
    follower: z.object({ name: FollowerName }),
    notice: PublicNotice,
    deviceMustWait: z.boolean(),
  }),
]);
export type JoinCheckResponse = z.infer<typeof JoinCheckResponse>;

/** New device: t + consentVersion (k optional). Resume: resume=true + k, no t, no consentVersion. */
export const JoinRequest = z
  .object({
    t: AccessToken.optional(),
    k: AccessToken.optional(),
    resume: z.literal(true).optional(),
    consentVersion: z.int().min(1).optional(),
    locale: LocaleCode,
  })
  .superRefine((req, ctx) => {
    const resume = req.resume === true;
    if (resume && (req.k === undefined || req.t !== undefined || req.consentVersion !== undefined)) {
      ctx.addIssue({ code: 'custom', message: 'A resume needs k and neither t nor consentVersion' });
    }
    if (!resume && (req.t === undefined || req.consentVersion === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'A new device needs t and consentVersion' });
    }
  });
export type JoinRequest = z.infer<typeof JoinRequest>;

/** `session` is present exactly when `handoff` is "/_/h/" (PHP enforces the same). */
const Active = z
  .object({
    status: z.literal('active'),
    handoff: HandoffPath,
    session: GateSession.optional(),
    deviceKey: AccessToken.optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.handoff === HANDOFF_PATH) !== (v.session !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['session'], message: 'session is required exactly with handoff "/_/h/"' });
    }
  });
const Activating = z.object({
  status: z.literal('activating'),
  pollAfterMs: PollAfter,
  deviceKey: AccessToken.optional(),
});
const Pending = z.object({ status: z.literal('pending'), pollAfterMs: PollAfter, deviceKey: AccessToken.optional() });

export const JoinResponse = z.discriminatedUnion('status', [
  Invalid,
  Ended,
  Unavailable,
  Active,
  Activating,
  Pending,
  z.object({ status: z.literal('consent_outdated'), notice: PublicNotice }),
]);
export type JoinResponse = z.infer<typeof JoinResponse>;
export const DeviceKeyRequest = z.object({ k: AccessToken });
export type DeviceKeyRequest = z.infer<typeof DeviceKeyRequest>;
export const DevicePollResponse = z.discriminatedUnion('status', [Ended, Unavailable, Active, Activating, Pending]);
export type DevicePollResponse = z.infer<typeof DevicePollResponse>;
const NoticeFlags = z.object({ version: z.int().min(1), required: z.boolean() });
/**
 * `pending` is answered by `me/consent` only, to a waiting device (limited D12 rights, §3.3): no
 * name, only whether THIS device still has to confirm the current notice. `me/hello` never sends it.
 */
export const MeHelloResponse = z.discriminatedUnion('status', [
  Ended,
  Unavailable,
  z.object({
    status: z.literal('active'),
    follower: z.object({ name: FollowerName }),
    device: z.object({ id: DeviceId, label: z.string().max(60) }),
    notice: NoticeFlags.nullable(),
  }),
  z.object({ status: z.literal('pending'), notice: NoticeFlags.nullable() }),
]);
export type MeHelloResponse = z.infer<typeof MeHelloResponse>;
export const MeNoticeResponse = z.discriminatedUnion('status', [
  Ended,
  Unavailable,
  z.object({ status: z.literal('ok'), notice: PublicNotice, confirmedVersion: z.int().min(1).nullable() }),
]);
export type MeNoticeResponse = z.infer<typeof MeNoticeResponse>;
export const MeConsentRequest = z.object({ k: AccessToken, version: z.int().min(1), locale: LocaleCode });
export type MeConsentRequest = z.infer<typeof MeConsentRequest>;
export const DELETE_ME_CONFIRMATION = 'delete-all-my-data';
export const MeDeleteRequest = z.object({ k: AccessToken, confirm: z.literal(DELETE_ME_CONFIRMATION) });
export type MeDeleteRequest = z.infer<typeof MeDeleteRequest>;
export const MeSimpleResponse = z.object({ status: z.enum(['signed_out', 'deleted', 'ended']) });
export type MeSimpleResponse = z.infer<typeof MeSimpleResponse>;
export const PanicRequest = z.object({ key: AccessToken });
export type PanicRequest = z.infer<typeof PanicRequest>;
export const PanicResponse = z.object({ ok: z.literal(true) });
export type PanicResponse = z.infer<typeof PanicResponse>;

// ---------------------------------------------------------------------------------------------
// Data view / export (D12)

export const DeviceState = z.enum(['pending', 'active', 'revoked', 'declined']);
export type DeviceState = z.infer<typeof DeviceState>;
export const DataCategoryKey = z.enum(['devices', 'consents', 'visits', 'views', 'reactions', 'messages', 'email']);
export type DataCategoryKey = z.infer<typeof DataCategoryKey>;
const RevokedBy = z.enum(['owner', 'follower', 'system']);
const DeviceLabel = z.string().max(60);

export const DataDevice = z.object({
  id: DeviceId,
  label: DeviceLabel,
  state: DeviceState,
  createdAt: IsoUtc,
  lastSeenAt: IsoUtc.nullable(),
  thisDevice: z.boolean(),
});
export type DataDevice = z.infer<typeof DataDevice>;
export const DataConsent = z.object({ version: z.int().min(1), confirmedAt: IsoUtc, locale: LocaleCode });
export type DataConsent = z.infer<typeof DataConsent>;
const DataCategories = z.array(z.object({ key: DataCategoryKey, count: Count }));

export const FollowerDataView = z.object({
  follower: z.object({ id: FollowerId, name: FollowerName, since: IsoUtc, state: z.enum(['active', 'revoked']) }),
  devices: z.array(DataDevice),
  consents: z.array(DataConsent),
  categories: DataCategories,
  noticeVersion: z.int().min(1).nullable(),
});
export type FollowerDataView = z.infer<typeof FollowerDataView>;
export const MeDataResponse = z.discriminatedUnion('status', [
  Ended,
  z.object({ status: z.literal('ok'), data: FollowerDataView }),
  /** Pending, declined or separately revoked device (§3.3 D12 rights): only this device. */
  z.object({
    status: z.literal('limited'),
    device: z.object({ label: DeviceLabel, state: DeviceState, createdAt: IsoUtc }),
  }),
]);
export type MeDataResponse = z.infer<typeof MeDataResponse>;
export const FollowerDataExport = z.object({
  format: z.literal('omw-follower-data/1'),
  exportedAt: IsoUtc,
  follower: z.object({
    id: FollowerId,
    name: FollowerName,
    since: IsoUtc,
    state: z.enum(['active', 'revoked']),
    linkCreatedAt: IsoUtc.nullable(),
    revokedAt: IsoUtc.nullable(),
  }),
  devices: z.array(
    DataDevice.omit({ thisDevice: true }).extend({
      decidedAt: IsoUtc.nullable(),
      revokedAt: IsoUtc.nullable(),
      revokedBy: RevokedBy.nullable(),
    }),
  ),
  consents: z.array(DataConsent.extend({ notice: PrivacyNotice })),
  categories: DataCategories,
});
export type FollowerDataExport = z.infer<typeof FollowerDataExport>;

// ---------------------------------------------------------------------------------------------
// Admin (§3.5)

export const AdminDevice = z.object({
  id: DeviceId,
  state: DeviceState,
  label: DeviceLabel,
  first: z.boolean(),
  createdAt: IsoUtc,
  decidedAt: IsoUtc.nullable(),
  revokedAt: IsoUtc.nullable(),
  revokedBy: RevokedBy.nullable(),
  lastSeenAt: IsoUtc.nullable(),
  sessionAt: IsoUtc.nullable(),
});
export type AdminDevice = z.infer<typeof AdminDevice>;
export const AdminFollower = z.object({
  id: FollowerId,
  name: FollowerName,
  note: FollowerNote.nullable(),
  state: z.enum(['active', 'revoked']),
  createdAt: IsoUtc,
  revokedAt: IsoUtc.nullable(),
  link: z.object({ createdAt: IsoUtc }).nullable(),
  devices: z.array(AdminDevice),
  consent: z.object({ version: z.int().min(1), confirmedAt: IsoUtc }).nullable(),
  lastSeenAt: IsoUtc.nullable(),
});
export type AdminFollower = z.infer<typeof AdminFollower>;
export const FollowerTombstone = z.object({
  id: FollowerId,
  state: z.literal('deleted'),
  deletedAt: IsoUtc,
  deletedBy: z.enum(['follower', 'owner', 'restore']),
});
export type FollowerTombstone = z.infer<typeof FollowerTombstone>;
export const FollowerListResponse = z.object({
  items: z.array(AdminFollower),
  tombstones: z.array(FollowerTombstone),
});
export type FollowerListResponse = z.infer<typeof FollowerListResponse>;
export const FollowerCreate = z.object({ name: FollowerName, note: FollowerNote.optional() });
export type FollowerCreate = z.infer<typeof FollowerCreate>;
export const FollowerPatch = z.object({ name: FollowerName.optional(), note: FollowerNote.nullable().optional() });
export type FollowerPatch = z.infer<typeof FollowerPatch>;
export const PersonalLink = z.object({ url: z.url({ protocol: /^https?$/ }), createdAt: IsoUtc });
export type PersonalLink = z.infer<typeof PersonalLink>;
export const FollowerCreated = z.object({ follower: AdminFollower, link: PersonalLink });
export type FollowerCreated = z.infer<typeof FollowerCreated>;
export const PersonalLinkCreated = z.object({ link: PersonalLink });
export type PersonalLinkCreated = z.infer<typeof PersonalLinkCreated>;
export const FollowerDeleteRequest = z.object({ confirm: z.literal(true) });
export type FollowerDeleteRequest = z.infer<typeof FollowerDeleteRequest>;
export const WriterMode = z.enum(['direct', 'sftp', 'none']);
export type WriterMode = z.infer<typeof WriterMode>;
export const Effect = z.object({
  applied: z.boolean(),
  via: z.enum(['direct', 'sftp', 'mac', 'pending']),
  pendingOps: Count,
});
export type Effect = z.infer<typeof Effect>;
const FidDid = z.object({ fid: FollowerId, did: DeviceId });
export const StoreReport = z.object({
  at: IsoUtc,
  mode: z.enum(['normal', 'restored_api']),
  deleted: Count,
  missing: z.array(FidDid),
  orphans: z.array(FidDid),
  imported: z.array(z.string().max(200)),
});
export type StoreReport = z.infer<typeof StoreReport>;
const LockedBy = z.enum(['admin', 'panic', 'mac']);
/** Counts only, no names: persisted in the admin's IndexedDB as part of StatusResponse. */
export const AccessSummary = z.object({
  locked: z.boolean(),
  lockedAt: IsoUtc.nullable(),
  lockedBy: LockedBy.nullable(),
  pendingDevices: Count,
  pendingOps: Count,
  oldestPendingOpAt: IsoUtc.nullable(),
  writer: z.object({ mode: WriterMode, blocked: z.boolean(), error: z.string().max(500).nullable() }),
  restoring: z.boolean(),
  mismatch: z.boolean(),
  unreadNotices: Count,
  noticeVersion: z.int().min(1).nullable(),
});
export type AccessSummary = z.infer<typeof AccessSummary>;
export const GateCheckResult = z.object({
  at: IsoUtc,
  by: z.enum(['mac', 'api']),
  result: z.enum(['ok', 'gate_open', 'store_unverified', 'error', 'skipped']),
  detail: z.string().max(300).nullable(),
});
export type GateCheckResult = z.infer<typeof GateCheckResult>;
/** Not persisted by the admin (names): Home's pending-device cards read it (§7.5). */
export const PendingDeviceCard = z.object({
  did: DeviceId,
  fid: FollowerId,
  name: FollowerName,
  label: DeviceLabel,
  createdAt: IsoUtc,
});
export type PendingDeviceCard = z.infer<typeof PendingDeviceCard>;
export const AccessStatus = AccessSummary.extend({
  panicLink: z.boolean(),
  siteOrigin: Origin.nullable(),
  cookieMode: CookieMode,
  lastReconcile: StoreReport.nullable(),
  lastAppliedAt: IsoUtc.nullable(),
  storeId: StoreId.nullable(),
  storeProofAt: IsoUtc.nullable(),
  gateCheck: GateCheckResult.nullable(),
  pending: z.array(PendingDeviceCard).max(3),
});
export type AccessStatus = z.infer<typeof AccessStatus>;
export const AccessActionResult = z.object({
  effect: Effect,
  follower: AdminFollower.optional(),
  device: AdminDevice.optional(),
  status: AccessSummary.optional(),
});
export type AccessActionResult = z.infer<typeof AccessActionResult>;
export const LockRequest = z.discriminatedUnion('locked', [
  z.object({ locked: z.literal(true) }),
  z.object({ locked: z.literal(false), password: z.string().min(1).max(1000) }),
]);
export type LockRequest = z.infer<typeof LockRequest>;
export const PanicLinkCreated = z.object({ url: z.url({ protocol: /^https?$/ }) });
export type PanicLinkCreated = z.infer<typeof PanicLinkCreated>;
export const OwnerNoticeKind = z.enum(['follower_deleted', 'restore_reconciled', 'store_mismatch']);
export type OwnerNoticeKind = z.infer<typeof OwnerNoticeKind>;
export const OwnerNotice = z.object({
  id: z.int().positive(),
  kind: OwnerNoticeKind,
  createdAt: IsoUtc,
  readAt: IsoUtc.nullable(),
});
export type OwnerNotice = z.infer<typeof OwnerNotice>;
export const OwnerNoticeList = z.object({ items: z.array(OwnerNotice) });
export type OwnerNoticeList = z.infer<typeof OwnerNoticeList>;
export const NoticeReadRequest = z.object({ ids: z.array(z.int().positive()).min(1).max(100) });
export type NoticeReadRequest = z.infer<typeof NoticeReadRequest>;

// ---------------------------------------------------------------------------------------------
// Backend access sync (§3.6)

export const StoreOp = z.object({
  id: z.int().positive(),
  op: StoreOpKind,
  path: z.string().min(1).max(200),
  content: z.string().max(1000).nullable(),
  exclusive: z.boolean(),
});
export type StoreOp = z.infer<typeof StoreOp>;
export const StoreListing = z.object({
  marker: z.string().max(1000).nullable(),
  locked: z.string().max(1000).nullable(),
  sessions: z.array(z.string().regex(STORE_PATH_PATTERNS.session)).max(10_000),
  handoffs: z.array(DeviceId).max(10_000),
  tombstones: z
    .array(
      z.object({
        path: z.string().regex(new RegExp(`^t/${FID}(?:\\.${DID})?$`)),
        content: z.string().max(1000),
      }),
    )
    .max(10_000),
  /** Anything else found (reported; deleted when inside s/ or h/). */
  strays: z.array(z.string().max(200)).max(1000),
});
export type StoreListing = z.infer<typeof StoreListing>;
export const AccessClaimRequest = z.object({ holder: z.literal('mac') });
export type AccessClaimRequest = z.infer<typeof AccessClaimRequest>;
const Lease = z.object({ until: IsoUtc }).nullable();
export const AccessClaim = z.object({
  lease: Lease,
  storeId: StoreId.nullable(),
  epoch: Epoch,
  ops: z.array(StoreOp).max(200),
  listingWanted: z.boolean(),
});
export type AccessClaim = z.infer<typeof AccessClaim>;
export const AccessRenewRequest = z.object({ epoch: Epoch });
export type AccessRenewRequest = z.infer<typeof AccessRenewRequest>;
export const AccessLease = z.object({ lease: Lease });
export type AccessLease = z.infer<typeof AccessLease>;
export const StoreListingUpload = z.object({ epoch: Epoch, listing: StoreListing });
export type StoreListingUpload = z.infer<typeof StoreListingUpload>;
export const AccessAck = z.object({
  epoch: Epoch,
  appliedThrough: Count,
  failed: z.object({ opId: z.int().positive(), error: z.string().max(500) }).optional(),
});
export type AccessAck = z.infer<typeof AccessAck>;
export const ServiceSession = z.object({ cookieName: CookieName, cookieValue: GateSession, expiresAt: IsoUtc });
export type ServiceSession = z.infer<typeof ServiceSession>;
