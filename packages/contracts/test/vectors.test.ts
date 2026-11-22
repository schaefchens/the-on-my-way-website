/**
 * fixtures/vectors/*.json are the cross-runtime contract for the PHP duplicates of ids/time/policy
 * (and, from wave 5, of the access store layout: access-paths.json). They are written by
 * `pnpm fixtures` (`--owner-only` is enough); this test keeps them in sync with the TS implementation.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_RE,
  type CookieMode,
  DEVICE_ID_RE,
  FOLLOWER_ID_RE,
  GATE_SESSION_RE,
  gateCookies,
  gateCookieValue,
  isSafeStoreDir,
  isValidStoreOpPath,
  panicLinkUrl,
  parseGateSession,
  parseLinkFragment,
  personalLinkUrl,
  STORE_PATHS,
  type StoreOpKind,
  storePathKind,
} from '../src/access.js';
import type { Visibility } from '../src/common.js';
import { publicIdForSourceKey, publishedPostId } from '../src/ids.js';
import {
  type AnnotationPolicyInput,
  effectiveCaptureVisibility,
  effectiveLocalDate,
  effectiveTz,
  entryReleaseAt,
  type HoldDay,
  holdEndAt,
  leftPlaceAt,
  nextModeSince,
  nextReleaseSlot,
  type PlacementInput,
  type PolicySettings,
  placeKey,
  portraitReleaseAt,
  type ReleaseSettings,
  type TripRange,
  tripForDate,
} from '../src/policy.js';
import { coarsenToBucket, localDateFor, localTimeFor, timeBucket, zonedWallTimeToUtc } from '../src/time.js';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/vectors');
const load = <T>(name: string): { cases: T[] } => JSON.parse(readFileSync(resolve(dir, name), 'utf8'));

describe('cross-runtime vectors', () => {
  it('ids.json', async () => {
    const { cases } = load<{ sourceKey: string; publicId: string }>('ids.json');
    expect(cases.length).toBeGreaterThan(10);
    for (const c of cases) expect(await publicIdForSourceKey(c.sourceKey)).toBe(c.publicId);
  });

  it('ids.json: publishedPost (published post ids, E16)', async () => {
    const { publishedPost } = JSON.parse(readFileSync(resolve(dir, 'ids.json'), 'utf8')) as {
      publishedPost: { publicId: string; publishedId: string }[];
    };
    expect(publishedPost.length).toBeGreaterThanOrEqual(5);
    for (const c of publishedPost) expect(await publishedPostId(c.publicId), c.publicId).toBe(c.publishedId);
  });

  it('release.json: release slots, departure hold, portrait release', () => {
    const { cases } = load<{ fn: string; args: unknown[]; expected: unknown }>('release.json');
    const counts = new Map<string, number>();
    for (const c of cases) {
      counts.set(c.fn, (counts.get(c.fn) ?? 0) + 1);
      const label = `${c.fn}(${JSON.stringify(c.args)})`;
      const a = c.args as [never, never, never, never];
      switch (c.fn) {
        case 'zonedWallTimeToUtc':
          expect(zonedWallTimeToUtc(a[0], a[1], a[2]), label).toBe(c.expected);
          break;
        case 'nextReleaseSlot':
          expect(nextReleaseSlot(a[0], a[1], a[2]), label).toBe(c.expected);
          break;
        case 'placeKey':
          expect(placeKey(a[0]), label).toBe(c.expected);
          break;
        case 'leftPlaceAt':
          expect(Object.fromEntries(leftPlaceAt(a[0] as HoldDay[])), label).toEqual(c.expected);
          break;
        case 'holdEndAt':
          expect(holdEndAt(a[0], a[1], a[2] as ReleaseSettings), label).toBe(c.expected);
          break;
        case 'entryReleaseAt':
          expect(entryReleaseAt(a[0], a[1], a[2] as ReleaseSettings), label).toBe(c.expected);
          break;
        case 'portraitReleaseAt':
          expect(portraitReleaseAt(a[0], a[1], a[2], a[3]), label).toBe(c.expected);
          break;
        default:
          throw new Error(`unknown fn ${c.fn}`);
      }
    }
    for (const fn of [
      'zonedWallTimeToUtc',
      'nextReleaseSlot',
      'placeKey',
      'leftPlaceAt',
      'holdEndAt',
      'entryReleaseAt',
    ]) {
      expect(counts.get(fn) ?? 0, fn).toBeGreaterThan(0);
    }
    expect(counts.get('portraitReleaseAt')).toBe(96);
  });

  it('time-buckets.json: timeBucket and coarsenToBucket (incl. DST days in Berlin and New York)', () => {
    const { cases } = load<{
      at: string;
      tz: string;
      index: number;
      startHour: number;
      partOfDay: string;
      coarsened: string;
    }>('time-buckets.json');
    expect(cases.length).toBeGreaterThan(20);
    expect(new Set(cases.map((c) => c.tz))).toEqual(
      new Set(['Asia/Ho_Chi_Minh', 'Europe/Berlin', 'America/New_York', 'Asia/Kathmandu', 'UTC']),
    );
    for (const c of cases) {
      const label = `${c.at} ${c.tz} #${c.index}`;
      expect(timeBucket(c.at, c.tz), label).toEqual({ startHour: c.startHour, partOfDay: c.partOfDay });
      expect(coarsenToBucket(c.at, c.tz, c.index), label).toBe(c.coarsened);
      // The coarsened time stays in the same local bucket and never moves later than the entry
      // by more than its index.
      expect(timeBucket(c.coarsened, c.tz).startHour, label).toBe(c.startHour);
      expect(Date.parse(c.coarsened) - Date.parse(c.at), label).toBeLessThanOrEqual(c.index * 1000);
    }
  });

  it('access-paths.json: ids, cookie values, links, store layout (TS side; PHP StoreLayout reads it too)', () => {
    const v = JSON.parse(readFileSync(resolve(dir, 'access-paths.json'), 'utf8')) as {
      tokens: { accept: string[]; reject: string[] };
      followerIds: { accept: string[]; reject: string[] };
      deviceIds: { accept: string[]; reject: string[] };
      gateSessions: { accept: string[]; reject: string[] };
      cookieValues: { fid: string; did: string; sid: string; value: string }[];
      personalLinks: { origin: string; t: string; url: string }[];
      panicLinks: { origin: string; k: string; url: string }[];
      badOrigins: string[];
      storePaths: Record<string, string>;
      pathKinds: { path: string; kind: string | null }[];
      opPaths: { op: StoreOpKind; path: string; exclusive: boolean; valid: boolean }[];
      storeDirs: { dir: string; safe: boolean }[];
      fragments: { hash: string; parsed: unknown }[];
      cookies: { origin: string; cookieMode: CookieMode; cookies: unknown }[];
      ids: { fid: string; did: string; sid: string; t: string; k: string };
    };
    const lists: [RegExp, { accept: string[]; reject: string[] }][] = [
      [ACCESS_TOKEN_RE, v.tokens],
      [FOLLOWER_ID_RE, v.followerIds],
      [DEVICE_ID_RE, v.deviceIds],
      [GATE_SESSION_RE, v.gateSessions],
    ];
    for (const [re, list] of lists) {
      for (const s of list.accept) expect(re.test(s), s).toBe(true);
      for (const s of list.reject) expect(re.test(s), s).toBe(false);
    }
    for (const c of v.cookieValues) {
      expect(gateCookieValue(c.fid, c.did, c.sid)).toBe(c.value);
      expect(parseGateSession(c.value)).toEqual({ fid: c.fid, did: c.did, sid: c.sid });
    }
    for (const c of v.personalLinks) expect(personalLinkUrl(c.origin, c.t)).toBe(c.url);
    for (const c of v.panicLinks) expect(panicLinkUrl(c.origin, c.k)).toBe(c.url);
    for (const origin of v.badOrigins) expect(() => personalLinkUrl(origin, v.ids.t), origin).toThrow(RangeError);
    const { fid, did, sid } = v.ids;
    expect(v.storePaths).toEqual({
      marker: STORE_PATHS.marker,
      locked: STORE_PATHS.locked,
      htaccess: STORE_PATHS.htaccess,
      session: STORE_PATHS.session(fid, did, sid),
      sessionDir: STORE_PATHS.sessionDir(fid),
      sessionPrefix: `${STORE_PATHS.sessionDir(fid)}/${STORE_PATHS.sessionPrefix(did)}`,
      handoff: STORE_PATHS.handoff(did),
      personTombstone: STORE_PATHS.personTombstone(fid),
      deviceTombstone: STORE_PATHS.deviceTombstone(fid, did),
    });
    expect(v.pathKinds.length).toBeGreaterThan(30);
    for (const c of v.pathKinds) expect(storePathKind(c.path), JSON.stringify(c.path)).toBe(c.kind);
    expect(v.opPaths.length).toBe(v.pathKinds.length * 6);
    for (const c of v.opPaths) {
      expect(isValidStoreOpPath(c.op, c.path, c.exclusive), `${c.op} ${JSON.stringify(c.path)} ${c.exclusive}`).toBe(
        c.valid,
      );
    }
    expect(v.storeDirs.some((d) => d.safe) && v.storeDirs.some((d) => !d.safe)).toBe(true);
    for (const c of v.storeDirs) expect(isSafeStoreDir(c.dir), c.dir).toBe(c.safe);
    for (const c of v.fragments) expect(parseLinkFragment(c.hash), c.hash).toEqual(c.parsed);
    expect(v.cookies).toHaveLength(9);
    for (const c of v.cookies)
      expect(gateCookies(c.origin, c.cookieMode), `${c.origin} ${c.cookieMode}`).toEqual(c.cookies);
  });

  it('time.json', () => {
    const { cases } = load<{ isoUtc: string; tz: string; localDate: string; localTime: string }>('time.json');
    expect(cases.length).toBeGreaterThan(10);
    for (const c of cases) {
      expect(localDateFor(c.isoUtc, c.tz), `${c.isoUtc} ${c.tz}`).toBe(c.localDate);
      expect(localTimeFor(c.isoUtc, c.tz), `${c.isoUtc} ${c.tz}`).toBe(c.localTime);
    }
  });

  it('policy.json', () => {
    const { cases } = load<{
      settings: PolicySettings;
      capture: { occurredAt: string; revokedAt: string | null };
      annotation: AnnotationPolicyInput;
      now: string;
      expected: Visibility;
    }>('policy.json');
    expect(cases.length).toBe(288);
    expect(cases.some((c) => c.settings['publish.mode_since'] !== '1970-01-01T00:00:00.000Z')).toBe(true);
    for (const c of cases) {
      expect(effectiveCaptureVisibility(c.capture, c.annotation, c.settings, c.now)).toBe(c.expected);
    }
  });

  it('mode-switch.json: publish.mode_since and what a switch releases', () => {
    const { captures, cases } = JSON.parse(readFileSync(resolve(dir, 'mode-switch.json'), 'utf8')) as {
      captures: { label: string; occurredAt: string }[];
      cases: {
        before: PolicySettings;
        after: Pick<PolicySettings, 'publish.mode' | 'publish.delay_minutes'>;
        now: string;
        modeSince: string;
        visibilityBefore: Visibility[];
        visibilityAfter: Visibility[];
      }[];
    };
    expect(cases.length).toBe(162);
    let releasedByReviewToDelayed = 0;
    for (const c of cases) {
      const name = `${c.before['publish.mode']}(${c.before['publish.delay_minutes']}, ${c.before['publish.mode_since']}) -> ${c.after['publish.mode']}(${c.after['publish.delay_minutes']})`;
      expect(nextModeSince(c.before, c.after, c.now), name).toBe(c.modeSince);
      const after: PolicySettings = { ...c.before, ...c.after, 'publish.mode_since': c.modeSince };
      captures.forEach((capture, i) => {
        const label = `${name}: ${capture.label}`;
        const was = effectiveCaptureVisibility(capture, null, c.before, c.now);
        const is = effectiveCaptureVisibility(capture, null, after, c.now);
        expect(was, label).toBe(c.visibilityBefore[i]);
        expect(is, label).toBe(c.visibilityAfter[i]);
        // A capture at exactly the switch instant already falls under the new mode (mode_since
        // is inclusive): it counts as arriving with the switch, not before it.
        if (Date.parse(capture.occurredAt) >= Date.parse(c.now)) return;
        // The policy's promises: nothing public becomes pending; waiting statuses are released
        // only by -> instant, review -> delayed and a shorter delay, and only once they are at
        // least as old as the new delay.
        expect(was === 'public' && is === 'pending', label).toBe(false);
        if (was === 'pending' && is === 'public') {
          const from = c.before['publish.mode'];
          const to = c.after['publish.mode'];
          const age = Date.parse(c.now) - Date.parse(capture.occurredAt);
          const oldEnough = age >= c.after['publish.delay_minutes'] * 60_000;
          const shorter = from === 'delayed' && c.after['publish.delay_minutes'] < c.before['publish.delay_minutes'];
          expect(to === 'instant' || (to === 'delayed' && (from === 'review' || shorter) && oldEnough), label).toBe(
            true,
          );
          if (from === 'review' && to === 'delayed') releasedByReviewToDelayed++;
        }
        // review -> delayed releases EXACTLY the waiting statuses at least as old as the new delay.
        if (c.before['publish.mode'] === 'review' && c.after['publish.mode'] === 'delayed' && was === 'pending') {
          const age = Date.parse(c.now) - Date.parse(capture.occurredAt);
          expect(is, label).toBe(age >= c.after['publish.delay_minutes'] * 60_000 ? 'public' : 'pending');
        }
      });
    }
    expect(releasedByReviewToDelayed).toBeGreaterThan(0);
  });

  it('placement.json', () => {
    const { cases } = load<{
      item: PlacementInput;
      annotation: AnnotationPolicyInput | null;
      dayTz: string | null;
      localDate: string;
      tz: string;
    }>('placement.json');
    expect(cases.length).toBeGreaterThan(5);
    for (const c of cases) {
      expect(effectiveLocalDate(c.item, c.annotation, c.dayTz)).toBe(c.localDate);
      expect(effectiveTz(c.item, c.annotation, c.dayTz)).toBe(c.tz);
    }
  });

  it('trips.json', () => {
    const { trips, cases } = JSON.parse(readFileSync(resolve(dir, 'trips.json'), 'utf8')) as {
      trips: TripRange[];
      cases: { date: string; trip: string | null }[];
    };
    expect(cases.length).toBeGreaterThan(5);
    for (const c of cases) expect(tripForDate(c.date, trips), c.date).toBe(c.trip);
  });
});
