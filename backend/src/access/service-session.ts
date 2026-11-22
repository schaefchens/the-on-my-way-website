/**
 * The publisher's own gate session for the post-deploy check (spec-wave5 §3.6, §5.6.3 #4–#5).
 *
 * rotate() asks GET /backend/access/service-session?rotate=1 once and then polls the plain route
 * every 2 s (503 busy while the API, or the Mac's own fallback writer, has not applied the store
 * ops yet; asking with rotate=1 again would rotate again) for up to 30 s. The current and the
 * previous value live in memory only (never persisted, never logged): the previous one is what
 * gate check #5 expects Apache to refuse.
 */
import type { ServiceSession } from '@omw/contracts/access';
import type { CheckCookie } from '../publisher/gatecheck.js';
import type { ServiceSessionSource } from '../publisher/index.js';
import { type ApiClient, ApiRequestError } from '../sync/client.js';

export interface ServiceSessionOptions {
  /** The API client (null = no API: the check skips #4–#5). */
  client: () => ApiClient | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Wait for the session to be applied (default 30 s), polling every `pollMs` (default 2 s). */
  maxWaitMs?: number;
  pollMs?: number;
}

export class ServiceSessionTimeout extends Error {
  override name = 'ServiceSessionTimeout';
}

export class ServiceSessionKeeper implements ServiceSessionSource {
  private readonly opts: Required<Omit<ServiceSessionOptions, 'client'>> & Pick<ServiceSessionOptions, 'client'>;
  private current: ServiceSession | null = null;

  constructor(opts: ServiceSessionOptions) {
    this.opts = {
      client: opts.client,
      sleep: opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
      now: opts.now ?? (() => new Date()),
      maxWaitMs: opts.maxWaitMs ?? 30_000,
      pollMs: opts.pollMs ?? 2_000,
    };
  }

  async rotate(): Promise<{ current: CheckCookie; previous: CheckCookie | null } | null> {
    const client = this.opts.client();
    if (!client) return null;
    const previous = this.current;
    const started = this.opts.now().getTime();
    let rotate = true;
    for (;;) {
      try {
        const fresh = await client.serviceSession(rotate);
        // A plain poll may still answer the old session for a moment: wait for the new one.
        if (!previous || fresh.cookieValue !== previous.cookieValue) {
          this.current = fresh;
          return {
            current: { name: fresh.cookieName, value: fresh.cookieValue },
            previous: previous ? { name: previous.cookieName, value: previous.cookieValue } : null,
          };
        }
      } catch (err) {
        if (!(err instanceof ApiRequestError && err.status === 503)) throw err;
      }
      rotate = false;
      if (this.opts.now().getTime() - started + this.opts.pollMs > this.opts.maxWaitMs) {
        throw new ServiceSessionTimeout(
          `the service session was not applied within ${Math.round(this.opts.maxWaitMs / 1000)} s`,
        );
      }
      await this.opts.sleep(this.opts.pollMs);
    }
  }
}
