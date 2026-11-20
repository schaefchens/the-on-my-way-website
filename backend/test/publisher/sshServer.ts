/**
 * In-process SSH + SFTP server (ssh2 Server) over an in-memory filesystem, for connector tests.
 * SFTP v3 semantics like OpenSSH: RENAME fails when the target exists; no posix-rename extension
 * (ssh2's server does not advertise extensions).
 */
import { timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';
import type { AuthenticationType, Connection, ParsedKey, SFTPWrapper } from 'ssh2';
import ssh2 from 'ssh2';
import { fingerprintOf } from '../../src/publisher/hostkeys.js';

// ssh2 is CommonJS: Server/utils are not ESM named exports under plain Node.
const { Server, utils } = ssh2;
const { STATUS_CODE, OPEN_MODE } = utils.sftp;

export type AuthMethod = Extract<AuthenticationType, 'password' | 'keyboard-interactive' | 'publickey'>;

export interface TestSshServer {
  port: number;
  hostKeyFingerprint: string;
  files: Map<string, Buffer>;
  dirs: Set<string>;
  /** Permission bits per path (create mode minus `umask`, then SETSTAT/FSETSTAT), like OpenSSH. */
  modes: Map<string, number>;
  /** Credential attempts (method "none" is not recorded). */
  authAttempts: { method: string; ok: boolean }[];
  connections: number;
  close(): Promise<void>;
}

export async function startSshServer(opts: {
  port: number;
  password?: string;
  publicKey?: string;
  methods?: AuthMethod[];
  /**
   * What the server does after a rejected credential: 'reject' (USERAUTH_FAILURE, the default),
   * 'close' (drop the connection without a reason) or 'disconnect' (SSH DISCONNECT 14,
   * "no more auth methods available", like hosts that end the session after a wrong password).
   */
  failedAuth?: 'reject' | 'close' | 'disconnect';
  /** Applied to the mode of created files and directories (default 0o022). */
  umask?: number;
}): Promise<TestSshServer> {
  const host = utils.generateKeyPairSync('ed25519');
  const hostBlob = Buffer.from(host.public.split(' ')[1] as string, 'base64');
  const methods = opts.methods ?? ['password'];
  const allowedKey = opts.publicKey ? (utils.parseKey(opts.publicKey) as ParsedKey) : null;
  const state: TestSshServer = {
    port: opts.port,
    hostKeyFingerprint: fingerprintOf(hostBlob),
    files: new Map(),
    dirs: new Set(['/']),
    modes: new Map([['/', 0o755]]),
    authAttempts: [],
    connections: 0,
    close: async () => {},
  };
  const clients = new Set<Connection>();

  const server = new Server({ hostKeys: [host.private] }, (client) => {
    state.connections++;
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    const failed = (ctx: { reject: (m?: AuthenticationType[]) => void }) => {
      if (opts.failedAuth === 'close') return client.end();
      if (opts.failedAuth === 'disconnect') {
        (client as unknown as { _protocol: { disconnect(reason: number): void } })._protocol.disconnect(14);
        return client.end();
      }
      return ctx.reject(methods);
    };
    client.on('authentication', (ctx) => {
      if (ctx.method === 'none' || !methods.includes(ctx.method as AuthMethod)) return ctx.reject(methods);
      if (ctx.method === 'password') {
        const ok = ctx.password === opts.password;
        state.authAttempts.push({ method: 'password', ok });
        return ok ? ctx.accept() : failed(ctx);
      }
      if (ctx.method === 'keyboard-interactive') {
        return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => {
          const ok = answers[0] === opts.password;
          state.authAttempts.push({ method: 'keyboard-interactive', ok });
          if (ok) ctx.accept();
          else ctx.reject(methods);
        });
      }
      if (ctx.method === 'publickey') {
        const want = allowedKey?.getPublicSSH();
        const same =
          allowedKey !== null &&
          ctx.key.algo === allowedKey.type &&
          Buffer.isBuffer(want) &&
          want.length === ctx.key.data.length &&
          timingSafeEqual(want, ctx.key.data);
        if (!same) {
          state.authAttempts.push({ method: 'publickey', ok: false });
          return ctx.reject(methods);
        }
        if (!ctx.signature) return ctx.accept(); // key query: "this key would be accepted"
        const ok = allowedKey.verify(ctx.blob as Buffer, ctx.signature, ctx.hashAlgo) === true;
        state.authAttempts.push({ method: 'publickey', ok });
        return ok ? ctx.accept() : ctx.reject(methods);
      }
      return ctx.reject(methods);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp) => serveSftp(acceptSftp(), state, opts.umask));
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolve());
  });
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const c of clients) c.end();
      server.close(() => resolve());
    });
  return state;
}

function serveSftp(sftp: SFTPWrapper, fs: TestSshServer, umask = 0o022): void {
  type H = { path: string; kind: 'file' | 'dir'; listed?: boolean };
  const handles = new Map<number, H>();
  let next = 1;
  const newHandle = (h: H) => {
    const id = next++;
    handles.set(id, h);
    const b = Buffer.alloc(4);
    b.writeUInt32BE(id);
    return b;
  };
  const getHandle = (b: Buffer) => (b.length === 4 ? handles.get(b.readUInt32BE(0)) : undefined);
  const norm = (p: string) => posix.normalize(p.startsWith('/') ? p : `/${p}`);
  const attrsOf = (p: string) => {
    if (fs.dirs.has(p)) return { mode: 0o040755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 };
    const f = fs.files.get(p);
    return f ? { mode: 0o100644, uid: 0, gid: 0, size: f.length, atime: 0, mtime: 0 } : null;
  };

  const modeOf = (attrs: unknown, fallback: number) => {
    const m = (attrs as { mode?: unknown } | undefined)?.mode;
    return (typeof m === 'number' ? m & 0o7777 : fallback) & ~umask;
  };
  const setMode = (p: string, attrs: unknown) => {
    const m = (attrs as { mode?: unknown } | undefined)?.mode;
    if (typeof m === 'number') fs.modes.set(p, m & 0o7777);
  };
  sftp.on('OPEN', (reqid, filename, flags, attrs) => {
    const p = norm(filename);
    if (flags & OPEN_MODE.WRITE) {
      if (!fs.dirs.has(posix.dirname(p)) || fs.dirs.has(p)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
      if (!fs.files.has(p)) fs.modes.set(p, modeOf(attrs, 0o666));
      if (flags & OPEN_MODE.TRUNC || !fs.files.has(p)) fs.files.set(p, Buffer.alloc(0));
      return sftp.handle(reqid, newHandle({ path: p, kind: 'file' }));
    }
    if (!fs.files.has(p)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    return sftp.handle(reqid, newHandle({ path: p, kind: 'file' }));
  });
  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const h = getHandle(handle);
    if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE);
    const cur = fs.files.get(h.path) ?? Buffer.alloc(0);
    const end = Number(offset) + data.length;
    const buf = end > cur.length ? Buffer.concat([cur, Buffer.alloc(end - cur.length)]) : Buffer.from(cur);
    data.copy(buf, Number(offset));
    fs.files.set(h.path, buf);
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on('READ', (reqid, handle, offset, length) => {
    const h = getHandle(handle);
    const f = h && fs.files.get(h.path);
    if (!f) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (Number(offset) >= f.length) return sftp.status(reqid, STATUS_CODE.EOF);
    sftp.data(reqid, f.subarray(Number(offset), Number(offset) + length));
  });
  sftp.on('FSTAT', (reqid, handle) => {
    const h = getHandle(handle);
    const a = h && attrsOf(h.path);
    return a ? sftp.attrs(reqid, a) : sftp.status(reqid, STATUS_CODE.FAILURE);
  });
  sftp.on('CLOSE', (reqid, handle) => {
    const b = handle as Buffer;
    if (b.length === 4) handles.delete(b.readUInt32BE(0));
    sftp.status(reqid, STATUS_CODE.OK);
  });
  const stat = (reqid: number, path: string) => {
    const a = attrsOf(norm(path));
    return a ? sftp.attrs(reqid, a) : sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
  };
  sftp.on('STAT', stat);
  sftp.on('LSTAT', stat);
  sftp.on('SETSTAT', (reqid, path, attrs) => {
    const p = norm(path);
    if (!fs.files.has(p) && !fs.dirs.has(p)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    setMode(p, attrs);
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on('FSETSTAT', (reqid, handle, attrs) => {
    const h = getHandle(handle);
    if (h) setMode(h.path, attrs);
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on('MKDIR', (reqid, path, attrs) => {
    const p = norm(path);
    if (fs.dirs.has(p) || fs.files.has(p)) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (!fs.dirs.has(posix.dirname(p))) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    fs.dirs.add(p);
    fs.modes.set(p, modeOf(attrs, 0o777));
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on('RMDIR', (reqid, path) => {
    const p = norm(path);
    if (!fs.dirs.has(p)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    const prefix = `${p}/`;
    if ([...fs.files.keys(), ...fs.dirs].some((x) => x.startsWith(prefix)))
      return sftp.status(reqid, STATUS_CODE.FAILURE);
    fs.dirs.delete(p);
    fs.modes.delete(p);
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on('REMOVE', (reqid, path) => {
    const p = norm(path);
    if (!fs.files.delete(p)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    fs.modes.delete(p);
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on('RENAME', (reqid, oldPath, newPath) => {
    const a = norm(oldPath);
    const b = norm(newPath);
    const data = fs.files.get(a);
    if (!data) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    if (fs.files.has(b) || fs.dirs.has(b)) return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (!fs.dirs.has(posix.dirname(b))) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    fs.files.delete(a);
    fs.files.set(b, data);
    const mode = fs.modes.get(a);
    fs.modes.delete(a);
    if (mode !== undefined) fs.modes.set(b, mode);
    sftp.status(reqid, STATUS_CODE.OK);
  });
  sftp.on('OPENDIR', (reqid, path) => {
    const p = norm(path);
    if (!fs.dirs.has(p)) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    sftp.handle(reqid, newHandle({ path: p, kind: 'dir' }));
  });
  sftp.on('READDIR', (reqid, handle) => {
    const h = getHandle(handle);
    if (h?.kind !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE);
    if (h.listed) return sftp.status(reqid, STATUS_CODE.EOF);
    h.listed = true;
    const prefix = h.path === '/' ? '/' : `${h.path}/`;
    const names = [...fs.dirs, ...fs.files.keys()]
      .filter((x) => x !== h.path && x.startsWith(prefix) && !x.slice(prefix.length).includes('/'))
      .map((x) => ({ filename: x.slice(prefix.length), longname: x.slice(prefix.length), attrs: attrsOf(x) ?? {} }));
    sftp.name(reqid, names as never);
  });
  sftp.on('REALPATH', (reqid, path) => {
    const p = norm(path === '.' ? '/' : path);
    sftp.name(reqid, [{ filename: p, longname: p, attrs: {} }] as never);
  });
}
