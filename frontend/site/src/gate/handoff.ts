/**
 * The only way a gate page starts a handoff (spec-wave5 §2.3.2): write the 120-second transfer
 * cookie, then `location.replace('/_/h/')`. Apache checks the Strict key cookie, the transfer
 * cookie, the handoff marker and the session file, then sets the gate cookie and redirects into
 * the content. Neither the session id nor the device key ever enters a URL.
 */
import { GATE_SESSION_RE, HANDOFF_PATH } from './access-lite';
import type { GateCookies } from './cookies';
import { type GateEnv, writeStored } from './env';

/** sessionStorage flag: the one automatic retry after `#handoff-failed` was used (§6.2.1). */
export const HANDOFF_RETRY_KEY = 'omw.hr';

export function startHandoff(env: GateEnv, cookies: GateCookies, session: string): void {
  if (!GATE_SESSION_RE.test(session)) {
    env.replace('/');
    return;
  }
  // A fresh session gets its own retry if the handoff is refused.
  writeStored(env, 'session', HANDOFF_RETRY_KEY, null);
  cookies.writeTransfer(session);
  env.replace(HANDOFF_PATH);
}
