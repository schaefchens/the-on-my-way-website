/**
 * HTTP check against a real HTTP server, the live self test (against a local folder served over
 * HTTP and against the fake SFTP server) and the CLI. Ports 19208/19209 (publisher range).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { join, normalize } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BACKEND_ROOT, REPO_ROOT } from '../../src/paths.js';
import { main } from '../../src/publisher/cli.js';
import { type Connector, checkPublishedVersion, PublishError } from '../../src/publisher/index.js';
import { runSelftest } from '../../src/publisher/selftest.js';
import { TargetStore } from '../../src/publisher/targets.js';
import { makeTempDir } from '../helpers.js';
import { FakeServer } from './fakeRemote.js';
import { localTarget, sftpTarget, silentLog, testConfig } from './helpers.js';
import { writeSite } from './site.js';

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

describe('HTTP check (real HTTP server on :19208)', () => {
  let server: Server;
  let version: unknown = 7;
  let status = 200;
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers });
      if (req.url?.startsWith('/travel/data/manifest.json')) {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(typeof version === 'string' ? version : JSON.stringify({ version }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await listen(server, 19208);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    seen.length = 0;
    status = 200;
    version = 7;
  });

  const url = 'http://127.0.0.1:19208/travel/';
  const opts = { attempts: 2, retryDelayMs: 1, now: () => new Date('2026-11-19T10:00:00.000Z') };

  it('ok when the public manifest has the deployed version; cache-busting query + no-cache', async () => {
    expect(await checkPublishedVersion(url, 7, opts)).toMatchObject({ status: 'ok', detail: 'version 7' });
    expect(seen[0]?.url).toBe(`/travel/data/manifest.json?t=${Date.parse('2026-11-19T10:00:00.000Z')}`);
    expect(seen[0]?.headers['cache-control']).toBe('no-cache');
  });

  it('mismatch, HTTP errors, non-JSON, unreachable, skipped', async () => {
    expect(await checkPublishedVersion(url, 8, opts)).toMatchObject({
      status: 'mismatch',
      detail: 'expected version 8, got 7',
    });
    expect(seen).toHaveLength(2); // retried once
    status = 500;
    expect(await checkPublishedVersion(url, 7, opts)).toMatchObject({ status: 'error', detail: 'HTTP 500' });
    status = 200;
    version = '<html>';
    expect(await checkPublishedVersion(url, 7, opts)).toMatchObject({
      status: 'error',
      detail: 'response is not JSON',
    });
    expect(await checkPublishedVersion('http://127.0.0.1:19207/', 7, { ...opts, attempts: 1 })).toMatchObject({
      status: 'error',
    });
    expect(await checkPublishedVersion(null, 7)).toMatchObject({ status: 'skipped' });
    expect(await checkPublishedVersion(url, null)).toMatchObject({ status: 'skipped' });
  });
});

describe('self test', () => {
  let tmp: ReturnType<typeof makeTempDir>;
  let http: Server | null = null;
  beforeEach(() => {
    tmp = makeTempDir('publisher-selftest-');
  });
  afterEach(async () => {
    const h = http;
    http = null;
    if (h) await new Promise<void>((r) => h.close(() => r()));
    tmp.cleanup();
  });

  it('local target served over HTTP: deploy, verify, remove, confirm gone (2 logins)', async () => {
    const www = join(tmp.dir, 'www');
    http = createServer((req, res) => {
      const p = normalize(decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/'));
      const file = join(www, p);
      if (!file.startsWith(www) || !existsSync(file) || p.endsWith('/')) {
        res.statusCode = 404;
        return res.end();
      }
      res.end(readFileSync(file));
    });
    await listen(http, 19209);
    writeFileSync(join(tmp.dir, 'keep.txt'), 'x');
    const report = await runSelftest({
      target: localTarget('www', www, { publicBaseUrl: 'http://127.0.0.1:19209/' }),
      config: testConfig(tmp.dir),
      log: silentLog,
      workDir: join(tmp.dir, 'work'),
    });
    expect(report.steps.map((s) => [s.name, s.ok])).toEqual([
      ['deploy', true],
      ['http', true],
      ['cleanup', true],
      ['http-gone', true],
    ]);
    expect(report).toMatchObject({ ok: true, logins: 2 });
    expect(report.dir).toMatch(/^omw-selftest-[0-9a-f]{10}$/);
    expect(existsSync(join(www, report.dir))).toBe(false);
    expect(existsSync(join(tmp.dir, 'work', report.dir))).toBe(false);
  });

  it('sftp target: works only inside <root>/omw-selftest-*/ and leaves everything else alone', async () => {
    const server = new FakeServer({ atomicReplace: false });
    server.dirs.add('/www');
    server.files.set('/www/index.html', Buffer.from('live site'));
    const connect: Connector = async () => server.connect();
    const fetch = async (url: string) => {
      const path = new URL(url).pathname.replace(/^\/site/, '/www');
      const body = server.files.get(path);
      // A copy (Uint8Array<ArrayBuffer>) is a valid body under both Node's and DOM's BodyInit.
      return body ? new Response(new Uint8Array(body)) : new Response('nope', { status: 404 });
    };
    const report = await runSelftest({
      target: sftpTarget('live', { remoteRoot: '/www', publicBaseUrl: 'https://example.test/site/' }),
      config: testConfig(tmp.dir),
      log: silentLog,
      workDir: join(tmp.dir, 'work'),
      connect,
      fetch,
    });
    expect(report).toMatchObject({ ok: true, logins: 2 });
    expect(report.connection).toEqual({ description: 'fake://', atomicReplace: false, hostKey: null });
    expect(report.url).toBe(`https://example.test/site/${report.dir}/data/manifest.json`);
    expect([...server.files.keys()]).toEqual(['/www/index.html']);
    expect([...server.dirs].sort()).toEqual(['/', '/www']);
    const touched = server.log.filter((l) => !l.includes(`/www/${report.dir}`));
    expect(touched).toEqual([]);
  });

  it('after an authentication failure it stops: no cleanup login, no retry', async () => {
    let calls = 0;
    const connect: Connector = async () => {
      calls++;
      throw new PublishError('auth', 'SSH authentication failed (test)');
    };
    const report = await runSelftest({
      target: sftpTarget('live'),
      config: testConfig(tmp.dir),
      log: silentLog,
      workDir: join(tmp.dir, 'work'),
      connect,
    });
    expect(report).toMatchObject({ ok: false, logins: 1 });
    expect(calls).toBe(1);
    expect(report.steps).toEqual([{ name: 'deploy', ok: false, detail: 'auth: SSH authentication failed (test)' }]);
  });
});

describe('CLI', () => {
  let tmp: ReturnType<typeof makeTempDir>;
  let env: Record<string, string>;
  let out: string[];
  let err: string[];
  const io = () => ({ out: (l: string) => out.push(l), err: (l: string) => err.push(l), env });

  beforeEach(() => {
    tmp = makeTempDir('publisher-cli-');
    env = {
      NODE_ENV: 'test',
      WA_MODE: 'fixture',
      DATA_DIR: join(tmp.dir, 'state'),
      ARCHIVE_DIR: join(tmp.dir, 'archive'),
      OUT_DIR: join(tmp.dir, 'out'),
      CONFIG_DIR: join(tmp.dir, 'config'),
      MEDIA_DIR: join(tmp.dir, 'media'),
    };
    out = [];
    err = [];
  });
  afterEach(() => tmp.cleanup());

  it('loads under plain Node ESM + tsx (CommonJS named exports are not transformed there)', () => {
    const r = spawnSync(
      process.execPath,
      ['--conditions=@omw/source', '--import', 'tsx', join(BACKEND_ROOT, 'src', 'publisher', 'cli.ts'), '--help'],
      { cwd: REPO_ROOT, env: { ...process.env, TSX_DISABLE_CACHE: '1' }, encoding: 'utf8', timeout: 60_000 },
    );
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: publisher');
  });

  it('usage errors exit 2, --help exits 0', async () => {
    expect(await main([], io())).toBe(2);
    expect(await main(['--help'], io())).toBe(0);
    expect(out.join('\n')).toContain('Usage: publisher');
    expect(await main(['bogus'], io())).toBe(2);
    expect(await main(['deploy', '--nope'], io())).toBe(2);
    expect(await main(['test'], io())).toBe(2);
  });

  it('list bootstraps the env target from --env-file (literal parsing) and never prints secrets', async () => {
    const envFile = join(tmp.dir, 'test.env');
    const secret = 'p@ss"$(rm -rf /)`#';
    writeFileSync(
      envFile,
      `SITE_BASE_URL=https://site.example.test/\nSFTP_HOST=sftp.example.test\nSFTP_USER=deploy\nSFTP_PASSWORD='${secret}'\nSFTP_HOST_FINGERPRINT=SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n`,
    );
    expect(await main(['list', '--env-file', envFile], io())).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('sftp-main  sftp://deploy@sftp.example.test:22/ (auth: password, host keys: 1)');
    expect(text).not.toContain(secret);
    out = [];
    expect(await main(['list', '--json'], io())).toBe(0);
    expect(JSON.parse(out.join('\n'))[0]).toMatchObject({ id: 'sftp-main', hasPassword: true });
    expect(out.join('\n')).not.toContain(secret);
    expect(JSON.parse(readFileSync(join(tmp.dir, 'config', 'targets.json'), 'utf8')).targets[0].password).toBe(secret);
  });

  it('test, deploy --dry-run and deploy a local target', async () => {
    new TargetStore({
      file: join(tmp.dir, 'config', 'targets.json'),
      configDir: join(tmp.dir, 'config'),
      baseDir: tmp.dir,
      outDir: join(tmp.dir, 'out'),
      env: {},
      log: silentLog,
      now: () => new Date(),
    }).save({ id: 'www', kind: 'local', dir: join(tmp.dir, 'www') });
    const files = writeSite(join(tmp.dir, 'out'), { version: 4, build: 'b', days: { '2026-11-18': ['a'] } });

    expect(await main(['test', 'www'], io())).toBe(0);
    expect(out.pop()).toMatch(/^OK: Connected to file:\/\/.*remote root \/ is writable; atomic replace: yes$/);

    expect(await main(['deploy', 'www', '--dry-run', '--offline'], io())).toBe(0);
    expect(out.join('\n')).toContain(`upload ${files.size} file(s)`);
    expect(out.join('\n')).toContain('deployed state UNKNOWN');
    out = [];

    expect(await main(['deploy', '--json'], io())).toBe(0);
    const [r] = JSON.parse(out.join('\n'));
    expect(r).toMatchObject({ targetId: 'www', ok: true, version: 4, uploaded: files.size, httpCheck: 'skipped' });
    out = [];
    expect(await main(['deploy', 'www'], io())).toBe(0);
    expect(out[0]).toMatch(/^www: OK version 4; uploaded 0 \(0 B\), deleted 0/);
    out = [];
    expect(await main(['deploy', 'nope'], io())).toBe(1);
    expect(out.join('\n')).toContain('Unknown publish target: nope');
    expect(readFileSync(join(tmp.dir, 'www', 'data', 'manifest.json'), 'utf8')).toBe(files.get('data/manifest.json'));
  });
});
