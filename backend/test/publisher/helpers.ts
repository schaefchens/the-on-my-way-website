import { join } from 'node:path';
import { type Config, loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import type { TargetSource } from '../../src/publisher/index.js';
import { PublishError, type StoredTarget } from '../../src/publisher/types.js';

export const silentLog = createLogger({ level: 'silent' });

/** Config whose directories all live below `dir`. */
export function testConfig(dir: string, extra: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    WA_MODE: 'fixture',
    DATA_DIR: join(dir, 'state'),
    ARCHIVE_DIR: join(dir, 'archive'),
    OUT_DIR: join(dir, 'out'),
    CONFIG_DIR: join(dir, 'config'),
    MEDIA_DIR: join(dir, 'media'),
    ...extra,
  });
}

/** A fixed, in-memory target list. */
export function staticTargets(list: StoredTarget[]): TargetSource & { pinned: string[] } {
  const pinned: string[] = [];
  return {
    pinned,
    list: () => list.map((t) => structuredClone(t)),
    get: (id) => {
      const t = list.find((x) => x.id === id);
      return t ? structuredClone(t) : undefined;
    },
    save: () => {
      throw new PublishError('config', 'read-only');
    },
    remove: () => false,
    pinHostKey: (_id, fp) => {
      pinned.push(fp);
    },
  };
}

const ISO = '2026-11-19T10:00:00.000Z';

export function localTarget(id: string, dir: string, extra: Partial<StoredTarget> = {}): StoredTarget {
  return {
    id,
    kind: 'local',
    enabled: true,
    publicBaseUrl: null,
    dir,
    createdAt: ISO,
    updatedAt: ISO,
    ...extra,
  } as StoredTarget;
}

export function sftpTarget(id: string, extra: Partial<Extract<StoredTarget, { kind: 'sftp' }>> = {}): StoredTarget {
  return {
    id,
    kind: 'sftp',
    enabled: true,
    publicBaseUrl: null,
    host: 'sftp.example.test',
    port: 22,
    username: 'deploy',
    password: 'secret-pass',
    hostKeys: [],
    trustOnFirstUse: false,
    remoteRoot: '/',
    concurrency: 4,
    createdAt: ISO,
    updatedAt: ISO,
    ...extra,
  };
}
