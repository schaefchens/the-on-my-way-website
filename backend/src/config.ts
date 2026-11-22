/**
 * Backend configuration from environment variables (plan A7 + D7), validated with zod.
 *
 * | Variable            | Default (dev)                    | Default (production)   |
 * |---------------------|----------------------------------|------------------------|
 * | NODE_ENV            | development                      |                        |
 * | LOG_LEVEL           | debug                            | info                   |
 * | WA_MODE             | fixture                          | observer               |
 * |   (off = no WhatsApp at all: only app entries are captured; nothing to link)               |
 * | TRAVELER_PHONE      | – (required for observer mode)   |                        |
 * | TRAVELER_LID        | – (learned; overrides store meta)|                        |
 * | WA_HELPER_BIN       | backend/wa-helper/bin/wa-helper  | same                   |
 * | SEND_READ_RECEIPT   | false                            | false                  |
 * | FIXTURES_DIR        | fixtures/generated               | same                   |
 * | API_BASE_URL        | – (no API: captures-only site)   |                        |
 * | API_TOKEN           | – (required with API_BASE_URL)   |                        |
 * | API_BACKUP_KEEP     | 7                                | 7                      |
 * | CONTROL_HOST        | 127.0.0.1                        | 127.0.0.1              |
 * | CONTROL_PORT        | 8787                             | 8787                   |
 * | CONTROL_TOKEN       | dev token (warns; loopback only) | required (>= 16 chars) |
 * | CONTROL_ALLOWED_HOSTS | – (loopback names only)        | e.g. omw.tailnet.ts.net |
 * | NTFY_URL            | –                                |                        |
 * | DEFAULT_TIMEZONE    | Europe/Berlin                    | Europe/Berlin          |
 * | SITE_PUBLIC_URL     | – (http://127.0.0.1:4173/)       | required for SFTP      |
 * | MEDIA_GIVE_UP_HOURS | 48                               | 48                     |
 * | DATA_DIR            | backend/data/state               | /data                  |
 * | ARCHIVE_DIR         | backend/data/archive             | same                   |
 * | OUT_DIR             | backend/data/out                 | same                   |
 * | CONFIG_DIR          | backend/data/config              | same                   |
 * | MEDIA_DIR           | backend/data/media               | same                   |
 * | SITE_DIST_DIR       | frontend/site/dist               | same                   |
 * | OMW_VERSION         | backend/package.json version     | (Docker build arg)     |
 * | APP_PUBLISH         | false (archive-only, Q8 a)       | false                  |
 * | APP_INBOX_POLL_SECONDS | 60                            | 60                     |
 * | ACCESS_MODE         | open                             | gate (live hosting)    |
 * | API_PUBLIC_URL      | API_BASE_URL                     | required in gate mode  |
 * | ACCESS_STORE_DIR    | –                                | required in gate mode  |
 * | ACCESS_COOKIE_MODE  | headers                          | headers / co / parent  |
 * | ACCESS_COOKIE_DOMAIN| –                                | co: site host; parent  |
 * | ACCESS_HTTPS_REDIRECT | false                          | true when P0b-10 passed|
 * | GATE_OUT_DIR        | backend/data/out-gate            | same                   |
 *
 * Relative paths are resolved against backend/. DEFAULT_TIMEZONE is used until the mirrored
 * setting "timezone.current" arrives from the API.
 *
 * MEDIA_DIR (processed variants, D8) must be on the SAME filesystem as OUT_DIR: public variants
 * are hard-linked into OUT_DIR/media, and link(2)/rename(2) fail with EXDEV across mounts (in
 * Docker DATA_DIR=/data is a named volume while backend/data is a bind mount). The default puts
 * it next to OUT_DIR; linkOrCopy() (fsutil.ts) still falls back to a copy on EXDEV.
 *
 * SITE_PUBLIC_URL is the public URL of the static site (origin + basePath, e.g.
 * "https://example.org/travel/"): canonical/hreflang/og:url/sitemap use it and its path is the
 * basePath baked into the HTML. All publish targets serve the same OUT_DIR, so they must all
 * publish under that URL.
 *
 * CONTROL_ALLOWED_HOSTS: comma-separated Host names the control UI accepts besides loopback
 * (localhost, 127.0.0.1, ::1); needed only behind a reverse proxy or VPN name.
 *
 * SITE_DIST_DIR: the Vite build of @omw/site the generator copies to /assets/ (its
 * .vite/manifest.json also fingerprints the frontend: a new build triggers a full HTML rebuild).
 * OMW_VERSION: backend version string reported in the heartbeat and the control UI (the Docker
 * image sets it to "<package version>+<build id>").
 *
 * API_BASE_URL must be https:// in production (the backend token travels in every request and can
 * read the whole owner feed and the API's database backup); plain http is accepted only for a
 * loopback host (127.0.0.0/8, ::1, localhost: an API on the same machine or behind a local tunnel).
 * API_BACKUP_KEEP: how many daily API database backups (GET /backend/backup/latest) are kept in
 * DATA_DIR/api-backups (sync/backup.ts).
 *
 * APP_PUBLISH: whether entries from the traveler app may be published (capture/app-source.ts). Off
 * (the default) is the archive-only mode of owner decision Q8 a: app entries reach the home
 * archive, the pipeline and the admin, but the generator leaves every "app:" capture out until the
 * owner switches it on (after the wave-5 follower gate). APP_INBOX_POLL_SECONDS: how often the
 * API's app inbox is asked for new entries (only with an API).
 *
 * TRAVELER_LID: the traveler's WhatsApp LID (digits). Normally learned by the helper (`traveler`
 * event), persisted by Node and passed to the helper as -traveler-lid; set it only to override.
 *
 * Access gate (spec-wave5 §5.1). ACCESS_MODE=gate turns on the gate tree (GATE_OUT_DIR: root
 * .htaccess, neutral page, /_/ gate pages), the gated content .htaccess, the two-root publisher
 * and the anonymous-refused check; "open" is today's output (dev, fixtures, Docker e2e), with the
 * P0 fixes. In gate mode SITE_PUBLIC_URL is "https://<site host>/<secret>/" with <secret> =
 * [a-z0-9]{20} (exactly one path segment, generated once; backend/README.md has a one-liner), its
 * origin is the site origin and its path the content basePath.
 * API_PUBLIC_URL: the API base the browser calls (default API_BASE_URL); the gate pages call
 * "<API_PUBLIC_URL>api/v1/public/" and the CSP's connect-src names its origin. ACCESS_STORE_DIR:
 * the session-file store as Apache sees it (absolute, [A-Za-z0-9._/-], no "..", no "//"); it is
 * baked into both .htaccess files. ACCESS_COOKIE_MODE / ACCESS_COOKIE_DOMAIN must equal the API's
 * (headers: __Host- cookies, no domain; co: F1, the site host; parent: F2, the shared parent
 * domain). The whole config is checked with siteAccessProblems() (@omw/contracts/access). Nothing
 * in backend/src names a real host: every origin comes from here (Q9).
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  type AccessMode,
  CONTENT_PATH_RE,
  type CookieMode,
  SiteAccessConfig,
  siteAccessProblems,
} from '@omw/contracts/access';
import { isValidTimeZone } from '@omw/contracts/time';
import { z } from 'zod';
import { BACKEND_ROOT, REPO_ROOT } from './paths.js';

export const DEV_CONTROL_TOKEN = 'omw-dev-control-token';

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().trim().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.url({ protocol: /^https?$/ }).optional());
const booleanFlag = z.preprocess(
  emptyToUndefined,
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => v === 'true' || v === '1' || v === 'yes'),
);

const EnvSchema = z.object({
  NODE_ENV: z.preprocess(emptyToUndefined, z.enum(['development', 'production', 'test']).default('development')),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  ),
  WA_MODE: z.preprocess(emptyToUndefined, z.enum(['observer', 'self', 'fixture', 'off']).optional()),
  TRAVELER_LID: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{1,32}$/, 'Expected LID digits')
      .optional(),
  ),
  TRAVELER_PHONE: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .transform((v) => v.replace(/[\s()+-]/g, '').replace(/^00/, ''))
      .pipe(z.string().regex(/^[1-9]\d{5,15}$/, { message: 'Expected an international phone number' }))
      .optional(),
  ),
  WA_HELPER_BIN: optionalString,
  SEND_READ_RECEIPT: booleanFlag,
  FIXTURES_DIR: optionalString,
  API_BASE_URL: optionalUrl,
  API_TOKEN: optionalString,
  API_BACKUP_KEEP: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(365).default(7)),
  CONTROL_HOST: z.preprocess(emptyToUndefined, z.string().default('127.0.0.1')),
  CONTROL_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(8787)),
  CONTROL_TOKEN: optionalString,
  CONTROL_ALLOWED_HOSTS: optionalString,
  NTFY_URL: optionalUrl,
  SITE_PUBLIC_URL: optionalUrl,
  MEDIA_GIVE_UP_HOURS: z.preprocess(
    emptyToUndefined,
    z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(48),
  ),
  DEFAULT_TIMEZONE: z.preprocess(
    emptyToUndefined,
    z.string().refine(isValidTimeZone, { message: 'Unknown IANA time zone' }).default('Europe/Berlin'),
  ),
  DATA_DIR: optionalString,
  ARCHIVE_DIR: optionalString,
  OUT_DIR: optionalString,
  CONFIG_DIR: optionalString,
  MEDIA_DIR: optionalString,
  SITE_DIST_DIR: optionalString,
  OMW_VERSION: optionalString,
  APP_PUBLISH: booleanFlag,
  APP_INBOX_POLL_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(10).max(3600).default(60)),
  ACCESS_MODE: z.preprocess(emptyToUndefined, z.enum(['open', 'gate']).default('open')),
  API_PUBLIC_URL: optionalUrl,
  ACCESS_STORE_DIR: optionalString,
  ACCESS_COOKIE_MODE: z.preprocess(emptyToUndefined, z.enum(['headers', 'co', 'parent']).default('headers')),
  ACCESS_COOKIE_DOMAIN: optionalString,
  ACCESS_HTTPS_REDIRECT: booleanFlag,
  GATE_OUT_DIR: optionalString,
});

export type WaMode = 'observer' | 'self' | 'fixture' | 'off';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface Config {
  env: 'development' | 'production' | 'test';
  logLevel: LogLevel;
  wa: {
    mode: WaMode;
    /** Digits only, e.g. "4915112345678"; null in fixture/self mode when unset. */
    travelerPhone: string | null;
    /** Explicit LID override (digits); null = use the learned one. */
    travelerLid: string | null;
    /** Give up on a media download (-> media_lost) after this many hours (wa.ts rule 3). */
    mediaGiveUpHours: number;
    helperBin: string;
    sendReadReceipt: boolean;
    fixturesDir: string;
  };
  /** null = no API configured: captures-only site with default settings. */
  api: { baseUrl: string; token: string } | null;
  /** Daily API database backups kept in DATA_DIR/api-backups (API_BACKUP_KEEP). Optional for hand-built configs. */
  apiBackupKeep?: number;
  control: { host: string; port: number; token: string; tokenIsDefault: boolean };
  ntfyUrl: string | null;
  defaultTimezone: string;
  /** Public URL of the static site; basePath is its path ("/" or "/travel/"). */
  site: { publicUrl: string | null; basePath: string };
  dirs: { data: string; archive: string; out: string; config: string; media: string };
  /** Backend version (OMW_VERSION, else backend/package.json). Optional for hand-built configs. */
  version?: string;
  /** Vite build of @omw/site (SITE_DIST_DIR). Optional for hand-built configs. */
  siteDistDir?: string;
  /** Extra Host names for the control UI (CONTROL_ALLOWED_HOSTS), lowercase. */
  controlAllowedHosts?: string[];
  /**
   * Traveler app (APP_PUBLISH, APP_INBOX_POLL_SECONDS). Optional for hand-built configs: absent
   * means archive-only (app entries are never published) and a 60 s poll.
   */
  app?: { publish: boolean; pollSeconds: number };
  /** Access gate (spec-wave5 §5.1); absent in hand-built configs = open mode (accessOf()). */
  access?: AccessSettings;
}

export interface AccessSettings {
  mode: AccessMode;
  /**
   * The site/API/cookie configuration (checked with siteAccessProblems). Always set in gate mode;
   * in open mode only when SITE_PUBLIC_URL and an API URL are known (heartbeat `site`).
   */
  site: SiteAccessConfig | null;
  /** Gate mode: the content folder ("<secret>", the one segment of SITE_PUBLIC_URL's path). */
  secret: string | null;
  /** Where the gate tree is generated (GATE_OUT_DIR; a sibling of OUT_DIR, never inside it). */
  gateOutDir: string;
}

/** The access settings of a config (hand-built configs without them are open mode). */
export function accessOf(config: Pick<Config, 'access' | 'dirs'>): AccessSettings {
  return (
    config.access ?? { mode: 'open', site: null, secret: null, gateOutDir: join(config.dirs.out, '..', 'out-gate') }
  );
}

/** True for a config in gate mode (with its site configuration, which gate mode guarantees). */
export function isGateMode(config: Pick<Config, 'access' | 'dirs'>): config is Pick<Config, 'dirs'> & {
  access: AccessSettings & { mode: 'gate'; site: SiteAccessConfig; secret: string };
} {
  const a = accessOf(config);
  return a.mode === 'gate' && a.site !== null && a.secret !== null;
}

/** backend/package.json version ("0.0.0" if unreadable). */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(BACKEND_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/**
 * Loopback host names: localhost, 127.0.0.0/8 and ::1 (with or without brackets, as URL.hostname
 * returns IPv6 literals bracketed).
 */
export function isLoopbackHostname(host: string): boolean {
  return /^(?:localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i.test(host);
}

function resolvePath(value: string | undefined, fallback: string): string {
  const v = value ?? fallback;
  return isAbsolute(v) ? v : resolve(BACKEND_ROOT, v);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  const problems: string[] = [];

  const mode: WaMode = e.WA_MODE ?? (production ? 'observer' : 'fixture');
  if (mode === 'observer' && !e.TRAVELER_PHONE) {
    problems.push('TRAVELER_PHONE is required when WA_MODE=observer');
  }
  if (Boolean(e.API_BASE_URL) !== Boolean(e.API_TOKEN)) {
    problems.push('API_BASE_URL and API_TOKEN must be set together');
  }
  if (production && e.API_BASE_URL) {
    const api = new URL(e.API_BASE_URL);
    if (api.protocol !== 'https:' && !isLoopbackHostname(api.hostname)) {
      problems.push(
        `API_BASE_URL must use https:// in production (the backend token would travel in cleartext to ${api.host}); ` +
          'plain http is only accepted for a loopback host (127.0.0.1, ::1, localhost)',
      );
    }
  }
  let controlToken = e.CONTROL_TOKEN;
  let tokenIsDefault = false;
  if (!controlToken) {
    if (production) problems.push('CONTROL_TOKEN is required in production');
    controlToken = DEV_CONTROL_TOKEN;
    tokenIsDefault = true;
  } else if (production && controlToken.length < 16) {
    problems.push('CONTROL_TOKEN must be at least 16 characters in production');
  }
  // The development token is public (it is in this file): never accept it on a reachable address.
  // (A client in the LAN can send "Host: localhost", so the Host allow-list is no protection.)
  const loopbackHost = isLoopbackHostname(e.CONTROL_HOST);
  if (tokenIsDefault && !loopbackHost) {
    problems.push(`CONTROL_TOKEN is required when CONTROL_HOST (${e.CONTROL_HOST}) is not a loopback address`);
  }
  let basePath = '/';
  if (e.SITE_PUBLIC_URL) {
    const url = new URL(e.SITE_PUBLIC_URL);
    basePath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    if (!/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(basePath)) problems.push('SITE_PUBLIC_URL has an unsupported path');
    if (url.search || url.hash) problems.push('SITE_PUBLIC_URL must not have a query or fragment');
  }
  const controlAllowedHosts = (e.CONTROL_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  for (const h of controlAllowedHosts) {
    if (!/^[a-z0-9.-]+$|^\[[0-9a-f:]+\]$/.test(h)) problems.push(`CONTROL_ALLOWED_HOSTS: invalid host name "${h}"`);
  }
  const outDir = resolvePath(e.OUT_DIR, 'data/out');
  const access = accessSettings(e, basePath, outDir, problems);
  if (problems.length > 0) throw new ConfigError(`Invalid environment:\n  ${problems.join('\n  ')}`);

  const dataDefault = production ? '/data' : 'data/state';
  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL ?? (production ? 'info' : e.NODE_ENV === 'test' ? 'silent' : 'debug'),
    wa: {
      mode,
      travelerPhone: e.TRAVELER_PHONE ?? null,
      travelerLid: e.TRAVELER_LID ?? null,
      mediaGiveUpHours: e.MEDIA_GIVE_UP_HOURS,
      helperBin: resolvePath(e.WA_HELPER_BIN, 'wa-helper/bin/wa-helper'),
      sendReadReceipt: e.SEND_READ_RECEIPT,
      fixturesDir: resolvePath(e.FIXTURES_DIR, join(REPO_ROOT, 'fixtures', 'generated')),
    },
    api: e.API_BASE_URL && e.API_TOKEN ? { baseUrl: e.API_BASE_URL.replace(/\/+$/, ''), token: e.API_TOKEN } : null,
    apiBackupKeep: e.API_BACKUP_KEEP,
    control: { host: e.CONTROL_HOST, port: e.CONTROL_PORT, token: controlToken, tokenIsDefault },
    ntfyUrl: e.NTFY_URL ?? null,
    defaultTimezone: e.DEFAULT_TIMEZONE,
    site: { publicUrl: e.SITE_PUBLIC_URL ?? null, basePath },
    dirs: {
      data: resolvePath(e.DATA_DIR, dataDefault),
      archive: resolvePath(e.ARCHIVE_DIR, 'data/archive'),
      out: outDir,
      config: resolvePath(e.CONFIG_DIR, 'data/config'),
      media: resolvePath(e.MEDIA_DIR, 'data/media'),
    },
    version: e.OMW_VERSION ?? packageVersion(),
    siteDistDir: resolvePath(e.SITE_DIST_DIR, join(REPO_ROOT, 'frontend', 'site', 'dist')),
    controlAllowedHosts,
    app: { publish: e.APP_PUBLISH, pollSeconds: e.APP_INBOX_POLL_SECONDS },
    access,
  };
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The access gate settings (spec-wave5 §5.1); pushes every problem found. */
function accessSettings(
  e: z.infer<typeof EnvSchema>,
  basePath: string,
  outDir: string,
  problems: string[],
): AccessSettings {
  const mode: AccessMode = e.ACCESS_MODE;
  const gateOutDir = resolvePath(e.GATE_OUT_DIR, 'data/out-gate');
  if (mode === 'gate' && (isInside(gateOutDir, outDir) || isInside(outDir, gateOutDir))) {
    problems.push('GATE_OUT_DIR must be a sibling of OUT_DIR (neither inside the other)');
  }
  const apiUrl = e.API_PUBLIC_URL ?? e.API_BASE_URL;
  if (mode === 'gate') {
    if (!e.SITE_PUBLIC_URL) problems.push('ACCESS_MODE=gate needs SITE_PUBLIC_URL (https://<site host>/<secret>/)');
    if (!apiUrl) problems.push('ACCESS_MODE=gate needs API_PUBLIC_URL (or API_BASE_URL)');
  }
  if (!e.SITE_PUBLIC_URL || !apiUrl) return { mode, site: null, secret: null, gateOutDir };
  const api = new URL(apiUrl);
  const apiBase = `${api.origin}${api.pathname.endsWith('/') ? api.pathname : `${api.pathname}/`}`;
  const candidate = {
    mode,
    siteOrigin: new URL(e.SITE_PUBLIC_URL).origin,
    contentPath: basePath,
    apiPublicBase: `${apiBase}api/v1/public/`,
    cookieMode: e.ACCESS_COOKIE_MODE as CookieMode,
    ...(e.ACCESS_COOKIE_DOMAIN ? { cookieDomain: e.ACCESS_COOKIE_DOMAIN.toLowerCase() } : {}),
    ...(e.ACCESS_STORE_DIR ? { storeDir: e.ACCESS_STORE_DIR } : {}),
    httpsRedirect: e.ACCESS_HTTPS_REDIRECT,
  };
  if (api.search || api.hash || api.username || api.password) {
    problems.push('API_PUBLIC_URL must not have a query, fragment or credentials');
  }
  const parsed = SiteAccessConfig.safeParse(candidate);
  if (!parsed.success) {
    // Only gate mode depends on these values; in open mode they merely describe the site.
    if (mode === 'gate') {
      problems.push(...parsed.error.issues.map((i) => `access config: ${i.path.join('.')}: ${i.message}`));
    }
    return { mode, site: null, secret: null, gateOutDir };
  }
  const site = parsed.data;
  const found = siteAccessProblems(site);
  if (found.length > 0) {
    // Gate mode refuses an inconsistent config; open mode merely leaves the description out.
    if (mode === 'gate') problems.push(...found.map((p) => `access config: ${p}`));
    return { mode, site: null, secret: null, gateOutDir };
  }
  const secret = mode === 'gate' && CONTENT_PATH_RE.test(basePath) ? basePath.slice(1, -1) : null;
  return { mode, site, secret, gateOutDir };
}

/** Config without secrets, for logs and the control UI. */
export function redactConfig(config: Config): unknown {
  return {
    ...config,
    api: config.api ? { baseUrl: config.api.baseUrl, token: '***' } : null,
    control: { ...config.control, token: '***' },
  };
}
