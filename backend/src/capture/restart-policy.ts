/**
 * Restart policy of the wa-helper supervisor, keyed by the helper's exit code (contracts wa.ts,
 * backend/wa-helper/README.md "Exit codes"):
 *
 *   0 clean shutdown (unexpected unless we asked)   exponential backoff
 *   1 fatal error                                   exponential backoff
 *   2 invalid configuration                         no automatic restart (fix the config); but exit 2
 *                                                   AFTER `ready` is a Go runtime panic and is
 *                                                   restarted like 1 (HelperSource.onExit)
 *   3 logged out (session deleted)                  restart soon: a fresh QR follows
 *   4 stream replaced                               slow backoff (never a tight loop; the helper
 *                                                   also waits 5 min before reconnecting)
 *   5 client outdated                               long hold (needs a new whatsmeow pin)
 *   6 temporary ban                                 restart at the ban end (helper waits as well)
 *   7 pairing ended without a link (QR timeout)     no automatic restart: like WhatsApp Web's
 *                                                   "reload QR", restart() when a QR is wanted
 *   8 connect failure                               exponential backoff
 *   other / spawn error                             exponential backoff
 *
 * Every delay gets ±25 % jitter. The failure streak resets once a helper ran for
 * `stableAfterMs`, so a helper that crashes once a week restarts quickly.
 */

export const HELPER_EXIT = {
  ok: 0,
  fatal: 1,
  invalidConfig: 2,
  loggedOut: 3,
  streamReplaced: 4,
  clientOutdated: 5,
  temporaryBan: 6,
  pairingEnded: 7,
  connectFailure: 8,
} as const;

export function exitMeaning(code: number | null, signal: string | null): string {
  if (code === null) return signal ? `killed by ${signal}` : 'did not start';
  switch (code) {
    case 0:
      return 'clean shutdown';
    case 1:
      return 'fatal error';
    case 2:
      return 'invalid configuration';
    case 3:
      return 'logged out (relink needed)';
    case 4:
      return 'stream replaced (session used elsewhere)';
    case 5:
      return 'client outdated (update whatsmeow)';
    case 6:
      return 'temporary ban';
    case 7:
      return 'pairing ended without a link';
    case 8:
      return 'connect failure';
    default:
      return `exit code ${code}`;
  }
}

export interface RestartPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  /** A run at least this long resets the failure streak. */
  stableAfterMs: number;
  loggedOutDelayMs: number;
  streamReplacedDelayMs: number;
  streamReplacedMaxDelayMs: number;
  clientOutdatedDelayMs: number;
  /** Minimum wait after a temporary ban (used when the ban end is unknown or already past). */
  banDelayMs: number;
  /** Upper bound for waiting on a ban end. */
  banMaxDelayMs: number;
  /** Jitter fraction (0.25 = ±25 %). */
  jitter: number;
}

export const DEFAULT_RESTART_POLICY: Readonly<RestartPolicy> = Object.freeze({
  baseDelayMs: 1_000,
  maxDelayMs: 5 * 60_000,
  stableAfterMs: 2 * 60_000,
  loggedOutDelayMs: 5_000,
  streamReplacedDelayMs: 60_000,
  streamReplacedMaxDelayMs: 30 * 60_000,
  clientOutdatedDelayMs: 60 * 60_000,
  banDelayMs: 60_000,
  banMaxDelayMs: 24 * 60 * 60_000,
  jitter: 0.25,
});

function exponential(base: number, max: number, streak: number): number {
  return Math.min(max, base * 2 ** Math.max(0, Math.min(30, streak - 1)));
}

/**
 * Delay before the next start, or null for "no automatic restart". `streak` counts consecutive
 * unstable runs including this one (>= 1); `banUntilMs` is the ban end from the last state event.
 */
export function restartDelay(
  policy: RestartPolicy,
  exit: { code: number | null },
  streak: number,
  nowMs: number,
  banUntilMs: number | null,
  random: () => number = Math.random,
): number | null {
  let delay: number;
  switch (exit.code) {
    case HELPER_EXIT.invalidConfig:
    case HELPER_EXIT.pairingEnded:
      return null;
    case HELPER_EXIT.loggedOut:
      delay = exponential(policy.loggedOutDelayMs, policy.maxDelayMs, streak);
      break;
    case HELPER_EXIT.streamReplaced:
      delay = exponential(policy.streamReplacedDelayMs, policy.streamReplacedMaxDelayMs, streak);
      break;
    case HELPER_EXIT.clientOutdated:
      delay = policy.clientOutdatedDelayMs;
      break;
    case HELPER_EXIT.temporaryBan: {
      const untilDelay = banUntilMs === null ? 0 : banUntilMs - nowMs;
      delay = Math.min(policy.banMaxDelayMs, Math.max(policy.banDelayMs, untilDelay));
      break;
    }
    default:
      delay = exponential(policy.baseDelayMs, policy.maxDelayMs, streak);
  }
  const factor = 1 - policy.jitter + 2 * policy.jitter * random();
  return Math.max(0, Math.round(delay * factor));
}
