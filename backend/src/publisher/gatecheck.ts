/**
 * The anonymous-must-be-refused check (spec-wave5 §5.6.3; gate mode, after a deploy). At most 5
 * requests, 2 s apart, against the site origin:
 *
 *   #1 GET <origin>/<secret>/data/manifest.json?t=<now>       403, body = /_/403.txt     gate_open
 *   #2 GET <origin>/<secret>/data/days/0000-00-00.json        same status, length, body   gate_open
 *   #3 GET <origin>/<secret>/<defaultLocale>/                 200, body = neutral page    gate_open
 *   #4 #1 with Cookie <name>=<new service session>            200 JSON, version = deployed  store_unverified
 *   #5 #1 with Cookie <name>=<previous service session>       403                          store_unverified
 *
 * Before #4 the backend rotates the service session (GET /backend/access/service-session?rotate=1)
 * and waits until the API (or the Mac fallback writer) has applied it. #4 and #5 together prove
 * that both put and delete reach the folder Apache reads. Without an API #4–#5 are skipped;
 * without a previous value (first run) #5 is skipped. A network error or timeout is `error`,
 * never `gate_open` (the host may block the Mac's IP); `error` and `skipped` never fail the
 * publish report. Redirects are never followed.
 *
 * The check runs only after a deploy that changed the gate tree or a .htaccess, after a change of
 * the access configuration, or when the last successful check is older than 6 h (gateCheckDue).
 */
import { createHash } from 'node:crypto';
import type { GateCheckResult } from '@omw/contracts/access';
import type { FetchLike } from './httpcheck.js';

export const GATE_CHECK_SPACING_MS = 2_000;
export const GATE_CHECK_MAX_AGE_MS = 6 * 60 * 60_000;

/** A gate cookie the check presents (ServiceSession.cookieName/cookieValue). */
export interface CheckCookie {
  name: string;
  value: string;
}

export interface GateCheckOptions {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** Site origin ("https://host"). */
  origin: string;
  /** The content folder. */
  secret: string;
  defaultLocale: string;
  /** Exact bytes of /_/403.txt and of the neutral page. */
  forbiddenBody: Buffer;
  neutralBody: Buffer;
  /** The deployed Manifest.version (#4). */
  expectedVersion: number;
  /**
   * Rotates the service session and resolves once it is applied (null = no API: #4–#5 skipped).
   * Returns the new value and the previous one (null on the first run: #5 skipped).
   */
  rotateSession?: (() => Promise<{ current: CheckCookie; previous: CheckCookie | null } | null>) | null;
  timeoutMs?: number;
}

interface Answer {
  status: number;
  length: string | null;
  body: Buffer;
}

class NetworkError extends Error {
  override name = 'NetworkError';
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Runs the check (see the module header); never throws. */
export async function runGateCheck(o: GateCheckOptions): Promise<GateCheckResult> {
  const at = () => o.now().toISOString();
  const result = (r: GateCheckResult['result'], detail: string | null): GateCheckResult => ({
    at: at(),
    by: 'mac',
    result: r,
    detail: detail === null ? null : detail.slice(0, 300),
  });
  let requests = 0;
  const get = async (path: string, cookie?: CheckCookie): Promise<Answer> => {
    if (requests > 0) await o.sleep(GATE_CHECK_SPACING_MS);
    requests++;
    try {
      const res = await o.fetch(`${o.origin}${path}`, {
        method: 'GET',
        cache: 'no-store',
        redirect: 'manual',
        headers: { 'cache-control': 'no-cache', ...(cookie ? { cookie: `${cookie.name}=${cookie.value}` } : {}) },
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
      const body = Buffer.from(await res.arrayBuffer());
      return { status: res.status, length: res.headers.get('content-length'), body };
    } catch (err) {
      const e = err as Error;
      throw new NetworkError(e.name === 'TimeoutError' ? `${path}: timed out` : `${path}: ${e.message}`);
    }
  };
  const data = (t: number) => `/${o.secret}/data/manifest.json?t=${t}`;
  try {
    const first = await get(data(o.now().getTime()));
    if (first.status !== 403 || !first.body.equals(o.forbiddenBody)) {
      return result('gate_open', `anonymous data request: HTTP ${first.status} (expected the fixed 403)`);
    }
    const second = await get(`/${o.secret}/data/days/0000-00-00.json`);
    if (second.status !== first.status || second.length !== first.length || !second.body.equals(first.body)) {
      return result('gate_open', 'an existing and a missing data file answer differently');
    }
    const page = await get(`/${o.secret}/${o.defaultLocale}/`);
    if (page.status !== 200 || sha(page.body) !== sha(o.neutralBody)) {
      return result('gate_open', `anonymous page request: HTTP ${page.status}, not the neutral page`);
    }
    const sessions = o.rotateSession ? await o.rotateSession() : null;
    if (!sessions) return result('skipped', 'gate refuses anonymous requests; store proof skipped (no API session)');
    const fresh = await get(data(o.now().getTime()), sessions.current);
    let version: unknown = null;
    try {
      version = (JSON.parse(fresh.body.toString('utf8')) as { version?: unknown }).version;
    } catch {
      version = null;
    }
    if (fresh.status !== 200 || version !== o.expectedVersion) {
      return result(
        'store_unverified',
        `a session the writer just created is refused (HTTP ${fresh.status}): the writer and Apache use different folders`,
      );
    }
    if (!sessions.previous) return result('ok', 'gate ok; created session accepted (no previous session to check)');
    const old = await get(data(o.now().getTime()), sessions.previous);
    if (old.status !== 403) {
      return result(
        'store_unverified',
        `a session the writer just deleted is still accepted (HTTP ${old.status}): the delete did not reach Apache's folder`,
      );
    }
    return result('ok', 'gate ok; created session accepted, deleted session refused');
  } catch (err) {
    if (err instanceof NetworkError) return result('error', err.message);
    return result('error', err instanceof Error ? err.message : String(err));
  }
}

/** Persisted facts of the last check (store meta "gatecheck.last"). */
export interface GateCheckState {
  /** Last successful (ok) check. */
  okAt: string | null;
  /** Access configuration the last check ran with (a change makes the next deploy check). */
  configKey: string | null;
}

/** Whether a check is due after this deploy (see the module header). */
export function gateCheckDue(
  state: GateCheckState,
  opts: { gateChanged: boolean; configKey: string; now: Date },
): boolean {
  if (opts.gateChanged) return true;
  if (state.configKey !== opts.configKey) return true;
  if (!state.okAt) return true;
  return opts.now.getTime() - Date.parse(state.okAt) >= GATE_CHECK_MAX_AGE_MS;
}
