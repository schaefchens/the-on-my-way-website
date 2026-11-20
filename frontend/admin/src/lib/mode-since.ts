/**
 * "publish.mode_since" after a settings change, restated from the API (Settings::patch) so the
 * optimistic settings and the mock API agree with it. Captures that occurred before
 * mode_since count as "instant" (policy rule 3), so the cut-off decides what a mode switch
 * publishes. With t = now:
 *   - instant -> delayed | review:                      since = t (only new statuses wait)
 *   - delayed -> review, or a delay change while delayed: since = max(old since, t - old delay + 1 ms)
 *     (what already passed its delay stays public; what was still waiting keeps waiting)
 *   - review -> delayed:                                 since unchanged (the review backlog
 *     follows the delay: whatever is older than the delay is published, see waitingToPublish)
 *   - any -> instant, anything else:                     unchanged
 */
import type { Visibility } from '@omw/contracts';
import type { PublishMode } from '@omw/contracts/api';
import { MODE_SINCE_EPOCH } from '@omw/contracts/policy';

export interface ModeSettings {
  'publish.mode': PublishMode;
  'publish.delay_minutes': number;
  'publish.mode_since'?: string | undefined;
}

export interface ModePatch {
  'publish.mode'?: PublishMode | undefined;
  'publish.delay_minutes'?: number | undefined;
}

function delayMs(minutes: number): number {
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : 0;
}

/** The new publish.mode_since (ISO), or the old one when the patch leaves it unchanged. */
export function modeSinceAfter(prev: ModeSettings, patch: ModePatch, now: number): string {
  const oldMode = prev['publish.mode'];
  const newMode = patch['publish.mode'] ?? oldMode;
  const oldSince = prev['publish.mode_since'] ?? MODE_SINCE_EPOCH;
  const newDelay = patch['publish.delay_minutes'] ?? prev['publish.delay_minutes'];
  const delayChanged = delayMs(newDelay) !== delayMs(prev['publish.delay_minutes']);
  if (oldMode === 'instant' && newMode !== 'instant') return new Date(now).toISOString();
  if (oldMode === 'delayed' && (newMode === 'review' || (newMode === 'delayed' && delayChanged))) {
    // + 1 ms: exactly the captures already public under the old delay (now >= occurredAt + d0)
    // fall before the cut-off and stay public (PHP Policy::nextModeSince).
    const cut = now - delayMs(prev['publish.delay_minutes']) + 1;
    return new Date(Math.max(Date.parse(oldSince), cut)).toISOString();
  }
  return oldSince;
}

export interface WaitingCapture {
  sourceKey: string;
  occurredAt: string;
  effectiveVisibility: Visibility;
  annotation: { visibility?: Visibility | null } | null;
}

/**
 * Waiting statuses (pending without an owner override) that switching to `nextMode` would
 * publish at once: all of them for "instant", for review -> delayed those older than the delay.
 * Other switches publish nothing.
 */
/** Whether switching to `nextMode` publishes waiting statuses at once (-> instant, review -> delayed). */
export function switchReleases(prev: Pick<ModeSettings, 'publish.mode'>, nextMode: PublishMode): boolean {
  const oldMode = prev['publish.mode'];
  return nextMode !== oldMode && (nextMode === 'instant' || (oldMode === 'review' && nextMode === 'delayed'));
}

export function waitingToPublish<C extends WaitingCapture>(
  captures: Iterable<C>,
  prev: ModeSettings,
  nextMode: PublishMode,
  now: number,
): C[] {
  if (!switchReleases(prev, nextMode)) return [];
  const releasesOld = nextMode !== 'instant';
  const cut = now - delayMs(prev['publish.delay_minutes']);
  const out = new Map<string, C>();
  for (const c of captures) {
    if (c.effectiveVisibility !== 'pending' || c.annotation?.visibility) continue;
    if (releasesOld && Date.parse(c.occurredAt) > cut) continue;
    out.set(c.sourceKey, c);
  }
  return [...out.values()];
}
