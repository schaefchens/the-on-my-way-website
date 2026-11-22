/**
 * Target fields of wave 5 (spec-wave5 §5.6.1): gateRoot / gateDir, accessStoreRoot /
 * accessStoreDir, publish (store-only targets); their validation (gateTargetProblem), the public
 * view, and the control UI form mapping.
 */
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gateTargetProblem, TargetStore, toPublic } from '../../src/publisher/targets.js';
import type { StoredTarget } from '../../src/publisher/types.js';
import { targetInputFromForm } from '../../src/ui/targets.js';
import { fakeClock, makeTempDir } from '../helpers.js';
import { localTarget, sftpTarget, silentLog } from './helpers.js';

const SECRET = 'k3j9x0m2p7q4r8s1t5u6';

describe('wave 5 target fields', () => {
  let tmp: ReturnType<typeof makeTempDir>;
  let targets: TargetStore;
  beforeEach(() => {
    tmp = makeTempDir('targets-gate-');
    targets = new TargetStore({
      file: join(tmp.dir, 'config', 'targets.json'),
      configDir: join(tmp.dir, 'config'),
      baseDir: tmp.dir,
      outDir: join(tmp.dir, 'out'),
      protectedDirs: [join(tmp.dir, 'state')],
      env: {},
      log: silentLog,
      now: fakeClock(),
    });
  });
  afterEach(() => tmp.cleanup());

  it('stores gateRoot, accessStoreRoot and publish; absent keeps, null removes', () => {
    const saved = targets.save({
      id: 'live',
      kind: 'sftp',
      host: 'sftp.example.org',
      username: 'u',
      password: 'p',
      hostKeys: [],
      remoteRoot: `/${SECRET}`,
      gateRoot: '/',
      accessStoreRoot: '/omw-store/site1/',
    });
    expect(saved).toMatchObject({ gateRoot: '/', accessStoreRoot: '/omw-store/site1' });
    expect(saved.publish).toBeUndefined();
    expect(
      targets.save({ id: 'live', kind: 'sftp', host: 'sftp.example.org', username: 'u', publish: false }),
    ).toMatchObject({ gateRoot: '/', accessStoreRoot: '/omw-store/site1', publish: false });
    const cleared = targets.save({ id: 'live', kind: 'sftp', host: 'sftp.example.org', username: 'u', gateRoot: null });
    expect(cleared.kind === 'sftp' && cleared.gateRoot).toBeUndefined();
    expect(toPublic(cleared)).toMatchObject({ publish: false, gateRoot: null, accessStoreRoot: '/omw-store/site1' });
    expect(JSON.stringify(toPublic(cleared))).not.toMatch(/"password":/);
  });

  it('local gateDir and accessStoreDir are absolute and never overlap OUT_DIR or state', () => {
    const saved = targets.save({
      id: 'web',
      kind: 'local',
      dir: `web/${SECRET}`,
      gateDir: 'web',
      accessStoreDir: 'store',
    });
    expect(saved).toMatchObject({
      dir: join(tmp.dir, 'web', SECRET),
      gateDir: join(tmp.dir, 'web'),
      accessStoreDir: join(tmp.dir, 'store'),
    });
    expect(() => targets.save({ id: 'bad', kind: 'local', dir: 'web2', gateDir: 'out/x' })).toThrow(/OUT_DIR/);
    expect(() => targets.save({ id: 'bad', kind: 'local', dir: 'web2', accessStoreDir: 'state/store' })).toThrow(
      /state directory/,
    );
  });

  it('gateTargetProblem: gateRoot/gateDir required, content root = gateRoot/<secret>; store-only targets are exempt', () => {
    const ok: StoredTarget[] = [
      sftpTarget('a', { remoteRoot: `/${SECRET}`, gateRoot: '/' }),
      sftpTarget('b', { remoteRoot: `/www/${SECRET}`, gateRoot: '/www' }),
      localTarget('c', `/srv/web/${SECRET}`, { gateDir: '/srv/web' } as Partial<StoredTarget>),
      sftpTarget('d', { publish: false, accessStoreRoot: '/store' }),
    ];
    for (const t of ok) expect(gateTargetProblem(t, SECRET), t.id).toBeNull();
    expect(gateTargetProblem(sftpTarget('e', { remoteRoot: `/${SECRET}` }), SECRET)).toMatch(/needs gateRoot/);
    expect(gateTargetProblem(sftpTarget('f', { remoteRoot: '/', gateRoot: '/' }), SECRET)).toMatch(
      new RegExp(`/${SECRET}`),
    );
    expect(gateTargetProblem(localTarget('g', '/srv/web'), SECRET)).toMatch(/needs gateDir/);
    expect(
      gateTargetProblem(localTarget('h', '/srv/web/x', { gateDir: '/srv/web' } as Partial<StoredTarget>), SECRET),
    ).toMatch(/dir must be/);
  });

  it('the control UI form maps the new fields; old forms leave them untouched', () => {
    expect(
      targetInputFromForm({
        mode: 'create',
        id: 'live',
        kind: 'sftp',
        host: 'h',
        username: 'u',
        enabled: 'on',
        publish_field: '1',
        gateRoot: '/',
        accessStoreRoot: ' /omw-store/site1 ',
      }),
    ).toMatchObject({ publish: false, gateRoot: '/', accessStoreRoot: '/omw-store/site1' });
    const edit = targetInputFromForm({
      mode: 'edit',
      id: 'live',
      kind: 'sftp',
      host: 'h',
      username: 'u',
      publish_field: '1',
      publish: 'on',
      gateRoot: '',
      accessStoreRoot: '',
    });
    expect(edit).toMatchObject({ publish: true, gateRoot: null, accessStoreRoot: null });
    const legacy = targetInputFromForm({ mode: 'edit', id: 'live', kind: 'sftp', host: 'h', username: 'u' });
    expect(legacy).not.toHaveProperty('publish');
    expect(legacy).not.toHaveProperty('gateRoot');
    expect(
      targetInputFromForm({
        mode: 'create',
        id: 'web',
        kind: 'local',
        dir: '/srv/web/x',
        gateDir: '/srv/web',
        accessStoreDir: '',
      }),
    ).toEqual({
      id: 'web',
      kind: 'local',
      label: null,
      enabled: false,
      publicBaseUrl: null,
      dir: '/srv/web/x',
      gateDir: '/srv/web',
    });
  });
});
