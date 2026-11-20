/**
 * SFTP connector (ssh2). One SSH connection with one SFTP channel; operations may run
 * concurrently on it (SFTP requests are pipelined by request id).
 *
 * Security and politeness rules:
 * - The host key must match a pinned "SHA256:…" fingerprint. Without pins the connection is
 *   refused, unless trustOnFirstUse is set: then the first key seen is accepted and reported
 *   through onTrustedFirstUse (the caller pins it).
 * - Exactly ONE credential is offered per login (key, or password via "password", or
 *   "keyboard-interactive" when the server only offers that). An authentication failure is
 *   reported as PublishError('auth') and is never retried by the publisher. Once the credential
 *   has been sent, ANY failure before the session is ready (the server closing the connection or
 *   sending DISCONNECT instead of USERAUTH_FAILURE, a timeout while it "thinks") also counts as
 *   an authentication failure: some hosts drop the connection after a wrong password, and
 *   retrying would send the same wrong password again (hosts may ban the client for that).
 * - The client and the SFTP channel always have an 'error' listener, so a late socket or
 *   protocol error (after a failed login, or between login and channel open) can never surface
 *   as an unhandled 'error' event that would crash the process.
 * - Uploads go through writeFile (parallel 32 KiB writes) or uploadFile (ssh2 fastPut).
 * - replace() uses posix-rename@openssh.com when the server offers it (atomic overwrite);
 *   otherwise plain RENAME, and when that fails because the target exists, delete + rename.
 */
import type { Client, ConnectConfig, SFTPWrapper, Stats } from 'ssh2';
import ssh2 from 'ssh2';
import type { Logger } from '../log.js';
import { fingerprintOf, keyTypeOf } from './hostkeys.js';
import { type RemoteEntry, RemoteError, type RemoteFs, type RemoteStat, runPool, withTimeout } from './remote.js';
import { PublishError } from './types.js';

export interface SftpConnectOptions {
  host: string;
  port: number;
  username: string;
  password?: string | undefined;
  privateKey?: string | Buffer | undefined;
  passphrase?: string | undefined;
  /** Accepted host key fingerprints ("SHA256:…"). */
  hostKeys: readonly string[];
  trustOnFirstUse: boolean;
  /** Called after a successful login when the key was accepted by trust-on-first-use. */
  onTrustedFirstUse?: (fingerprint: string, keyType: string | null) => void;
  /** Handshake + authentication deadline (default 20 s). */
  readyTimeoutMs?: number;
  /** Deadline for a single small operation (default 60 s). */
  opTimeoutMs?: number;
  log?: Logger;
}

const CHUNK = 32 * 1024;
const WRITE_WINDOW = 32;
/** Minimum assumed throughput for upload deadlines (bytes/s). */
const MIN_RATE = 32 * 1024;

const SFTP_STATUS = { NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4, OP_UNSUPPORTED: 8 } as const;

export interface SftpRemote extends RemoteFs {
  readonly hostKey: { fingerprint: string; type: string | null } | null;
  readonly negotiated: { hostKeyAlgorithm?: string; cipher?: string } | null;
}

export async function connectSftp(opts: SftpConnectOptions): Promise<SftpRemote> {
  const client = new ssh2.Client();
  // Permanent listener: without one, a socket error after the connect promise settled (e.g. a
  // reset after a failed login) would be an unhandled 'error' event and crash the process.
  client.on('error', (err: Error) => opts.log?.debug({ err: err.message }, 'sftp: connection error'));
  let seen: { fingerprint: string; type: string | null } | null = null;
  let negotiated: SftpRemote['negotiated'] = null;
  const usingKey = opts.privateKey !== undefined;
  let credentialSent = false;

  const hostVerifier = (key: Buffer): boolean => {
    seen = { fingerprint: fingerprintOf(key), type: keyTypeOf(key) };
    if (opts.hostKeys.length > 0) return opts.hostKeys.includes(seen.fingerprint);
    return opts.trustOnFirstUse;
  };

  // ssh2 passes null before the first round trip (types say string[]); `false` ends authentication.
  const chooseAuth = (methodsLeft: string[] | null): unknown => {
    if (methodsLeft === null) return { type: 'none', username: opts.username };
    if (credentialSent) return false; // never offer a second credential
    const allowed = new Set(methodsLeft);
    if (usingKey && allowed.has('publickey')) {
      credentialSent = true;
      return {
        type: 'publickey',
        username: opts.username,
        key: opts.privateKey,
        ...(opts.passphrase ? { passphrase: opts.passphrase } : {}),
      };
    }
    if (!usingKey && opts.password !== undefined) {
      const password = opts.password;
      if (allowed.has('password')) {
        credentialSent = true;
        return { type: 'password', username: opts.username, password };
      }
      if (allowed.has('keyboard-interactive')) {
        credentialSent = true;
        return {
          type: 'keyboard-interactive',
          username: opts.username,
          prompt: (_n: string, _i: string, _l: string, prompts: unknown[], finish: (r: string[]) => void) =>
            finish(prompts.map(() => password)),
        };
      }
    }
    return false;
  };
  const authHandler = (methodsLeft: string[] | null, _partial: boolean, next: (auth: unknown) => void): void => {
    next(chooseAuth(methodsLeft));
  };

  const config: ConnectConfig = {
    host: opts.host,
    port: opts.port,
    username: opts.username,
    readyTimeout: opts.readyTimeoutMs ?? 20_000,
    keepaliveInterval: 10_000,
    keepaliveCountMax: 3,
    hostVerifier,
    authHandler: authHandler as unknown as ConnectConfig['authHandler'],
  };

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const done = (err?: unknown) => {
      if (settled) return;
      settled = true;
      client.off('ready', onReady);
      client.off('error', onError);
      client.off('close', onClose);
      if (err) {
        client.end();
        reject(err);
      } else resolve();
    };
    const onReady = () => done();
    const onError = (err: Error & { level?: string; code?: string }) =>
      done(classifyConnectError(err, seen, opts, credentialSent));
    const onClose = () =>
      done(
        credentialSent
          ? afterCredentialError(opts, 'the server closed the connection')
          : new RemoteError('connection', 'Connection closed during the SSH handshake'),
      );
    client.on('ready', onReady);
    client.on('error', onError);
    client.on('close', onClose);
    client.on('handshake', (n: { serverHostKey?: string; cs?: { cipher?: string } }) => {
      negotiated = {
        ...(n.serverHostKey ? { hostKeyAlgorithm: n.serverHostKey } : {}),
        ...(n.cs?.cipher ? { cipher: n.cs.cipher } : {}),
      };
    });
    try {
      client.connect(config);
    } catch (err) {
      done(new PublishError('config', `Cannot connect: ${(err as Error).message}`));
    }
  });

  const hostKey = seen as { fingerprint: string; type: string | null } | null;
  if (opts.hostKeys.length === 0 && hostKey) opts.onTrustedFirstUse?.(hostKey.fingerprint, hostKey.type);

  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    const onClose = () => reject(new RemoteError('connection', 'Connection closed before the SFTP channel opened'));
    client.once('close', onClose);
    client.sftp((err, s) => {
      client.off('close', onClose);
      if (err) {
        client.end();
        reject(new RemoteError('connection', `SFTP subsystem unavailable: ${err.message}`, err));
      } else {
        // Fatal SFTP protocol errors are emitted as 'error' on the channel: never unhandled.
        s.on('error', (e: Error) => opts.log?.warn({ err: e.message }, 'sftp: channel error'));
        resolve(s);
      }
    });
  });
  return new Ssh2Remote(client, sftp, opts, hostKey, negotiated);
}

function classifyConnectError(
  err: Error & { level?: string; code?: string },
  seen: { fingerprint: string; type: string | null } | null,
  opts: SftpConnectOptions,
  credentialSent: boolean,
): PublishError {
  const where = `${opts.username}@${opts.host}:${opts.port}`;
  if (err.level !== 'client-authentication' && credentialSent && !/Host denied/i.test(err.message)) {
    return afterCredentialError(opts, err.message, err);
  }
  if (err.level === 'client-authentication') {
    return new PublishError(
      'auth',
      credentialSent
        ? `SSH authentication failed for ${where} (credentials rejected; not retrying)`
        : `SSH authentication failed for ${where} (no acceptable method offered by the server; not retrying)`,
      { cause: err },
    );
  }
  if (/Host denied/i.test(err.message)) {
    const got = seen ? `${seen.fingerprint}${seen.type ? ` (${seen.type})` : ''}` : 'unknown';
    const msg =
      opts.hostKeys.length > 0
        ? `Host key of ${opts.host} does not match the pinned fingerprint(s); server offered ${got}`
        : `Host key of ${opts.host} is not pinned (server offered ${got}); pin it or enable trust-on-first-use`;
    return new PublishError('host_key', msg, { cause: err });
  }
  if (err.level === 'client-timeout') return new RemoteError('timeout', `SSH handshake with ${where} timed out`, err);
  if (err.level === 'client-socket' || err.level === 'client-dns' || err.code) {
    return new RemoteError('connection', `Cannot reach ${where}: ${err.message}`, err);
  }
  return new PublishError('connection', `SSH handshake with ${where} failed: ${err.message}`, { cause: err });
}

/** Failure after the credential was sent and before the session was ready: never retried. */
function afterCredentialError(opts: SftpConnectOptions, what: string, cause?: unknown): PublishError {
  return new PublishError(
    'auth',
    `SSH login to ${opts.username}@${opts.host}:${opts.port} failed after the credentials were sent (${what}); treated as an authentication failure, not retrying`,
    cause === undefined ? {} : { cause },
  );
}

type Cb<T> = (err: (Error & { code?: number | string }) | null | undefined, value?: T) => void;

/** Remote modes are explicit: public files 0644, directories 0755 (never the local file's mode). */
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

class Ssh2Remote implements SftpRemote {
  readonly description: string;
  readonly hostKey: SftpRemote['hostKey'];
  readonly negotiated: SftpRemote['negotiated'];
  private posixRename: boolean;
  private closed = false;
  private readonly opTimeoutMs: number;
  private readonly client: Client;
  private readonly sftp: SFTPWrapper;
  private readonly log: Logger | undefined;
  private chmodWarned = false;

  constructor(
    client: Client,
    sftp: SFTPWrapper,
    opts: SftpConnectOptions,
    hostKey: SftpRemote['hostKey'],
    negotiated: SftpRemote['negotiated'],
  ) {
    this.client = client;
    this.sftp = sftp;
    this.description = `sftp://${opts.username}@${opts.host}:${opts.port}`;
    this.hostKey = hostKey;
    this.negotiated = negotiated;
    this.opTimeoutMs = opts.opTimeoutMs ?? 60_000;
    this.log = opts.log;
    // ssh2 keeps the server's SFTP extensions in a private field; ext_openssh_rename() checks it.
    const ext = (sftp as unknown as { _extensions?: Record<string, string> })._extensions;
    this.posixRename = ext?.['posix-rename@openssh.com'] === '1';
    const markClosed = () => {
      this.closed = true;
    };
    client.on('close', markClosed);
    client.on('error', (err) => {
      opts.log?.warn({ err: err.message }, 'sftp: connection error');
      markClosed();
    });
    sftp.on('close', markClosed);
  }

  get atomicReplace(): boolean {
    return this.posixRename;
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    await withTimeout(
      this.opTimeoutMs + (data.length / MIN_RATE) * 1000,
      `upload ${path}`,
      async () => {
        const handle = await this.call<Buffer>(`open ${path}`, (cb) =>
          this.sftp.open(path, 'w', { mode: FILE_MODE }, cb),
        );
        let failure: unknown;
        try {
          // The open mode only applies to a new file, minus the server's umask: set it explicitly
          // (pipelined with the writes, so it costs no extra round trip).
          const chmod = this.call<void>(`chmod ${path}`, (cb) => this.sftp.fchmod(handle, FILE_MODE, cb)).catch(
            (err: unknown) => this.chmodFailed(path, err),
          );
          const offsets: number[] = [];
          for (let off = 0; off < data.length; off += CHUNK) offsets.push(off);
          await runPool(offsets, WRITE_WINDOW, async (off) => {
            await this.call(`write ${path}`, (cb) =>
              this.sftp.write(handle, data, off, Math.min(CHUNK, data.length - off), off, cb),
            );
          });
          await chmod;
        } catch (err) {
          failure = err;
        }
        try {
          await this.call(`close ${path}`, (cb) => this.sftp.close(handle, cb));
        } catch (err) {
          failure ??= err;
        }
        if (failure) throw failure;
      },
      () => this.kill(),
    );
  }

  async uploadFile(localPath: string, path: string, size: number): Promise<void> {
    await withTimeout(
      this.opTimeoutMs + (size / MIN_RATE) * 1000,
      `upload ${path}`,
      () =>
        this.call(`upload ${path}`, (cb) =>
          this.sftp.fastPut(localPath, path, { concurrency: WRITE_WINDOW, chunkSize: CHUNK, mode: FILE_MODE }, cb),
        ),
      () => this.kill(),
    );
  }

  async readFile(path: string): Promise<Buffer | null> {
    try {
      return await this.timed(`read ${path}`, (cb) => this.sftp.readFile(path, cb as Cb<Buffer>));
    } catch (err) {
      if (err instanceof RemoteError && err.kind === 'not_found') return null;
      throw err;
    }
  }

  async replace(from: string, to: string): Promise<void> {
    if (this.posixRename) {
      try {
        await this.timed(`rename ${to}`, (cb) => this.sftp.ext_openssh_rename(from, to, cb));
        return;
      } catch (err) {
        if (!(err instanceof Error && /does not support/i.test(err.message))) throw err;
        this.posixRename = false;
      }
    }
    try {
      await this.timed(`rename ${to}`, (cb) => this.sftp.rename(from, to, cb));
    } catch (err) {
      if (!(err instanceof RemoteError) || (err.kind !== 'failure' && err.kind !== 'permission')) throw err;
      if (!(await this.stat(to))) throw err;
      // SFTP v3 RENAME refuses to overwrite: delete + rename (brief window without `to`).
      await this.remove(to);
      await this.timed(`rename ${to}`, (cb) => this.sftp.rename(from, to, cb));
    }
  }

  async remove(path: string): Promise<boolean> {
    try {
      await this.timed(`delete ${path}`, (cb) => this.sftp.unlink(path, cb));
      return true;
    } catch (err) {
      if (err instanceof RemoteError && err.kind === 'not_found') return false;
      throw err;
    }
  }

  async mkdir(path: string): Promise<void> {
    try {
      await this.timed(`mkdir ${path}`, (cb) => this.sftp.mkdir(path, { mode: DIR_MODE }, cb));
    } catch (err) {
      const st = await this.stat(path).catch(() => null);
      if (st?.type === 'dir') return;
      throw err;
    }
    // New directories only (the server's umask applies to the mkdir mode).
    await this.timed(`chmod ${path}`, (cb) => this.sftp.chmod(path, DIR_MODE, cb)).catch((err: unknown) =>
      this.chmodFailed(path, err),
    );
  }

  /** A host that refuses chmod keeps its own default modes: warn once, never fail the deploy. */
  private chmodFailed(path: string, err: unknown): void {
    if (this.chmodWarned) return;
    this.chmodWarned = true;
    this.log?.warn(
      { path, err: err instanceof Error ? err.message : String(err) },
      'sftp: cannot set file modes (files 0644, directories 0755); the host keeps its defaults',
    );
  }

  async rmdir(path: string): Promise<boolean> {
    try {
      await this.timed(`rmdir ${path}`, (cb) => this.sftp.rmdir(path, cb));
      return true;
    } catch (err) {
      if (err instanceof RemoteError && (err.kind === 'not_found' || err.kind === 'failure')) return false;
      throw err;
    }
  }

  async stat(path: string): Promise<RemoteStat | null> {
    try {
      const st = await this.timed<Stats>(`stat ${path}`, (cb) => this.sftp.stat(path, cb as Cb<Stats>));
      return { type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: Number(st.size) };
    } catch (err) {
      if (err instanceof RemoteError && err.kind === 'not_found') return null;
      throw err;
    }
  }

  async list(path: string): Promise<RemoteEntry[]> {
    type Entry = { filename: string; attrs: Stats };
    const entries = await this.timed<Entry[]>(`list ${path}`, (cb) => this.sftp.readdir(path, cb as Cb<Entry[]>));
    return entries
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map((e) => ({
        name: e.filename,
        type: e.attrs.isDirectory() ? 'dir' : e.attrs.isFile() ? 'file' : 'other',
        size: Number(e.attrs.size),
      }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        this.kill();
        resolve();
      }, 3000);
      t.unref?.();
      this.client.once('close', () => {
        clearTimeout(t);
        resolve();
      });
      this.client.end();
    });
    this.closed = true;
  }

  private kill(): void {
    this.closed = true;
    try {
      this.client.destroy();
    } catch {}
  }

  private timed<T>(what: string, fn: (cb: Cb<T>) => void): Promise<T> {
    return withTimeout(
      this.opTimeoutMs,
      what,
      () => this.call(what, fn),
      () => this.kill(),
    );
  }

  private call<T>(what: string, fn: (cb: Cb<T>) => void): Promise<T> {
    if (this.closed) return Promise.reject(new RemoteError('connection', `${what}: connection is closed`));
    return new Promise<T>((resolve, reject) => {
      try {
        fn((err, value) => (err ? reject(mapSftpError(err, what)) : resolve(value as T)));
      } catch (err) {
        reject(err);
      }
    });
  }
}

function mapSftpError(err: Error & { code?: number | string }, what: string): RemoteError {
  const msg = `${what}: ${err.message}`;
  switch (err.code) {
    case SFTP_STATUS.NO_SUCH_FILE:
      return new RemoteError('not_found', msg, err);
    case SFTP_STATUS.PERMISSION_DENIED:
      return new RemoteError('permission', msg, err);
    case SFTP_STATUS.FAILURE:
      return new RemoteError('failure', msg, err);
    case SFTP_STATUS.OP_UNSUPPORTED:
      return new RemoteError('unsupported', msg, err);
    default:
      // No SFTP status: channel closed, "No response from server", socket errors.
      return new RemoteError(typeof err.code === 'number' ? 'failure' : 'connection', msg, err);
  }
}
