/**
 * Access state of the SPA (spec-wave5 §6.3). Viewing never talks to the API; only when the gate
 * refuses a data request (AccessEndedError: 403, or the neutral page instead of JSON) does the
 * SPA ask `me/hello` what happened:
 *   unavailable (locked, …) → state "locked" (the ended screen: "not available right now")
 *   ended                    → /_/ended/
 *   active (a store glitch)  → /_/join/#resume (a new session via the device key)
 *   network error / no key   → state "unavailable"
 * Open mode (no Boot.access): state "unavailable". Before asking, the manifest poll stops and the
 * query cache is emptied, so nothing already loaded stays on screen.
 */
import type { BootAccess } from '@omw/contracts/site';
import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { createPublicApi, type PublicApi } from '../gate/api';
import { GateCookies } from '../gate/cookies';

export type AccessState = 'ok' | 'checking' | 'locked' | 'unavailable';

export interface Store<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const accessState: Store<AccessState> = createStore<AccessState>('ok');

export function useAccessState(): AccessState {
  return useSyncExternalStore(accessState.subscribe, accessState.get, accessState.get);
}

export interface Navigator {
  replace(url: string): void;
  assign(url: string): void;
}

export interface AccessRuntime {
  /** Boot.access (gate mode) or null (open mode). */
  access: BootAccess | null;
  queryClient: QueryClient | null;
  api: PublicApi | null;
  cookies: GateCookies | null;
  navigate: Navigator;
}

const browserNavigator: Navigator = {
  replace: (url) => window.location.replace(url),
  assign: (url) => window.location.assign(url),
};

let runtime: AccessRuntime = { access: null, queryClient: null, api: null, cookies: null, navigate: browserNavigator };

/** The SPA's cookie helper for Boot.access (Secure on https, the F1/F2 Domain when set). */
export function accessCookies(
  access: BootAccess,
  doc: { cookie: string } = document,
  secure = location.protocol === 'https:',
): GateCookies {
  return new GateCookies(doc, access.cookies, { secure, domain: access.cookieDomain });
}

/** The public API client for Boot.access. */
export function accessApi(
  access: BootAccess,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): PublicApi {
  return createPublicApi({
    api: access.api,
    cookieMode: access.cookieMode,
    fetch: fetchImpl,
    schedule: (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
  });
}

/**
 * Wires the access layer to the page (createSiteContext calls it). In gate mode it builds the API
 * client and the cookie helper from Boot.access unless given.
 */
export function configureAccess(next: Partial<AccessRuntime> & { access: BootAccess | null }): void {
  const access = next.access;
  const inBrowser = typeof document !== 'undefined' && typeof location !== 'undefined';
  runtime = {
    access,
    queryClient: next.queryClient ?? null,
    api: next.api ?? (access ? accessApi(access) : null),
    cookies: next.cookies ?? (access && inBrowser ? accessCookies(access) : null),
    navigate: next.navigate ?? browserNavigator,
  };
}

export function accessRuntime(): AccessRuntime {
  return runtime;
}

let running: Promise<void> | null = null;

/** Handles a refused data request once per page (concurrent and later calls are no-ops). */
export function onAccessEnded(): Promise<void> {
  if (running) return running;
  if (accessState.get() !== 'ok') return Promise.resolve();
  running = check().finally(() => {
    running = null;
  });
  return running;
}

async function check(): Promise<void> {
  accessState.set('checking');
  const { queryClient, access, api, cookies, navigate } = runtime;
  if (queryClient) {
    await queryClient.cancelQueries().catch(() => undefined);
    queryClient.clear();
  }
  const k = cookies?.readKey() ?? null;
  if (!access || !api || !k) {
    accessState.set('unavailable');
    return;
  }
  try {
    const res = await api.post('me/hello', { k });
    switch (res.status) {
      case 'unavailable':
        accessState.set('locked');
        return;
      case 'ended':
        navigate.replace('/_/ended/');
        return;
      case 'active':
        navigate.replace('/_/join/#resume');
        return;
    }
  } catch {
    accessState.set('unavailable');
  }
}

/** Tests: back to a fresh page. */
export function resetAccessForTests(): void {
  running = null;
  accessState.set('ok');
  runtime = { access: null, queryClient: null, api: null, cookies: null, navigate: browserNavigator };
}
