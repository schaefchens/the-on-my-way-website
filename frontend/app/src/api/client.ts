/**
 * The few JSON calls the app's JS makes to the API (the native uploader does the uploads and the
 * withdrawals of Undo, durably and paced): pairing, hints and entry states. The base URL comes from the build
 * (app.config.ts extra.apiBaseUrl; never from a link), so development talks to the local API only.
 *
 * Gentle with the host (its IP block after rapid requests, app-plan §7): at most 2 requests per
 * 10 s from JS, a 15 s timeout, and after any failure a backoff of at least a minute for the
 * polling calls. The token is read from the TokenVault per call and never kept in JS state.
 */

import { CONTRACT_VERSION } from '@omw/contracts';
import {
  APP_LIMITS,
  AppEntryListResponse,
  type AppEntryState,
  AppHints,
  type AppPairRequest,
  AppPairResponse,
} from '@omw/contracts/app';
import Constants from 'expo-constants';

export type ApiErrorCode =
  | 'pairing_invalid'
  | 'pairing_expired'
  | 'rate_limited'
  | 'token_revoked'
  | 'unauthorized'
  | 'not_found'
  | 'network'
  | 'server'
  | 'busy';

export class AppApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number | null,
  ) {
    super(`API ${code}${status ? ` (${status})` : ''}`);
    this.name = 'AppApiError';
  }
}

export function apiBaseUrl(): string {
  const base = String(Constants.expoConfig?.extra?.apiBaseUrl ?? 'http://127.0.0.1:8080');
  return base.replace(/\/+$/, '');
}

// ---- request budget (JS side; the native uploader keeps its own)

const WINDOW_MS = 10_000;
const MAX_IN_WINDOW = 2;
const recent: number[] = [];
let quietUntil = 0;

function takeBudget(now = Date.now()): boolean {
  while (recent.length > 0 && now - (recent[0] ?? 0) > WINDOW_MS) recent.shift();
  if (recent.length >= MAX_IN_WINDOW) return false;
  recent.push(now);
  return true;
}

/** After a failure, polling calls stay quiet for a while (pairing is her own tap and may retry). */
function backOff(ms: number) {
  quietUntil = Math.max(quietUntil, Date.now() + ms);
}

export function pollingAllowed(now = Date.now()): boolean {
  return now >= quietUntil;
}

async function request(
  path: string,
  init: { method: 'GET' | 'POST'; token?: string | null; body?: unknown; polling?: boolean },
): Promise<{ status: number; json: unknown }> {
  if (init.polling && !pollingAllowed()) throw new AppApiError('busy', null);
  if (!takeBudget()) throw new AppApiError('busy', null);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}/api/v1${path}`, {
      method: init.method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    backOff(60_000);
    throw new AppApiError('network', null);
  } finally {
    clearTimeout(timer);
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok) return { status: res.status, json };
  const code = (json as { error?: { code?: string } } | null)?.error?.code;
  const retryAfter = Number(res.headers.get('Retry-After'));
  backOff(Math.max(60_000, Number.isFinite(retryAfter) ? retryAfter * 1000 : 0));
  if (code === 'pairing_invalid' || code === 'pairing_expired' || code === 'token_revoked' || code === 'unauthorized') {
    throw new AppApiError(code, res.status);
  }
  if (res.status === 429) throw new AppApiError('rate_limited', 429);
  if (res.status === 401) throw new AppApiError('unauthorized', 401);
  if (res.status === 404) throw new AppApiError('not_found', 404);
  if (res.status === 503 || res.status === 507) throw new AppApiError('busy', res.status);
  throw new AppApiError('server', res.status);
}

/** POST /app/pair: a typed or linked one-time code for a `capture` token. */
export async function pairPhone(input: Omit<AppPairRequest, 'contractVersion' | 'platform'>): Promise<AppPairResponse> {
  const { json } = await request('/app/pair', {
    method: 'POST',
    body: { contractVersion: CONTRACT_VERSION, platform: 'android', ...input } satisfies AppPairRequest,
  });
  const parsed = AppPairResponse.safeParse(json);
  if (!parsed.success) throw new AppApiError('server', 201);
  return parsed.data;
}

/** GET /app/hints (archive-only, delay, the home computer's last contact). */
export async function fetchHints(token: string): Promise<AppHints> {
  const { json } = await request('/app/hints', { method: 'GET', token, polling: true });
  const parsed = AppHints.safeParse(json);
  if (!parsed.success) throw new AppApiError('server', 200);
  return parsed.data;
}

/** GET /app/entries?ids=… for at most 50 ids (unknown ids are left out by the API). */
export async function fetchEntryStates(token: string, ids: readonly string[]): Promise<AppEntryState[]> {
  const chunk = ids.slice(0, APP_LIMITS.listIds);
  if (chunk.length === 0) return [];
  const { json } = await request(`/app/entries?ids=${chunk.join(',')}`, { method: 'GET', token, polling: true });
  const parsed = AppEntryListResponse.safeParse(json);
  if (!parsed.success) throw new AppApiError('server', 200);
  return parsed.data.items;
}
