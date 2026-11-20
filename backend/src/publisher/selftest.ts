/**
 * Live self test of a publish target: deploys a 3-file synthetic site into a fresh subdirectory
 * "<remoteRoot>/omw-selftest-<random>/", checks it over HTTPS (<publicBaseUrl>omw-selftest-…/
 * data/manifest.json must show the right version), then deletes that subdirectory and confirms
 * it is gone. Nothing else on the target is touched.
 *
 * Login budget: at most `maxLogins` (default 3) connections; normally 2 (deploy, cleanup). The
 * deploy runs with maxAttempts = 1, and after an authentication failure nothing else is tried.
 * It uses a throw-away in-memory store, so the backend's deploy state is not affected.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import pino from 'pino';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { Store } from '../store/index.js';
import type { FetchLike } from './httpcheck.js';
import { type Connector, createPublisher, defaultConnector, remoteRootOf, type TargetSource } from './index.js';
import type { RemoteFs } from './remote.js';
import type { SftpRemote } from './sftp.js';
import { PublishError, type StoredTarget } from './types.js';

export const SELFTEST_DIR = /^omw-selftest-[0-9a-f]{10}$/;

export interface SelftestOptions {
  /** The target to test (its remoteRoot / dir is the parent of the test directory). */
  target: StoredTarget;
  config: Config;
  log?: Logger;
  /** Local scratch directory for the synthetic site (removed afterwards). */
  workDir: string;
  fetch?: FetchLike;
  connect?: Connector;
  /** Keep the remote test directory (debugging). */
  keep?: boolean;
  maxLogins?: number;
}

export interface SelftestStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SelftestReport {
  ok: boolean;
  dir: string;
  remotePath: string;
  url: string | null;
  version: number;
  logins: number;
  /** What the first connection reported (server capabilities). */
  connection?: { description: string; atomicReplace: boolean; hostKey: string | null };
  steps: SelftestStep[];
}

export async function runSelftest(opts: SelftestOptions): Promise<SelftestReport> {
  const log = opts.log ?? pino({ level: 'silent' });
  const connect = opts.connect ?? defaultConnector;
  const maxLogins = opts.maxLogins ?? 3;
  const dir = `omw-selftest-${randomBytes(5).toString('hex')}`;
  const version = 100_000 + Math.floor(Math.random() * 800_000);
  const base = opts.target;
  const sub: StoredTarget =
    base.kind === 'sftp'
      ? {
          ...base,
          id: 'selftest',
          remoteRoot: posix.join(base.remoteRoot, dir),
          publicBaseUrl: base.publicBaseUrl ? new URL(`${dir}/`, base.publicBaseUrl).toString() : null,
          enabled: true,
        }
      : {
          ...base,
          id: 'selftest',
          dir: join(base.dir, dir),
          publicBaseUrl: base.publicBaseUrl ? new URL(`${dir}/`, base.publicBaseUrl).toString() : null,
          enabled: true,
        };
  const remotePath = sub.kind === 'sftp' ? sub.remoteRoot : sub.dir;
  const report: SelftestReport = {
    ok: false,
    dir,
    remotePath,
    url: sub.publicBaseUrl ? new URL('data/manifest.json', sub.publicBaseUrl).toString() : null,
    version,
    logins: 0,
    steps: [],
  };
  const step = (name: string, ok: boolean, detail: string) => {
    report.steps.push({ name, ok, detail });
    log.info({ step: name, ok, detail }, 'selftest');
  };

  let authFailed = false;
  const countingConnect: Connector = async (t, hooks) => {
    if (report.logins >= maxLogins) throw new PublishError('config', `Login budget of ${maxLogins} exhausted`);
    if (authFailed) throw new PublishError('auth_blocked', 'Not logging in again after an authentication failure');
    report.logins++;
    try {
      const remote = await connect(t, hooks);
      if (!report.connection) {
        const hk = (remote as Partial<SftpRemote>).hostKey;
        report.connection = {
          description: remote.description,
          atomicReplace: remote.atomicReplace,
          hostKey: hk ? `${hk.fingerprint}${hk.type ? ` (${hk.type})` : ''}` : null,
        };
      }
      return remote;
    } catch (err) {
      if (err instanceof PublishError && err.code === 'auth') authFailed = true;
      throw err;
    }
  };

  // Synthetic 3-file site.
  const siteDir = join(opts.workDir, dir);
  mkdirSync(join(siteDir, 'data'), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(siteDir, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>omw self test</title></head><body><p>On My Way publisher self test ${dir} (${now}). This directory is removed again within seconds.</p></body></html>\n`,
  );
  writeFileSync(join(siteDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
  writeFileSync(
    join(siteDir, 'data', 'manifest.json'),
    `${JSON.stringify({ selftest: true, version, generatedAt: now })}\n`,
  );

  const store = Store.memory();
  const targets: TargetSource = {
    list: () => [sub],
    get: (id) => (id === sub.id ? sub : undefined),
    save: () => {
      throw new PublishError('config', 'read-only');
    },
    remove: () => false,
    pinHostKey: () => {},
  };
  try {
    const publisher = createPublisher({
      config: opts.config,
      log,
      store,
      targets,
      connect: countingConnect,
      hashCacheFile: null,
      maxAttempts: 1,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      httpCheck: { attempts: 3, retryDelayMs: 1500 },
    });
    const [res] = await publisher.deploy({ targetId: sub.id, outDir: siteDir, reason: 'selftest' });
    if (!res) throw new PublishError('internal', 'No deploy result');
    step(
      'deploy',
      res.ok,
      res.ok ? `${res.uploaded} files, ${res.bytes} bytes to ${remotePath}` : `${res.errorCode}: ${res.error}`,
    );
    if (res.ok && report.url) {
      step('http', res.httpCheck === 'ok', `${res.httpCheck}: ${res.httpDetail ?? ''} (${report.url})`);
    } else if (res.ok) {
      step('http', true, 'skipped: the target has no public URL');
    }

    // Cleanup: only if we ever logged in (and not after an auth failure).
    if (opts.keep) {
      step('cleanup', true, 'skipped (--keep)');
    } else if (report.logins > 0 && !authFailed) {
      let remote: RemoteFs | null = null;
      try {
        remote = await countingConnect(sub, {
          configDir: opts.config.dirs.config,
          outDir: opts.config.dirs.out,
          log,
          onTrustedFirstUse: () => {},
        });
        const root = remoteRootOf(sub);
        assertSelftestPath(root, base);
        const removed = await removeTree(remote, root);
        const gone = (await remote.stat(root)) === null;
        step('cleanup', gone, gone ? `removed ${removed} entries; ${root} is gone` : `${root} still exists`);
      } finally {
        const r = remote as RemoteFs | null;
        if (r) await r.close().catch(() => {});
      }
      if (report.url) {
        const doFetch = opts.fetch ?? fetch;
        const r = await doFetch(`${report.url}?t=${Date.now()}`, { cache: 'no-store' }).catch((e: Error) => e);
        if (r instanceof Error) step('http-gone', false, r.message);
        else {
          await r.body?.cancel().catch(() => {});
          step('http-gone', r.status === 404 || r.status === 410, `HTTP ${r.status} after cleanup`);
        }
      }
    }
  } catch (err) {
    step('error', false, (err as Error).message);
  } finally {
    store.close();
    rmSync(siteDir, { recursive: true, force: true });
  }
  report.ok = report.steps.length > 0 && report.steps.every((s) => s.ok);
  return report;
}

/** Refuses to delete anything but "<base root>/omw-selftest-<10 hex>". */
function assertSelftestPath(root: string, base: StoredTarget): void {
  const parent = base.kind === 'sftp' ? base.remoteRoot : '/';
  const ok = base.kind === 'sftp' ? posix.dirname(root) === parent : root === '/';
  if (!ok || (base.kind === 'sftp' && !SELFTEST_DIR.test(posix.basename(root)))) {
    throw new PublishError('internal', `Refusing to delete ${root}: not a self-test directory`);
  }
}

/** Deletes a remote directory tree (files, then directories). Returns the number of entries removed. */
export async function removeTree(remote: RemoteFs, dir: string): Promise<number> {
  const st = await remote.stat(dir);
  if (!st) return 0;
  if (st.type !== 'dir') throw new PublishError('internal', `${dir} is not a directory`);
  let n = 0;
  for (const e of await remote.list(dir)) {
    const p = posix.join(dir, e.name);
    if (e.type === 'dir') n += await removeTree(remote, p);
    else if (await remote.remove(p)) n++;
  }
  if (await remote.rmdir(dir)) n++;
  return n;
}
