/**
 * The few runtime values of @omw/contracts/access the gate pages need, without the module.
 *
 * Why a copy: access.ts builds its zod schemas at module level with chained calls
 * (`z.string().regex(…)`), which the bundler must treat as side effects, so importing any value
 * from it pulls zod and every schema into the public gate bundle (≈ 140 kB instead of ≈ 20 kB).
 * Types still come from the contracts (`import type`). test/gate/access-lite.test.ts pins every
 * copy to the contracts: identical regex sources and constants, and the same parseLinkFragment
 * result on a table of fragments and on generated ones.
 */
import type { LinkFragment, LinkFragmentMode } from '@omw/contracts/access';

export const ACCESS_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const GATE_SESSION_RE = /^[a-z2-7]{12}\.[a-z2-7]{8}\.[A-Za-z0-9_-]{43}$/;
export const PUBLIC_API_BASE_RE = /^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?\/api\/v1\/public\/$/;
export const GATE_BOOT_ELEMENT_ID = 'omw-gate';
export const HANDOFF_PATH = '/_/h/';
export const DELETE_ME_CONFIRMATION = 'delete-all-my-data';
/** Max-Age (seconds) of the JS-written key cookie and of the transfer cookie (§2.3.1). */
export const GATE_COOKIE_MAX_AGE = { keyJs: 1_209_600, transfer: 120 } as const;

const FRAGMENT_MODES: readonly LinkFragmentMode[] = ['resume', 'reconfirm', 'view', 'handoff-failed'];
const RETURN_PATH_RE = /^\/[A-Za-z0-9._~\-/]*$/;

/** Same semantics as the contracts' parseLinkFragment (see the module header). */
export function parseLinkFragment(hash: string): LinkFragment {
  const out: LinkFragment = {};
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  if (body === '') return out;
  for (const part of body.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      const mode = FRAGMENT_MODES.find((m) => m === part);
      if (mode && out.mode === undefined) out.mode = mode;
      continue;
    }
    const name = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if ((name === 't' || name === 'k') && out[name] === undefined && ACCESS_TOKEN_RE.test(value)) {
      out[name] = value;
    } else if (name === 'return' && out.returnPath === undefined) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        continue;
      }
      if (RETURN_PATH_RE.test(decoded) && !decoded.includes('//')) out.returnPath = decoded;
    }
  }
  return out;
}
