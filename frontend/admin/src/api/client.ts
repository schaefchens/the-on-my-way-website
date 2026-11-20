/**
 * Admin API client (plan B "Endpoints", api/src/Http/Routes.php):
 *   POST /api/v1/admin/session (LoginRequest -> Me, sets the session cookie), DELETE …/session,
 *   GET …/me, …/status, …/captures, …/posts, …/days, …/trips, …/settings, …/tokens
 *   (+ PATCH/PUT/POST/DELETE).
 *
 * - Same origin, cookie session (`credentials: 'include'`); a Bearer token is never used in the
 *   browser. Mutating requests carry X-CSRF-Token = Me.csrfToken. A 403 "csrf" (session renewed
 *   in another tab) refreshes the token once via the registered refresher and retries.
 * - Errors are ApiRequestError (status 0 = network). A 401 outside the auth endpoints calls the
 *   registered unauthorized handler (-> login screen).
 * - Network failures and any HTTP answer are reported to the reachability hooks, so the offline
 *   machinery (api/online.ts) can pause and resume queued writes.
 * - Offline-safe writes: posts are created with a client-chosen publicId (idempotent replay) and
 *   PATCH/PUT bodies carry ifUpdatedAt (409 "conflict" when someone else changed the item).
 * - In dev builds responses are checked against @omw/contracts/api (loaded lazily).
 */
import type {
  AdminDayDetail,
  AdminPost,
  AdminTrip,
  AnnotationPatch,
  CaptureListItem,
  CaptureListQuery,
  CaptureListResponse,
  DayListResponse,
  DayPatch,
  Health,
  LoginRequest,
  Me,
  PostCreate,
  PostListQuery,
  PostListResponse,
  PostUpdate,
  Settings,
  SettingsPatch,
  StatusResponse,
  TokenCreate,
  TokenCreated,
  TokenListResponse,
  TripListResponse,
  TripUpsert,
} from '@omw/contracts/api';

export const API_ROOT = '/api/v1';
export const API_BASE = `${API_ROOT}/admin`;
export const CSRF_HEADER = 'X-CSRF-Token';
/** Requests that hang longer than this fail as network errors (and get queued/retried). */
export const REQUEST_TIMEOUT_MS = 20_000;

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** True for errors where the request never got an HTTP answer (offline, DNS, timeout). */
export function isNetworkError(err: unknown): err is ApiRequestError {
  return err instanceof ApiRequestError && err.status === 0;
}

export function isConflictError(err: unknown): err is ApiRequestError {
  return err instanceof ApiRequestError && err.status === 409 && err.code === 'conflict';
}

export function isUnauthorizedError(err: unknown): err is ApiRequestError {
  return err instanceof ApiRequestError && err.status === 401;
}

/** Errors worth retrying automatically: network failures and server-side 5xx/429. */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof ApiRequestError)) return false;
  return err.status === 0 || err.status === 429 || err.status >= 500;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------------------------
// Module state and hooks (set once by the app; tests reset them)

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

export interface ClientHooks {
  /** A 401 on a request that needed a session (not /me, not /session). */
  onUnauthorized?: (err: ApiRequestError) => void;
  /** Called on 403 "csrf": returns a fresh token (e.g. from GET /me) or null. */
  refreshCsrf?: () => Promise<string | null>;
  /** The request failed without an HTTP answer. */
  onNetworkError?: () => void;
  /** Any HTTP answer arrived (the API is reachable). */
  onReachable?: () => void;
}

let hooks: ClientHooks = {};

export function setClientHooks(next: ClientHooks): void {
  hooks = next;
}

// ---------------------------------------------------------------------------------------------

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Contract schema name to validate the response with in dev. */
  schema?: DevSchemaName;
  fetch?: FetchLike;
  /** Absolute path below /api/v1 instead of /api/v1/admin (health). */
  root?: boolean;
  timeoutMs?: number;
}

export type DevSchemaName =
  | 'Me'
  | 'Health'
  | 'StatusResponse'
  | 'CaptureListResponse'
  | 'CaptureListItem'
  | 'PostListResponse'
  | 'AdminPost'
  | 'DayListResponse'
  | 'AdminDayDetail'
  | 'TripListResponse'
  | 'AdminTrip'
  | 'Settings'
  | 'TokenListResponse'
  | 'TokenCreated';

function isApiErrorBody(v: unknown): v is { error: { code: string; message: string; details?: unknown } } {
  if (!v || typeof v !== 'object' || !('error' in v)) return false;
  const e = (v as { error: unknown }).error;
  return !!e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string';
}

/** Paths whose 401 means "not logged in" rather than "session lost". */
const AUTH_PATHS = new Set(['/me', '/session']);

function withTimeout(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('Request timed out', 'TimeoutError')), ms);
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

async function send(path: string, opts: RequestOptions, token: string | null): Promise<Response> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && token) headers[CSRF_HEADER] = token;
  const fetchImpl = opts.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const timeout = withTimeout(opts.signal, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(`${opts.root ? API_ROOT : API_BASE}${path}`, {
      method,
      headers,
      credentials: 'include',
      cache: 'no-store',
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: timeout.signal,
    });
  } catch (err) {
    // A caller-initiated abort (query cancelled) is not a connectivity problem.
    if (opts.signal?.aborted) throw err;
    hooks.onNetworkError?.();
    throw new ApiRequestError(0, 'network', `API unreachable: ${(err as Error).message}`);
  } finally {
    timeout.cancel();
  }
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  // No token yet (offline start with the remembered owner, or a resumed write right after a
  // reload): fetch one first instead of provoking a 403.
  if (method !== 'GET' && !csrfToken && !opts.root && !AUTH_PATHS.has(path) && hooks.refreshCsrf) {
    const fresh = await hooks.refreshCsrf().catch(() => null);
    if (fresh) csrfToken = fresh;
  }
  let res = await send(path, opts, csrfToken);
  hooks.onReachable?.();

  if (res.status === 403 && method !== 'GET' && hooks.refreshCsrf) {
    const body = await res
      .clone()
      .json()
      .catch(() => null);
    if (isApiErrorBody(body) && body.error.code === 'csrf') {
      const fresh = await hooks.refreshCsrf().catch(() => null);
      if (fresh) {
        csrfToken = fresh;
        res = await send(path, opts, fresh);
      }
    }
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiRequestError(res.status, 'invalid_json', `${method} ${path}: HTTP ${res.status}, not JSON`);
    }
  }
  if (!res.ok) {
    const err = isApiErrorBody(json)
      ? new ApiRequestError(res.status, json.error.code, json.error.message, json.error.details)
      : new ApiRequestError(res.status, `http_${res.status}`, `${method} ${path}: HTTP ${res.status}`);
    if (res.status === 401 && !opts.root && !AUTH_PATHS.has(path.split('?')[0] ?? path)) {
      hooks.onUnauthorized?.(err);
    }
    throw err;
  }
  if (import.meta.env.DEV && opts.schema) {
    const { checkResponse } = await import('./validate.dev');
    checkResponse(opts.schema, json, `${method} ${path}`);
  }
  return json as T;
}

const enc = encodeURIComponent;

/** CaptureListQuery/PostListQuery -> "?date=…&limit=…" (empty values dropped). */
export function queryString(query: Readonly<Record<string, string | number | undefined>>): string {
  const pairs = Object.entries(query)
    .filter((e): e is [string, string | number] => e[1] !== undefined && e[1] !== '')
    .map(([k, v]) => [k, String(v)] as [string, string]);
  const qs = new URLSearchParams(pairs).toString();
  return qs ? `?${qs}` : '';
}

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Client-chosen post id ("p_" + ULID): makes POST /posts idempotent for offline replays. */
export function newPostPublicId(
  now = Date.now(),
  random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = (ULID_ALPHABET[t % 32] ?? '0') + time;
    t = Math.floor(t / 32);
  }
  const rand = [...random(16)].map((b) => ULID_ALPHABET[b % 32]).join('');
  return `p_${time}${rand}`;
}

export const adminApi = {
  health: () => apiRequest<Health>('/health', { root: true, schema: 'Health', timeoutMs: 8000 }),
  login: (body: LoginRequest) => apiRequest<Me>('/session', { method: 'POST', body, schema: 'Me' }),
  logout: () => apiRequest<void>('/session', { method: 'DELETE' }),
  me: (signal?: AbortSignal) => apiRequest<Me>('/me', { schema: 'Me', ...(signal ? { signal } : {}) }),
  status: (signal?: AbortSignal) =>
    apiRequest<StatusResponse>('/status', { schema: 'StatusResponse', ...(signal ? { signal } : {}) }),
  captures: (query: CaptureListQuery = {}, signal?: AbortSignal) =>
    apiRequest<CaptureListResponse>(`/captures${queryString(query)}`, {
      schema: 'CaptureListResponse',
      ...(signal ? { signal } : {}),
    }),
  capture: (sourceKey: string, signal?: AbortSignal) =>
    apiRequest<CaptureListItem>(`/captures/${enc(sourceKey)}`, {
      schema: 'CaptureListItem',
      ...(signal ? { signal } : {}),
    }),
  annotate: (sourceKey: string, body: AnnotationPatch) =>
    apiRequest<CaptureListItem>(`/captures/${enc(sourceKey)}`, { method: 'PATCH', body, schema: 'CaptureListItem' }),
  posts: (query: PostListQuery = {}, signal?: AbortSignal) =>
    apiRequest<PostListResponse>(`/posts${queryString(query)}`, {
      schema: 'PostListResponse',
      ...(signal ? { signal } : {}),
    }),
  post: (publicId: string, signal?: AbortSignal) =>
    apiRequest<AdminPost>(`/posts/${enc(publicId)}`, { schema: 'AdminPost', ...(signal ? { signal } : {}) }),
  /** Idempotent: a replay with the same publicId returns the existing post. */
  createPost: (body: PostCreate) => apiRequest<AdminPost>('/posts', { method: 'POST', body, schema: 'AdminPost' }),
  updatePost: (publicId: string, body: PostUpdate) =>
    apiRequest<AdminPost>(`/posts/${enc(publicId)}`, { method: 'PATCH', body, schema: 'AdminPost' }),
  /** 204 also when the post is already gone (replayed delete). */
  deletePost: (publicId: string) => apiRequest<void>(`/posts/${enc(publicId)}`, { method: 'DELETE' }),
  days: (signal?: AbortSignal) =>
    apiRequest<DayListResponse>('/days', { schema: 'DayListResponse', ...(signal ? { signal } : {}) }),
  day: (date: string, signal?: AbortSignal) =>
    apiRequest<AdminDayDetail>(`/days/${enc(date)}`, { schema: 'AdminDayDetail', ...(signal ? { signal } : {}) }),
  patchDay: (date: string, body: DayPatch) =>
    apiRequest<AdminDayDetail>(`/days/${enc(date)}`, { method: 'PATCH', body, schema: 'AdminDayDetail' }),
  trips: (signal?: AbortSignal) =>
    apiRequest<TripListResponse>('/trips', { schema: 'TripListResponse', ...(signal ? { signal } : {}) }),
  trip: (slug: string, signal?: AbortSignal) =>
    apiRequest<AdminTrip>(`/trips/${enc(slug)}`, { schema: 'AdminTrip', ...(signal ? { signal } : {}) }),
  putTrip: (body: TripUpsert) =>
    apiRequest<AdminTrip>(`/trips/${enc(body.slug)}`, { method: 'PUT', body, schema: 'AdminTrip' }),
  deleteTrip: (slug: string) => apiRequest<void>(`/trips/${enc(slug)}`, { method: 'DELETE' }),
  settings: (signal?: AbortSignal) =>
    apiRequest<Settings>('/settings', { schema: 'Settings', ...(signal ? { signal } : {}) }),
  patchSettings: (body: SettingsPatch) =>
    apiRequest<Settings>('/settings', { method: 'PATCH', body, schema: 'Settings' }),
  tokens: (signal?: AbortSignal) =>
    apiRequest<TokenListResponse>('/tokens', { schema: 'TokenListResponse', ...(signal ? { signal } : {}) }),
  createToken: (body: TokenCreate) =>
    apiRequest<TokenCreated>('/tokens', { method: 'POST', body, schema: 'TokenCreated' }),
  revokeToken: (id: number) => apiRequest<void>(`/tokens/${id}`, { method: 'DELETE' }),
};

export type AdminApi = typeof adminApi;
