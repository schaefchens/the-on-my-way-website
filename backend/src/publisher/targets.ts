/**
 * Publish target configuration: CONFIG_DIR/targets.json (format 1, mode 0600, atomic writes).
 *
 * Bootstrap: when targets.json does not exist and the environment describes an SFTP target
 * (SFTP_HOST, SFTP_USER, SFTP_PASSWORD or SFTP_PRIVATE_KEY_PATH, optional SFTP_PORT,
 * SFTP_REMOTE_ROOT, SITE_BASE_URL, SFTP_HOST_FINGERPRINT, SFTP_TRUST_ON_FIRST_USE, SFTP_TARGET_ID),
 * that target is written to targets.json once. Afterwards the file is the only source: removing
 * every target leaves an empty file and never re-bootstraps.
 *
 * Secrets are only ever read from here by the SFTP connector; toPublic() strips them.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  type Stats,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
// ssh2 is CommonJS; Node's ESM loader does not expose `utils` as a named export.
import ssh2 from 'ssh2';
import { z } from 'zod';
import type { Logger } from '../log.js';
import { defaultHostKeys, parseFingerprints } from './hostkeys.js';
import {
  PublishError,
  PublishTargetInput,
  type PublishTargetPublic,
  type StoredLocalTarget,
  type StoredSftpTarget,
  StoredTarget,
  type TargetStatusPublic,
  TargetsFile,
} from './types.js';

export const TARGETS_FILE = 'targets.json';
export const DEFAULT_SFTP_TARGET_ID = 'sftp-main';
export const DEFAULT_CONCURRENCY = 4;

export interface TargetStoreOptions {
  /** CONFIG_DIR/targets.json */
  file: string;
  /** Base for relative privateKeyPath values. */
  configDir: string;
  /** Base for relative local target dirs (backend/). */
  baseDir: string;
  /** OUT_DIR: a local target must not overlap it. */
  outDir: string;
  /**
   * Backend state directories (DATA_DIR, ARCHIVE_DIR, CONFIG_DIR, MEDIA_DIR): a local target must
   * not overlap them either (its deletes of "media/…" would otherwise hit MEDIA_DIR's variants).
   */
  protectedDirs?: readonly string[];
  env: Record<string, string | undefined>;
  log: Logger;
  now: () => Date;
}

export class TargetStore {
  private readonly opts: TargetStoreOptions;
  private cache: { key: string; targets: StoredTarget[] } | null = null;
  /** The env bootstrap failed once: do not re-validate (and warn) on every list(). */
  private bootstrapFailed = false;

  constructor(opts: TargetStoreOptions) {
    this.opts = opts;
  }

  get file(): string {
    return this.opts.file;
  }

  list(): StoredTarget[] {
    return this.load().map((t) => structuredClone(t));
  }

  get(id: string): StoredTarget | undefined {
    const t = this.load().find((x) => x.id === id);
    return t ? structuredClone(t) : undefined;
  }

  /** Validates, merges secrets (absent = keep, null = remove) and persists. */
  save(input: unknown): StoredTarget {
    const parsed = PublishTargetInput.safeParse(input);
    if (!parsed.success) throw new PublishError('config', `Invalid target: ${z.prettifyError(parsed.error)}`);
    const data = parsed.data;
    const targets = this.load();
    const existing = targets.find((t) => t.id === data.id);
    const now = this.opts.now().toISOString();
    const createdAt = existing?.createdAt ?? now;
    const label = data.label === undefined ? existing?.label : (data.label ?? undefined);
    const enabled = data.enabled ?? existing?.enabled ?? true;
    const publicBaseUrl =
      data.publicBaseUrl === undefined ? (existing?.publicBaseUrl ?? null) : (data.publicBaseUrl ?? null);

    const publish = data.publish ?? existing?.publish;
    let next: StoredTarget;
    if (data.kind === 'local') {
      const abs = (p: string) => (isAbsolute(p) ? resolve(p) : resolve(this.opts.baseDir, p));
      const dir = abs(data.dir);
      assertLocalDirAllowed(dir, this.opts.outDir, this.opts.protectedDirs);
      const prevLocal = existing?.kind === 'local' ? existing : undefined;
      const gateDir =
        data.gateDir === undefined ? prevLocal?.gateDir : data.gateDir === null ? undefined : abs(data.gateDir);
      if (gateDir) assertLocalDirAllowed(gateDir, this.opts.outDir, this.opts.protectedDirs);
      const accessStoreDir =
        data.accessStoreDir === undefined
          ? prevLocal?.accessStoreDir
          : data.accessStoreDir === null
            ? undefined
            : abs(data.accessStoreDir);
      if (accessStoreDir) assertLocalDirAllowed(accessStoreDir, this.opts.outDir, this.opts.protectedDirs);
      next = {
        id: data.id,
        kind: 'local',
        enabled,
        publicBaseUrl,
        dir,
        ...(gateDir ? { gateDir } : {}),
        ...(accessStoreDir ? { accessStoreDir } : {}),
        createdAt,
        updatedAt: now,
      };
    } else {
      const prev = existing?.kind === 'sftp' ? existing : undefined;
      const pick = (v: string | null | undefined, old: string | undefined) =>
        v === undefined ? old : (v ?? undefined);
      const password = pick(data.password, prev?.password);
      const privateKey = pick(data.privateKey, prev?.privateKey);
      const privateKeyPath = pick(data.privateKeyPath, prev?.privateKeyPath);
      const passphrase = pick(data.passphrase, prev?.passphrase);
      if (!password && !privateKey && !privateKeyPath) {
        throw new PublishError('config', 'An SFTP target needs a password, a private key or a private key file');
      }
      if (privateKey) assertPrivateKey(privateKey, passphrase);
      if (privateKeyPath) {
        const keyFile = resolveKeyPath(privateKeyPath, this.opts.configDir);
        if (!existsSync(keyFile)) throw new PublishError('config', `Private key file not found: ${privateKeyPath}`);
        assertPrivateKey(readFileSync(keyFile, 'utf8'), passphrase);
      }
      const hostChanged = prev !== undefined && prev.host.toLowerCase() !== data.host.toLowerCase();
      const hostKeys = data.hostKeys ?? (prev && !hostChanged ? prev.hostKeys : defaultHostKeys(data.host));
      next = {
        id: data.id,
        kind: 'sftp',
        enabled,
        publicBaseUrl,
        host: data.host,
        port: data.port ?? prev?.port ?? 22,
        username: data.username,
        ...(password ? { password } : {}),
        ...(privateKey ? { privateKey } : {}),
        ...(privateKeyPath ? { privateKeyPath } : {}),
        ...(passphrase ? { passphrase } : {}),
        hostKeys: [...new Set(hostKeys)],
        trustOnFirstUse: data.trustOnFirstUse ?? prev?.trustOnFirstUse ?? false,
        remoteRoot: data.remoteRoot ?? prev?.remoteRoot ?? '/',
        concurrency: data.concurrency ?? prev?.concurrency ?? DEFAULT_CONCURRENCY,
        ...pickRoot('gateRoot', data.gateRoot, prev?.gateRoot),
        ...pickRoot('accessStoreRoot', data.accessStoreRoot, prev?.accessStoreRoot),
        createdAt,
        updatedAt: now,
      };
    }
    if (label) next.label = label;
    if (publish !== undefined) next.publish = publish;
    const checked = StoredTarget.parse(next);
    this.write(existing ? targets.map((t) => (t.id === checked.id ? checked : t)) : [...targets, checked]);
    return structuredClone(checked);
  }

  remove(id: string): boolean {
    const targets = this.load();
    if (!targets.some((t) => t.id === id)) return false;
    this.write(targets.filter((t) => t.id !== id));
    return true;
  }

  /** Trust-on-first-use: pins the host key seen on the first successful connection. */
  pinHostKey(id: string, fingerprint: string): void {
    const targets = this.load();
    const t = targets.find((x) => x.id === id);
    if (t?.kind !== 'sftp' || t.hostKeys.length > 0) return;
    const pinned: StoredSftpTarget = { ...t, hostKeys: parseFingerprints([fingerprint]), updatedAt: this.now() };
    this.write(targets.map((x) => (x.id === id ? pinned : x)));
  }

  private now(): string {
    return this.opts.now().toISOString();
  }

  private load(): StoredTarget[] {
    const { file, log } = this.opts;
    let st: Stats | undefined;
    try {
      st = statSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (!st) {
      this.cache = null;
      if (this.bootstrapFailed) return [];
      let boot: StoredSftpTarget | null = null;
      try {
        boot = bootstrapTargetFromEnv(this.opts.env, this.opts.now());
      } catch (err) {
        this.bootstrapFailed = true;
        log.warn({ err: (err as Error).message }, 'publisher: ignoring SFTP_* environment (invalid target)');
      }
      if (!boot) return [];
      this.write([boot]);
      log.info({ target: boot.id }, 'publisher: bootstrapped publish target from environment');
      return [boot];
    }
    const key = `${st.size}:${st.mtimeMs}:${st.ino}`;
    if (this.cache?.key === key) return this.cache.targets;
    if ((st.mode & 0o077) !== 0) {
      chmodSync(file, 0o600);
      log.warn({ file }, 'publisher: targets.json was readable by others; mode fixed to 0600');
    }
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      // Never echo the parser message: V8 quotes the text around the error, i.e. maybe a secret.
      throw new PublishError('config', `${file} is not valid JSON${jsonErrorPosition(err)}`);
    }
    const parsed = TargetsFile.safeParse(json);
    if (!parsed.success) throw new PublishError('config', `${file} is invalid: ${z.prettifyError(parsed.error)}`);
    this.cache = { key, targets: parsed.data.targets };
    return parsed.data.targets;
  }

  private write(targets: StoredTarget[]): void {
    const body: TargetsFile = { format: 1, targets };
    writeFileAtomic(this.opts.file, `${JSON.stringify(body, null, 2)}\n`, 0o600);
    this.cache = null;
  }
}

/** An optional remote root of an input: absent = keep the stored one, null = remove it. */
function pickRoot<K extends string>(
  key: K,
  value: string | null | undefined,
  old: string | undefined,
): Partial<Record<K, string>> {
  const v = value === undefined ? old : (value ?? undefined);
  return v ? ({ [key]: v } as Record<K, string>) : {};
}

/** " (line 3 column 14)" / " (position 52)" from a JSON.parse error, without any file content. */
function jsonErrorPosition(err: unknown): string {
  const msg = err instanceof Error ? err.message : '';
  const lc = /\(line (\d+) column (\d+)\)/.exec(msg);
  if (lc) return ` (line ${lc[1]} column ${lc[2]})`;
  const pos = /at position (\d+)/.exec(msg);
  return pos ? ` (position ${pos[1]})` : '';
}

/** The SFTP target described by SFTP_* / SITE_BASE_URL, or null when SFTP_HOST is unset. */
export function bootstrapTargetFromEnv(env: Record<string, string | undefined>, now: Date): StoredSftpTarget | null {
  const v = (k: string) => {
    const x = env[k];
    return x === undefined || x.trim() === '' ? undefined : x;
  };
  const host = v('SFTP_HOST')?.trim();
  if (!host) return null;
  const username = v('SFTP_USER')?.trim();
  const password = v('SFTP_PASSWORD');
  const privateKeyPath = v('SFTP_PRIVATE_KEY_PATH')?.trim();
  if (!username) throw new PublishError('config', 'SFTP_USER is required with SFTP_HOST');
  if (!password && !privateKeyPath) {
    throw new PublishError('config', 'SFTP_PASSWORD or SFTP_PRIVATE_KEY_PATH is required with SFTP_HOST');
  }
  const port = v('SFTP_PORT') ? Number.parseInt(v('SFTP_PORT') ?? '', 10) : 22;
  const fp = v('SFTP_HOST_FINGERPRINT');
  const tofu = /^(?:1|true|yes)$/i.test(v('SFTP_TRUST_ON_FIRST_USE') ?? '');
  const iso = now.toISOString();
  const candidate = {
    id: v('SFTP_TARGET_ID')?.trim() ?? DEFAULT_SFTP_TARGET_ID,
    kind: 'sftp',
    enabled: true,
    publicBaseUrl: v('SITE_BASE_URL')?.trim() ?? v('SITE_PUBLIC_URL')?.trim() ?? null,
    host,
    port,
    username,
    ...(password ? { password } : {}),
    ...(privateKeyPath ? { privateKeyPath } : {}),
    ...(v('SFTP_PASSPHRASE') ? { passphrase: v('SFTP_PASSPHRASE') } : {}),
    hostKeys: fp ? parseFingerprints(fp) : defaultHostKeys(host),
    trustOnFirstUse: tofu,
    remoteRoot: v('SFTP_REMOTE_ROOT')?.trim() ?? '/',
    concurrency: DEFAULT_CONCURRENCY,
    createdAt: iso,
    updatedAt: iso,
  };
  const parsed = StoredTarget.safeParse(candidate);
  if (!parsed.success) {
    // Report field names only: values may be secrets.
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new PublishError('config', `Invalid SFTP_* environment (fields: ${fields})`);
  }
  return parsed.data as StoredSftpTarget;
}

const EMPTY_STATUS: TargetStatusPublic = {
  lastDeploy: null,
  deployedVersion: null,
  deployedAt: null,
  authBlocked: null,
  deferredDeletes: 0,
};

/** Target without secrets (control UI, CLI, logs). */
export function toPublic(t: StoredTarget, status: TargetStatusPublic = EMPTY_STATUS): PublishTargetPublic {
  const base = {
    id: t.id,
    label: t.label ?? null,
    enabled: t.enabled,
    publish: t.publish !== false,
    publicBaseUrl: t.publicBaseUrl,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    status,
  };
  if (t.kind === 'local') {
    return { ...base, kind: 'local', dir: t.dir, gateDir: t.gateDir ?? null, accessStoreDir: t.accessStoreDir ?? null };
  }
  const hasKey = Boolean(t.privateKey || t.privateKeyPath);
  return {
    ...base,
    kind: 'sftp',
    host: t.host,
    port: t.port,
    username: t.username,
    auth: hasKey ? 'key' : t.password ? 'password' : 'none',
    hasPassword: Boolean(t.password),
    hasPrivateKey: hasKey,
    hasPassphrase: Boolean(t.passphrase),
    privateKeyPath: t.privateKeyPath ?? null,
    hostKeys: [...t.hostKeys],
    trustOnFirstUse: t.trustOnFirstUse,
    remoteRoot: t.remoteRoot,
    concurrency: t.concurrency,
    gateRoot: t.gateRoot ?? null,
    accessStoreRoot: t.accessStoreRoot ?? null,
  };
}

/**
 * Gate mode (spec-wave5 §5.6.1): why `t` cannot carry the gate, or null. A publishing target needs
 * gateRoot/gateDir, and its content root must be gateRoot/<secret> (dir = gateDir/<secret>).
 */
export function gateTargetProblem(t: StoredTarget, secret: string): string | null {
  if (t.publish === false) return null;
  if (t.kind === 'sftp') {
    if (!t.gateRoot) return `target ${t.id}: gate mode needs gateRoot (the web root, usually "/")`;
    const expected = t.gateRoot === '/' ? `/${secret}` : `${t.gateRoot}/${secret}`;
    if (t.remoteRoot !== expected)
      return `target ${t.id}: remoteRoot must be ${expected} (gateRoot + "/" + the content folder)`;
    return null;
  }
  if (!t.gateDir) return `target ${t.id}: gate mode needs gateDir (the local web root)`;
  if (resolve(t.dir) !== resolve(t.gateDir, secret)) {
    return `target ${t.id}: dir must be ${resolve(t.gateDir, secret)} (gateDir + "/" + the content folder)`;
  }
  return null;
}

/** Identity of the place a target writes to; a change invalidates the deployed state. */
export function destinationKey(t: StoredTarget): string {
  return t.kind === 'local' ? `local:${t.dir}` : `sftp:${t.username}@${t.host.toLowerCase()}:${t.port}:${t.remoteRoot}`;
}

export function resolveKeyPath(p: string, configDir: string): string {
  return isAbsolute(p) ? p : resolve(configDir, p);
}

/** Absolute local target dir as stored (re-checks the overlap rules). */
export function localTargetDir(t: StoredLocalTarget, outDir: string, protectedDirs: readonly string[] = []): string {
  assertLocalDirAllowed(t.dir, outDir, protectedDirs);
  return t.dir;
}

function assertLocalDirAllowed(dir: string, outDir: string, protectedDirs: readonly string[] = []): void {
  const inside = (child: string, parent: string) => {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  const overlaps = (other: string) => inside(dir, resolve(other)) || inside(resolve(other), dir);
  if (dir === '/' || dir === resolve('/')) throw new PublishError('config', 'A local target cannot be "/"');
  if (overlaps(outDir)) {
    throw new PublishError('config', 'A local target must not be OUT_DIR or contain/lie inside it');
  }
  if (protectedDirs.some(overlaps)) {
    throw new PublishError(
      'config',
      'A local target must not be, contain or lie inside a backend state directory (DATA_DIR, ARCHIVE_DIR, CONFIG_DIR, MEDIA_DIR)',
    );
  }
}

function assertPrivateKey(key: string, passphrase: string | undefined): void {
  const parsed = ssh2.utils.parseKey(key, passphrase);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || first instanceof Error) {
    throw new PublishError('config', `Unusable private key: ${first instanceof Error ? first.message : 'empty'}`);
  }
  if (!first.isPrivateKey()) throw new PublishError('config', 'The key is not a private key');
}

/** Writes via a temp file in the same directory: fsync, rename, fsync directory. */
export function writeFileAtomic(file: string, text: string, mode = 0o600): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'wx', mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    unlinkSync(tmp);
    throw err;
  }
  closeSync(fd);
  try {
    chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
  try {
    const dfd = openSync(dir, 'r');
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Directory fsync is not supported everywhere (e.g. some network filesystems).
  }
}
