/**
 * Generator CLI (run from the repo root; env as for the backend, see config.ts):
 *
 *   node --conditions=@omw/source --import tsx backend/src/generator/cli.ts <command> [options]
 *
 *   generate [--full] [--dates 2026-11-15,2026-11-16] [--site-dist DIR] [--now ISO] [--reason TEXT]
 *       Generates OUT_DIR from the store in DATA_DIR (store.db). Prints the result as JSON.
 *   serve [--dir OUT_DIR] [--port 4173] [--host 127.0.0.1] [--base /]
 *       Static preview of OUT_DIR (directory index, MIME types, 404.html, byte ranges).
 *   check [--dir OUT_DIR]
 *       Verifies OUT_DIR (contracts, hashes, references, pages, CSP). Exit 1 on problems.
 *   demo [--work DIR] [--port 4173] [--base /] [--site-dist DIR] [--no-serve]
 *       Seeds a throwaway store + MEDIA_DIR from fixtures/generated (real media via sharp and
 *       ffmpeg, cached in --work, default .cache/generator-demo), generates and serves it.
 *
 * Built: node backend/dist/generator/cli.js <command> …
 */
import { mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isGateMode, loadConfig } from '../config.js';
import { createLogger } from '../log.js';
import { REPO_ROOT, statePaths } from '../paths.js';
import { Store } from '../store/index.js';
import { gateHtaccessConfig } from './gate.js';
import { createGenerator } from './index.js';
import { startGatePreviewServer, startPreviewServer } from './serve.js';
import { contentLeakFacts, verifyGateTree, verifyOutDir } from './verify.js';

const USAGE = `usage: generator <generate|serve|check|demo> [options]
  generate [--full] [--dates D1,D2] [--site-dist DIR] [--now ISO] [--reason TEXT]
  serve    [--dir OUT_DIR] [--port 4173] [--host 127.0.0.1] [--base /]
  check    [--dir OUT_DIR]
  demo     [--work DIR] [--port 4173] [--base /] [--site-dist DIR] [--no-serve]`;

const abs = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

async function waitForSignal(close: () => Promise<void>): Promise<void> {
  await new Promise<void>((done) => {
    const stop = () => {
      void close().then(done);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      full: { type: 'boolean', default: false },
      dates: { type: 'string' },
      'site-dist': { type: 'string' },
      now: { type: 'string' },
      reason: { type: 'string' },
      dir: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      base: { type: 'string' },
      work: { type: 'string' },
      'no-serve': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const port = values.port ? Number.parseInt(values.port, 10) : 4173;
  const host = values.host ?? '127.0.0.1';

  switch (command) {
    case 'generate': {
      const config = loadConfig(process.env);
      const log = createLogger({ level: config.logLevel, pretty: config.env === 'development' });
      const store = Store.open(statePaths(config.dirs.data).storeDb);
      try {
        const now = values.now ? new Date(values.now) : undefined;
        if (now && Number.isNaN(now.getTime())) throw new RangeError(`Invalid --now: ${values.now}`);
        const generator = createGenerator({
          config,
          log,
          store,
          ...(now ? { now: () => now } : {}),
          ...(values['site-dist'] ? { siteDistDir: abs(values['site-dist']) } : {}),
        });
        const result = await generator.generate({
          full: values.full,
          ...(values.dates ? { dates: values.dates.split(',').map((d) => d.trim()) } : {}),
          reason: values.reason ?? 'cli',
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      } finally {
        store.close();
      }
    }
    case 'serve': {
      const config = loadConfig(process.env);
      if (isGateMode(config) && !values.dir) {
        const preview = await startGatePreviewServer({
          gateDir: config.access.gateOutDir,
          outDir: config.dirs.out,
          secret: config.access.secret,
          host,
          port,
        });
        process.stdout.write(
          `serving the gate tree at ${preview.url} and the content at ${preview.url}${config.access.secret}/ ` +
            'WITHOUT the gate (no cookie check; gate behaviour is only tested with Apache) (Ctrl+C to stop)\n',
        );
        await waitForSignal(preview.close);
        return 0;
      }
      const preview = await startPreviewServer({
        dir: values.dir ? abs(values.dir) : config.dirs.out,
        host,
        port,
        basePath: values.base ?? config.site.basePath,
      });
      process.stdout.write(`serving ${values.dir ?? config.dirs.out} at ${preview.url} (Ctrl+C to stop)\n`);
      await waitForSignal(preview.close);
      return 0;
    }
    case 'check': {
      const config = loadConfig(process.env);
      const dir = values.dir ? abs(values.dir) : config.dirs.out;
      const gate = isGateMode(config) ? gateHtaccessConfig(config.access.site, config.access.secret) : null;
      const result = await verifyOutDir(dir, { gate });
      if (gate && isGateMode(config)) {
        // The gate tree: allowed files, leak test against this content, CSP hashes, .htaccess.
        const facts = await contentLeakFacts(dir, config.access.secret);
        const g = await verifyGateTree(config.access.gateOutDir, { cfg: gate, facts });
        result.problems.push(...g.problems.map((p) => `gate tree: ${p}`));
      }
      for (const p of result.problems) process.stderr.write(`- ${p}\n`);
      process.stdout.write(
        `${result.problems.length === 0 ? 'OK' : 'INVALID'}: ${result.files} files, ${result.pages} pages, ${result.media} media (${dir})\n`,
      );
      return result.problems.length === 0 ? 0 : 1;
    }
    case 'demo': {
      const { fixturesPresent, seedFromFixtures } = await import('./dev/fixtures.js');
      if (!fixturesPresent()) throw new Error('fixtures/generated is missing: run `pnpm fixtures` first');
      const work = abs(values.work ?? join(REPO_ROOT, '.cache', 'generator-demo'));
      const basePath = values.base ?? '/';
      const dirs = { data: join(work, 'state'), media: join(work, 'media'), out: join(work, 'out') };
      rmSync(dirs.data, { recursive: true, force: true });
      rmSync(dirs.out, { recursive: true, force: true });
      for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
      const config = loadConfig({
        NODE_ENV: 'development',
        LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
        SITE_PUBLIC_URL: `http://${host}:${port}${basePath}`,
        DATA_DIR: dirs.data,
        MEDIA_DIR: dirs.media,
        OUT_DIR: dirs.out,
        ARCHIVE_DIR: join(work, 'archive'),
        CONFIG_DIR: join(work, 'config'),
      });
      const log = createLogger({ level: config.logLevel, pretty: true });
      const store = Store.open(statePaths(dirs.data).storeDb);
      try {
        const seeded = await seedFromFixtures({ store, mediaDir: dirs.media, media: 'real' });
        log.info({ ready: seeded.ready }, 'fixtures seeded');
        const generator = createGenerator({
          config,
          log,
          store,
          // The fixtures are from November 2026; evaluate "delayed" mode at a fixed time.
          now: () => new Date('2026-11-19T12:00:00Z'),
          ...(values['site-dist'] ? { siteDistDir: abs(values['site-dist']) } : {}),
        });
        const result = await generator.generate({ reason: 'demo' });
        const check = await verifyOutDir(dirs.out);
        for (const p of check.problems) process.stderr.write(`- ${p}\n`);
        process.stdout.write(
          `demo: v${result.version}, ${result.stats.days} days, ${result.stats.entries} entries, ${result.changed.length} files -> ${dirs.out}\n`,
        );
      } finally {
        store.close();
      }
      if (values['no-serve']) return 0;
      const preview = await startPreviewServer({ dir: dirs.out, host, port, basePath });
      process.stdout.write(`serving at ${preview.url} (Ctrl+C to stop)\n`);
      await waitForSignal(preview.close);
      return 0;
    }
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  },
);
