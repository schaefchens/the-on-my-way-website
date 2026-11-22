/**
 * Test harness of the gate pages (jsdom): a GateEnv that records every navigation instead of
 * leaving the page, a fake public API with per-route answers, contract-valid fixtures, and
 * helpers to read what the page shows. Timers are vitest's fake timers when a test enables them.
 */
import type { GateBoot, PublicNotice } from '@omw/contracts/access';
// Loaded up front: the API client's dev-only schema check imports it dynamically, and a first
// (slow) module load would otherwise race the fake timers.
import '@omw/contracts/access';
import { expect, vi } from 'vitest';
import type { PublicRoute } from '../../src/gate/api';
import { createGateContext, mountGate, ROOT_ID } from '../../src/gate/app';
import type { GateContext } from '../../src/gate/context';
import { type GateEnv, safeTarget } from '../../src/gate/env';

export const FID = 'abcdefgh2345';
export const DID = 'qrst2345';
export const SID = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0-_z';
export const T = 'tTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtT-_0';
export const K = 'kKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkK_-9';
export const K2 = 'k2k2k2k2k2k2k2k2k2k2k2k2k2k2k2k2k2k2k2k2k2k';
export const SESSION = `${FID}.${DID}.${SID}`;
export const API = 'https://api.example.org/api/v1/public/';

export function gateBoot(page: GateBoot['page'], over: Partial<GateBoot> = {}): GateBoot {
  return {
    page,
    api: API,
    locales: ['de', 'en'],
    defaultLocale: 'de',
    cookies: {
      session: '__Host-omw',
      key: '__Host-omw_k',
      transfer: '__Host-omw_s',
      handoff: '__Host-omw_h',
      resume: '__Host-omw_r',
      secure: true,
    },
    cookieMode: 'headers',
    cookieDomain: null,
    build: 'test',
    ...over,
  };
}

export function notice(version = 1, over: Partial<PublicNotice> = {}): PublicNotice {
  const texts = (prefix: string) => ({
    title: `${prefix} Datenschutz`,
    intro: `${prefix} Einleitung.\n\nZweiter Absatz.`,
    collected: `${prefix} Gespeichert.`,
    audience: `${prefix} Publikum.`,
    purpose: `${prefix} Zweck.`,
    retention: `${prefix} Dauer.`,
    rights: `${prefix} Rechte.`,
  });
  return {
    controller: { name: 'Erika Muster', email: 'erika@example.org', address: 'Weg 1\n12345 Ort' },
    texts: { de: texts('DE'), en: texts('EN') },
    version,
    publishedAt: '2026-11-20T10:00:00.000Z',
    ...over,
  };
}

export interface Call {
  route: string;
  body: Record<string, unknown>;
  init: RequestInit;
  url: string;
}

/** An answer: a JSON body (200), or an HTTP status (with optional Retry-After), or a network error. */
export type Answer =
  | Record<string, unknown>
  | { http: number; retryAfter?: number }
  | { network: true }
  | { raw: Response };

export type Handler = Answer | Answer[] | ((body: Record<string, unknown>) => Answer);

export function fakeApi(handlers: Partial<Record<PublicRoute | 'me/export', Handler>>) {
  const calls: Call[] = [];
  const queues = new Map<string, Answer[]>();
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    expect(url.startsWith(API)).toBe(true);
    const route = url.slice(API.length);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ route, body, init, url });
    const handler = handlers[route as PublicRoute];
    let answer: Answer | undefined;
    if (Array.isArray(handler)) {
      if (!queues.has(route)) queues.set(route, [...handler]);
      const queue = queues.get(route) as Answer[];
      answer = queue.length > 1 ? queue.shift() : queue[0];
    } else if (typeof handler === 'function') answer = handler(body);
    else answer = handler;
    if (answer === undefined) throw new Error(`no fake answer for ${route}`);
    if ('network' in answer) throw new TypeError('Failed to fetch');
    if ('raw' in answer) return answer.raw as Response;
    if ('http' in answer && typeof answer.http === 'number') {
      const headers: Record<string, string> = {};
      if (typeof answer.retryAfter === 'number') headers['Retry-After'] = String(answer.retryAfter);
      return new Response('{"error":"x"}', { status: answer.http, headers });
    }
    return new Response(JSON.stringify(answer), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return {
    fetch,
    calls,
    routes: () => calls.map((c) => c.route),
  };
}

export interface Nav {
  mode: 'replace' | 'assign';
  url: string;
  /** document.cookie at the moment of the navigation. */
  cookies: string;
}

export interface TestEnv extends GateEnv {
  navs: Nav[];
  replacedUrls: string[];
  downloads: { blob: Blob; filename: string }[];
  setHidden(hidden: boolean): void;
}

export function testEnv(opts: {
  fetch: GateEnv['fetch'];
  pathname?: string;
  hash?: string;
  userAgent?: string;
  languages?: string[];
}): TestEnv {
  const navs: Nav[] = [];
  const replacedUrls: string[] = [];
  const downloads: { blob: Blob; filename: string }[] = [];
  let hidden = false;
  const listeners = new Set<() => void>();
  return {
    doc: document,
    location: { pathname: opts.pathname ?? '/_/join/', hash: opts.hash ?? '', protocol: 'https:' },
    replaceUrl: (url) => replacedUrls.push(url),
    replace: (url) => navs.push({ mode: 'replace', url, cookies: document.cookie }),
    assign: (url) => navs.push({ mode: 'assign', url, cookies: document.cookie }),
    fetch: opts.fetch,
    storage: (kind) => (kind === 'session' ? window.sessionStorage : window.localStorage),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    schedule: (fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    now: () => Date.now(),
    userAgent: opts.userAgent ?? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1.15',
    languages: opts.languages ?? ['de-DE', 'de'],
    isHidden: () => hidden,
    onVisibilityChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    download: (blob, filename) => downloads.push({ blob, filename }),
    navs,
    replacedUrls,
    downloads,
    setHidden(next) {
      hidden = next;
      for (const cb of [...listeners]) cb();
    },
  };
}

/** A fresh document body with the gate root, cookies and storage cleared. */
export function resetDom(): void {
  document.documentElement.removeAttribute('lang');
  document.documentElement.removeAttribute('dir');
  document.body.replaceChildren();
  const main = document.createElement('main');
  main.id = ROOT_ID;
  document.body.append(main);
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim();
    if (name) rawCookie(`${name}=; Path=/; Max-Age=0; Secure; SameSite=Strict`);
  }
  window.localStorage.clear();
  window.sessionStorage.clear();
}

/** Writes a raw cookie line into the page's jar (as Apache or the neutral page would). */
export function rawCookie(line: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: the tests drive the browser's real cookie jar
  document.cookie = line;
}

export function setCookie(name: string, value: string): void {
  rawCookie(`${name}=${value}; Path=/; Max-Age=600; Secure; SameSite=Strict`);
}

export function cookieValue(name: string): string | null {
  for (const part of document.cookie.split(';')) {
    const [n, ...rest] = part.trim().split('=');
    if (n === name) return rest.join('=');
  }
  return null;
}

export async function mount(env: TestEnv, boot: GateBoot): Promise<GateContext | null> {
  return mountGate(env, boot);
}

export function context(env: TestEnv, boot: GateBoot): GateContext {
  return createGateContext(env, boot, document.getElementById(ROOT_ID) as HTMLElement);
}

/** Visible text of the gate root (whitespace collapsed). */
export function text(): string {
  return (document.getElementById(ROOT_ID)?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function action(name: string): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`[data-action="${name}"]`);
  if (!el) throw new Error(`no [data-action="${name}"] in: ${text()}`);
  return el;
}

export function hasAction(name: string): boolean {
  return document.querySelector(`[data-action="${name}"]`) !== null;
}

/** Lets pending promises (fake fetch, response bodies, awaits) settle. */
export async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const TOKEN_RUN = /[A-Za-z0-9_-]{43}/;

/** Every navigation goes to a fixed gate target and carries no secret. */
export function expectSafeNavs(env: TestEnv): void {
  for (const nav of env.navs) {
    expect(safeTarget(nav.url), nav.url).toBe(nav.url);
    expect(TOKEN_RUN.test(nav.url), nav.url).toBe(false);
    for (const secret of [SID, K, K2, T, SESSION]) expect(nav.url.includes(secret)).toBe(false);
  }
  for (const url of env.replacedUrls) expect(TOKEN_RUN.test(url), url).toBe(false);
}
