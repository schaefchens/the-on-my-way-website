/**
 * fixtures/vectors/*.json are the cross-runtime contract for the PHP duplicates of ids/time/policy.
 * They are written by `pnpm fixtures`; this test keeps them in sync with the TS implementation.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Visibility } from '../src/common.js';
import { publicIdForSourceKey } from '../src/ids.js';
import {
  type AnnotationPolicyInput,
  effectiveCaptureVisibility,
  effectiveLocalDate,
  effectiveTz,
  type PlacementInput,
  type PolicySettings,
  type TripRange,
  tripForDate,
} from '../src/policy.js';
import { localDateFor, localTimeFor } from '../src/time.js';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/vectors');
const load = <T>(name: string): { cases: T[] } => JSON.parse(readFileSync(resolve(dir, name), 'utf8'));

describe('cross-runtime vectors', () => {
  it('ids.json', async () => {
    const { cases } = load<{ sourceKey: string; publicId: string }>('ids.json');
    expect(cases.length).toBeGreaterThan(10);
    for (const c of cases) expect(await publicIdForSourceKey(c.sourceKey)).toBe(c.publicId);
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
