/**
 * Non-page files at the site root: robots.txt, sitemap.xml (only when indexable) and the
 * optional Apache .htaccess.
 *
 * robots.txt / sitemap.xml are only meaningful at the host root; with a basePath other than "/"
 * they are still generated (harmless) and the operator must point the host root's robots.txt
 * at them if wanted. In gate mode (spec-wave5 §5.4) neither is written into OUT_DIR: the gate
 * tree's robots.txt ("Disallow: /") rules the host.
 *
 * Gate mode .htaccess files (spec-wave5 §2.4, exact text; verified on Apache 2.4 by
 * .cache/design-w5/apache-probe-w5r and backend/test/gate/apache.test.ts):
 * - gateBlock(cfg): the "omw gate v1" block, byte-identical in the root and the content file;
 * - rootCookieSection(cfg): the root-only Set-Cookie lines, HSTS and the <If> header blocks;
 * - rootHtaccess(cfg): the gate tree's /.htaccess;
 * - contentHtaccess(site, cfg): /<secret>/.htaccess = today's htaccess() without the dot
 *   FilesMatch, with ErrorDocument 403, private caching and Referrer-Policy same-origin, then
 *   the gate block. In open mode (cfg null) it is today's htaccess() unchanged.
 * Cookie modes: headers (primary, __Host- cookies from mod_headers), co (F1: the CO flag on the
 * handoff and refresh rules, no Set-Cookie lines) and parent (F2: the API sets the cookies;
 * Apache sets none, so no host-only duplicates of the parent-domain cookies can appear).
 */
import type { CookieMode } from '@omw/contracts/access';
import type { LocaleCode } from '@omw/contracts/i18n';
import { type RouteRef, routePath, type SiteInfo } from '@omw/contracts/site';
import { escapeHtml } from './html.js';

export function robotsTxt(site: SiteInfo, publicBase: string | null): string {
  if (!site.indexable) return 'User-agent: *\nDisallow: /\n';
  const lines = ['User-agent: *', 'Allow: /'];
  if (publicBase) lines.push(`Sitemap: ${publicBase}sitemap.xml`);
  return `${lines.join('\n')}\n`;
}

/** sitemap.xml with hreflang alternates; null when the site must not be indexed or has no URL. */
export function sitemapXml(site: SiteInfo, publicBase: string | null, routes: readonly RouteRef[]): string | null {
  if (!site.indexable || !publicBase) return null;
  const url = (locale: LocaleCode, route: RouteRef) => escapeHtml(publicBase + routePath(locale, route));
  const entries: string[] = [];
  for (const route of routes) {
    for (const locale of site.locales) {
      const alternates = site.locales
        .map((l) => `<xhtml:link rel="alternate" hreflang="${l}" href="${url(l, route)}"/>`)
        .join('');
      entries.push(`<url><loc>${url(locale, route)}</loc>${alternates}</url>`);
    }
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...entries,
    '</urlset>',
    '',
  ].join('\n');
}

/** Text types worth compressing (media is already compressed and is never listed). */
export const COMPRESSIBLE_TYPES = [
  'text/html',
  'text/css',
  'text/javascript',
  'application/javascript',
  'application/json',
  'image/svg+xml',
  'application/manifest+json',
] as const;

/**
 * Content-addressed media file names ("<sha16>_<variant>.<ext>", paths.ts mediaRelPath). Vite
 * asset names ("name-<hash>.ext") never match.
 */
export const MEDIA_FILE_PATTERN = '^[0-9a-f]{16}_[a-z0-9_]+\\.(?:avif|webp|jpg|mp4|m4a)$';

/**
 * Apache config for shared hosting (plan A5 "Static host quirks"): MIME types, 404 page,
 * directory index, caching (hashed assets and content-addressed media are immutable; HTML and
 * JSON are revalidated on every load, data files are additionally cache-busted with ?v=),
 * compression of text responses (brotli where mod_brotli exists, else gzip via mod_deflate; both
 * blocks are no-ops without their module, AddOutputFilterByType itself needs mod_filter), no
 * directory listings, dotfiles (e.g. the publisher's /.omw-deploy.json.gz) never served.
 *
 * Media is cached "private": the publisher deletes the files of hidden or revoked items at once,
 * and a shared cache (CDN, proxy) must not keep serving them for a year. Browsers may still keep
 * their own copy (see docs/OPERATIONS.md: purge a CDN on hide/revoke if one is ever added).
 */
export function htaccess(site: SiteInfo): string {
  return htaccessLines(site, null).join('\n');
}

/** The mod_mime block ({{CT}} of spec-wave5 §2.4): the same in every generated .htaccess. */
export function mimeBlock(): string[] {
  return [
    '<IfModule mod_mime.c>',
    '    AddType image/avif .avif',
    '    AddType image/webp .webp',
    '    AddType audio/mp4 .m4a',
    '    AddType video/mp4 .mp4',
    '    AddType font/woff2 .woff2',
    '    AddType application/manifest+json .webmanifest',
    '    AddType application/json .json',
    '    AddType text/javascript .js .mjs',
    '    AddCharset utf-8 .html .json .js .mjs .css .txt .xml .webmanifest',
    '</IfModule>',
  ];
}

function compressionBlock(): string[] {
  const types = COMPRESSIBLE_TYPES.join(' ');
  return [
    '<IfModule mod_brotli.c>',
    '    <IfModule mod_filter.c>',
    `        AddOutputFilterByType BROTLI_COMPRESS ${types}`,
    '    </IfModule>',
    '</IfModule>',
    '<IfModule mod_deflate.c>',
    '    <IfModule mod_filter.c>',
    `        AddOutputFilterByType DEFLATE ${types}`,
    '    </IfModule>',
    '</IfModule>',
  ];
}

/** Content .htaccess lines: today's (gate null) or the gated variant of spec-wave5 §2.4.3. */
function htaccessLines(site: SiteInfo, gate: GateHtaccessConfig | null): string[] {
  const priv = gate !== null;
  return [
    '# Generated by the On My Way site generator. Do not edit: it is rewritten on every build.',
    'Options -Indexes -MultiViews',
    'DirectoryIndex index.html',
    `ErrorDocument 404 ${site.basePath}404.html`,
    ...(priv ? ['ErrorDocument 403 /_/403.txt'] : []),
    '',
    ...mimeBlock(),
    '',
    // Gate mode: the gate block's dot rule answers 403 for every dot path (and §5.5 allows no
    // Require outside the gate block).
    ...(priv ? [] : ['<FilesMatch "^\\.">', '    Require all denied', '</FilesMatch>', '']),
    '<IfModule mod_headers.c>',
    '    Header always set X-Content-Type-Options "nosniff"',
    `    Header always set Referrer-Policy "${priv ? 'same-origin' : 'strict-origin-when-cross-origin'}"`,
    '    Header always set X-Frame-Options "SAMEORIGIN"',
    '    <FilesMatch "\\.(?:html|json|xml|txt)$">',
    `        Header set Cache-Control "${priv ? 'private, no-cache' : 'no-cache'}"`,
    '    </FilesMatch>',
    '    <FilesMatch "\\.(?:js|mjs|css|woff2|avif|webp|jpg|mp4|m4a)$">',
    `        Header set Cache-Control "${priv ? 'private' : 'public'}, max-age=31536000, immutable"`,
    '    </FilesMatch>',
    `    <FilesMatch "${MEDIA_FILE_PATTERN}">`,
    '        Header set Cache-Control "private, max-age=31536000, immutable"',
    '    </FilesMatch>',
    '</IfModule>',
    '',
    ...compressionBlock(),
    '',
    ...(gate ? gateBlock(gate).split('\n') : []),
  ];
}

// ---------------------------------------------------------------------------------------------
// Gate mode (spec-wave5 §2.4)

/** Everything the gate .htaccess text depends on (generate.ts gateHtaccessConfig()). */
export interface GateHtaccessConfig {
  /** Absolute store path as Apache sees it, no trailing slash (isSafeStoreDir). */
  storeDir: string;
  /** The content folder ("<secret>", [a-z0-9]{20}). */
  secret: string;
  /** The site host (https redirect target, F1 cookie domain). */
  host: string;
  cookieMode: CookieMode;
  /** Gate cookie names (gateCookies()) and whether they carry Secure. */
  cookies: { session: string; key: string; transfer: string; handoff: string; resume: string; secure: boolean };
  /** [https] lines: the http→https redirect (ACCESS_HTTPS_REDIRECT, https only). */
  httpsRedirect: boolean;
  /** [hsts] line: Strict-Transport-Security (https SITE_PUBLIC_URL). */
  hsts: boolean;
  /** {{CSP_N}}: the neutral page's CSP (hashes of its inline script and style). */
  cspNeutral: string;
  /** {{CSP_G}}: the gate pages' CSP (connect-src = the API origin). */
  cspGate: string;
}

export const GATE_BLOCK_START = '# >>> omw gate v1 (generated; identical in both .htaccess files; never edit) >>>';
export const GATE_BLOCK_END = '# <<< omw gate v1 <<<';
export const COOKIE_SECTION_START = '# >>> omw gate cookies v1 (root only) >>>';
export const COOKIE_SECTION_END = '# <<< omw gate cookies v1 <<<';

const SESSION_CAPTURE = '([a-z2-7]{12})\\.([a-z2-7]{8})\\.([A-Za-z0-9_-]{43})';
const KEY_CAPTURE = '([A-Za-z0-9_-]{43})';

/** F1 (CO flag) cookie flags: lifetime in minutes (576000 = 400 days), secure only over https. */
function coFlag(name: string, value: string, cfg: GateHtaccessConfig, minutes: number, http: boolean, site: string) {
  const secure = cfg.cookies.secure ? 'secure' : 'false';
  return `CO=${name}:${value}:${cfg.host}:${minutes}:/:${secure}:${http ? 'httponly' : 'false'}:${site}`;
}

/**
 * The gate block (spec-wave5 §2.4.1), byte-identical in both .htaccess files. The [https] lines
 * are emitted only with cfg.httpsRedirect. In co mode (F1) the handoff and refresh rules carry
 * CO flags instead of the environment variables the root's Set-Cookie lines read.
 */
export function gateBlock(cfg: GateHtaccessConfig): string {
  const S = cfg.storeDir;
  const { session: CK, key: KK, transfer: SK, handoff: HK } = cfg.cookies;
  const co = cfg.cookieMode === 'co';
  const handoffFlags = co
    ? [
        coFlag(CK, '%1.%2.%3', cfg, 576000, true, 'lax'),
        coFlag(KK, '%{ENV:OMW_HK}', cfg, 576000, false, 'strict'),
        coFlag(HK, '1', cfg, 10, false, 'strict'),
        coFlag(SK, 'x', cfg, -1, false, 'strict'),
      ].join(',')
    : 'E=OMW_SET:%1.%2.%3,E=OMW_KEY:%{ENV:OMW_HK}';
  const keyRefresh = co ? coFlag(KK, '%1', cfg, 576000, false, 'strict') : 'E=OMW_RK:%1';
  const sessionRefresh = co ? coFlag(CK, '%{ENV:OMW_C}', cfg, 576000, true, 'lax') : 'E=OMW_RC:%{ENV:OMW_C}';
  return [
    GATE_BLOCK_START,
    'RewriteEngine On',
    'RewriteOptions InheritDownBefore AllowNoSlash',
    'DirectorySlash Off',
    'RewriteCond %{REQUEST_URI} ^/\\.well-known/acme-challenge/[A-Za-z0-9_-]+$',
    'RewriteRule ^ - [L]',
    ...(cfg.httpsRedirect
      ? ['RewriteCond %{HTTPS} !=on', `RewriteRule ^ https://${cfg.host}%{REQUEST_URI} [R=301,L]`]
      : []),
    'RewriteCond %{REQUEST_URI} (?:^|/)\\.',
    'RewriteRule ^ - [F,L]',
    'RewriteCond %{REQUEST_URI} =/_/h/',
    `RewriteCond %{HTTP_COOKIE} (?:^|;\\s*)${KK}=${KEY_CAPTURE}(?:;|$)`,
    'RewriteRule ^ - [E=OMW_HK:%1]',
    'RewriteCond %{ENV:OMW_HK} ^[A-Za-z0-9_-]{43}$',
    `RewriteCond %{HTTP_COOKIE} (?:^|;\\s*)${SK}=${SESSION_CAPTURE}(?:;|$)`,
    `RewriteCond ${S}/h/%2 -f`,
    `RewriteCond ${S}/s/%1/%2.%3 -f`,
    `RewriteCond ${S}/locked !-f`,
    `RewriteRule ^ /${cfg.secret}/ [R=303,L,${handoffFlags}]`,
    'RewriteCond %{REQUEST_URI} ^/_/h(?:/|$)',
    'RewriteRule ^ /_/join/#handoff-failed [R=303,L,NE]',
    'RewriteCond %{REQUEST_URI} ^/_/(?:n|join|info|wait|ended|me|panic)$',
    'RewriteRule ^ %{REQUEST_URI}/ [R=301,L]',
    'RewriteCond %{REQUEST_URI} ^/_/(?:join|info|wait|ended|me)/$',
    `RewriteCond %{HTTP_COOKIE} (?:^|;\\s*)${KK}=${KEY_CAPTURE}(?:;|$)`,
    `RewriteRule ^ - [${keyRefresh}]`,
    'RewriteCond %{REQUEST_URI} ^/(?:_/|robots\\.txt$|favicon\\.svg$)',
    'RewriteRule ^ - [L]',
    `RewriteCond ${S}/locked !-f`,
    `RewriteCond %{HTTP_COOKIE} (?:^|;\\s*)${CK}=${SESSION_CAPTURE}(?:;|$)`,
    `RewriteCond ${S}/s/%1/%2.%3 -f`,
    'RewriteRule ^ - [E=OMW_OK:1,E=OMW_C:%1.%2.%3]',
    'RewriteCond %{ENV:OMW_OK} =1',
    'RewriteCond %{REQUEST_FILENAME} -d',
    'RewriteCond %{REQUEST_URI} [^/]$',
    'RewriteRule ^ %{REQUEST_URI}/ [R=301,L]',
    'RewriteCond %{ENV:OMW_OK} =1',
    'RewriteCond %{REQUEST_URI} =/',
    `RewriteRule ^ /${cfg.secret}/ [R=302,L]`,
    'RewriteCond %{ENV:OMW_OK} =1',
    'RewriteCond %{REQUEST_URI} /$',
    `RewriteCond %{HTTP_COOKIE} (?:^|;\\s*)${KK}=${KEY_CAPTURE}(?:;|$)`,
    `RewriteRule ^ - [${keyRefresh}]`,
    'RewriteCond %{ENV:OMW_OK} =1',
    'RewriteCond %{REQUEST_URI} /$',
    `RewriteRule ^ - [${sessionRefresh}]`,
    'RewriteCond %{ENV:OMW_OK} =1',
    'RewriteRule ^ - [L]',
    `RewriteCond ${S}/locked !-f`,
    `RewriteCond %{HTTP_COOKIE} (?:^|;\\s*)${CK}=`,
    'RewriteRule ^ - [E=OMW_STALE:1]',
    'RewriteCond %{REQUEST_URI} ^/[^/]+/(?:data|media)/',
    'RewriteRule ^ - [F,L]',
    'RewriteRule ^ /_/n/index.html [END]',
    'Header always set Vary "Cookie"',
    'Header always set X-Robots-Tag "noindex, nofollow, noarchive"',
    'Header always set Clear-Site-Data "\\"cache\\", \\"storage\\"" env=OMW_STALE',
    'Header always set Clear-Site-Data "\\"cache\\", \\"storage\\"" env=REDIRECT_OMW_STALE',
    GATE_BLOCK_END,
  ].join('\n');
}

/**
 * The root-only section (spec-wave5 §2.4.2): the Set-Cookie lines (headers mode only: in co mode
 * the CO flags set the cookies, in parent mode the API does), HSTS for an https site, and the
 * <If> header blocks of the public /_/ tree.
 */
export function rootCookieSection(cfg: GateHtaccessConfig): string {
  const { session: CK, key: KK, transfer: SK, handoff: HK } = cfg.cookies;
  const SEC = cfg.cookies.secure ? 'Secure; ' : '';
  const setCookies =
    cfg.cookieMode === 'headers'
      ? [
          `Header always add Set-Cookie "${CK}=%{OMW_SET}e; Path=/; Max-Age=34560000; ${SEC}HttpOnly; SameSite=Lax" env=OMW_SET`,
          `Header always add Set-Cookie "${KK}=%{OMW_KEY}e; Path=/; Max-Age=34560000; ${SEC}SameSite=Strict" env=OMW_KEY`,
          `Header always add Set-Cookie "${SK}=; Path=/; Max-Age=0; ${SEC}SameSite=Strict" env=OMW_SET`,
          `Header always add Set-Cookie "${HK}=1; Path=/; Max-Age=600; ${SEC}SameSite=Strict" env=OMW_SET`,
          `Header always add Set-Cookie "${CK}=%{OMW_RC}e; Path=/; Max-Age=34560000; ${SEC}HttpOnly; SameSite=Lax" env=OMW_RC`,
          `Header always add Set-Cookie "${CK}=%{REDIRECT_OMW_RC}e; Path=/; Max-Age=34560000; ${SEC}HttpOnly; SameSite=Lax" env=REDIRECT_OMW_RC`,
          `Header always add Set-Cookie "${KK}=%{OMW_RK}e; Path=/; Max-Age=34560000; ${SEC}SameSite=Strict" env=OMW_RK`,
          `Header always add Set-Cookie "${KK}=%{REDIRECT_OMW_RK}e; Path=/; Max-Age=34560000; ${SEC}SameSite=Strict" env=REDIRECT_OMW_RK`,
        ]
      : [];
  return [
    COOKIE_SECTION_START,
    ...setCookies,
    ...(cfg.hsts ? ['Header always set Strict-Transport-Security "max-age=31536000"'] : []),
    '<If "%{REQUEST_URI} =~ m#^/_/(?!assets/)#">',
    '    Header always set Cache-Control "no-store"',
    '    Header always set Referrer-Policy "no-referrer"',
    '    Header always set X-Content-Type-Options "nosniff"',
    '</If>',
    '<If "%{REQUEST_URI} =~ m#^/_/(?:n/|index\\.html$|$)#">',
    `    Header always set Content-Security-Policy "${cfg.cspNeutral}"`,
    '</If>',
    '<If "%{REQUEST_URI} =~ m#^/_/(?:join|info|wait|ended|me|panic)/#">',
    `    Header always set Content-Security-Policy "${cfg.cspGate}"`,
    '</If>',
    '<If "%{REQUEST_URI} =~ m#^/_/assets/#">',
    '    Header always set Cache-Control "public, max-age=31536000, immutable"',
    '</If>',
    COOKIE_SECTION_END,
  ].join('\n');
}

/** The gate tree's /.htaccess (spec-wave5 §2.4.2). */
export function rootHtaccess(cfg: GateHtaccessConfig): string {
  return [
    '# Generated by the On My Way site generator (gate tree). Do not edit: rewritten by the publisher.',
    'Options -Indexes -MultiViews',
    'DirectoryIndex index.html',
    'ErrorDocument 403 /_/403.txt',
    'ErrorDocument 404 /_/n/index.html',
    ...mimeBlock(),
    gateBlock(cfg),
    rootCookieSection(cfg),
    '',
  ].join('\n');
}

/** /<secret>/.htaccess: today's htaccess() in open mode (cfg null), the gated one in gate mode. */
export function contentHtaccess(site: SiteInfo, cfg: GateHtaccessConfig | null): string {
  if (!cfg) return htaccess(site);
  return `${htaccessLines(site, cfg).join('\n')}\n`;
}
