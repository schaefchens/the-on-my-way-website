/**
 * Auth: the session lives in an HttpOnly cookie set by POST /api/v1/admin/session; the SPA only
 * asks GET /me (401 => not logged in) and keeps Me.csrfToken in memory for mutating requests.
 *
 * Offline start: when /me cannot be reached at all, the owner who was logged in last on this
 * device (email + name, never the CSRF token) is let in with the cached data, and queued edits
 * wait for the connection. The first write after reconnecting refreshes the CSRF token (403
 * "csrf" -> GET /me -> retry, see api/client.ts).
 *
 * VITE_AUTH_STUB=1 fakes an owner so the UI can be developed without the PHP API.
 */
import type { Me } from '@omw/contracts/api';
import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { ApiRequestError, adminApi, isNetworkError, setCsrfToken } from './api/client';
import { localStore } from './lib/store';

export interface AuthState {
  me: Me | null;
  /** Set when the API could not answer (network/5xx), shown on the login screen. */
  error: string | null;
  /** True when `me` is the remembered owner because the API is unreachable. */
  offline?: boolean;
}

const STUB_ME: Me = { email: 'dev@example.org', displayName: 'Dev (stub)', csrfToken: 'stub' };
const LAST_ME_KEY = 'omw.admin.lastMe';

export const authQueryKey = ['admin', 'auth'] as const;

type RememberedMe = Pick<Me, 'email' | 'displayName'>;

export function rememberMe(me: Me | null): void {
  localStore.write(LAST_ME_KEY, me ? ({ email: me.email, displayName: me.displayName } satisfies RememberedMe) : null);
}

export function rememberedMe(): RememberedMe | null {
  const value = localStore.read<RememberedMe | null>(LAST_ME_KEY, null);
  return value && typeof value.email === 'string' ? value : null;
}

export async function loadAuth(fetchMe: () => Promise<Me> = () => adminApi.me()): Promise<AuthState> {
  if (import.meta.env.VITE_AUTH_STUB === '1') return { me: STUB_ME, error: null };
  try {
    const me = await fetchMe();
    setCsrfToken(me.csrfToken);
    rememberMe(me);
    return { me, error: null };
  } catch (err) {
    setCsrfToken(null);
    if (err instanceof ApiRequestError && err.status === 401) {
      rememberMe(null);
      return { me: null, error: null };
    }
    const last = isNetworkError(err) ? rememberedMe() : null;
    if (last) return { me: { ...last, csrfToken: '' }, error: null, offline: true };
    return { me: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export const authQueryOptions = queryOptions({
  queryKey: authQueryKey,
  queryFn: () => loadAuth(),
  staleTime: 5 * 60_000,
  retry: false,
  // Must run (and fail fast) while offline, so the guard can fall back to the remembered owner.
  networkMode: 'always',
  meta: { persist: false },
});

export function getAuth(queryClient: QueryClient): Promise<AuthState> {
  return queryClient.ensureQueryData(authQueryOptions);
}

/** Fresh CSRF token for the client's 403 "csrf" retry. */
export async function refreshCsrf(queryClient: QueryClient): Promise<string | null> {
  const state = await loadAuth();
  queryClient.setQueryData(authQueryKey, state);
  return state.me?.csrfToken || null;
}

/**
 * Only same-app paths are allowed as post-login redirects: "/inbox?show=hidden" yes;
 * "//evil.example", "/\evil.example" (browsers read "\" as "/") and control characters
 * (stripped by URL parsers, so "/\t/evil" would become "//evil") no.
 */
export function safeRedirect(target: unknown): string {
  if (typeof target !== 'string' || !target.startsWith('/') || target.length > 2000) return '/';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/^\/[/\\]/.test(target) || /[\\\u0000-\u001f\u007f]/.test(target)) return '/';
  return target;
}

/**
 * beforeLoad of the authenticated layout route: anonymous visitors go to /login?redirect=<href>.
 * Returns { me } into the route context.
 */
export async function authGuard({
  context,
  location,
}: {
  context: { queryClient: QueryClient };
  location: { href: string };
}): Promise<{ me: Me }> {
  const auth = await getAuth(context.queryClient);
  if (!auth.me) {
    throw redirect({ to: '/login', search: location.href === '/' ? {} : { redirect: location.href } });
  }
  return { me: auth.me };
}
