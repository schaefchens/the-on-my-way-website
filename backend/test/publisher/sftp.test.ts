/**
 * The real ssh2 connector against in-process SSH/SFTP servers on 127.0.0.1 (backend test ports
 * 19200-19219, see test/helpers.ts TEST_PORTS; tools.test.ts runs in parallel and owns 19208/19209):
 *   19203 main server · 19204 keyboard-interactive · 19205 public key · 19206 servers that drop
 *   the connection after a wrong password · 19207 nothing listening.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectSftp,
  createPublisher,
  type DeployResult,
  PublishError,
  type StoredTarget,
} from '../../src/publisher/index.js';
import { Store } from '../../src/store/index.js';
import { fakeClock, makeTempDir } from '../helpers.js';
import { sftpTarget, silentLog, staticTargets, testConfig } from './helpers.js';
import { assetPaths, referenceProblems, type SiteSpec, writeSite } from './site.js';
import { startSshServer, type TestSshServer } from './sshServer.js';

const PORT = 19203;
const KBD_PORT = 19204;
const KEY_PORT = 19205;
const DROP_PORT = 19206;
const NOTHING_PORT = 19207; // nothing listens here
const PASSWORD = 'correct horse $tapl`e';
const OTHER_FP = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('SFTP connector (ssh2) against a local SSH server', () => {
  let server: TestSshServer;
  const base = () => ({ host: '127.0.0.1', port: PORT, username: 'deploy', trustOnFirstUse: false });

  beforeAll(async () => {
    // A restrictive server umask: the publisher must still produce 0644 files and 0755 dirs.
    server = await startSshServer({ port: PORT, password: PASSWORD, umask: 0o077 });
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    server.authAttempts.length = 0;
  });

  it('logs in with a password, verifies the pinned host key and performs file operations', async () => {
    const remote = await connectSftp({ ...base(), password: PASSWORD, hostKeys: [server.hostKeyFingerprint] });
    expect(remote.hostKey).toEqual({ fingerprint: server.hostKeyFingerprint, type: 'ssh-ed25519' });
    expect(remote.atomicReplace).toBe(false);
    await remote.mkdir('/a');
    await remote.mkdir('/a'); // exists: fine
    await remote.mkdir('/a/b');
    const big = Buffer.alloc(200_000, 7);
    big.write('head');
    await remote.writeFile('/a/b/.omw-tmp.x.bin', big);
    await remote.replace('/a/b/.omw-tmp.x.bin', '/a/b/x.bin');
    expect((await remote.readFile('/a/b/x.bin'))?.equals(big)).toBe(true);
    // Replace an existing file (no posix-rename on this server: delete + rename fallback).
    await remote.writeFile('/a/b/.omw-tmp.x.bin', Buffer.from('v2'));
    await remote.replace('/a/b/.omw-tmp.x.bin', '/a/b/x.bin');
    expect((await remote.readFile('/a/b/x.bin'))?.toString()).toBe('v2');
    expect(await remote.stat('/a/b/x.bin')).toEqual({ type: 'file', size: 2 });
    expect(await remote.stat('/a/b')).toEqual({ type: 'dir', size: 0 });
    expect(await remote.stat('/nope')).toBeNull();
    expect(await remote.readFile('/nope')).toBeNull();
    expect(await remote.list('/a/b')).toEqual([{ name: 'x.bin', type: 'file', size: 2 }]);
    expect(await remote.rmdir('/a/b')).toBe(false); // not empty
    expect(await remote.remove('/a/b/x.bin')).toBe(true);
    expect(await remote.remove('/a/b/x.bin')).toBe(false);
    expect(await remote.rmdir('/a/b')).toBe(true);
    await expect(remote.writeFile('/missing/dir/file', Buffer.from('x'))).rejects.toMatchObject({ kind: 'not_found' });
    await remote.close();
    expect(server.authAttempts).toEqual([{ method: 'password', ok: true }]);
  });

  it('streams large local files with fastPut', async () => {
    const tmp = makeTempDir('publisher-sftp-');
    try {
      const local = join(tmp.dir, 'video.mp4');
      const data = Buffer.alloc(300_000);
      for (let i = 0; i < data.length; i++) data[i] = i % 251;
      writeFileSync(local, data);
      const remote = await connectSftp({ ...base(), password: PASSWORD, hostKeys: [server.hostKeyFingerprint] });
      await remote.uploadFile(local, '/video.mp4', data.length);
      expect(server.files.get('/video.mp4')?.equals(data)).toBe(true);
      await remote.remove('/video.mp4');
      await remote.close();
    } finally {
      tmp.cleanup();
    }
  });

  it('a rejected password is reported as auth error after exactly one attempt', async () => {
    const err = await connectSftp({ ...base(), password: 'wrong', hostKeys: [server.hostKeyFingerprint] }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PublishError);
    expect(err).toMatchObject({ code: 'auth', transient: false });
    expect((err as Error).message).not.toContain('wrong');
    expect(server.authAttempts).toEqual([{ method: 'password', ok: false }]);
  });

  it('refuses a host key that does not match the pins, before authenticating', async () => {
    const err = await connectSftp({ ...base(), password: PASSWORD, hostKeys: [OTHER_FP] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'host_key', transient: false });
    expect((err as Error).message).toContain(server.hostKeyFingerprint);
    expect(server.authAttempts).toEqual([]);
  });

  it('without pins: refuses unless trust-on-first-use, which reports the key to pin', async () => {
    const err = await connectSftp({ ...base(), password: PASSWORD, hostKeys: [] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'host_key' });
    expect((err as Error).message).toMatch(/not pinned/);
    const seen: string[] = [];
    const remote = await connectSftp({
      ...base(),
      password: PASSWORD,
      hostKeys: [],
      trustOnFirstUse: true,
      onTrustedFirstUse: (fp) => seen.push(fp),
    });
    await remote.close();
    expect(seen).toEqual([server.hostKeyFingerprint]);
  });

  it('a closed server is a transient connection error', async () => {
    const err = await connectSftp({ ...base(), port: NOTHING_PORT, password: PASSWORD, hostKeys: [OTHER_FP] }).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'connection', transient: true });
  });

  it('end to end: publisher deploys over SFTP, testTarget works, an auth failure blocks further logins', async () => {
    const clock = fakeClock('2026-11-19T10:00:00.000Z');
    const tmp = makeTempDir('publisher-sftp-e2e-');
    const store = Store.memory({ now: clock });
    try {
      const config = testConfig(tmp.dir);
      const V1: SiteSpec = { version: 1, build: 'b1', days: { '2026-11-17': ['a', 'b'] } };
      const V2: SiteSpec = { version: 2, build: 'b2', days: { '2026-11-17': ['a'], '2026-11-18': ['c'] } };
      const out1 = join(tmp.dir, 'o1');
      const out2 = join(tmp.dir, 'o2');
      writeSite(out1, V1);
      const files2 = writeSite(out2, V2);
      let target: StoredTarget = sftpTarget('ssh', {
        host: '127.0.0.1',
        port: PORT,
        password: PASSWORD,
        hostKeys: [server.hostKeyFingerprint],
        remoteRoot: '/srv/site',
      });
      const targets = staticTargets([target]);
      const publisher = createPublisher({
        config,
        log: silentLog,
        store,
        targets,
        hashCacheFile: null,
        httpCheck: false,
      });

      const test = await publisher.testTarget('ssh');
      expect(test.ok).toBe(true);
      expect(test.detail).toMatch(/does not exist yet/);

      const [r1] = (await publisher.deploy({ outDir: out1 })) as DeployResult[];
      expect(r1).toMatchObject({ ok: true, version: 1, connections: 1 });
      clock.advance(60_000);
      const [r2] = (await publisher.deploy({ outDir: out2 })) as DeployResult[];
      expect(r2).toMatchObject({ ok: true, version: 2, deferred: 2 });

      const live = new Map<string, Buffer>();
      for (const [p, b] of server.files)
        if (p.startsWith('/srv/site/') && !p.includes('/.omw-')) live.set(p.slice(10), b);
      const old = assetPaths('b1');
      expect([...live.keys()].sort()).toEqual([...files2.keys(), old.js, old.css].sort());
      for (const [p, c] of files2) expect(live.get(p)?.toString()).toBe(c);
      expect(referenceProblems(live)).toEqual([]);
      expect([...server.files.keys()].filter((p) => p.includes('.omw-tmp.'))).toEqual([]);
      // L1-09: remote modes are explicit (files 0644, directories 0755), whatever the server umask
      for (const p of server.files.keys()) {
        if (p.startsWith('/srv/site/')) expect(server.modes.get(p)?.toString(8), p).toBe('644');
      }
      for (const d of server.dirs) {
        if (d.startsWith('/srv/site/')) expect(server.modes.get(d)?.toString(8), d).toBe('755');
      }

      const probe = await publisher.testTarget('ssh');
      expect(probe).toMatchObject({ ok: true });
      expect(probe.detail).toContain(server.hostKeyFingerprint);
      expect(probe.detail).toContain('atomic replace: no');

      // Wrong password: one login, then blocked without connecting again.
      target = { ...target, password: 'wrong' } as StoredTarget;
      const blocked = createPublisher({
        config,
        log: silentLog,
        store,
        targets: staticTargets([target]),
        hashCacheFile: null,
        httpCheck: false,
        sleep: async () => {},
      });
      const before = server.connections;
      writeSite(out2, { ...V2, version: 3 });
      const [r3] = (await blocked.deploy({ outDir: out2 })) as DeployResult[];
      expect(r3).toMatchObject({ ok: false, errorCode: 'auth', connections: 1 });
      const [r4] = (await blocked.deploy({ outDir: out2 })) as DeployResult[];
      expect(r4).toMatchObject({ ok: false, errorCode: 'auth_blocked', connections: 0 });
      expect(server.connections).toBe(before + 1);
      expect(server.authAttempts.filter((a) => !a.ok)).toHaveLength(1);
    } finally {
      store.close();
      tmp.cleanup();
    }
  }, 30_000); // each SSH login takes ~1 s in a loaded Linux container (D-13)
});

describe('SFTP connector: other authentication methods', () => {
  let tmpServer: TestSshServer | null = null;
  afterEach(async () => {
    await tmpServer?.close();
    tmpServer = null;
  });

  it('answers keyboard-interactive prompts with the password when "password" is not offered', async () => {
    tmpServer = await startSshServer({ port: KBD_PORT, password: PASSWORD, methods: ['keyboard-interactive'] });
    const remote = await connectSftp({
      host: '127.0.0.1',
      port: KBD_PORT,
      username: 'u',
      password: PASSWORD,
      hostKeys: [tmpServer.hostKeyFingerprint],
      trustOnFirstUse: false,
    });
    await remote.close();
    expect(tmpServer.authAttempts).toEqual([{ method: 'keyboard-interactive', ok: true }]);
  });

  it('authenticates with a private key (and only offers that key)', async () => {
    const key = ssh2.utils.generateKeyPairSync('ed25519');
    tmpServer = await startSshServer({ port: KEY_PORT, publicKey: key.public, methods: ['publickey', 'password'] });
    const remote = await connectSftp({
      host: '127.0.0.1',
      port: KEY_PORT,
      username: 'u',
      privateKey: key.private,
      hostKeys: [tmpServer.hostKeyFingerprint],
      trustOnFirstUse: false,
    });
    await remote.close();
    expect(tmpServer.authAttempts).toEqual([{ method: 'publickey', ok: true }]);

    const other = ssh2.utils.generateKeyPairSync('ed25519');
    const err = await connectSftp({
      host: '127.0.0.1',
      port: KEY_PORT,
      username: 'u',
      privateKey: other.private,
      password: 'never-sent',
      hostKeys: [tmpServer.hostKeyFingerprint],
      trustOnFirstUse: false,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'auth' });
    expect(tmpServer.authAttempts.filter((a) => a.method === 'password')).toEqual([]);
  });
});

describe('SFTP connector: hosts that drop the connection after a wrong password', () => {
  let tmpServer: TestSshServer | null = null;
  afterEach(async () => {
    await tmpServer?.close();
    tmpServer = null;
  });

  for (const mode of ['close', 'disconnect'] as const) {
    it(`${mode} after the password: auth error, never retried, target blocked`, async () => {
      const srv = await startSshServer({ port: DROP_PORT, password: PASSWORD, failedAuth: mode });
      tmpServer = srv;
      const err = await connectSftp({
        host: '127.0.0.1',
        port: DROP_PORT,
        username: 'u',
        password: 'wrong',
        hostKeys: [srv.hostKeyFingerprint],
        trustOnFirstUse: false,
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'auth', transient: false });
      expect((err as Error).message).toMatch(/after the credentials were sent/);
      expect((err as Error).message).not.toContain('wrong');

      const tmp = makeTempDir('publisher-sftp-drop-');
      const store = Store.memory();
      try {
        writeSite(join(tmp.dir, 'o'), { version: 1, build: 'b', days: { '2026-11-17': ['a'] } });
        const publisher = createPublisher({
          config: testConfig(tmp.dir),
          log: silentLog,
          store,
          hashCacheFile: null,
          httpCheck: false,
          sleep: async () => {},
          targets: staticTargets([
            sftpTarget('t', {
              host: '127.0.0.1',
              port: DROP_PORT,
              password: 'wrong',
              hostKeys: [srv.hostKeyFingerprint],
            }),
          ]),
        });
        srv.authAttempts.length = 0;
        const [r1] = (await publisher.deploy({ outDir: join(tmp.dir, 'o') })) as DeployResult[];
        expect(r1).toMatchObject({ ok: false, errorCode: 'auth', connections: 1 });
        const [r2] = (await publisher.deploy({ outDir: join(tmp.dir, 'o') })) as DeployResult[];
        expect(r2).toMatchObject({ ok: false, errorCode: 'auth_blocked', connections: 0 });
        // A dry run must not log in again either.
        await publisher.plan({ outDir: join(tmp.dir, 'o') });
        expect(srv.authAttempts).toEqual([{ method: 'password', ok: false }]);
      } finally {
        store.close();
        tmp.cleanup();
      }
    });
  }
});

describe('SFTP connector: late errors never crash the process', () => {
  let tmpServer: TestSshServer | null = null;
  afterEach(async () => {
    await tmpServer?.close();
    tmpServer = null;
  });

  it('errors emitted after a failed login, or on the SFTP channel, are handled', async () => {
    const srv = await startSshServer({ port: DROP_PORT, password: PASSWORD });
    tmpServer = srv;
    const clients: InstanceType<typeof ssh2.Client>[] = [];
    const spy = vi.spyOn(ssh2.Client.prototype, 'connect').mockImplementation(function (
      this: InstanceType<typeof ssh2.Client>,
      ...args: Parameters<InstanceType<typeof ssh2.Client>['connect']>
    ) {
      clients.push(this);
      spy.mockRestore();
      return this.connect(...args);
    });
    const err = await connectSftp({
      host: '127.0.0.1',
      port: DROP_PORT,
      username: 'u',
      password: 'wrong',
      hostKeys: [srv.hostKeyFingerprint],
      trustOnFirstUse: false,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'auth' });
    expect(clients).toHaveLength(1);
    // e.g. ECONNRESET after the promise settled: must not be an unhandled 'error' event.
    expect(() => clients[0]?.emit('error', new Error('read ECONNRESET'))).not.toThrow();

    const remote = await connectSftp({
      host: '127.0.0.1',
      port: DROP_PORT,
      username: 'u',
      password: PASSWORD,
      hostKeys: [srv.hostKeyFingerprint],
      trustOnFirstUse: false,
    });
    const channel = (remote as unknown as { sftp: NodeJS.EventEmitter }).sftp;
    expect(() => channel.emit('error', new Error('Malformed packet'))).not.toThrow();
    await remote.close();
  });
});
