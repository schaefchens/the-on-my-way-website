/**
 * Child process of crash.test.ts: replays the fixtures and runs the ingest until it is killed.
 * Configuration comes from the environment (DATA_DIR, ARCHIVE_DIR, MEDIA_DIR, FIXTURES_DIR, …).
 */
import { createIngest, createWaSource } from '../../src/capture/index.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import { statePaths } from '../../src/paths.js';
import { Store } from '../../src/store/index.js';

const config = loadConfig(process.env);
const log = createLogger({ level: 'silent' });
const paths = statePaths(config.dirs.data);
const store = Store.open(paths.storeDb, { now: () => new Date('2026-11-17T15:00:00.000Z') });
const source = createWaSource({ config, log, paths, store });
const ingest = createIngest({ config, log, paths, store, source, workers: 1 });
await source.start();
process.stdout.write('replayed\n');
await ingest.drain();
process.stdout.write('done\n');
store.close();
