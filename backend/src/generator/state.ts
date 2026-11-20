/**
 * Generator state, persisted in the store's meta table (key "generator.state", JSON) next to the
 * monotonic counter meta.site_version (Manifest.version).
 *
 * It records what the last run wrote, so the next run can work incrementally and so that a run
 * on a wiped OUT_DIR reproduces byte-identical files (release stamps of unchanged pages survive):
 * - inputs that force a full run: generator version, site build hash, settings hash;
 * - the release (version, generatedAt, timeline hash);
 * - per day/trip: change key `v` (hash of the DaySummary/TripSummary, which includes the data
 *   file's own `v`), trip membership and story ids (dependency map);
 * - per output file: short sha of the bytes; per page: content hash without stamp + stamp.
 * Media are not listed: OUT_DIR/media is scanned (it only ever holds referenced variants).
 *
 * "generator.dirty" is set while a run writes and cleared at the end; a run that finds it set
 * (crash mid-run) escalates to a full run, which re-checks every file on disk.
 */
import { z } from 'zod';
import type { Store } from '../store/index.js';

export const STATE_KEY = 'generator.state';
export const DIRTY_KEY = 'generator.dirty';

const PageState = z.object({ h: z.string(), mv: z.int().min(1), tv: z.string() });

export const GeneratorState = z.object({
  schema: z.literal(1),
  generatorVersion: z.int(),
  buildHash: z.string(),
  settingsHash: z.string(),
  version: z.int().min(1),
  generatedAt: z.string(),
  timelineV: z.string(),
  timelineGeneratedAt: z.string(),
  mediaHash: z.string(),
  locales: z.array(z.string()),
  days: z.record(z.string(), z.object({ v: z.string(), trip: z.string().nullable(), stories: z.array(z.string()) })),
  trips: z.record(z.string(), z.object({ v: z.string(), days: z.array(z.string()) })),
  /** OUT_DIR-relative path -> short sha of the bytes (everything but media and assets). */
  files: z.record(z.string(), z.string()),
  pages: z.record(z.string(), PageState),
});
export type GeneratorState = z.infer<typeof GeneratorState>;
export type PageState = z.infer<typeof PageState>;

export function loadState(store: Store): GeneratorState | null {
  const raw = store.meta.get(STATE_KEY);
  if (!raw) return null;
  try {
    const parsed = GeneratorState.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveState(store: Store, state: GeneratorState): void {
  store.transaction(() => {
    store.meta.set(STATE_KEY, JSON.stringify(state));
    store.meta.set(DIRTY_KEY, '0');
  });
}

export function isDirty(store: Store): boolean {
  return store.meta.get(DIRTY_KEY) === '1';
}

export function markDirty(store: Store): void {
  store.meta.set(DIRTY_KEY, '1');
}

/** Forgets the state (next run is full and re-stamps every page). */
export function resetState(store: Store): void {
  store.transaction(() => {
    store.db.prepare('DELETE FROM meta WHERE key IN (?, ?)').run(STATE_KEY, DIRTY_KEY);
  });
}
