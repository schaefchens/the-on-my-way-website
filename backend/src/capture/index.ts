/**
 * Capture module (plan A1/A2): where WhatsApp statuses come from (WaSource: the supervised Go
 * helper, or recorded fixtures) and how they become ready captures (Ingest: inbox scan, archive,
 * media pipeline, sync outbox, change notifications for the generator).
 *
 * Wiring (main.ts):
 *   const source = createWaSource({ config, log, paths, store });
 *   const ingest = createIngest({ config, log, paths, store, source });
 *   ingest.onChange(({ localDates }) => generator.generate({ dates: localDates, reason: 'capture' }));
 *   await ingest.start();   // subscribe first, then
 *   await source.start();   // start the helper / fixture replay
 *   …
 *   await source.stop(); await ingest.stop();
 */
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { StatePaths } from '../paths.js';
import type { Store } from '../store/index.js';
import { FixtureSource, type FixtureSourceOptions } from './fixture.js';
import { HelperSource, type HelperSourceOptions } from './helper.js';
import { CaptureIngest, type IngestOptions } from './ingest.js';
import type { Ingest, WaSource } from './types.js';

export {
  type AppArchiveRecord,
  appPipelineInput,
  appRecordRelPath,
  isAppRecordPath,
  listAppRecords,
  readAppRecord,
} from './app-archive.js';
export {
  AppSource,
  type AppSourceDeps,
  type AppSourceOptions,
  type AppSourceStatus,
  createAppSource,
  newCaptureFromApp,
} from './app-source.js';
export type { ArchiveOriginal, ArchiveRecord } from './archive.js';
export { archiveRecordRelPath, listArchiveRecords, readArchiveRecord } from './archive.js';
export { FixtureSource, type FixtureSourceOptions } from './fixture.js';
export { HelperSource, type HelperSourceOptions } from './helper.js';
export { CaptureIngest, type IngestDeps, type IngestOptions } from './ingest.js';
export {
  DEFAULT_RESTART_POLICY,
  exitMeaning,
  HELPER_EXIT,
  type RestartPolicy,
  restartDelay,
} from './restart-policy.js';
export {
  captureMirrorFromRow,
  enqueueCaptureMirror,
  enqueuePreviews,
  enqueueRevoke,
  mediaStateOf,
  PreviewOutboxPayload,
  previewOutboxKey,
} from './sync-outbox.js';
export { knownTravelerLid, META_TRAVELER_LID, META_TRAVELER_PN, persistTravelerLid } from './traveler.js';
export type {
  DrainResult,
  Ingest,
  IngestChange,
  WaProcessState,
  WaSource,
  WaSourceState,
} from './types.js';

export interface WaSourceDeps {
  config: Config;
  log: Logger;
  paths: StatePaths;
  store: Store;
  /** Environment for WA_FIXTURE_PACE_MS (default process.env). */
  env?: Record<string, string | undefined>;
  helper?: HelperSourceOptions;
  fixture?: FixtureSourceOptions;
}

function paceFromEnv(env: Record<string, string | undefined>): number {
  const n = Number.parseInt(env.WA_FIXTURE_PACE_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * WA_MODE=fixture -> FixtureSource (replays FIXTURES_DIR; WA_FIXTURE_PACE_MS > 0 paces it);
 * observer | self -> HelperSource (spawns WA_HELPER_BIN).
 */
export function createWaSource(deps: WaSourceDeps): WaSource {
  if (deps.config.wa.mode === 'fixture') {
    return new FixtureSource(
      { config: deps.config, log: deps.log, paths: deps.paths },
      { paceMs: paceFromEnv(deps.env ?? process.env), ...deps.fixture },
    );
  }
  return new HelperSource({ config: deps.config, log: deps.log, paths: deps.paths, store: deps.store }, deps.helper);
}

export function createIngest(
  deps: { config: Config; log: Logger; paths: StatePaths; store: Store; source: WaSource } & IngestOptions,
): Ingest {
  return new CaptureIngest(deps);
}
