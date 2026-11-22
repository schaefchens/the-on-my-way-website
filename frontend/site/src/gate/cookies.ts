/**
 * The cookies the gate JS writes (spec-wave5 §2.3.1, §6.2):
 *   key       <key>=<k>; Path=/; Max-Age=1209600; SameSite=Strict[; Secure][; Domain=<d>]
 *   transfer  <transfer>=<fid>.<did>.<sid>; Path=/; Max-Age=120; SameSite=Strict[; Secure][; Domain=<d>]
 * Deletion uses the same Path and Domain with Max-Age=0, else the browser keeps two cookies of
 * one name (F1/F2) and the first one sent wins. Apache replaces the JS-set key cookie with a
 * server-set one (400 days) on the next gate page load and at the handoff.
 *
 * The SPA (src/access) uses the same helpers for the handoff and transfer cookies it deletes.
 */
import { ACCESS_TOKEN_RE, GATE_COOKIE_MAX_AGE, GATE_SESSION_RE } from './access-lite';

export interface CookieConfig {
  /** true on https: every cookie carries Secure (the `__Host-` names require it). */
  secure: boolean;
  /** F1/F2: the Domain attribute; null = host-only. */
  domain: string | null;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DOMAIN_RE = /^[a-z0-9.-]+$/;

function attributes(maxAge: number, cfg: CookieConfig): string {
  return `Path=/; Max-Age=${maxAge}; SameSite=Strict${cfg.secure ? '; Secure' : ''}${
    cfg.domain !== null ? `; Domain=${cfg.domain}` : ''
  }`;
}

function checkName(name: string, cfg: CookieConfig): void {
  if (!NAME_RE.test(name)) throw new RangeError('Invalid cookie name');
  if (cfg.domain !== null && !DOMAIN_RE.test(cfg.domain)) throw new RangeError('Invalid cookie domain');
}

/** The cookie string that stores the device key (JS-set: 14 days until Apache re-sets it). */
export function keyCookieString(name: string, k: string, cfg: CookieConfig): string {
  checkName(name, cfg);
  if (!ACCESS_TOKEN_RE.test(k)) throw new RangeError('Invalid device key');
  return `${name}=${k}; ${attributes(GATE_COOKIE_MAX_AGE.keyJs, cfg)}`;
}

/** The 120-second transfer cookie the handoff reads. */
export function transferCookieString(name: string, session: string, cfg: CookieConfig): string {
  checkName(name, cfg);
  if (!GATE_SESSION_RE.test(session)) throw new RangeError('Invalid session value');
  return `${name}=${session}; ${attributes(GATE_COOKIE_MAX_AGE.transfer, cfg)}`;
}

/** Expires a JS-visible cookie with the attributes it was written with. */
export function deleteCookieString(name: string, cfg: CookieConfig): string {
  checkName(name, cfg);
  return `${name}=; ${attributes(0, cfg)}`;
}

/**
 * The value of the first cookie called `name` in a Cookie header string (first wins, like the
 * gate's RewriteCond), or null.
 */
export function readCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

export interface CookieJar {
  cookie: string;
}

/** Key and transfer cookies of one page, with the names and attributes from the boot data. */
export class GateCookies {
  readonly #jar: CookieJar;
  readonly #names: { key: string; transfer: string; handoff: string };
  readonly #cfg: CookieConfig;

  constructor(jar: CookieJar, names: { key: string; transfer: string; handoff: string }, cfg: CookieConfig) {
    this.#jar = jar;
    this.#names = names;
    this.#cfg = cfg;
  }

  get config(): CookieConfig {
    return this.#cfg;
  }

  /** The device key, when a well-formed one is stored. */
  readKey(): string | null {
    const k = readCookie(this.#jar.cookie, this.#names.key);
    return k !== null && ACCESS_TOKEN_RE.test(k) ? k : null;
  }

  writeKey(k: string): void {
    this.#jar.cookie = keyCookieString(this.#names.key, k, this.#cfg);
  }

  deleteKey(): void {
    this.#jar.cookie = deleteCookieString(this.#names.key, this.#cfg);
  }

  /** The transfer value, when a well-formed one is stored. */
  readTransfer(): string | null {
    const v = readCookie(this.#jar.cookie, this.#names.transfer);
    return v !== null && GATE_SESSION_RE.test(v) ? v : null;
  }

  writeTransfer(session: string): void {
    this.#jar.cookie = transferCookieString(this.#names.transfer, session, this.#cfg);
  }

  deleteTransfer(): void {
    this.#jar.cookie = deleteCookieString(this.#names.transfer, this.#cfg);
  }

  /** True when the handoff marker cookie (set by Apache at a handoff) is present. */
  hasHandoff(): boolean {
    return readCookie(this.#jar.cookie, this.#names.handoff) !== null;
  }

  deleteHandoff(): void {
    this.#jar.cookie = deleteCookieString(this.#names.handoff, this.#cfg);
  }
}
