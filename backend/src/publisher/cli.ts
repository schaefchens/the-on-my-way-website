/**
 * Publisher CLI.
 *
 *   node --conditions=@omw/source --import tsx backend/src/publisher/cli.ts <command> [options]
 *   (with TSX_DISABLE_CACHE=1; from dist: node backend/dist/publisher/cli.js …)
 *
 * Commands:
 *   list                                  publish targets (no secrets) and their last deploy
 *   test <target> [--force]               log in, check the remote root is writable
 *   deploy [<target>] [--out DIR] [--full] [--dry-run [--offline]]
 *                                         deploy OUT_DIR (all enabled targets without <target>)
 *   selftest [<target>] [--keep]          live smoke test in <root>/omw-selftest-<random>/
 *                                         (without <target>: the SFTP_* target from the env,
 *                                         not persisted)
 * Options:
 *   --env-file PATH   read KEY=value lines literally (never shell-sourced); real env wins
 *   --json            machine-readable output
 *   --verbose         log progress to stderr
 *
 * Exit codes: 0 success, 1 failure, 2 usage error.
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pino from 'pino';
import { loadConfig } from '../config.js';
import { BACKEND_ROOT, REPO_ROOT, statePaths } from '../paths.js';
import { Store } from '../store/index.js';
import { mergeEnv, readDotenvFile } from './dotenv.js';
import { createPublisher } from './index.js';
import { runSelftest } from './selftest.js';
import { bootstrapTargetFromEnv, TARGETS_FILE, TargetStore } from './targets.js';
import type { DeployResult, PlanSummary, PublishTargetPublic, StoredTarget } from './types.js';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
}

const USAGE = `Usage: publisher <command> [options]
  list                                   list publish targets (no secrets)
  test <target> [--force]                log in and check that the remote root is writable
  deploy [<target>] [--out DIR] [--full] [--dry-run [--offline]]
  selftest [<target>] [--keep]           live smoke test in <root>/omw-selftest-<random>/
Options: --env-file PATH  --json  --verbose  --help`;

export async function main(argv: string[], io: CliIo): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (err) {
    io.err(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, targetArg, ...rest] = positionals;
  if (values.help || !command) {
    io.out(USAGE);
    return command || values.help ? 0 : 2;
  }
  if (rest.length > 0) {
    io.err(`Unexpected arguments: ${rest.join(' ')}\n${USAGE}`);
    return 2;
  }

  let env = io.env;
  if (values['env-file']) {
    try {
      env = mergeEnv(readDotenvFile(resolve(values['env-file'])), io.env);
    } catch (err) {
      io.err(`Cannot read ${values['env-file']}: ${(err as Error).message}`);
      return 1;
    }
  }
  const config = loadConfig(env);
  const log = pino({ level: values.verbose ? 'info' : 'warn', name: 'publisher' }, pino.destination(2));
  const json = values.json === true;

  if (command === 'selftest') {
    // A stored target (secrets included) or the SFTP_* env target, which is NOT persisted here.
    let chosen: StoredTarget | null | undefined;
    try {
      chosen = targetArg
        ? new TargetStore({
            file: join(config.dirs.config, TARGETS_FILE),
            configDir: config.dirs.config,
            baseDir: BACKEND_ROOT,
            outDir: config.dirs.out,
            env: {},
            log,
            now: () => new Date(),
          }).get(targetArg)
        : bootstrapTargetFromEnv(env, new Date());
    } catch (err) {
      io.err((err as Error).message);
      return 1;
    }
    if (!chosen) {
      io.err(targetArg ? `Unknown publish target: ${targetArg}` : 'No SFTP_HOST/SFTP_* target in the environment');
      return 1;
    }
    const workDir = join(REPO_ROOT, '.cache', 'tmp', 'publisher-selftest');
    mkdirSync(workDir, { recursive: true });
    const report = await runSelftest({ target: chosen, config, log, workDir, keep: values.keep === true });
    if (json) io.out(JSON.stringify(report, null, 2));
    else {
      io.out(`self test ${report.ok ? 'PASSED' : 'FAILED'}: ${report.remotePath} (${report.logins} login(s))`);
      if (report.connection) {
        const c = report.connection;
        io.out(
          `  ${c.description}${c.hostKey ? `, host key ${c.hostKey}` : ''}, atomic replace: ${c.atomicReplace ? 'yes (posix-rename)' : 'no (delete + rename fallback)'}`,
        );
      }
      for (const s of report.steps) io.out(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.name}: ${s.detail}`);
    }
    return report.ok ? 0 : 1;
  }

  const store = Store.open(statePaths(config.dirs.data).storeDb);
  try {
    const publisher = createPublisher({ config, log, store, env });
    switch (command) {
      case 'list': {
        const targets = publisher.listTargets();
        if (json) io.out(JSON.stringify(targets, null, 2));
        else if (targets.length === 0) io.out('No publish targets configured.');
        else for (const t of targets) io.out(describeTarget(t));
        return 0;
      }
      case 'test': {
        if (!targetArg) {
          io.err(`test needs a target id\n${USAGE}`);
          return 2;
        }
        const r = await publisher.testTarget(targetArg, { force: values.force === true });
        if (json) io.out(JSON.stringify(r, null, 2));
        else io.out(`${r.ok ? 'OK' : 'FAILED'}: ${r.detail}`);
        return r.ok ? 0 : 1;
      }
      case 'deploy': {
        const outDir = values.out ? resolve(values.out) : undefined;
        if (values['dry-run']) {
          const plans = await publisher.plan({
            ...(targetArg ? { targetId: targetArg } : {}),
            ...(outDir ? { outDir } : {}),
            ...(values.full ? { full: true } : {}),
            ...(values.offline ? { offline: true } : {}),
          });
          if (json) io.out(JSON.stringify(plans, null, 2));
          else if (plans.length === 0) io.out('No enabled publish targets.');
          else for (const p of plans) io.out(describePlan(p));
          return 0;
        }
        const results = await publisher.deploy({
          ...(targetArg ? { targetId: targetArg } : {}),
          ...(outDir ? { outDir } : {}),
          ...(values.full ? { full: true } : {}),
          reason: 'cli',
        });
        if (json) io.out(JSON.stringify(results, null, 2));
        else if (results.length === 0) io.out('No enabled publish targets.');
        else for (const r of results) io.out(describeResult(r));
        return results.length > 0 && results.every((r) => r.ok) ? 0 : 1;
      }
      default:
        io.err(`Unknown command: ${command}\n${USAGE}`);
        return 2;
    }
  } finally {
    store.close();
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      'env-file': { type: 'string' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean' },
      offline: { type: 'boolean' },
      full: { type: 'boolean' },
      force: { type: 'boolean' },
      keep: { type: 'boolean' },
      json: { type: 'boolean' },
      verbose: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

function describeTarget(t: PublishTargetPublic): string {
  const where =
    t.kind === 'sftp'
      ? `sftp://${t.username}@${t.host}:${t.port}${t.remoteRoot} (auth: ${t.auth}, host keys: ${t.hostKeys.length}${t.trustOnFirstUse ? ', TOFU' : ''})`
      : `local ${t.dir}`;
  const last = t.status.lastDeploy;
  const lastLine = last
    ? `last deploy ${last.at ?? '?'}: ${last.ok ? 'ok' : `FAILED (${last.error ?? ''})`}, version ${last.version ?? '-'}, http ${last.httpCheck}`
    : 'never deployed';
  const blocked = t.status.authBlocked ? `\n    LOGIN BLOCKED since ${t.status.authBlocked.at}` : '';
  return `${t.id}${t.enabled ? '' : ' (disabled)'}  ${where}\n    url: ${t.publicBaseUrl ?? '-'}; ${lastLine}${blocked}`;
}

function describePlan(p: PlanSummary): string {
  const lines = [
    `${p.targetId}: version ${p.version ?? '-'}; ${p.remoteKnown ? 'deployed state known' : 'deployed state UNKNOWN (upload all, delete only known-obsolete)'}`,
    `  upload ${p.uploads.length} file(s), ${p.uploadBytes} bytes; unchanged ${p.unchanged}; delete ${p.deletes.length}; deferred ${p.deferred.length}`,
  ];
  if (p.refusal) lines.push(`  a deploy would be REFUSED: ${p.refusal}`);
  const show = <T>(label: string, items: T[], fmt: (x: T) => string) => {
    for (const x of items.slice(0, 50)) lines.push(`  ${label} ${fmt(x)}`);
    if (items.length > 50) lines.push(`  … ${items.length - 50} more`);
  };
  show('+', p.uploads, (u) => `${u.path} [${u.phase}, ${u.reason}, ${u.size} B]`);
  show('-', p.deletes, (d) => d);
  show('~', p.deferred, (d) => `${d.path} (obsolete since ${d.since}, due ${d.dueAt})`);
  if (p.skipped.length) lines.push(`  skipped (unsupported names): ${p.skipped.join(', ')}`);
  return lines.join('\n');
}

function describeResult(r: DeployResult): string {
  const head = `${r.targetId}: ${r.ok ? 'OK' : 'FAILED'} version ${r.version ?? '-'}; uploaded ${r.uploaded} (${r.bytes} B), deleted ${r.deleted}, unchanged ${r.unchanged ?? '-'}, deferred ${r.deferred ?? 0}; http ${r.httpCheck}${r.httpDetail ? ` (${r.httpDetail})` : ''}; ${r.durationMs} ms, ${r.connections ?? 0} login(s)`;
  return r.error ? `${head}\n  error [${r.errorCode ?? 'error'}]: ${r.error}` : head;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2), {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    env: process.env,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exitCode = 1;
    },
  );
}
