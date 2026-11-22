/**
 * "A visit" (D11, spec-wave5 §6.3), gate mode only: `me/hello {k}`
 * - on every SPA start (after the first render, when the browser is idle), unless one succeeded
 *   in this tab less than 5 minutes ago (sessionStorage['omw.helloAt']);
 * - always right after a handoff (the handoff cookie: deleted first, with any leftover transfer
 *   cookie; the API then deletes the one-time handoff marker);
 * - when the tab becomes visible after at least 30 minutes hidden.
 * `active` stores the follower's name for the footer (sessionStorage['omw.name']); a required
 * notice goes to /_/info/#reconfirm and back; `ended` goes to /_/ended/. Errors are ignored:
 * viewing never depends on the API.
 */
import { useSyncExternalStore } from 'react';
import type { PublicApi } from '../gate/api';
import type { GateCookies } from '../gate/cookies';
import { createStore, type Navigator, type Store } from './access';

export const HELLO_THROTTLE_MS = 5 * 60_000;
export const HELLO_AFTER_HIDDEN_MS = 30 * 60_000;
export const HELLO_AT_KEY = 'omw.helloAt';
export const FOLLOWER_NAME_KEY = 'omw.name';

interface SessionLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function sessionStore(): SessionLike | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function read(store: SessionLike | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(store: SessionLike | null, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    // storage blocked: the throttle and the footer name last for this page view only
  }
}

/** The follower's name as the last `me/hello` returned it (null until known). */
export const followerName: Store<string | null> = createStore<string | null>(null);

export function useFollowerName(): string | null {
  return useSyncExternalStore(followerName.subscribe, followerName.get, followerName.get);
}

/** Seeds the name from this tab's storage (a reload keeps the footer line). */
export function loadFollowerName(store: SessionLike | null = sessionStore()): void {
  const name = read(store, FOLLOWER_NAME_KEY);
  if (name && name.trim() !== '' && [...name].length <= 60) followerName.set(name);
}

export interface HelloDeps {
  api: PublicApi;
  cookies: GateCookies;
  navigate: Navigator;
  session?: SessionLike | null;
  now?: () => number;
  /** Runs `cb` when the browser is idle; returns a cancel function. */
  idle?: (cb: () => void) => () => void;
  /** visibilitychange subscription; returns an unsubscribe function. */
  onVisibility?: (cb: (hidden: boolean) => void) => () => void;
  pathname?: () => string;
}

function browserIdle(cb: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(cb, { timeout: 3000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(cb, 1000);
  return () => window.clearTimeout(id);
}

function browserVisibility(cb: (hidden: boolean) => void): () => void {
  const listener = () => cb(document.hidden);
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}

/** Starts the visit pings; returns a stop function (the root layout's effect cleanup). */
export function startHello(deps: HelloDeps): () => void {
  const session = deps.session === undefined ? sessionStore() : deps.session;
  const now = deps.now ?? (() => Date.now());
  const idle = deps.idle ?? browserIdle;
  const onVisibility = deps.onVisibility ?? browserVisibility;
  const pathname = deps.pathname ?? (() => window.location.pathname);
  let stopped = false;
  let hiddenAt: number | null = null;

  const hello = async (force: boolean): Promise<void> => {
    if (!force) {
      const last = Number(read(session, HELLO_AT_KEY));
      if (Number.isFinite(last) && last > 0 && now() - last < HELLO_THROTTLE_MS && now() >= last) return;
    }
    const k = deps.cookies.readKey();
    if (!k) return;
    try {
      const res = await deps.api.post('me/hello', { k });
      if (stopped) return;
      if (res.status === 'active') {
        write(session, HELLO_AT_KEY, String(now()));
        write(session, FOLLOWER_NAME_KEY, res.follower.name);
        followerName.set(res.follower.name);
        if (res.notice?.required) {
          deps.navigate.assign(`/_/info/#reconfirm&return=${encodeURIComponent(pathname())}`);
        }
      } else if (res.status === 'ended') {
        deps.navigate.replace('/_/ended/');
      }
    } catch {
      // Viewing never depends on the API.
    }
  };

  const cancelIdle = idle(() => {
    if (stopped) return;
    const afterHandoff = deps.cookies.hasHandoff();
    if (afterHandoff) {
      deps.cookies.deleteHandoff();
      deps.cookies.deleteTransfer();
    }
    void hello(afterHandoff);
  });

  const unsubscribe = onVisibility((hidden) => {
    if (hidden) {
      hiddenAt = now();
      return;
    }
    const away = hiddenAt === null ? 0 : now() - hiddenAt;
    hiddenAt = null;
    if (away >= HELLO_AFTER_HIDDEN_MS) void hello(true);
  });

  return () => {
    stopped = true;
    cancelIdle();
    unsubscribe();
  };
}
