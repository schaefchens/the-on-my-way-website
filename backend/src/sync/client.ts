/**
 * HTTP client for the backend endpoints of the PHP API (contracts api.ts, api/src/Http/Routes.php).
 *
 * - Bearer API_TOKEN (token kind "backend"); every request has a timeout and can be aborted.
 * - URLs: `${API_BASE_URL}/api/v1/backend/…`; the sourceKey path segment is URL-encoded
 *   ("wa:ABC" -> "wa%3AABC").
 * - Errors are ApiRequestError with a classification the sync loops act on:
 *     network / timeout / 5xx / 408 / 429      transient: retry with backoff (Retry-After honoured)
 *     401 / 403                                auth: pause all API traffic, alert in the control UI
 *     404 capture_not_mirrored                 ordering: retry soon (the capture PUT comes first)
 *     409 feed_reset                           change feed: rebuild the owner mirror from seq 0
 *     other 4xx (422, 413, 415, 400, …)        permanent for this payload
 *     invalid_response                         2xx with an unparseable body: transient
 */
import {
  type AccessAck,
  AccessClaim,
  type AccessClaimRequest,
  AccessLease,
  type AccessRenewRequest,
  ServiceSession,
  type StoreListingUpload,
} from '@omw/contracts/access';
import type { CaptureMirror, CaptureRevoke, Heartbeat, PreviewRole, PublishedReport } from '@omw/contracts/api';
import type { z } from 'zod';

export type ApiErrorKind = 'network' | 'timeout' | 'aborted' | 'http' | 'invalid_response';
export type ApiErrorClass = 'transient' | 'auth' | 'ordering' | 'feed_reset' | 'permanent' | 'aborted';

export class ApiRequestError extends Error {
  override name = 'ApiRequestError';
  readonly kind: ApiErrorKind;
  /** HTTP status (null for network errors and timeouts). */
  readonly status: number | null;
  /** ApiError.error.code from the body, if any. */
  readonly code: string | null;
  /** From a Retry-After header (seconds or HTTP date), if any. */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    init: { kind: ApiErrorKind; status?: number | null; code?: string | null; retryAfterMs?: number | null },
  ) {
    super(message);
    this.kind = init.kind;
    this.status = init.status ?? null;
    this.code = init.code ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
  }

  get errorClass(): ApiErrorClass {
    if (this.kind === 'aborted') return 'aborted';
    if (this.kind !== 'http' || this.status === null) return 'transient';
    const s = this.status;
    if (s === 401 || s === 403) return 'auth';
    if (s === 409 && this.code === 'feed_reset') return 'feed_reset';
    if (s === 404 && this.code === 'capture_not_mirrored') return 'ordering';
    if (s >= 500 || s === 408 || s === 429) return 'transient';
    return 'permanent';
  }
}

export interface ApiClientOptions {
  /** API_BASE_URL without trailing slash, e.g. "https://api.example.org" or "https://x.org/omw". */
  baseUrl: string;
  token: string;
  /** Per-request timeout (default 20 s; uploads get twice as long). */
  timeoutMs?: number;
  /** Injectable for tests (default: global fetch). */
  fetch?: typeof fetch;
  userAgent?: string;
}

export interface PreviewFile {
  bytes: Uint8Array;
  /** image/webp or image/jpeg (PREVIEW_UPLOAD.mimeTypes). */
  mime: string;
  filename: string;
}

const RETRY_AFTER_MAX_MS = 60 * 60_000;

function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(0, at - nowMs), RETRY_AFTER_MAX_MS);
}

function errorCodeOf(body: unknown): { code: string | null; message: string | null } {
  if (body && typeof body === 'object' && 'error' in body) {
    const e = (body as { error: unknown }).error;
    if (e && typeof e === 'object') {
      const code = (e as { code?: unknown }).code;
      const message = (e as { message?: unknown }).message;
      return {
        code: typeof code === 'string' ? code : null,
        message: typeof message === 'string' ? message : null,
      };
    }
  }
  return { code: null, message: null };
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly lifetime = new AbortController();

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.userAgent = options.userAgent ?? 'omw-backend';
  }

  /** Aborts all in-flight requests (shutdown); later requests fail immediately with "aborted". */
  abortAll(): void {
    this.lifetime.abort();
  }

  static capturePath(sourceKey: string): string {
    return `/api/v1/backend/captures/${encodeURIComponent(sourceKey)}`;
  }

  async putCapture(mirror: CaptureMirror): Promise<void> {
    await this.request('PUT', ApiClient.capturePath(mirror.sourceKey), { json: mirror });
  }

  async uploadPreview(sourceKey: string, role: PreviewRole, file: PreviewFile): Promise<void> {
    const form = new FormData();
    form.set('role', role);
    form.set('file', new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: file.mime }), file.filename);
    await this.request('POST', `${ApiClient.capturePath(sourceKey)}/preview`, {
      body: form,
      timeoutMs: this.timeoutMs * 2,
    });
  }

  async revoke(sourceKey: string, body: CaptureRevoke): Promise<void> {
    await this.request('POST', `${ApiClient.capturePath(sourceKey)}/revoke`, { json: body });
  }

  /** Raw change-feed page (the caller validates the envelope and the items one by one). */
  async changes(after: number, limit?: number): Promise<unknown> {
    const query = new URLSearchParams({ after: String(after) });
    if (limit !== undefined) query.set('limit', String(limit));
    const res = await this.request('GET', `/api/v1/backend/changes?${query.toString()}`, {});
    if (res.body === undefined) {
      throw new ApiRequestError('Change feed answered without a JSON body', { kind: 'invalid_response' });
    }
    return res.body;
  }

  async heartbeat(body: Heartbeat): Promise<void> {
    await this.request('POST', '/api/v1/backend/heartbeat', { json: body });
  }

  async published(body: PublishedReport): Promise<void> {
    await this.request('POST', '/api/v1/backend/published', { json: body });
  }

  // --- access store writer fallback (spec-wave5 §3.6, §5.6.6) -----------------------------------

  /** POST /backend/access/claim: the lease (≤ 60 s) and the first ≤ 200 pending store ops. */
  async claim(body: AccessClaimRequest = { holder: 'mac' }): Promise<AccessClaim> {
    return this.parsed('POST', '/api/v1/backend/access/claim', AccessClaim, body);
  }

  /** POST /backend/access/renew: extends the Mac's lease; `lease: null` = lost (stop at once). */
  async renew(body: AccessRenewRequest): Promise<AccessLease> {
    return this.parsed('POST', '/api/v1/backend/access/renew', AccessLease, body);
  }

  /** POST /backend/access/listing: the API reconciles the Mac's store listing and returns the ops. */
  async uploadListing(body: StoreListingUpload): Promise<AccessClaim> {
    return this.parsed('POST', '/api/v1/backend/access/listing', AccessClaim, body);
  }

  /** POST /backend/access/ack: ops ≤ appliedThrough applied (or `failed`); releases the lease. */
  async ack(body: AccessAck): Promise<void> {
    await this.request('POST', '/api/v1/backend/access/ack', { json: body });
  }

  /**
   * GET /backend/access/service-session (?rotate=1): the publisher's own gate session for the
   * post-deploy check. 503 busy until the API (or the Mac's writer) applied it.
   */
  async serviceSession(rotate: boolean): Promise<ServiceSession> {
    return this.parsed(
      'GET',
      `/api/v1/backend/access/service-session${rotate ? '?rotate=1' : ''}`,
      ServiceSession,
      undefined,
    );
  }

  private async parsed<T>(method: string, path: string, schema: z.ZodType<T>, json: unknown): Promise<T> {
    const res = await this.request(method, path, json === undefined ? {} : { json });
    const r = schema.safeParse(res.body);
    if (!r.success) {
      throw new ApiRequestError(`${method} ${path}: unexpected response (${r.error.issues[0]?.message ?? 'invalid'})`, {
        kind: 'invalid_response',
        status: res.status,
      });
    }
    return r.data;
  }

  /** GET /api/v1/health (no auth needed; used by "test API connection"). */
  async health(): Promise<unknown> {
    return (await this.request('GET', '/api/v1/health', {})).body;
  }

  private async request(
    method: string,
    path: string,
    options: { json?: unknown; body?: FormData; timeoutMs?: number },
  ): Promise<{ status: number; body: unknown }> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
      'user-agent': this.userAgent,
    };
    let body: string | FormData | undefined;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.body) {
      body = options.body;
    }
    if (this.lifetime.signal.aborted) throw new ApiRequestError(`${method} ${path}: aborted`, { kind: 'aborted' });
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs);
    const signal = AbortSignal.any([timeout, this.lifetime.signal]);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, ...(body !== undefined ? { body } : {}), signal });
    } catch (err) {
      if (this.lifetime.signal.aborted) throw new ApiRequestError(`${method} ${path}: aborted`, { kind: 'aborted' });
      if (timeout.aborted) throw new ApiRequestError(`${method} ${path}: timed out`, { kind: 'timeout' });
      const cause = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
      throw new ApiRequestError(`${method} ${path}: ${cause}`, { kind: 'network' });
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (timeout.aborted) throw new ApiRequestError(`${method} ${path}: timed out`, { kind: 'timeout' });
      throw new ApiRequestError(`${method} ${path}: reading the body failed: ${String(err)}`, { kind: 'network' });
    }
    let parsed: unknown;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        if (res.ok && method === 'GET') {
          throw new ApiRequestError(`${method} ${path}: invalid JSON (HTTP ${res.status})`, {
            kind: 'invalid_response',
            status: res.status,
          });
        }
      }
    }
    if (!res.ok) {
      const { code, message } = errorCodeOf(parsed);
      const detail = message ?? (text.length > 0 && parsed === undefined ? text.slice(0, 200) : res.statusText);
      throw new ApiRequestError(`${method} ${path}: HTTP ${res.status}${code ? ` ${code}` : ''}: ${detail}`, {
        kind: 'http',
        status: res.status,
        code,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after'), Date.now()),
      });
    }
    return { status: res.status, body: parsed };
  }
}
