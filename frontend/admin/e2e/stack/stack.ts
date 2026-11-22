/**
 * The whole local stack for the end-to-end owner flow, started from scratch in .cache/e2e-stack:
 *
 *   PHP API     php -S 127.0.0.1:8080 (api/public/index.php as router), fresh database in its own
 *               VAR_DIR, APP_ENV=development + DEV_INSECURE_COOKIE=true (the http dev session
 *               cookie, see api/src/Http/SessionCookie.php), admin user + backend token created
 *               with api/bin/*.php; serves the BUILT admin from api/public/admin
 *   backend     backend/src/cli.ts start (tsx): WA_MODE=fixture, API_BASE_URL = the PHP API,
 *               control UI on 127.0.0.1:8787, one `local` publish target (the "static host")
 *   static host the generator's preview server on 127.0.0.1:4173 serving the published folder
 *
 * Credentials (admin password, backend token, control token) are random per run, kept in memory
 * and in <root>/secrets (mode 600); they are never printed. Every child runs in its own process
 * group and is stopped with SIGTERM (SIGKILL after 15 s).
 *
 * Gate mode (`gate` option, spec-wave5 §8.7): the backend runs with ACCESS_MODE=gate and publishes
 * the gate tree to <root>/site and the content tree to <root>/site/<secret>; a local Apache
 * (macOS /usr/sbin/httpd or httpd/apache2 on PATH, 127.0.0.1 only) serves <root>/site with the
 * generated .htaccess files instead of the preview server; the session-file store is
 * <root>/store, written by the API (`direct`) or by the backend's fallback writer (`none`, the
 * local target's accessStoreDir). http on loopback → cookie names omw, omw_k, … without Secure.
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

export const REPO = resolve(import.meta.dirname, '../../../..');
const API_DIR = join(REPO, 'api');

export interface GateOptions {
  /** Who writes the session-file store: the API itself (`direct`) or the backend (`none`). */
  storeMode: 'direct' | 'none';
  /** The content folder ([a-z0-9]{20}); random per run when absent. */
  secret?: string;
}

export interface StackOptions {
  root?: string;
  apiPort?: number;
  controlPort?: number;
  sitePort?: number;
  gate?: GateOptions;
}

/** An Apache binary with the modules the gate needs, or null (gate stacks are skipped then). */
export function findApache(): { bin: string; modules: string } | null {
  const onPath = (name: string) =>
    (process.env.PATH ?? '')
      .split(delimiter)
      .map((d) => join(d, name))
      .find((p) => existsSync(p)) ?? null;
  const bin = [process.env.OMW_HTTPD, '/usr/sbin/httpd', onPath('httpd'), onPath('apache2')].find(
    (b): b is string => !!b && existsSync(b),
  );
  const modules = ['/usr/libexec/apache2', '/usr/lib/apache2/modules', '/usr/lib64/httpd/modules'].find(
    (d) => existsSync(join(d, 'mod_rewrite.so')) && existsSync(join(d, 'mod_headers.so')),
  );
  if (!bin || !modules || !existsSync(join(modules, 'mod_mpm_prefork.so'))) return null;
  return { bin, modules };
}

const APACHE_MODULES = [
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

export interface AdminCredentials {
  email: string;
  password: string;
}

function token(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Polls `probe` until it returns true (errors count as false). */
export async function waitFor(what: string, probe: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < until) {
    try {
      if (await probe()) return;
    } catch (err) {
      last = err;
    }
    await sleep(250);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`);
}

export class Stack {
  readonly root: string;
  readonly apiPort: number;
  readonly controlPort: number;
  readonly sitePort: number;
  readonly dirs: {
    apiVar: string;
    state: string;
    archive: string;
    out: string;
    outGate: string;
    config: string;
    media: string;
    site: string;
    store: string;
    apache: string;
    logs: string;
    secrets: string;
  };
  readonly gate: (GateOptions & { secret: string }) | null;
  admin: AdminCredentials = { email: 'owner@example.org', password: '' };
  private backendToken = '';
  private controlToken = '';
  private readonly procs = new Map<'api' | 'backend' | 'static', ChildProcess>();
  private apacheConf: string | null = null;

  constructor(opts: StackOptions = {}) {
    this.root = opts.root ?? join(REPO, '.cache/e2e-stack');
    this.apiPort = opts.apiPort ?? 8080;
    this.controlPort = opts.controlPort ?? 8787;
    this.sitePort = opts.sitePort ?? 4173;
    this.gate = opts.gate
      ? { ...opts.gate, secret: opts.gate.secret ?? randomBytes(20).toString('hex').slice(0, 20) }
      : null;
    if (this.gate && !/^[a-z0-9]{20}$/.test(this.gate.secret)) throw new Error('gate secret must be [a-z0-9]{20}');
    const r = this.root;
    this.dirs = {
      apiVar: join(r, 'api-var'),
      state: join(r, 'state'),
      archive: join(r, 'archive'),
      out: join(r, 'out'),
      outGate: join(r, 'out-gate'),
      config: join(r, 'config'),
      media: join(r, 'media'),
      site: join(r, 'site'),
      store: join(r, 'store'),
      apache: join(r, 'apache'),
      logs: join(r, 'logs'),
      secrets: join(r, 'secrets'),
    };
  }

  /** The content folder of the gate tree ("" in open mode). */
  get secret(): string {
    return this.gate?.secret ?? '';
  }

  /** Where the content (the SPA) lives on the site host: "/<secret>/" in gate mode, "/" otherwise. */
  get contentPath(): string {
    return this.gate ? `/${this.gate.secret}/` : '/';
  }

  get apiUrl(): string {
    return `http://127.0.0.1:${this.apiPort}`;
  }

  get siteUrl(): string {
    return `http://127.0.0.1:${this.sitePort}`;
  }

  get controlUrl(): string {
    return `http://127.0.0.1:${this.controlPort}`;
  }

  /** Fresh directories, database, admin user, backend token and publish target. */
  prepare(): void {
    if (!existsSync(join(API_DIR, 'public/admin/index.html'))) {
      throw new Error('api/public/admin is not built: run `pnpm --filter @omw/admin build` first');
    }
    if (this.gate && !existsSync(join(REPO, 'frontend/site/dist/gate/.vite/manifest.json'))) {
      throw new Error('the gate bundle is not built: run `pnpm --filter @omw/site build` first');
    }
    rmSync(this.root, { recursive: true, force: true });
    for (const d of Object.values(this.dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });
    // Apache (running as this user) only needs to traverse the store: 0711 like the live host.
    if (this.gate) execFileSync('chmod', ['0711', this.root, this.dirs.store]);

    this.admin = { email: 'owner@example.org', password: token(18) };
    this.controlToken = token();
    this.php(['bin/migrate.php']);
    this.php(
      ['bin/create-admin.php', `--email=${this.admin.email}`, '--name=Lena', '--password-stdin'],
      this.admin.password,
    );
    this.backendToken = this.php(['bin/create-token.php', '--kind=backend', '--name=e2e-stack']).trim();
    if (!/^omw_[A-Za-z0-9_-]{20,}$/.test(this.backendToken)) throw new Error('create-token did not print a token');

    const secret = (name: string, value: string) =>
      writeFileSync(join(this.dirs.secrets, name), `${value}\n`, { mode: 0o600 });
    secret('admin.txt', `email=${this.admin.email}\npassword=${this.admin.password}`);
    secret('backend-token', this.backendToken);
    secret('control-token', this.controlToken);

    this.writeTargets(this.dirs.store);
  }

  /**
   * CONFIG_DIR/targets.json: one local target. Gate mode: content at <site>/<secret>, the gate tree
   * at <site>, and the store as this machine sees it (`accessStoreDir`, used by the fallback writer).
   */
  writeTargets(accessStoreDir: string): void {
    const now = new Date().toISOString();
    const target = this.gate
      ? {
          id: 'local-e2e',
          kind: 'local',
          enabled: true,
          publicBaseUrl: `${this.siteUrl}${this.contentPath}`,
          dir: join(this.dirs.site, this.gate.secret),
          gateDir: this.dirs.site,
          accessStoreDir,
          createdAt: now,
          updatedAt: now,
        }
      : {
          id: 'local-e2e',
          kind: 'local',
          enabled: true,
          publicBaseUrl: `${this.siteUrl}/`,
          dir: this.dirs.site,
          createdAt: now,
          updatedAt: now,
        };
    writeFileSync(join(this.dirs.config, 'targets.json'), JSON.stringify({ format: 1, targets: [target] }, null, 2), {
      mode: 0o600,
    });
  }

  private apiEnv(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: join(REPO, '.cache/home'),
      TMPDIR: join(REPO, '.cache/tmp'),
      APP_ENV: 'development',
      DEV_INSECURE_COOKIE: 'true',
      APP_DEBUG: 'true',
      VAR_DIR: this.dirs.apiVar,
      DB_PATH: join(this.dirs.apiVar, 'app.sqlite'),
      LOG_PATH: join(this.dirs.apiVar, 'logs/app.log'),
      LOG_LEVEL: 'info',
      SITE_ORIGIN: this.siteUrl,
      MAIL_DSN: '',
      ...(this.gate?.storeMode === 'direct'
        ? { ACCESS_STORE_MODE: 'direct', ACCESS_STORE_DIR: this.dirs.store }
        : this.gate
          ? { ACCESS_STORE_MODE: 'none' }
          : {}),
    };
  }

  /** `php bin/cron.php` with the API's environment (every job, or `only`); returns stdout. */
  cron(only?: string[]): string {
    return this.php(['bin/cron.php', ...(only ? [`--only=${only.join(',')}`] : [])]);
  }

  /** Runs an api/bin script; returns stdout. Input goes to stdin (never on the command line). */
  private php(args: string[], input?: string): string {
    const r = spawnSync('php', args, { cwd: API_DIR, env: this.apiEnv(), input: input ?? '', encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`php ${args[0]} failed (${r.status}): ${r.stderr.trim()}`);
    return r.stdout;
  }

  private start(name: 'api' | 'backend' | 'static', cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd = REPO) {
    if (this.procs.has(name)) throw new Error(`${name} already running`);
    const log = createWriteStream(join(this.dirs.logs, `${name}.log`), { flags: 'a' });
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    child.on('exit', () => this.procs.delete(name));
    this.procs.set(name, child);
  }

  private async stop(name: 'api' | 'backend' | 'static'): Promise<void> {
    const child = this.procs.get(name);
    if (!child?.pid || child.exitCode !== null) {
      this.procs.delete(name);
      return;
    }
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    const killed = await Promise.race([exited.then(() => true), sleep(15_000).then(() => false)]);
    if (!killed) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      await exited;
    }
    this.procs.delete(name);
  }

  async startApi(): Promise<void> {
    // PHP_CLI_SERVER_WORKERS: the admin, the backend's sync and its heartbeat run concurrently.
    this.start(
      'api',
      'php',
      ['-S', `127.0.0.1:${this.apiPort}`, '-t', 'public', 'public/index.php'],
      { ...this.apiEnv(), PHP_CLI_SERVER_WORKERS: '4' },
      API_DIR,
    );
    await waitFor('the PHP API', async () => (await fetch(`${this.apiUrl}/api/v1/health`)).ok, 20_000);
  }

  stopApi(): Promise<void> {
    return this.stop('api');
  }

  async startBackend(): Promise<void> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: join(REPO, '.cache/home'),
      TMPDIR: join(REPO, '.cache/tmp'),
      TSX_DISABLE_CACHE: '1',
      WA_MODE: 'fixture',
      DATA_DIR: this.dirs.state,
      ARCHIVE_DIR: this.dirs.archive,
      OUT_DIR: this.dirs.out,
      CONFIG_DIR: this.dirs.config,
      MEDIA_DIR: this.dirs.media,
      SITE_PUBLIC_URL: `${this.siteUrl}/`,
      CONTROL_PORT: String(this.controlPort),
      CONTROL_TOKEN: this.controlToken,
      API_BASE_URL: this.apiUrl,
      API_TOKEN: this.backendToken,
      LOG_LEVEL: 'info',
      ...(this.gate
        ? {
            ACCESS_MODE: 'gate',
            SITE_PUBLIC_URL: `${this.siteUrl}${this.contentPath}`,
            API_PUBLIC_URL: `${this.apiUrl}/`,
            ACCESS_STORE_DIR: this.dirs.store,
            GATE_OUT_DIR: this.dirs.outGate,
          }
        : {}),
    };
    this.start('backend', 'node', ['--conditions=@omw/source', '--import', 'tsx', 'backend/src/cli.ts', 'start'], env);
    await waitFor('the backend control UI', async () => (await fetch(`${this.controlUrl}/healthz`)).ok, 60_000);
  }

  stopBackend(): Promise<void> {
    return this.stop('backend');
  }

  async startStatic(): Promise<void> {
    if (this.gate) return this.startApache();
    this.start(
      'static',
      'node',
      [
        '--conditions=@omw/source',
        '--import',
        'tsx',
        'backend/src/generator/cli.ts',
        'serve',
        '--dir',
        this.dirs.site,
        '--port',
        String(this.sitePort),
        '--host',
        '127.0.0.1',
      ],
      { PATH: process.env.PATH, HOME: join(REPO, '.cache/home'), TSX_DISABLE_CACHE: '1' },
    );
    await waitFor('the static server', async () => (await fetch(`${this.siteUrl}/robots.txt`)).status < 500, 30_000);
  }

  /** Gate mode: Apache on 127.0.0.1:<sitePort> serving <root>/site with AllowOverride All. */
  private async startApache(): Promise<void> {
    const apache = findApache();
    if (!apache) throw new Error('no Apache binary with mod_rewrite/mod_headers found');
    const dir = this.dirs.apache;
    mkdirSync(join(dir, 'logs'), { recursive: true });
    const systemTypes = ['/private/etc/apache2/mime.types', '/etc/mime.types'].find((p) => existsSync(p));
    const types = systemTypes ?? join(dir, 'mime.types');
    if (!systemTypes) writeFileSync(types, '');
    const conf = join(dir, 'httpd.conf');
    writeFileSync(
      conf,
      [
        `ServerRoot "${dir}"`,
        'ServerName 127.0.0.1',
        `Listen 127.0.0.1:${this.sitePort}`,
        ...APACHE_MODULES.map(([name, file]) => `LoadModule ${name} ${join(apache.modules, file)}`),
        `PidFile ${join(dir, 'logs/httpd.pid')}`,
        `ErrorLog ${join(this.dirs.logs, 'apache-error.log')}`,
        'LogLevel warn',
        // The request line only (no headers): it must never contain a session id or a key.
        'LogFormat "%r %>s" short',
        `CustomLog ${join(this.dirs.logs, 'apache-access.log')} short`,
        'StartServers 2',
        'MinSpareServers 1',
        'MaxSpareServers 4',
        `DocumentRoot "${this.dirs.site}"`,
        `<Directory "${this.dirs.site}">`,
        '  AllowOverride All',
        '  Options FollowSymLinks',
        '  Require all granted',
        '</Directory>',
        '<Files ".ht*">',
        '  Require all denied',
        '</Files>',
        `TypesConfig ${types}`,
        'AddType text/html .html',
        'AddType text/css .css',
        'AddType text/javascript .js .mjs',
        'AddType application/json .json',
        'AddType image/svg+xml .svg',
        '',
      ].join('\n'),
    );
    execFileSync(apache.bin, ['-f', conf, '-k', 'start'], { stdio: 'ignore' });
    this.apacheConf = conf;
    await waitFor('Apache', async () => (await fetch(`${this.siteUrl}/robots.txt`)).status < 500, 20_000);
  }

  private async stopApache(): Promise<void> {
    const apache = findApache();
    if (!this.apacheConf || !apache) return;
    try {
      execFileSync(apache.bin, ['-f', this.apacheConf, '-k', 'stop'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
    const pid = join(this.dirs.apache, 'logs/httpd.pid');
    await waitFor('Apache to stop', async () => !existsSync(pid), 15_000).catch(() => undefined);
    this.apacheConf = null;
  }

  /** Apache's access log (request line + status per line). */
  apacheAccessLog(): string {
    try {
      return readFileSync(join(this.dirs.logs, 'apache-access.log'), 'utf8');
    } catch {
      return '';
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([this.stop('backend'), this.stop('static'), this.stop('api'), this.stopApache()]);
  }

  /** Control API of the backend (Bearer CONTROL_TOKEN). */
  async control<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.controlUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.controlToken}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (!res.ok) throw new Error(`control ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** GET from the static host: status + body text + headers (`follow: false` keeps redirects). */
  async site(
    path: string,
    opts: { cookie?: string; follow?: boolean } = {},
  ): Promise<{ status: number; text: string; headers: Headers }> {
    const res = await fetch(`${this.siteUrl}${path}`, {
      cache: 'no-store',
      redirect: opts.follow === false ? 'manual' : 'follow',
      ...(opts.cookie ? { headers: { cookie: opts.cookie } } : {}),
    });
    return { status: res.status, text: await res.text(), headers: res.headers };
  }

  async siteJson<T = unknown>(path: string): Promise<T | null> {
    const r = await this.site(path);
    return r.status === 200 ? (JSON.parse(r.text) as T) : null;
  }

  publishedFileExists(rel: string): boolean {
    return existsSync(join(this.dirs.site, rel));
  }

  /**
   * Drops a new text status into the backend's inbox exactly like the helper does (staging dir +
   * rename); the ingest's periodic scan (30 s) picks it up.
   */
  injectTextStatus(msgId: string, body: string, at: Date): void {
    const inbox = join(this.dirs.state, 'inbox');
    const staging = join(inbox, `.fixture-${msgId}`);
    mkdirSync(staging, { recursive: true });
    const meta = {
      schema: 1,
      msgId,
      source: 'fixture', // live/history statuses also carry rawProtoB64 (contracts wa.ts)
      receivedAt: new Date(at.getTime() + 2_000).toISOString().replace('.000Z', 'Z'),
      sender: { lid: '100000000000001', jid: '100000000000001@lid' },
      timestamp: at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      kind: 'text',
      text: { body, bgArgb: 0xff5d3fa0, textArgb: 0xffffffff, font: 'SYSTEM' },
      download: { state: 'not_applicable', attempts: 0 },
      addressingMode: 'lid',
      stanzaTag: 'status',
    };
    writeFileSync(join(staging, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    renameSync(staging, join(inbox, msgId));
  }

  /** The last lines of a child's log (for failure messages). */
  logTail(name: 'api' | 'backend' | 'static' | 'apache-error', lines = 40): string {
    try {
      return readFileSync(join(this.dirs.logs, `${name}.log`), 'utf8')
        .split('\n')
        .slice(-lines)
        .join('\n');
    } catch {
      return '';
    }
  }
}
