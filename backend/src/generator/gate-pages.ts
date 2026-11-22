/**
 * Fixed public files of the gate tree (spec-wave5 §2.1, §2.5, §2.6): the neutral page, its inline
 * script and style (hashed into {{CSP_N}}), the gate page template that loads the gate bundle with
 * its GateBoot JSON, robots.txt, the 403 body and the generic favicon.
 *
 * Zero information without access (D3): nothing here varies with the content. The neutral page
 * varies only in its language order (site.default_locale: de first, else en first); the gate
 * pages carry GateBoot (API base, locales, cookie names, the bundle hash) and no personal data,
 * no content path and no count. The neutral page never names the API origin.
 */
import type { CookieMode, GateBoot, GatePage } from '@omw/contracts/access';
import { GATE_BOOT_ELEMENT_ID } from '@omw/contracts/access';
import { type LocaleCode, textDirection } from '@omw/contracts/i18n';
import { cspHash } from './hash.js';
import { inlineCode, jsonForScript, safeHref } from './html.js';
import type { GateBuild } from './site-build.js';

/** Body of /_/403.txt: the one 403 answer for data, media and dot paths. */
export const FORBIDDEN_TXT = 'Forbidden\n';
/** /robots.txt of the host. */
export const GATE_ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';
/** /favicon.svg: a soft rose dot on a cream disc (never the portrait, no travel motif). */
export const GATE_FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#fce7ee"/><circle cx="32" cy="32" r="12" fill="#be4a74"/></svg>\n';

/** Gate pages, in the order of §2.1. */
export const GATE_PAGES: readonly GatePage[] = ['join', 'info', 'wait', 'ended', 'me', 'panic'];

/**
 * The neutral page's inline style (cream → lilac wash, plum ink, rose button; the dusk palette in
 * dark mode; no images, no web fonts). Fixed: its hash is part of {{CSP_N}}.
 */
export const NEUTRAL_CSS =
  ':root{color-scheme:light dark;--bg:#fff8f6;--wash:#eee6fa;--ink:#3b2341;--muted:#6a4e6f;--accent:#be4a74;--on:#fff;--field:#fff;--ring:#8e6bd6}' +
  '@media (prefers-color-scheme:dark){:root{--bg:#1b1322;--wash:#30243b;--ink:#f7ecf2;--muted:#c9b6cc;--accent:#f4a3bc;--on:#1b1322;--field:#251a2e;--ring:#bca4f2}}' +
  '*{box-sizing:border-box}' +
  'html{background:var(--bg) linear-gradient(160deg,var(--bg),var(--wash)) fixed;color:var(--ink);font:1rem/1.55 ui-rounded,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
  'body{margin:0;min-block-size:100vh;min-block-size:100dvh;display:grid;place-items:center;padding:1rem}' +
  'main{inline-size:100%;max-inline-size:28rem;text-align:center}' +
  'h1{font:600 1.9rem/1.2 ui-serif,Georgia,"Times New Roman",serif;margin:0 0 1rem}' +
  'p{margin:0 0 .6rem}' +
  'details{margin-block-start:1.75rem;color:var(--muted)}' +
  'summary{cursor:pointer;border-radius:.5rem}' +
  'form{display:flex;gap:.5rem;margin-block-start:.75rem}' +
  'input{flex:1;min-inline-size:0;padding:.65rem 1rem;border:1px solid var(--muted);border-radius:9999px;background:var(--field);color:var(--ink);font:inherit}' +
  'button{padding:.65rem 1.15rem;border:0;border-radius:9999px;background:var(--accent);color:var(--on);font:inherit;font-weight:700;cursor:pointer}' +
  ':focus-visible{outline:2px solid var(--ring);outline-offset:2px}';

/** Cookie names the neutral page's script needs (gateCookies()). */
export interface NeutralCookies {
  key: string;
  resume: string;
  secure: boolean;
}

/**
 * NEUTRAL_SCRIPT (spec-wave5 §2.5) with {{KK}}, {{RK}} and {{SEC}} substituted: a device that
 * holds a key cookie resumes at most once per 5 minutes (throttle cookie, because the refusals'
 * Clear-Site-Data empties sessionStorage); the paste field forwards a pasted personal link.
 */
export function neutralScript(c: NeutralCookies): string {
  const sec = c.secure ? 'Secure; ' : '';
  return `(function(){try{var c=document.cookie.split('; '),h=function(n){return c.some(function(x){return x.indexOf(n+'=')===0})};if(h('${c.key}')&&!h('${c.resume}')){document.cookie='${c.resume}=1; Path=/; Max-Age=300; ${sec}SameSite=Strict';location.replace('/_/join/#resume');return;}}catch(e){}var f=document.getElementById('p');if(f)f.addEventListener('submit',function(e){e.preventDefault();var m=/#t=([A-Za-z0-9_-]{43})/.exec(document.getElementById('u').value);if(m)location.assign('/_/join/#t='+m[1]);});})();`;
}

type Bilingual = Readonly<Record<'de' | 'en', string>>;

const NEUTRAL_TEXT = {
  title: { de: 'Privat', en: 'Private' },
  lead: {
    de: 'Diese Seite ist nur mit persönlicher Einladung sichtbar.',
    en: 'This page is only visible with a personal invitation.',
  },
  summary: { de: 'Du hast einen persönlichen Link?', en: 'Have a personal link?' },
  paste: {
    de: 'Öffne ihn auf diesem Gerät oder füge ihn hier ein.',
    en: 'Open it on this device or paste it here.',
  },
} as const satisfies Record<string, Bilingual>;

/** de first unless the site's default locale is not German (§2.5). */
export function neutralOrder(defaultLocale: LocaleCode): readonly ['de', 'en'] | readonly ['en', 'de'] {
  return defaultLocale === 'de' ? (['de', 'en'] as const) : (['en', 'de'] as const);
}

function both(t: Bilingual, order: readonly ['de', 'en'] | readonly ['en', 'de'], sep = ' · '): string {
  return `${t[order[0]]}${sep}${t[order[1]]}`;
}

/** "Privat · Private" (or "Private · Privat"): the title of every gate tree page. */
export function privateTitle(defaultLocale: LocaleCode): string {
  return both(NEUTRAL_TEXT.title, neutralOrder(defaultLocale));
}

/**
 * The neutral page (/_/n/index.html, also /index.html and /_/index.html): the exact structure of
 * spec-wave5 §2.5. Its CSP comes from the root .htaccess ({{CSP_N}} = neutralCsp()).
 */
export function neutralPage(defaultLocale: LocaleCode, cookies: NeutralCookies): string {
  const order = neutralOrder(defaultLocale);
  const span = (t: Bilingual) => order.map((l) => `<span lang="${l}">${t[l]}</span>`).join(' · ');
  const title = privateTitle(defaultLocale);
  return [
    '<!doctype html>',
    `<html lang="${order[0]}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${title}</title>`,
    `<meta property="og:title" content="${title}">`,
    '<meta property="og:type" content="website">',
    `<style>${inlineCode(NEUTRAL_CSS).value}</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<h1>${span(NEUTRAL_TEXT.title)}</h1>`,
    ...order.map((l) => `<p lang="${l}">${NEUTRAL_TEXT.lead[l]}</p>`),
    '<details>',
    `<summary>${span(NEUTRAL_TEXT.summary)}</summary>`,
    `<p>${order.map((l) => `<span lang="${l}">${NEUTRAL_TEXT.paste[l]}</span>`).join(' ')}</p>`,
    '<form id="p"><input id="u" type="url" inputmode="url" autocomplete="off" aria-label="Link"><button type="submit">→</button></form>',
    '</details>',
    '</main>',
    `<script>${inlineCode(neutralScript(cookies)).value}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** {{CSP_N}}: the neutral page may run exactly its own inline script and style. */
export function neutralCsp(cookies: NeutralCookies): string {
  return [
    "default-src 'none'",
    `script-src ${cspHash(neutralScript(cookies))}`,
    `style-src ${cspHash(NEUTRAL_CSS)}`,
    'img-src data:',
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** {{CSP_G}}: the gate pages load the bundle from /_/assets/ and talk only to the API origin. */
export function gateCsp(apiOrigin: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${apiOrigin}`,
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/** Inputs of one gate page besides the page name. */
export interface GatePageContext {
  api: string;
  locales: readonly LocaleCode[];
  defaultLocale: LocaleCode;
  cookies: GateBoot['cookies'];
  cookieMode: CookieMode;
  cookieDomain: string | null;
  build: GateBuild;
}

/** The GateBoot JSON of one page (contract @omw/contracts/access GateBoot). */
export function gateBoot(page: GatePage, ctx: GatePageContext): GateBoot {
  return {
    page,
    api: ctx.api,
    locales: [...ctx.locales],
    defaultLocale: ctx.defaultLocale,
    cookies: { ...ctx.cookies },
    cookieMode: ctx.cookieMode,
    cookieDomain: ctx.cookieDomain,
    build: ctx.build.hash,
  };
}

/** Root-relative URL of a gate bundle file ("assets/gate-x.js" → "/_/assets/gate-x.js"). */
export function gateAssetUrl(rel: string): string {
  return safeHref(`/_/${rel}`);
}

/**
 * /_/<page>/index.html (§2.6): one template, an empty <main id="omw-gate-root"> the bundle fills,
 * a <noscript> line and the GateBoot JSON. No personal data, no content path.
 */
export function gatePage(page: GatePage, ctx: GatePageContext): string {
  const locale = ctx.defaultLocale;
  const title = privateTitle(locale);
  const boot = gateBoot(page, ctx);
  return [
    '<!doctype html>',
    `<html lang="${locale}" dir="${textDirection(locale)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${title}</title>`,
    `<meta property="og:title" content="${title}">`,
    '<meta property="og:type" content="website">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    ...ctx.build.css.map((c) => `<link rel="stylesheet" href="${gateAssetUrl(c)}">`),
    ...ctx.build.modulepreload.map((m) => `<link rel="modulepreload" href="${gateAssetUrl(m)}">`),
    `<script type="module" src="${gateAssetUrl(ctx.build.script)}"></script>`,
    `<script type="application/json" id="${GATE_BOOT_ELEMENT_ID}">${jsonForScript(boot).value}</script>`,
    '</head>',
    '<body>',
    '<noscript><p>Bitte JavaScript aktivieren / Please enable JavaScript</p></noscript>',
    '<main id="omw-gate-root"></main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}
