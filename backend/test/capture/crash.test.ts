/**
 * Crash safety: a child process ingests the fixtures and is SIGKILLed mid-pipeline (some captures
 * ready, others not). A fresh ingest over the same DATA_DIR/ARCHIVE_DIR/MEDIA_DIR must complete
 * everything exactly once: no duplicate captures or outbox items, no stale temp files, every
 * variant file present and matching its recorded sha256.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { createIngest, createWaSource } from '../../src/capture/index.js';
import { BACKEND_ROOT, mediaFilePath } from '../../src/paths.js';
import { sha256File } from '../../src/pipeline/index.js';
import { fakeClock } from '../helpers.js';
import { fixturesPresent, listFiles, makeEnv, type TestEnv } from './env.js';

describe.skipIf(!fixturesPresent)('crash and restart', () => {
  let env: TestEnv | null = null;
  afterAll(() => env?.cleanup());

  it('resumes after kill -9 in the middle of the pipeline', async () => {
    const clock = fakeClock('2026-11-17T15:00:00.000Z');
    env = makeEnv({ now: clock, prefix: 'crash-' });
    const e = env;
    e.store.close(); // the child owns the database until it is killed

    const child = spawn(
      process.execPath,
      ['--conditions=@omw/source', '--import', 'tsx', join(BACKEND_ROOT, 'test', 'capture', 'crash-child.ts')],
      {
        cwd: BACKEND_ROOT,
        env: {
          ...process.env,
          TSX_DISABLE_CACHE: '1',
          NODE_ENV: 'test',
          WA_MODE: 'fixture',
          FIXTURES_DIR: e.config.wa.fixturesDir,
          DATA_DIR: e.config.dirs.data,
          ARCHIVE_DIR: e.config.dirs.archive,
          MEDIA_DIR: e.config.dirs.media,
          OUT_DIR: e.config.dirs.out,
          CONFIG_DIR: e.config.dirs.config,
          DEFAULT_TIMEZONE: 'Europe/Berlin',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
      child.on('close', (code, signal) => resolve({ code, signal })),
    );

    // Kill as soon as the pipeline is part-way through.
    let observed = { ready: 0, total: 0 };
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const db = new Database(e.paths.storeDb, { readonly: true, fileMustExist: true });
        try {
          observed = db
            .prepare("SELECT SUM(state = 'ready') AS ready, COUNT(*) AS total FROM captures")
            .get() as typeof observed;
        } finally {
          db.close();
        }
      } catch {
        // database or table not created yet
      }
      if ((observed.ready ?? 0) >= 2) break;
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    child.kill('SIGKILL');
    const exit = await exited;
    expect(exit.signal, `child finished before it could be killed (${stderr})`).toBe('SIGKILL');
    expect(observed.ready).toBeGreaterThanOrEqual(2);
    expect(observed.ready).toBeLessThan(16);

    // Restart over the same directories.
    const store = e.reopenStore();
    const source = createWaSource({ config: e.config, log: e.log, paths: e.paths, store });
    const ingest = createIngest({ config: e.config, log: e.log, paths: e.paths, store, source });
    await source.start();
    const result = await ingest.drain();
    expect(result.failed).toBe(0);
    expect(store.captures.countByState()).toMatchObject({ ready: 16, awaiting_media: 1, media_lost: 1, failed: 0 });
    expect(store.captures.list()).toHaveLength(18);

    // Exactly one pending outbox item per (kind, key).
    const due = store.outbox.due(1000);
    expect(due.filter((i) => i.kind === 'capture')).toHaveLength(18);
    expect(due.filter((i) => i.kind === 'preview')).toHaveLength(9);
    expect(due.filter((i) => i.kind === 'revoke')).toHaveLength(1);

    // No leftovers of the killed run; every recorded variant exists with its sha256.
    for (const dir of [e.config.dirs.media, e.config.dirs.archive, e.paths.inbox]) {
      expect(listFiles(dir).filter((f) => f.includes('.tmp-') || f.includes('.fixture-'))).toEqual([]);
    }
    for (const row of store.captures.list({ states: ['ready'] })) {
      for (const v of row.variants ?? []) {
        expect((await sha256File(mediaFilePath(e.config.dirs.media, v.relPath))).sha256, v.relPath).toBe(v.sha256);
      }
    }
    await ingest.stop();
    await source.stop();
  }, 120_000);
});
