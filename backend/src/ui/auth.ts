/**
 * Control UI authentication.
 *
 * - CONTROL_TOKEN is the only credential. API clients send it as `Authorization: Bearer <token>`
 *   (no cookie, so no CSRF exposure). Browsers log in once with the token and get a session
 *   cookie: "<expiresMs>.<nonce>.<hmac>", HttpOnly, SameSite=Strict, Path=/ (Secure when served
 *   over https). The HMAC key is derived from CONTROL_TOKEN, so rotating the token logs every
 *   browser out; sessions survive backend restarts.
 * - CSRF (cookie-authenticated, state-changing requests): a synchronizer token derived from the
 *   session nonce (hidden form field `_csrf` or header `X-CSRF-Token`) AND, when the browser sends
 *   them, Origin/Sec-Fetch-Site must be same-origin.
 * - Failed logins are rate limited per client address.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'omw_ctl';
export const CSRF_FIELD = '_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const b64url = (buf: Buffer) => buf.toString('base64url');

function safeEqual(a: string, b: string): boolean {
  // Compare digests: constant time and independent of the input lengths.
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

export interface Session {
  nonce: string;
  expiresAt: number;
}

export interface ControlAuthOptions {
  sessionTtlMs?: number;
  now?: () => number;
  /** Failed logins allowed per address within `loginWindowMs`. */
  maxLoginFailures?: number;
  loginWindowMs?: number;
}

export class ControlAuth {
  private readonly key: Buffer;
  private readonly revoked = new Map<string, number>();
  private readonly failures = new Map<string, number[]>();

  private readonly token: string;
  private readonly options: ControlAuthOptions;

  constructor(token: string, options: ControlAuthOptions = {}) {
    this.token = token;
    this.options = options;
    this.key = createHash('sha256').update(`omw-control-session-v1:${token}`).digest();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get sessionTtlMs(): number {
    return this.options.sessionTtlMs ?? 30 * 24 * 60 * 60_000;
  }

  checkToken(candidate: string | undefined | null): boolean {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 4096) return false;
    return safeEqual(candidate, this.token);
  }

  /** Bearer token from an Authorization header value. */
  checkBearer(header: string | undefined): boolean {
    if (!header) return false;
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    return m?.[1] ? this.checkToken(m[1].trim()) : false;
  }

  private sign(payload: string): string {
    return b64url(createHmac('sha256', this.key).update(payload).digest());
  }

  issueSession(): { cookie: string; session: Session } {
    const expiresAt = this.now() + this.sessionTtlMs;
    const nonce = b64url(randomBytes(18));
    const payload = `${expiresAt}.${nonce}`;
    return { cookie: `${payload}.${this.sign(payload)}`, session: { nonce, expiresAt } };
  }

  verifySession(value: string | undefined): Session | null {
    if (!value) return null;
    const parts = value.split('.');
    if (parts.length !== 3) return null;
    const [exp, nonce, sig] = parts as [string, string, string];
    if (!/^\d{1,16}$/.test(exp) || !/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) return null;
    if (!safeEqual(sig, this.sign(`${exp}.${nonce}`))) return null;
    const expiresAt = Number(exp);
    if (expiresAt <= this.now()) return null;
    if (this.revoked.has(nonce)) return null;
    return { nonce, expiresAt };
  }

  /** Logout: the cookie is cleared client-side and its nonce refused until it would expire. */
  revoke(session: Session): void {
    this.revoked.set(session.nonce, session.expiresAt);
    const now = this.now();
    for (const [n, exp] of this.revoked) if (exp <= now) this.revoked.delete(n);
  }

  csrfToken(session: Session): string {
    return this.sign(`csrf:${session.nonce}`);
  }

  verifyCsrf(session: Session, candidate: unknown): boolean {
    return typeof candidate === 'string' && candidate.length > 0 && safeEqual(candidate, this.csrfToken(session));
  }

  /** True when `address` may try to log in now. */
  loginAllowed(address: string): boolean {
    const window = this.options.loginWindowMs ?? 5 * 60_000;
    const max = this.options.maxLoginFailures ?? 10;
    const now = this.now();
    const recent = (this.failures.get(address) ?? []).filter((t) => t > now - window);
    if (recent.length === 0) this.failures.delete(address);
    else this.failures.set(address, recent);
    return recent.length < max;
  }

  recordLoginFailure(address: string): void {
    const list = this.failures.get(address) ?? [];
    list.push(this.now());
    this.failures.set(address, list.slice(-100));
  }

  clearLoginFailures(address: string): void {
    this.failures.delete(address);
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!(name in out)) {
      try {
        out[name] = decodeURIComponent(value);
      } catch {
        out[name] = value;
      }
    }
  }
  return out;
}

export function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie('', 0, secure);
}
