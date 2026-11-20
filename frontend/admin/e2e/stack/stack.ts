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
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO = resolve(import.meta.dirname, '../../../..');
const API_DIR = join(REPO, 'api');

export interface StackOptions {
  root?: string;
  apiPort?: number;
  controlPort?: number;
  sitePort?: number;
}

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
    config: string;
    media: string;
    site: string;
    logs: string;
    secrets: string;
  };
  admin: AdminCredentials = { email: 'owner@example.org', password: '' };
  private backendToken = '';
  private controlToken = '';
  private readonly procs = new Map<'api' | 'backend' | 'static', ChildProcess>();

  constructor(opts: StackOptions = {}) {
    this.root = opts.root ?? join(REPO, '.cache/e2e-stack');
    this.apiPort = opts.apiPort ?? 8080;
    this.controlPort = opts.controlPort ?? 8787;
    this.sitePort = opts.sitePort ?? 4173;
    const r = this.root;
    this.dirs = {
      apiVar: join(r, 'api-var'),
      state: join(r, 'state'),
      archive: join(r, 'archive'),
      out: join(r, 'out'),
      config: join(r, 'config'),
      media: join(r, 'media'),
      site: join(r, 'site'),
      logs: join(r, 'logs'),
      secrets: join(r, 'secrets'),
    };
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
    rmSync(this.root, { recursive: true, force: true });
    for (const d of Object.values(this.dirs)) mkdirSync(d, { recursive: true, mode: 0o700 });

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

    const now = new Date().toISOString();
    writeFileSync(
      join(this.dirs.config, 'targets.json'),
      JSON.stringify(
        {
          format: 1,
          targets: [
            {
              id: 'local-e2e',
              kind: 'local',
              enabled: true,
              publicBaseUrl: `${this.siteUrl}/`,
              dir: this.dirs.site,
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
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
    };
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
    };
    this.start('backend', 'node', ['--conditions=@omw/source', '--import', 'tsx', 'backend/src/cli.ts', 'start'], env);
    await waitFor('the backend control UI', async () => (await fetch(`${this.controlUrl}/healthz`)).ok, 60_000);
  }

  stopBackend(): Promise<void> {
    return this.stop('backend');
  }

  async startStatic(): Promise<void> {
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

  async stopAll(): Promise<void> {
    await Promise.all([this.stop('backend'), this.stop('static'), this.stop('api')]);
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

  /** GET from the static host: status + body text. */
  async site(path: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`${this.siteUrl}${path}`, { cache: 'no-store' });
    return { status: res.status, text: await res.text() };
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
  logTail(name: 'api' | 'backend' | 'static', lines = 40): string {
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
