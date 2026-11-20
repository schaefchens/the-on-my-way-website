import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPublisher } from '../../src/publisher/index.js';
import { bootstrapTargetFromEnv, TargetStore, toPublic } from '../../src/publisher/targets.js';
import { Store } from '../../src/store/index.js';
import { fakeClock, makeTempDir } from '../helpers.js';
import { silentLog, testConfig } from './helpers.js';

const LIVE_KEYS = [
  'SHA256:1ckzga7xTCnKZNsqpWVAh4K85X9HmVe+5Ki1PW7tOQs',
  'SHA256:gQnQinEqX7NMlkAYbI8WiXGzkSfQWisi2SxHo7B2ebQ',
];
const PASSWORD = 'pa$$"w0rd`#x';

describe('TargetStore', () => {
  let tmp: ReturnType<typeof makeTempDir>;
  const clock = fakeClock();
  const make = (env: Record<string, string | undefined> = {}) =>
    new TargetStore({
      file: join(tmp.dir, 'config', 'targets.json'),
      configDir: join(tmp.dir, 'config'),
      baseDir: tmp.dir,
      outDir: join(tmp.dir, 'out'),
      env,
      log: silentLog,
      now: clock,
    });

  beforeEach(() => {
    tmp = makeTempDir('publisher-targets-');
  });
  afterEach(() => tmp.cleanup());

  it('bootstraps the SFTP target from the environment once, with the pinned live host keys', () => {
    const env = {
      SITE_BASE_URL: 'https://site.example.test',
      SFTP_HOST: 'www99.your-server.de',
      SFTP_PORT: '22',
      SFTP_USER: 'user1',
      SFTP_PASSWORD: PASSWORD,
      SFTP_REMOTE_ROOT: '/',
    };
    const ts = make(env);
    const [t] = ts.list();
    expect(t).toMatchObject({
      id: 'sftp-main',
      kind: 'sftp',
      host: 'www99.your-server.de',
      username: 'user1',
      password: PASSWORD,
      hostKeys: LIVE_KEYS,
      trustOnFirstUse: false,
      remoteRoot: '/',
      publicBaseUrl: 'https://site.example.test/',
      concurrency: 4,
    });
    const file = join(tmp.dir, 'config', 'targets.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Removing every target never re-bootstraps.
    expect(ts.remove('sftp-main')).toBe(true);
    expect(make(env).list()).toEqual([]);
  });

  it('bootstrap: explicit fingerprints, TOFU flag, unknown hosts get no pins, invalid env is ignored', () => {
    const now = new Date();
    const fp = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect(
      bootstrapTargetFromEnv(
        { SFTP_HOST: 'h.example', SFTP_USER: 'u', SFTP_PASSWORD: 'p', SFTP_HOST_FINGERPRINT: fp },
        now,
      )?.hostKeys,
    ).toEqual([fp]);
    const tofu = bootstrapTargetFromEnv(
      { SFTP_HOST: 'h.example', SFTP_USER: 'u', SFTP_PASSWORD: 'p', SFTP_TRUST_ON_FIRST_USE: 'true' },
      now,
    );
    expect(tofu).toMatchObject({ hostKeys: [], trustOnFirstUse: true });
    expect(bootstrapTargetFromEnv({}, now)).toBeNull();
    expect(() => bootstrapTargetFromEnv({ SFTP_HOST: 'h', SFTP_USER: 'u' }, now)).toThrow(/SFTP_PASSWORD/);
    // The error never echoes values.
    try {
      bootstrapTargetFromEnv(
        { SFTP_HOST: 'h', SFTP_USER: 'u', SFTP_PASSWORD: 'p', SITE_BASE_URL: 'notaurl-secret' },
        now,
      );
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('publicBaseUrl');
      expect((err as Error).message).not.toContain('notaurl-secret');
    }
    expect(make({ SFTP_HOST: 'h', SFTP_USER: 'u' }).list()).toEqual([]);
    expect(existsSync(join(tmp.dir, 'config', 'targets.json'))).toBe(false);
  });

  it('save: secrets absent = keep, null = remove; public view never contains them', () => {
    const ts = make();
    ts.save({ id: 'web', kind: 'sftp', host: 'sftp.example', username: 'deploy', password: PASSWORD });
    let t = ts.get('web');
    expect(t).toMatchObject({ password: PASSWORD, port: 22, remoteRoot: '/', hostKeys: [], enabled: true });
    ts.save({ id: 'web', kind: 'sftp', host: 'sftp.example', username: 'deploy', remoteRoot: '/www/' });
    t = ts.get('web');
    expect(t).toMatchObject({ password: PASSWORD, remoteRoot: '/www' });

    const { private: key } = ssh2.utils.generateKeyPairSync('ed25519');
    ts.save({ id: 'web', kind: 'sftp', host: 'sftp.example', username: 'deploy', password: null, privateKey: key });
    t = ts.get('web');
    expect(t?.kind === 'sftp' && t.password).toBeFalsy();
    expect(t?.kind === 'sftp' && t.privateKey).toBe(key);

    const pub = toPublic(t as NonNullable<typeof t>);
    const json = JSON.stringify(pub);
    expect(json).not.toContain(PASSWORD);
    expect(json).not.toContain('PRIVATE KEY');
    expect(pub).toMatchObject({ kind: 'sftp', auth: 'key', hasPrivateKey: true, hasPassword: false });

    expect(() =>
      ts.save({ id: 'web', kind: 'sftp', host: 'sftp.example', username: 'deploy', privateKey: null }),
    ).toThrow(/needs a password/);
    expect(() =>
      ts.save({ id: 'k2', kind: 'sftp', host: 'sftp.example', username: 'deploy', privateKey: 'not a key' }),
    ).toThrow(/Unusable private key/);
    expect(() => ts.save({ id: 'Bad Id', kind: 'local', dir: 'x' })).toThrow(/Invalid target/);
  });

  it('defaults host pins for known hosts and resets them when the host changes', () => {
    const ts = make();
    ts.save({ id: 'live', kind: 'sftp', host: 'www99.your-server.de', username: 'u', password: 'p' });
    expect(ts.get('live')).toMatchObject({ hostKeys: LIVE_KEYS });
    ts.save({ id: 'live', kind: 'sftp', host: 'other.example', username: 'u' });
    expect(ts.get('live')).toMatchObject({ hostKeys: [] });
    ts.pinHostKey('live', 'SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
    expect(ts.get('live')).toMatchObject({ hostKeys: ['SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'] });
    // Pinning never overrides existing pins.
    ts.pinHostKey('live', 'SHA256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC');
    expect(ts.get('live')).toMatchObject({ hostKeys: ['SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'] });
  });

  it('local targets: relative dirs resolve against the base dir; OUT_DIR overlap is refused', () => {
    const ts = make();
    expect(ts.save({ id: 'preview', kind: 'local', dir: 'www' })).toMatchObject({ dir: join(tmp.dir, 'www') });
    expect(() => ts.save({ id: 'bad', kind: 'local', dir: join(tmp.dir, 'out') })).toThrow(/OUT_DIR/);
    expect(() => ts.save({ id: 'bad', kind: 'local', dir: join(tmp.dir, 'out', 'sub') })).toThrow(/OUT_DIR/);
    expect(() => ts.save({ id: 'bad', kind: 'local', dir: tmp.dir })).toThrow(/OUT_DIR/);
  });

  it('repairs a world-readable targets.json and rejects a corrupt one', () => {
    const ts = make();
    ts.save({ id: 'preview', kind: 'local', dir: 'www' });
    const file = join(tmp.dir, 'config', 'targets.json');
    chmodSync(file, 0o644);
    expect(make().list()).toHaveLength(1);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, '{"format":1,"targets":[{"id":"x"}]}');
    expect(() => make().list()).toThrow(/invalid/);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ format: 1 });
  });

  it('a hand-broken targets.json never echoes file content (secrets) in the error', () => {
    const file = join(tmp.dir, 'config', 'targets.json');
    make().save({ id: 'preview', kind: 'local', dir: 'www' });
    // V8's JSON.parse messages quote the text around the error ("…"password":Sup3rS3cre"…").
    for (const broken of [
      '{"format":1,"targets":[{"password":Sup3rS3cretValue}]}',
      'Sup3rS3cretValue',
      '{"format":1,"targets":[{"password":"Sup3rS3cretValue" "x":1}]}',
    ]) {
      writeFileSync(file, broken, { mode: 0o600 });
      let message = '';
      try {
        make().list();
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/not valid JSON/);
      expect(message).not.toMatch(/Sup3r|S3cret|password/);
    }
  });
});

describe('Publisher target API', () => {
  let tmp: ReturnType<typeof makeTempDir>;
  let store: Store;

  beforeEach(() => {
    tmp = makeTempDir('publisher-api-');
    store = Store.memory();
  });
  afterEach(() => {
    store.close();
    tmp.cleanup();
  });

  it('lists, saves and removes targets without exposing secrets', () => {
    const config = testConfig(tmp.dir);
    const publisher = createPublisher({ config, log: silentLog, store, env: {}, hashCacheFile: null });
    expect(publisher.listTargets()).toEqual([]);
    const saved = publisher.saveTarget({
      id: 'web',
      kind: 'sftp',
      host: 'sftp.example',
      username: 'deploy',
      password: PASSWORD,
      publicBaseUrl: 'https://example.org/travel',
    });
    expect(saved).toMatchObject({ id: 'web', hasPassword: true, publicBaseUrl: 'https://example.org/travel/' });
    expect(JSON.stringify(publisher.listTargets())).not.toContain(PASSWORD);
    expect(publisher.getTarget('web')?.status).toEqual({
      lastDeploy: null,
      deployedVersion: null,
      deployedAt: null,
      authBlocked: null,
      deferredDeletes: 0,
    });
    publisher.removeTarget('web');
    expect(publisher.listTargets()).toEqual([]);
    expect(() => publisher.removeTarget('web')).toThrow(/Unknown publish target/);
    expect(store.events.recent().map((e) => e.type)).toEqual(['publish.target.removed', 'publish.target.saved']);
  });
});
