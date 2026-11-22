/**
 * Local Apache harness for the gate tests (spec-wave5 §8.2): finds an Apache binary and its
 * module directory, writes an httpd.conf (prefork, rewrite, headers, dir, mime, env, setenvif,
 * authz; AllowOverride All; <Files ".ht*"> denied) for a free port on 127.0.0.1, a docroot under
 * .cache/apache-test/<run>/ and the session-file store on a CASE-SENSITIVE volume (Linux: any
 * directory; macOS: a small "Case-sensitive APFS" disk image attached inside the run directory,
 * because the default volume would accept a session id with flipped case), and starts/stops
 * `httpd -f <conf> -k start|stop`. 127.0.0.1 only; nothing leaves the machine.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { delimiter, join } from 'node:path';
import { REPO_ROOT } from '../../src/paths.js';

export interface ApacheBinary {
  bin: string;
  modules: string;
}

const MODULE_DIRS = ['/usr/libexec/apache2', '/usr/lib/apache2/modules', '/usr/lib64/httpd/modules'];
const MODULES = [
  ['mpm_prefork_module', 'mod_mpm_prefork.so'],
  ['authz_core_module', 'mod_authz_core.so'],
  ['authz_host_module', 'mod_authz_host.so'],
  ['unixd_module', 'mod_unixd.so'],
  ['dir_module', 'mod_dir.so'],
  ['mime_module', 'mod_mime.so'],
  ['rewrite_module', 'mod_rewrite.so'],
  ['headers_module', 'mod_headers.so'],
  ['log_config_module', 'mod_log_config.so'],
  ['env_module', 'mod_env.so'],
  ['setenvif_module', 'mod_setenvif.so'],
  ['filter_module', 'mod_filter.so'],
] as const;

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(dir, name);
    if (dir && existsSync(p)) return p;
  }
  return null;
}

/** An Apache binary (OMW_HTTPD, /usr/sbin/httpd, httpd or apache2 on PATH) with its modules, or null. */
export function findApache(): ApacheBinary | null {
  const bin = [process.env.OMW_HTTPD, '/usr/sbin/httpd', onPath('httpd'), onPath('apache2'), '/usr/sbin/apache2'].find(
    (b): b is string => !!b && existsSync(b),
  );
  const modules = MODULE_DIRS.find(
    (d) => existsSync(join(d, 'mod_rewrite.so')) && existsSync(join(d, 'mod_headers.so')),
  );
  if (!bin || !modules) return null;
  if (!existsSync(join(modules, 'mod_mpm_prefork.so'))) return null;
  return { bin, modules };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface ApacheRun {
  /** Run directory (.cache/apache-test/<run>). */
  dir: string;
  /** The docroot (site account's web root). */
  docroot: string;
  /** The store (on a case-sensitive volume when `caseSensitive`). */
  store: string;
  caseSensitive: boolean;
  port: number;
  base: string;
  stop(): Promise<void>;
  errorLog(): string;
}

export interface HttpAnswer {
  status: number;
  headers: Record<string, string | string[]>;
  /** Header lines in order (lowercased names), minus Date/Connection/Keep-Alive/Server. */
  lines: string[];
  body: Buffer;
  setCookies: string[];
}

/** One raw HTTP request (path sent exactly as given: no normalisation of dot segments). */
export function http(
  run: Pick<ApacheRun, 'port'>,
  path: string,
  opts: { cookie?: string; method?: string } = {},
): Promise<HttpAnswer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: run.port,
        path,
        method: opts.method ?? 'GET',
        headers: { ...(opts.cookie !== undefined ? { cookie: opts.cookie } : {}), connection: 'close' },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const lines: string[] = [];
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            const name = (res.rawHeaders[i] ?? '').toLowerCase();
            if (['date', 'connection', 'keep-alive', 'server'].includes(name)) continue;
            lines.push(`${name}: ${res.rawHeaders[i + 1] ?? ''}`);
          }
          const sc = res.headers['set-cookie'];
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[]>,
            lines,
            body: Buffer.concat(chunks),
            setCookies: Array.isArray(sc) ? sc : sc ? [sc] : [],
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function httpdConf(apache: ApacheBinary, run: { dir: string; docroot: string; port: number }): string {
  return [
    `ServerRoot "${run.dir}"`,
    'ServerName 127.0.0.1',
    `Listen 127.0.0.1:${run.port}`,
    ...MODULES.map(([name, file]) => `LoadModule ${name} ${join(apache.modules, file)}`),
    `PidFile ${join(run.dir, 'logs', 'httpd.pid')}`,
    `ErrorLog ${join(run.dir, 'logs', 'error.log')}`,
    'LogLevel warn',
    'LogFormat "%r %>s" short',
    `CustomLog ${join(run.dir, 'logs', 'access.log')} short`,
    'StartServers 2',
    'MinSpareServers 1',
    'MaxSpareServers 3',
    `DocumentRoot "${run.docroot}"`,
    `<Directory "${run.docroot}">`,
    '  AllowOverride All',
    '  Options FollowSymLinks',
    '  Require all granted',
    '</Directory>',
    '<Files ".ht*">',
    '  Require all denied',
    '</Files>',
    `TypesConfig ${join(run.dir, 'mime.types')}`,
    'AddType text/html .html',
    'AddType text/plain .txt',
    'AddType text/css .css',
    'AddType image/svg+xml .svg',
    'AddType application/gzip .gz',
    '',
  ].join('\n');
}

async function waitFor(check: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function attachCaseSensitiveVolume(dir: string, store: string): boolean {
  if (process.platform === 'linux') return true;
  if (process.platform !== 'darwin') return false;
  try {
    const image = join(dir, 'store.dmg');
    execFileSync('hdiutil', ['create', '-size', '16m', '-fs', 'Case-sensitive APFS', '-volname', 'omwstore', image], {
      stdio: 'ignore',
    });
    execFileSync('hdiutil', ['attach', '-nobrowse', '-noverify', '-noautoopen', '-mountpoint', store, image], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** Starts Apache for one test file; `prepare` fills the docroot before the first request. */
export async function startApache(apache: ApacheBinary, label: string): Promise<ApacheRun> {
  const dir = join(REPO_ROOT, '.cache', 'apache-test', `${label}-${process.pid}-${Date.now().toString(36)}`);
  const docroot = join(dir, 'www');
  const store = join(dir, 'store');
  for (const d of [docroot, store, join(dir, 'logs')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(dir, 'mime.types'), '');
  const caseSensitive = attachCaseSensitiveVolume(dir, store);
  const port = await freePort();
  const conf = join(dir, 'httpd.conf');
  writeFileSync(conf, httpdConf(apache, { dir, docroot, port }));
  execFileSync(apache.bin, ['-f', conf, '-k', 'start'], { stdio: 'ignore' });
  const run: ApacheRun = {
    dir,
    docroot,
    store,
    caseSensitive,
    port,
    base: `http://127.0.0.1:${port}`,
    errorLog: () => {
      try {
        return readFileSync(join(dir, 'logs', 'error.log'), 'utf8');
      } catch {
        return '';
      }
    },
    stop: async () => {
      try {
        execFileSync(apache.bin, ['-f', conf, '-k', 'stop'], { stdio: 'ignore' });
      } catch {
        // already gone
      }
      const pidFile = join(dir, 'logs', 'httpd.pid');
      await waitFor(async () => !existsSync(pidFile), 'httpd to stop').catch(() => undefined);
      if (process.platform === 'darwin' && caseSensitive) {
        try {
          execFileSync('hdiutil', ['detach', store, '-force'], { stdio: 'ignore' });
        } catch {
          // detached already
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  try {
    await waitFor(
      async () =>
        http(run, '/robots.txt')
          .then(() => true)
          .catch(() => false),
      'httpd to answer',
    );
  } catch (err) {
    await run.stop();
    throw err;
  }
  return run;
}
