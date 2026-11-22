/**
 * The browser as the gate pages see it (spec-wave5 §6.2). Pages never touch `location`,
 * `history`, `fetch`, storage or timers directly: they go through a GateEnv, so the tests can run
 * every state machine in jsdom with a fake API and record every navigation.
 *
 * Navigation is the one place where a secret could leak into a URL (history, history sync, the
 * host's access log, Referer). `safeTarget` therefore admits only the fixed targets the gate uses:
 * "/", the handoff path "/_/h/", a gate page with one of its known fragments, and a validated
 * return path; anything else (and anything that contains a 43-character token run) becomes "/".
 */
import { ACCESS_TOKEN_RE } from './access-lite';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

export interface GateEnv {
  readonly doc: Document;
  /** Location of the page at load time. */
  readonly location: { readonly pathname: string; readonly hash: string; readonly protocol: string };
  /** history.replaceState(null, '', url): only ever used to drop the fragment. */
  replaceUrl(url: string): void;
  /** location.replace(url) (filtered by safeTarget). */
  replace(url: string): void;
  /** location.assign(url) (filtered by safeTarget). */
  assign(url: string): void;
  fetch(url: string, init: RequestInit): Promise<Response>;
  storage(kind: 'session' | 'local'): StorageLike | null;
  /** Resolves after `ms`. */
  delay(ms: number): Promise<void>;
  /** Runs `fn` after `ms`; returns a cancel function. */
  schedule(fn: () => void, ms: number): () => void;
  now(): number;
  readonly userAgent: string;
  readonly languages: readonly string[];
  isHidden(): boolean;
  /** Calls `cb` on every visibilitychange; returns an unsubscribe function. */
  onVisibilityChange(cb: () => void): () => void;
  /** Saves a file (the data export). */
  download(blob: Blob, filename: string): void;
}

const GATE_TARGET_RE = /^\/_\/(?:join|info|wait|ended|me|panic)\/(?:#(?:resume|view|signout|deleted|reconfirm))?$/;
const RECONFIRM_RE = /^\/_\/info\/#reconfirm&return=%2F[A-Za-z0-9._~%-]*$/;
const RETURN_PATH_RE = /^\/[A-Za-z0-9._~/-]*$/;
const TOKEN_RUN_RE = new RegExp(ACCESS_TOKEN_RE.source.slice(1, -1));

/**
 * The URL a gate page may navigate to, or "/" when `url` is not one of the fixed gate targets.
 * Never lets a token-shaped run (a link secret, session id or device key) through.
 */
export function safeTarget(url: string): string {
  if (TOKEN_RUN_RE.test(url)) return '/';
  if (url === '/' || url === '/_/h/') return url;
  if (GATE_TARGET_RE.test(url) || RECONFIRM_RE.test(url)) return url;
  if (RETURN_PATH_RE.test(url) && !url.includes('//')) return url;
  return '/';
}

function storageOf(kind: 'session' | 'local'): StorageLike | null {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

/** Reads a storage key; null when storage is blocked. */
export function readStored(env: GateEnv, kind: 'session' | 'local', key: string): string | null {
  try {
    return env.storage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStored(env: GateEnv, kind: 'session' | 'local', key: string, value: string | null): void {
  try {
    const store = env.storage(kind);
    if (value === null) store?.removeItem(key);
    else store?.setItem(key, value);
  } catch {
    // Storage blocked: a convenience is lost, nothing else.
  }
}

/** Empties localStorage and sessionStorage of the site origin (sign out, delete me). */
export function clearSiteStorage(env: GateEnv): void {
  for (const kind of ['local', 'session'] as const) {
    try {
      env.storage(kind)?.clear();
    } catch {
      // ignore
    }
  }
}

export function browserEnv(): GateEnv {
  return {
    doc: document,
    location: {
      pathname: window.location.pathname,
      hash: window.location.hash,
      protocol: window.location.protocol,
    },
    replaceUrl: (url) => {
      try {
        window.history.replaceState(null, '', url);
      } catch {
        // ignore: the fragment stays visible, it never reaches the server
      }
    },
    replace: (url) => window.location.replace(safeTarget(url)),
    assign: (url) => window.location.assign(safeTarget(url)),
    fetch: (url, init) => window.fetch(url, init),
    storage: storageOf,
    delay: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    schedule: (fn, ms) => {
      const id = window.setTimeout(fn, ms);
      return () => window.clearTimeout(id);
    },
    now: () => Date.now(),
    userAgent: navigator.userAgent,
    languages: navigator.languages?.length ? navigator.languages : [navigator.language],
    isHidden: () => document.hidden,
    onVisibilityChange: (cb) => {
      document.addEventListener('visibilitychange', cb);
      return () => document.removeEventListener('visibilitychange', cb);
    },
    download: (blob, filename) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    },
  };
}
