/**
 * The public API as the gate pages and the SPA call it (spec-wave5 §3.4, §6.2): POST with a
 * text/plain JSON body (a CORS "simple request": no preflight), no cookies (credentials only in
 * the F2 "parent" cookie mode), no referrer, never cached, 15 s deadline. Every answer is 200 JSON
 * with a `status`; 429 (Retry-After), 4xx and 5xx become a PublicApiError.
 *
 * Responses are checked against the contract schemas in dev builds only (dynamic import behind
 * import.meta.env.DEV, so zod never reaches the public gate bundle).
 */
import type {
  CookieMode,
  DeviceKeyRequest,
  DevicePollResponse,
  JoinCheckRequest,
  JoinCheckResponse,
  JoinRequest,
  JoinResponse,
  MeConsentRequest,
  MeDataResponse,
  MeDeleteRequest,
  MeHelloResponse,
  MeNoticeResponse,
  MeSimpleResponse,
  PanicRequest,
  PanicResponse,
} from '@omw/contracts/access';

export const PUBLIC_API_TIMEOUT_MS = 15_000;

export interface PublicRoutes {
  'join/check': [JoinCheckRequest, JoinCheckResponse];
  join: [JoinRequest, JoinResponse];
  'device/poll': [DeviceKeyRequest, DevicePollResponse];
  'me/hello': [DeviceKeyRequest, MeHelloResponse];
  'me/notice': [DeviceKeyRequest, MeNoticeResponse];
  'me/consent': [MeConsentRequest, MeHelloResponse];
  'me/data': [DeviceKeyRequest, MeDataResponse];
  'me/signout': [DeviceKeyRequest, MeSimpleResponse];
  'me/delete': [MeDeleteRequest, MeSimpleResponse];
  panic: [PanicRequest, PanicResponse];
}
export type PublicRoute = keyof PublicRoutes;

const RESPONSE_SCHEMAS = {
  'join/check': 'JoinCheckResponse',
  join: 'JoinResponse',
  'device/poll': 'DevicePollResponse',
  'me/hello': 'MeHelloResponse',
  'me/notice': 'MeNoticeResponse',
  'me/consent': 'MeHelloResponse',
  'me/data': 'MeDataResponse',
  'me/signout': 'MeSimpleResponse',
  'me/delete': 'MeSimpleResponse',
  panic: 'PanicResponse',
} as const;

export type PublicApiErrorKind = 'network' | 'rate_limited' | 'server';

export class PublicApiError extends Error {
  readonly kind: PublicApiErrorKind;
  /** HTTP status; 0 for network errors and timeouts. */
  readonly status: number;
  /** Seconds from Retry-After (429), else null. */
  readonly retryAfter: number | null;
  constructor(kind: PublicApiErrorKind, status: number, retryAfter: number | null = null) {
    super(`public API ${kind} (${status})`);
    this.name = 'PublicApiError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export interface PublicApiDeps {
  /** "https://api.example.org/api/v1/public/" (GateBoot.api / Boot.access.api). */
  api: string;
  cookieMode: CookieMode;
  fetch(url: string, init: RequestInit): Promise<Response>;
  /** Runs `fn` after `ms`; returns a cancel function (the request deadline). */
  schedule(fn: () => void, ms: number): () => void;
}

/** The export download: the JSON file with its name, or "ended" (no full D12 rights). */
export type ExportResult = { kind: 'file'; blob: Blob; filename: string } | { kind: 'ended' };

export interface PublicApi {
  post<R extends PublicRoute>(route: R, body: PublicRoutes[R][0]): Promise<PublicRoutes[R][1]>;
  exportData(body: DeviceKeyRequest): Promise<ExportResult>;
}

function retryAfterOf(res: Response): number | null {
  const value = Number(res.headers.get('Retry-After'));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

const FILENAME_RE = /filename="?([A-Za-z0-9._-]{1,100})"?/;

/** The file name from Content-Disposition, reduced to safe characters; else "data.json". */
export function exportFilename(contentDisposition: string | null): string {
  const name = contentDisposition ? FILENAME_RE.exec(contentDisposition)?.[1] : undefined;
  return name && !name.startsWith('.') ? name : 'data.json';
}

async function devCheck(route: PublicRoute, data: unknown): Promise<void> {
  if (import.meta.env.DEV) {
    const schemas = await import('@omw/contracts/access');
    const result = schemas[RESPONSE_SCHEMAS[route]].safeParse(data);
    if (!result.success) {
      console.error(`${route}: response does not match @omw/contracts/access`, result.error.issues, data);
      throw new PublicApiError('server', 200);
    }
  }
}

export function createPublicApi(deps: PublicApiDeps): PublicApi {
  async function request(route: PublicRoute | 'me/export', body: unknown): Promise<Response> {
    const controller = new AbortController();
    const cancel = deps.schedule(() => controller.abort(), PUBLIC_API_TIMEOUT_MS);
    try {
      const res = await deps.fetch(deps.api + route, {
        method: 'POST',
        mode: 'cors',
        credentials: deps.cookieMode === 'parent' ? 'include' : 'omit',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(body),
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      if (res.status === 429) throw new PublicApiError('rate_limited', 429, retryAfterOf(res));
      if (!res.ok) throw new PublicApiError('server', res.status, retryAfterOf(res));
      return res;
    } catch (err) {
      if (err instanceof PublicApiError) throw err;
      throw new PublicApiError('network', 0);
    } finally {
      cancel();
    }
  }

  async function json(res: Response): Promise<unknown> {
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new PublicApiError('server', res.status);
    }
  }

  return {
    async post(route, body) {
      const data = await json(await request(route, body));
      if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new PublicApiError('server', 200);
      await devCheck(route, data);
      return data as never;
    },
    async exportData(body) {
      const res = await request('me/export', body);
      const text = await res.text().catch(() => {
        throw new PublicApiError('network', 0);
      });
      let data: unknown;
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        throw new PublicApiError('server', res.status);
      }
      const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
      if (record.format === 'omw-follower-data/1') {
        return {
          kind: 'file',
          blob: new Blob([text], { type: 'application/json' }),
          filename: exportFilename(res.headers.get('Content-Disposition')),
        };
      }
      if (record.status === 'ended') return { kind: 'ended' };
      throw new PublicApiError('server', res.status);
    },
  };
}
