/**
 * Deploys the PHP API (api/) to the PHP host over SFTP. See docs/HOSTING.md.
 *
 *   TSX_DISABLE_CACHE=1 node --import tsx scripts/deploy-api.ts [options]
 *
 * Options:
 *   --dry-run               connect, compare, print the plan; change nothing (no secrets generated)
 *   --no-smoke              skip the authenticated round-trips after the deploy
 *   --skip-composer         reuse the vendor/ of the previous staging run (.cache/api-build)
 *   --reset-admin-password  generate a new admin password and let the app apply it (var/bootstrap.json)
 *   --rotate-feed-id        let the app rotate meta.feed_id (after restoring a backup)
 *   --set-admin-email=NEW   change the admin's login e-mail (the one in .secrets/api-admin.txt) to NEW:
 *                           uploads var/bootstrap.json with {"adminEmail": {"from", "to"}}, which the app
 *                           applies on the next request like bin/set-admin-email.php (sessions stay
 *                           valid), and updates .secrets/api-admin.txt. Runs only when passed.
 *   --concurrency=N         parallel SFTP uploads (default 4)
 *   --skip-http-checks      deploy over SFTP only; no HTTPS checks and no smoke round-trips (for when
 *                           this machine cannot reach the web server, e.g. a temporary IP block;
 *                           verify later with --checks-only). The result is reported as UNVERIFIED.
 *   --checks-only           no staging, no SFTP: only the HTTPS checks (+ smoke unless --no-smoke)
 *
 * What it does:
 *   1. Stages a clean copy of api/ in .cache/api-build (no tests, no var/ contents, no .env, no dev
 *      files, no source maps), runs `composer install --no-dev --classmap-authoritative` there and adds
 *      deny-all .htaccess files (vendor/). api/public/admin is included when built (warns otherwise).
 *   2. Connects ONCE (pinned host keys; an authentication failure is never retried) and compares the
 *      staged files with the remote deploy manifest /.omw-deploy.json (path -> sha256).
 *   3. First deploy only: creates /.env (APP_ENV=production, random CRON_KEY, SITE_ORIGIN, APP_URL,
 *      empty MAIL_DSN, DB path) and, while the database does not exist, an admin login + backend
 *      token. The clear texts go to .secrets/ (mode 600; never printed), the app receives only hashes
 *      in var/bootstrap.json and consumes that file on its first request.
 *   4. Uploads changed files as temp file + rename (vendor/src first, entry points and .htaccess
 *      last; /.maintenance is up while PHP files change), writes the manifest, deletes obsolete files
 *      last. Remote var/** (except creating var/ and uploading bootstrap.json) and an existing remote
 *      .env are never touched; files the manifest does not list are never deleted.
 *   5. Checks over HTTPS: /api/v1/health is 200 JSON; private files (/.env, /var/app.sqlite,
 *      /composer.json, /src/App.php, /vendor/autoload.php, …) are NOT 200; /admin/ is 200 when built;
 *      over plain http a missing /.well-known/acme-challenge/… file is a 404 (ACME http-01 challenges
 *      are served from the API root without the https redirect; not a 301 to /public/…, not a 403).
 *      Then (unless --no-smoke) logs in as the generated admin, GET /me, creates and deletes a test
 *      note, logs out, and does a backend-token heartbeat + change-feed read.
 *
 * .env (repo root) is parsed literally (never sourced): API_SITE_BASE_URL, API_SFTP_HOST,
 * API_SFTP_PORT, API_SFTP_USER, API_SFTP_PASSWORD, API_SFTP_REMOTE_ROOT, SITE_BASE_URL;
 * optional OMW_ADMIN_EMAIL (or the same process env var) for the first admin's e-mail.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import SftpClient from 'ssh2-sftp-client';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = join(ROOT, 'api');
const BUILD_DIR = join(ROOT, '.cache', 'api-build');
const SECRETS_DIR = join(ROOT, '.secrets');
const ADMIN_SECRET = join(SECRETS_DIR, 'api-admin.txt');
const TOKEN_SECRET = join(SECRETS_DIR, 'api-backend-token');
const CRON_SECRET = join(SECRETS_DIR, 'api-cron-key');
const MANIFEST = '.omw-deploy.json';
const MAINTENANCE = '.maintenance';
const DEFAULT_ADMIN_EMAIL = 'owner@on-my-way.invalid';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pinned host keys of the shared host: base64(sha256(key)) without padding. */
const PINNED_HOST_KEYS = new Set([
  '1ckzga7xTCnKZNsqpWVAh4K85X9HmVe+5Ki1PW7tOQs', // ED25519
  'gQnQinEqX7NMlkAYbI8WiXGzkSfQWisi2SxHo7B2ebQ', // RSA
]);

/** Paths (relative to the remote API root) that must never answer 200 over HTTP. */
const PRIVATE_PATHS = [
  '/.env',
  '/var/app.sqlite',
  '/var/bootstrap.json',
  '/var/logs/app.log',
  '/composer.json',
  '/composer.lock',
  '/src/App.php',
  '/vendor/autoload.php',
  '/bin/cron.php',
  '/migrations/0001_init.sql',
  '/schemas/index.json',
  '/.omw-deploy.json',
  '/.htaccess',
];

/**
 * Pause before each private-path probe: at most one every 5 s. A burst of ~25 such requests got
 * this machine's IP blocked on the web ports of the shared host (docs/HOSTING.md, Troubleshooting).
 */
const PROBE_SPACING_MS = 5000;

interface Options {
  dryRun: boolean;
  smoke: boolean;
  httpChecks: boolean;
  checksOnly: boolean;
  skipComposer: boolean;
  resetAdminPassword: boolean;
  rotateFeedId: boolean;
  /** --set-admin-email=NEW: new login e-mail for the admin (null = unchanged). */
  setAdminEmail: string | null;
  concurrency: number;
}

interface Target {
  baseUrl: string;
  host: string;
  port: number;
  username: string;
  password: string;
  remoteRoot: string;
  siteOrigin: string;
  adminEmail: string;
}

type Manifest = Record<string, string>;

interface RemoteManifestFile {
  version: 1;
  deployedAt: string;
  files: Manifest;
  /**
   * Hashed admin assets of earlier builds, still on the server (path -> retired at). An open admin
   * tab of the previous build can still lazy-load its chunks; they are deleted after RETIRE_DAYS.
   */
  retired?: Record<string, string>;
}

const RETIRE_DAYS = 7;

class DeployError extends Error {}

// ---------------------------------------------------------------------------------------------
// Helpers

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function warn(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    dryRun: false,
    smoke: true,
    httpChecks: true,
    checksOnly: false,
    skipComposer: false,
    resetAdminPassword: false,
    rotateFeedId: false,
    setAdminEmail: null,
    concurrency: 4,
  };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-smoke') options.smoke = false;
    else if (arg === '--skip-http-checks') options.httpChecks = false;
    else if (arg === '--checks-only') options.checksOnly = true;
    else if (arg === '--skip-composer') options.skipComposer = true;
    else if (arg === '--reset-admin-password') options.resetAdminPassword = true;
    else if (arg === '--rotate-feed-id') options.rotateFeedId = true;
    else if (arg.startsWith('--set-admin-email=')) {
      const email = arg.slice('--set-admin-email='.length).trim().toLowerCase();
      if (!EMAIL_RE.test(email) || email.length > 254)
        throw new DeployError('--set-admin-email needs an e-mail address');
      options.setAdminEmail = email;
    } else if (arg.startsWith('--concurrency=')) {
      const n = Number(arg.slice('--concurrency='.length));
      if (!Number.isInteger(n) || n < 1 || n > 16) throw new DeployError('--concurrency must be 1..16');
      options.concurrency = n;
    } else if (arg === '--help' || arg === '-h') {
      log(
        'Usage: node --import tsx scripts/deploy-api.ts [--dry-run] [--no-smoke] [--skip-composer] [--reset-admin-password] [--rotate-feed-id] [--set-admin-email=NEW] [--concurrency=N] [--skip-http-checks | --checks-only]',
      );
      process.exit(0);
    } else throw new DeployError(`Unknown option: ${arg}`);
  }
  if (options.checksOnly && !options.httpChecks)
    throw new DeployError('--checks-only and --skip-http-checks exclude each other');
  if (
    options.checksOnly &&
    (options.dryRun || options.resetAdminPassword || options.rotateFeedId || options.setAdminEmail !== null)
  ) {
    throw new DeployError(
      '--checks-only does not deploy: drop --dry-run/--reset-admin-password/--rotate-feed-id/--set-admin-email',
    );
  }
  return options;
}

/**
 * KEY=value lines, read literally: no variable expansion, no escapes; one pair of surrounding
 * quotes is stripped. Comments (#) and blank lines are skipped.
 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match?.[1]) continue;
    let value = (match[2] ?? '').trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function loadTarget(): Target {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) throw new DeployError(`${file} is missing`);
  const env = parseDotEnv(readFileSync(file, 'utf8'));
  const need = (key: string): string => {
    const value = env[key];
    if (!value) throw new DeployError(`${key} is not set in .env`);
    return value;
  };
  const baseUrl = need('API_SITE_BASE_URL').replace(/\/+$/, '');
  if (!/^https:\/\//.test(baseUrl)) throw new DeployError('API_SITE_BASE_URL must be an https:// URL');
  const port = Number(env.API_SFTP_PORT ?? '22');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DeployError('API_SFTP_PORT is not a port number');
  const site = env.SITE_BASE_URL ? new URL(env.SITE_BASE_URL).origin : '';
  const adminEmail = (process.env.OMW_ADMIN_EMAIL ?? env.OMW_ADMIN_EMAIL ?? '').trim() || DEFAULT_ADMIN_EMAIL;
  if (!EMAIL_RE.test(adminEmail)) throw new DeployError('OMW_ADMIN_EMAIL is not an e-mail address');
  const remoteRoot = posix.normalize(`/${env.API_SFTP_REMOTE_ROOT ?? '/'}`).replace(/\/+$/, '') || '/';
  return {
    baseUrl,
    host: need('API_SFTP_HOST'),
    port,
    username: need('API_SFTP_USER'),
    password: need('API_SFTP_PASSWORD'),
    remoteRoot,
    siteOrigin: site,
    adminEmail,
  };
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

function writeSecret(path: string, content: string): void {
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function run(cmd: string, args: string[], options: { cwd?: string; input?: string } = {}): string {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd ?? ROOT,
    input: options.input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env },
  });
  if (result.error) throw new DeployError(`${cmd} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new DeployError(
      `${cmd} ${args[0] ?? ''} exited with ${result.status}: ${(result.stderr || result.stdout).slice(-2000)}`,
    );
  }
  return result.stdout;
}

// ---------------------------------------------------------------------------------------------
// 1. Staging

const STAGE_TOP_LEVEL = new Set([
  '.htaccess',
  'bin',
  'migrations',
  'public',
  'schemas',
  'src',
  'composer.json',
  'composer.lock',
]);

function copyTree(from: string, to: string, skip: (rel: string) => boolean, base = from): number {
  let count = 0;
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const rel = relative(base, src).split('\\').join('/');
    if (skip(rel) || entry.name === '.DS_Store') continue;
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(dst, { recursive: true });
      count += copyTree(src, dst, skip, base);
    } else if (entry.isFile()) {
      copyFileSync(src, dst);
      count++;
    }
  }
  return count;
}

function stage(options: Options): { adminBuilt: boolean } {
  const keepVendor = options.skipComposer && existsSync(join(BUILD_DIR, 'vendor', 'autoload.php'));
  if (keepVendor) {
    for (const entry of readdirSync(BUILD_DIR))
      if (entry !== 'vendor') rmSync(join(BUILD_DIR, entry), { recursive: true, force: true });
  } else {
    rmSync(BUILD_DIR, { recursive: true, force: true });
  }
  mkdirSync(BUILD_DIR, { recursive: true });

  const adminBuilt = existsSync(join(API_DIR, 'public', 'admin', 'index.html'));
  if (!adminBuilt)
    warn('api/public/admin is not built (pnpm --filter @omw/admin build): deploying the API without the admin PWA.');

  const files = copyTree(API_DIR, BUILD_DIR, (rel) => {
    const top = rel.split('/')[0] ?? '';
    if (!STAGE_TOP_LEVEL.has(top)) return true;
    if (rel.endsWith('.map')) return true; // admin source maps stay local
    if (/(^|\/)\.env/.test(rel)) return true;
    return false;
  });
  // var/ is never synced; only its deny-all .htaccess is used when var/ is created on the first deploy.
  mkdirSync(join(BUILD_DIR, 'var'), { recursive: true });
  copyFileSync(join(API_DIR, 'var', '.htaccess'), join(BUILD_DIR, 'var', '.htaccess'));
  log(`staged ${files} files from api/ in ${relative(ROOT, BUILD_DIR)}${adminBuilt ? ' (with admin PWA)' : ''}`);

  if (keepVendor) {
    // vendor/ is reused, but the authoritative classmap must list the current src/ classes.
    run(join(ROOT, 'scripts', 'composer'), [
      'dump-autoload',
      '--no-dev',
      '--classmap-authoritative',
      '--no-interaction',
      `--working-dir=${BUILD_DIR}`,
    ]);
  } else {
    log('composer install --no-dev --classmap-authoritative …');
    run(join(ROOT, 'scripts', 'composer'), [
      'install',
      '--no-dev',
      '--classmap-authoritative',
      '--no-interaction',
      '--no-progress',
      '--prefer-dist',
      `--working-dir=${BUILD_DIR}`,
    ]);
  }
  writeFileSync(
    join(BUILD_DIR, 'vendor', '.htaccess'),
    '# Never served (defense in depth: ../.htaccess routes every request into public/).\nRequire all denied\n',
  );
  for (const required of ['vendor/autoload.php', 'public/index.php', '.htaccess', 'src/.htaccess', 'var/.htaccess']) {
    if (!existsSync(join(BUILD_DIR, required))) throw new DeployError(`staging is incomplete: ${required} missing`);
  }
  return { adminBuilt };
}

function manifestOf(dir: string): Manifest {
  const out: Manifest = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const rel = relative(dir, path).split('\\').join('/');
      if (rel === 'var' || rel.startsWith('var/')) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out[rel] = sha256(readFileSync(path));
    }
  };
  walk(dir);
  return out;
}

/** Upload order: libraries first, entry points and rewrite rules last. */
function priority(path: string): number {
  if (path.startsWith('vendor/')) return 0;
  if (/^(src|schemas|migrations|bin)\//.test(path)) return 1;
  if (path.startsWith('public/admin/assets/')) return 2;
  if (path.startsWith('public/admin/') && !/^public\/admin\/(index\.html|sw\.js|manifest\.webmanifest)$/.test(path))
    return 3;
  if (path.startsWith('public/admin/')) return 4;
  if (path === '.htaccess') return 6;
  return 5;
}

// ---------------------------------------------------------------------------------------------
// 2.-4. Remote

async function connect(target: Target): Promise<SftpClient> {
  const sftp = new SftpClient('omw-deploy-api');
  try {
    await sftp.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      readyTimeout: 20_000,
      hostVerifier: (key: Buffer) =>
        PINNED_HOST_KEYS.has(createHash('sha256').update(key).digest('base64').replace(/=+$/, '')),
    } as SftpClient.ConnectOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/authentication|auth fail|permission denied/i.test(message)) {
      throw new DeployError(
        'SFTP authentication failed. NOT retrying (the host may ban repeated failures); check .env.',
      );
    }
    if (/host.?key|verif/i.test(message)) {
      throw new DeployError('SFTP host key does not match the pinned fingerprints: refusing to connect.');
    }
    throw new DeployError(`SFTP connection failed: ${message}`);
  }
  return sftp;
}

class Remote {
  private readonly dirs = new Set<string>();
  private readonly sftp: SftpClient;
  private readonly root: string;

  constructor(sftp: SftpClient, root: string) {
    this.sftp = sftp;
    this.root = root;
  }

  path(rel: string): string {
    return posix.join(this.root, rel);
  }

  async exists(rel: string): Promise<boolean> {
    return (await this.sftp.exists(this.path(rel))) !== false;
  }

  async readText(rel: string): Promise<string | null> {
    if (!(await this.exists(rel))) return null;
    const data = await this.sftp.get(this.path(rel));
    return Buffer.isBuffer(data) ? data.toString('utf8') : null;
  }

  async ensureDir(relDir: string): Promise<void> {
    if (relDir === '' || relDir === '.' || this.dirs.has(relDir)) return;
    await this.ensureDir(posix.dirname(relDir) === '.' ? '' : posix.dirname(relDir));
    if (!(await this.exists(relDir))) await this.sftp.mkdir(this.path(relDir), true);
    this.dirs.add(relDir);
  }

  /** Atomic-ish upload: temp file in the same directory, then rename over the target. */
  async putAtomic(rel: string, data: Buffer | string, mode?: number): Promise<void> {
    await this.ensureDir(posix.dirname(rel) === '.' ? '' : posix.dirname(rel));
    const target = this.path(rel);
    const tmp = posix.join(posix.dirname(target), `.omw-tmp-${randomToken(6)}-${posix.basename(target)}`);
    await this.sftp.put(Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'), tmp);
    if (mode !== undefined) {
      try {
        await this.sftp.chmod(tmp, mode);
      } catch {
        // some hosts refuse chmod; the deny rules still protect the file
      }
    }
    try {
      await this.sftp.posixRename(tmp, target);
    } catch {
      // No posix-rename@openssh.com: classic rename fails when the target exists.
      if (await this.exists(rel)) await this.sftp.delete(target, true);
      await this.sftp.rename(tmp, target);
    }
  }

  async remove(rel: string): Promise<void> {
    await this.sftp.delete(this.path(rel), true);
  }

  async list(relDir: string): Promise<string[]> {
    return (await this.sftp.list(this.path(relDir))).map((f) => f.name);
  }
}

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

interface BootstrapSecrets {
  email: string;
  password: string;
  token: string;
}

function readAdminSecret(): { email: string; password: string } | null {
  if (!existsSync(ADMIN_SECRET)) return null;
  const values = parseDotEnv(readFileSync(ADMIN_SECRET, 'utf8'));
  return values.email && values.password ? { email: values.email, password: values.password } : null;
}

function phpHash(password: string, algo: 'PASSWORD_ARGON2ID' | 'PASSWORD_BCRYPT'): string {
  const options = algo === 'PASSWORD_BCRYPT' ? ", ['cost' => 12]" : '';
  const hash = run('php', ['-r', `echo password_hash(stream_get_contents(STDIN), ${algo}${options});`], {
    input: password,
  }).trim();
  if (!hash.startsWith('$')) throw new DeployError('php password_hash() returned no hash');
  return hash;
}

function writeAdminSecret(target: Target, email: string, password: string): void {
  writeSecret(
    ADMIN_SECRET,
    `# On My Way API admin login (scripts/deploy-api.ts, ${new Date().toISOString()}). Keep private.\nurl=${target.baseUrl}/admin/\nemail=${email}\npassword=${password}\n`,
  );
}

/** "owner@example.org" -> "o***@example.org" (log lines never show the whole login e-mail). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return at <= 0 ? '***' : `${email[0]}***${email.slice(at)}`;
}

/** Creates (or reuses) the local secrets of the first admin and the backend token. */
function prepareSecrets(target: Target, resetPassword: boolean): BootstrapSecrets {
  const existing = readAdminSecret();
  const email = existing?.email ?? target.adminEmail;
  const password = existing && !resetPassword ? existing.password : randomToken(24);
  const token = existsSync(TOKEN_SECRET) ? readFileSync(TOKEN_SECRET, 'utf8').trim() : `omw_${randomToken(32)}`;
  if (!/^omw_[A-Za-z0-9_-]{43}$/.test(token)) throw new DeployError(`${TOKEN_SECRET} does not contain a valid token`);
  writeAdminSecret(target, email, password);
  writeSecret(TOKEN_SECRET, `${token}\n`);
  return { email, password, token };
}

interface EmailChange {
  from: string;
  to: string;
}

export function bootstrapJson(
  secrets: BootstrapSecrets | null,
  options: { reset: boolean; rotateFeedId: boolean; adminEmail?: EmailChange | null },
): string {
  const body: Record<string, unknown> = { version: 1 };
  if (secrets) {
    body.admin = {
      email: secrets.email,
      passwordHash: phpHash(secrets.password, 'PASSWORD_ARGON2ID'),
      passwordHashFallback: phpHash(secrets.password, 'PASSWORD_BCRYPT'),
      displayName: 'Owner',
      reset: options.reset,
    };
    body.tokens = [
      {
        kind: 'backend',
        name: 'home backend',
        tokenHash: sha256(secrets.token),
        hint: `${secrets.token.slice(0, 10)}…`,
      },
    ];
  }
  if (options.rotateFeedId) body.rotateFeedId = true;
  if (options.adminEmail) body.adminEmail = { from: options.adminEmail.from, to: options.adminEmail.to };
  return `${JSON.stringify(body, null, 2)}\n`;
}

function productionEnv(target: Target, cronKey: string): string {
  return [
    '# On My Way API (created by scripts/deploy-api.ts on the first deploy; never overwritten).',
    'APP_ENV=production',
    'APP_DEBUG=false',
    `APP_URL=${target.baseUrl}`,
    `SITE_ORIGIN=${target.siteOrigin}`,
    'DB_PATH=var/app.sqlite',
    'DB_JOURNAL_MODE=WAL',
    'LOG_LEVEL=info',
    `CRON_KEY=${cronKey}`,
    '# Alert e-mails: e.g. smtp://user:pass@smtp.example.com:587 or native://default (docs/HOSTING.md).',
    'MAIL_DSN=',
    'MAIL_FROM=',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// 5. HTTP checks

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function http(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000), ...init });
}

async function healthWithRetry(baseUrl: string): Promise<Check> {
  let detail = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const response = await http(`${baseUrl}/api/v1/health`);
      const text = await response.text();
      if (response.status === 200 && response.headers.get('content-type')?.startsWith('application/json')) {
        const body = JSON.parse(text) as { ok?: unknown; contractVersion?: unknown; version?: unknown };
        if (body.ok === true && body.contractVersion === 1) {
          return { name: 'health', ok: true, detail: `200 version ${String(body.version)}` };
        }
      }
      detail = `${response.status} ${text.slice(0, 120)}`;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { name: 'health', ok: false, detail };
}

async function httpChecks(target: Target, adminBuilt: boolean): Promise<Check[]> {
  const checks: Check[] = [await healthWithRetry(target.baseUrl)];
  for (const path of PRIVATE_PATHS) {
    // Spaced out: shared hosts may block a client IP after a burst of requests to sensitive
    // paths (docs/HOSTING.md, Troubleshooting).
    await new Promise((r) => setTimeout(r, PROBE_SPACING_MS));
    try {
      const response = await http(`${target.baseUrl}${path}`);
      await response.arrayBuffer();
      checks.push({ name: `private ${path}`, ok: response.status !== 200, detail: String(response.status) });
    } catch (error) {
      checks.push({
        name: `private ${path}`,
        ok: true,
        detail: `unreachable (${error instanceof Error ? error.message : error})`,
      });
    }
  }
  if (adminBuilt) {
    try {
      const admin = await http(`${target.baseUrl}/admin/`);
      const html = await admin.text();
      checks.push({
        name: 'admin /admin/',
        ok: admin.status === 200 && html.includes('<div id="omw-admin">'),
        detail: `${admin.status} ${admin.headers.get('content-type') ?? ''} cache-control=${admin.headers.get('cache-control') ?? '-'}`,
      });
      const deepLink = await http(`${target.baseUrl}/admin/days/2026-01-01`);
      await deepLink.arrayBuffer();
      checks.push({ name: 'admin SPA fallback', ok: deepLink.status === 200, detail: String(deepLink.status) });
    } catch (error) {
      checks.push({ name: 'admin /admin/', ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  checks.push(await wellKnownCheck(target.baseUrl.replace(/^https:/, 'http:')));
  const insecure = await http(`${target.baseUrl.replace(/^https:/, 'http:')}/api/v1/health`).catch(() => null);
  checks.push({
    name: 'http -> https',
    ok:
      insecure !== null &&
      [301, 302, 307, 308].includes(insecure.status) &&
      (insecure.headers.get('location') ?? '').startsWith('https://'),
    detail: insecure ? `${insecure.status} ${insecure.headers.get('location') ?? ''}` : 'no answer',
  });
  return checks;
}

/**
 * ACME http-01 challenges must work over plain http from the API root: a missing file below
 * /.well-known/acme-challenge/ is a 404 (not a 301 to https://…/public/…, not a 403 from the
 * dotfile rules). $httpBase: the API's base URL with http://.
 */
export async function wellKnownCheck(httpBase: string): Promise<Check> {
  const url = `${httpBase}/.well-known/acme-challenge/omw-deploy-check-${randomToken(9)}`;
  try {
    const response = await http(url);
    await response.arrayBuffer();
    const location = response.headers.get('location');
    return {
      name: 'http /.well-known/acme-challenge/<missing>',
      ok: response.status === 404,
      detail: `${response.status}${location ? ` -> ${location}` : ''} (expected 404)`,
    };
  } catch (error) {
    return {
      name: 'http /.well-known/acme-challenge/<missing>',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function smoke(target: Target): Promise<Check[]> {
  const checks: Check[] = [];
  const admin = readAdminSecret();
  const token = existsSync(TOKEN_SECRET) ? readFileSync(TOKEN_SECRET, 'utf8').trim() : null;
  const base = `${target.baseUrl}/api/v1`;

  if (admin) {
    const login = await http(`${base}/admin/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: admin.email, password: admin.password }),
    });
    const me = (await login.json().catch(() => null)) as { email?: string; csrfToken?: string } | null;
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] ?? '')
      .find((c) => c.startsWith('__Host-omw_session='));
    const cookieAttrs = login.headers.getSetCookie().find((c) => c.startsWith('__Host-omw_session=')) ?? '';
    checks.push({
      name: 'admin login',
      ok:
        login.status === 200 &&
        !!cookie &&
        /;\s*Secure/i.test(cookieAttrs) &&
        /HttpOnly/i.test(cookieAttrs) &&
        /SameSite=Strict/i.test(cookieAttrs),
      detail: `${login.status}`,
    });
    if (login.status === 200 && cookie && me?.csrfToken) {
      const headers = { Cookie: cookie, 'X-CSRF-Token': me.csrfToken, 'Content-Type': 'application/json' };
      const meResponse = await http(`${base}/admin/me`, { headers: { Cookie: cookie } });
      const meBody = (await meResponse.json().catch(() => null)) as { email?: string } | null;
      checks.push({
        name: 'GET /admin/me',
        ok: meResponse.status === 200 && meBody?.email === admin.email,
        detail: `${meResponse.status}`,
      });
      const publicId = `p_deploysmoke${Date.now()}`;
      const created = await http(`${base}/admin/posts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          publicId,
          kind: 'note',
          origLocale: 'en',
          visibility: 'hidden',
          content: { en: { body: 'Deploy smoke test (deleted right away).' } },
        }),
      });
      await created.arrayBuffer();
      checks.push({ name: 'create test note', ok: created.status === 201, detail: `${created.status}` });
      const deleted = await http(`${base}/admin/posts/${publicId}`, {
        method: 'DELETE',
        headers: { Cookie: cookie, 'X-CSRF-Token': me.csrfToken },
      });
      checks.push({ name: 'delete test note', ok: deleted.status === 204, detail: `${deleted.status}` });
      const noCsrf = await http(`${base}/admin/settings`, {
        method: 'PATCH',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
      await noCsrf.arrayBuffer();
      checks.push({ name: 'CSRF enforced', ok: noCsrf.status === 403, detail: `${noCsrf.status}` });
      const logout = await http(`${base}/admin/session`, {
        method: 'DELETE',
        headers: { Cookie: cookie, 'X-CSRF-Token': me.csrfToken },
      });
      checks.push({ name: 'logout', ok: logout.status === 204, detail: `${logout.status}` });
    }
  } else {
    checks.push({ name: 'admin login', ok: false, detail: `${ADMIN_SECRET} missing` });
  }

  if (token) {
    const auth = { Authorization: `Bearer ${token}` };
    const now = new Date().toISOString();
    const heartbeat = await http(`${base}/backend/heartbeat`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contractVersion: 1,
        at: now,
        backendVersion: 'deploy-smoke',
        wa: { state: 'closed', traveler: { pn: null, lidKnown: false } },
        queue: { pending: 0, failed: 0 },
        sync: { feedId: null, feedSeq: 0, lastPullAt: null, quarantined: 0 },
        captures: { awaitingMedia: 0, failed: 0, mediaLost: 0 },
        stats: {},
        disk: { freeBytes: 0 },
        publish: {},
      }),
    });
    await heartbeat.arrayBuffer();
    checks.push({ name: 'backend heartbeat', ok: heartbeat.status === 204, detail: `${heartbeat.status}` });
    const changes = await http(`${base}/backend/changes?after=0&limit=5`, { headers: auth });
    const page = (await changes.json().catch(() => null)) as { feedId?: string; items?: unknown[] } | null;
    checks.push({
      name: 'backend changes',
      ok: changes.status === 200 && typeof page?.feedId === 'string' && Array.isArray(page.items),
      detail: `${changes.status} items=${page?.items?.length ?? '-'}`,
    });
    const noToken = await http(`${base}/backend/changes`);
    await noToken.arrayBuffer();
    checks.push({ name: 'backend auth enforced', ok: noToken.status === 401, detail: `${noToken.status}` });
  } else {
    checks.push({ name: 'backend token', ok: false, detail: `${TOKEN_SECRET} missing` });
  }
  return checks;
}

// ---------------------------------------------------------------------------------------------
// Main

async function runChecks(target: Target, adminBuilt: boolean, options: Options): Promise<boolean> {
  const checks = await httpChecks(target, adminBuilt);
  if (options.smoke) checks.push(...(await smoke(target)));
  let failed = false;
  for (const check of checks) {
    log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`);
    if (!check.ok) failed = true;
  }
  return !failed;
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const target = loadTarget();
  if (options.checksOnly) {
    log(`checks only: ${target.baseUrl} (nothing is deployed)`);
    const ok = await runChecks(target, existsSync(join(API_DIR, 'public', 'admin', 'index.html')), options);
    log(ok ? 'all checks passed' : 'CHECKS FAILED');
    return ok ? 0 : 1;
  }
  log(
    `target: ${target.baseUrl} (sftp ${target.host}:${target.port}, root ${target.remoteRoot})${options.dryRun ? ' [dry run]' : ''}`,
  );

  const { adminBuilt } = stage(options);
  const local = manifestOf(BUILD_DIR);
  log(`local: ${Object.keys(local).length} files`);

  const sftp = await connect(target);
  const remote = new Remote(sftp, target.remoteRoot);
  let checksFailed = false;
  try {
    const manifestText = await remote.readText(MANIFEST);
    let previous: Manifest = {};
    let previousRetired: Record<string, string> = {};
    if (manifestText) {
      try {
        const parsed = JSON.parse(manifestText) as RemoteManifestFile;
        previous = parsed.files ?? {};
        previousRetired = parsed.retired ?? {};
      } catch {
        warn(`remote ${MANIFEST} is unreadable: uploading everything`);
      }
    }
    // A flag left by an interrupted deploy (content "deploy …") is ours and gets replaced and removed;
    // any other /.maintenance is a manual maintenance or restore in progress.
    const flag = await remote.readText(MAINTENANCE);
    if (flag !== null && !flag.startsWith('deploy ')) {
      throw new DeployError(
        `/${MAINTENANCE} exists on the server (manual maintenance or restore in progress). Finish that and delete the file, then deploy again.`,
      );
    }
    if (flag !== null) warn(`/${MAINTENANCE} of an interrupted deploy found: this deploy replaces and removes it`);
    const envExists = await remote.exists('.env');
    const varExists = await remote.exists('var');
    const dbExists = await remote.exists('var/app.sqlite');
    const bootstrapPending = await remote.exists('var/bootstrap.json');
    const rootEntries = await remote.list('');
    const unmanaged = rootEntries.filter(
      (name) =>
        !STAGE_TOP_LEVEL.has(name) &&
        !['vendor', 'var', '.env', MANIFEST, MAINTENANCE].includes(name) &&
        !name.startsWith('.omw-tmp-'),
    );

    const upload = Object.keys(local)
      .filter((path) => previous[path] !== local[path])
      .sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
    const obsolete = Object.keys(previous).filter(
      (path) => !(path in local) && !path.startsWith('var/') && path !== '.env',
    );
    const nowIso = new Date().toISOString();
    const retireBefore = new Date(Date.now() - RETIRE_DAYS * 86_400_000).toISOString();
    const retired: Record<string, string> = {};
    for (const [path, at] of Object.entries(previousRetired)) {
      if (!(path in local) && at > retireBefore) retired[path] = at;
    }
    for (const path of obsolete) {
      if (path.startsWith('public/admin/assets/')) retired[path] = nowIso;
    }
    const remove = [
      ...obsolete.filter((path) => !(path in retired)),
      ...Object.keys(previousRetired).filter((path) => !(path in retired) && !(path in local)),
    ];
    const bytes = upload.reduce((sum, path) => sum + statSync(join(BUILD_DIR, path)).size, 0);
    const phpChanges = upload.some(
      (path) => /^(vendor|src|bin|migrations|schemas)\//.test(path) || path === 'public/index.php',
    );
    let emailChange: EmailChange | null = null;
    if (options.setAdminEmail !== null) {
      if (!dbExists)
        throw new DeployError(
          '--set-admin-email changes an existing admin; for the first deploy set OMW_ADMIN_EMAIL in .env instead',
        );
      const current = readAdminSecret();
      if (!current)
        throw new DeployError(`${relative(ROOT, ADMIN_SECRET)} is missing: the current admin e-mail is unknown`);
      if (current.email.toLowerCase() === options.setAdminEmail)
        log(`admin e-mail is already ${maskEmail(options.setAdminEmail)}: nothing to change`);
      else emailChange = { from: current.email.toLowerCase(), to: options.setAdminEmail };
    }
    const needsBootstrap =
      (!dbExists && !bootstrapPending) || options.resetAdminPassword || options.rotateFeedId || emailChange !== null;

    log(
      `remote: manifest ${manifestText ? `${Object.keys(previous).length} files` : 'missing (first deploy)'}, .env ${envExists ? 'present' : 'MISSING'}, database ${dbExists ? 'present' : 'missing'}${bootstrapPending ? ', bootstrap.json pending' : ''}`,
    );
    if (unmanaged.length > 0) log(`remote root also contains (left alone): ${unmanaged.join(', ')}`);
    if (Object.keys(retired).length > 0)
      log(`keeping ${Object.keys(retired).length} retired admin assets (deleted after ${RETIRE_DAYS} days)`);
    log(
      `plan: upload ${upload.length} files (${(bytes / 1024).toFixed(0)} KiB), delete ${remove.length}${phpChanges && manifestText ? ', maintenance flag during the upload' : ''}`,
    );
    for (const path of upload.slice(0, 15)) log(`  + ${path}`);
    if (upload.length > 15) log(`  … ${upload.length - 15} more`);
    for (const path of remove.slice(0, 15)) log(`  - ${path}`);
    if (!envExists) log('  first deploy: will create /.env (random CRON_KEY -> .secrets/api-cron-key)');
    if (needsBootstrap) {
      log(
        `  bootstrap: var/bootstrap.json${!dbExists ? ` (admin ${readAdminSecret()?.email ?? target.adminEmail} + backend token -> .secrets/)` : ''}${options.resetAdminPassword ? ' (new admin password)' : ''}${options.rotateFeedId ? ' (rotate feed id)' : ''}${emailChange ? ` (admin e-mail ${maskEmail(emailChange.from)} -> ${maskEmail(emailChange.to)})` : ''}`,
      );
    }
    if (options.dryRun) {
      log('dry run: nothing changed.');
      return 0;
    }

    // Secrets and remote config first (so they are never lost if the upload breaks).
    if (!envExists) {
      const cronKey = existsSync(CRON_SECRET) ? readFileSync(CRON_SECRET, 'utf8').trim() : randomToken(32);
      writeSecret(CRON_SECRET, `${cronKey}\n`);
      await remote.putAtomic('.env', productionEnv(target, cronKey), 0o600);
      log(`created remote .env (CRON_KEY saved to ${relative(ROOT, CRON_SECRET)})`);
    }
    if (!varExists) {
      await remote.ensureDir('var');
      await remote.putAtomic('var/.htaccess', readFileSync(join(BUILD_DIR, 'var', '.htaccess')));
    }
    if (needsBootstrap) {
      const withAdmin = !dbExists || options.resetAdminPassword;
      const secrets = withAdmin ? prepareSecrets(target, options.resetAdminPassword) : null;
      await remote.putAtomic(
        'var/bootstrap.json',
        bootstrapJson(secrets, {
          reset: options.resetAdminPassword,
          rotateFeedId: options.rotateFeedId,
          adminEmail: emailChange,
        }),
        0o600,
      );
      if (secrets)
        log(
          `admin login and backend token saved to ${relative(ROOT, ADMIN_SECRET)} and ${relative(ROOT, TOKEN_SECRET)}`,
        );
      if (emailChange) {
        // The app applies it on its next request (the HTTPS checks below make one; the smoke
        // login then uses the new e-mail).
        const admin = readAdminSecret();
        if (!admin) throw new DeployError(`${relative(ROOT, ADMIN_SECRET)} vanished`);
        writeAdminSecret(target, emailChange.to, admin.password);
        log(`admin e-mail change queued; ${relative(ROOT, ADMIN_SECRET)} now holds the new e-mail`);
      }
      log('uploaded var/bootstrap.json (consumed by the first request)');
    }

    const maintenance = (phpChanges && manifestText !== null) || flag !== null;
    if (maintenance) await remote.putAtomic(MAINTENANCE, `deploy ${new Date().toISOString()}\n`);
    // The flag comes down only once every file is in place: after a failed upload the API keeps
    // answering 503 instead of running a half-updated code base (the next deploy replaces and
    // removes the flag, see above).
    let complete = false;
    try {
      // Directories first (sequentially), then files in priority groups.
      for (const dir of [...new Set(upload.map((p) => posix.dirname(p)).filter((d) => d !== '.'))].sort())
        await remote.ensureDir(dir);
      let done = 0;
      for (const group of [0, 1, 2, 3, 4, 5, 6]) {
        const files = upload.filter((path) => priority(path) === group);
        await pool(files, options.concurrency, async (path) => {
          await remote.putAtomic(path, readFileSync(join(BUILD_DIR, path)));
          done++;
          if (done % 100 === 0) log(`  uploaded ${done}/${upload.length}`);
        });
      }
      const manifest: RemoteManifestFile = { version: 1, deployedAt: nowIso, files: local, retired };
      await remote.putAtomic(MANIFEST, `${JSON.stringify(manifest)}\n`);
      complete = true;
      for (const path of remove) await remote.remove(path);
      log(`uploaded ${upload.length}, deleted ${remove.length}`);
    } finally {
      if (maintenance && complete) await remote.remove(MAINTENANCE);
      else if (maintenance)
        warn(
          `upload failed: /${MAINTENANCE} stays up (the API answers 503) so no request runs on half-updated code. Re-run the deploy to finish it.`,
        );
    }
  } finally {
    await sftp.end();
  }

  if (!options.httpChecks) {
    warn(
      'HTTPS checks skipped (--skip-http-checks): the deploy is UNVERIFIED. Run --checks-only once the API is reachable.',
    );
    log('deploy finished (UNVERIFIED: no HTTPS checks)');
    return 0;
  }
  checksFailed = !(await runChecks(target, adminBuilt, options));
  log(checksFailed ? 'deploy finished WITH FAILED CHECKS' : 'deploy finished, all checks passed');
  return checksFailed ? 1 : 0;
}

// Runs only as a script (importing it, e.g. to test parseArgs/bootstrapJson, deploys nothing).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(
        `deploy-api: ${error instanceof DeployError ? error.message : error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
