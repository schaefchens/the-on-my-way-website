import { existsSync, promises as fsp, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyDurable, type FsOps, linkOrCopy } from '../src/fsutil.js';
import { makeTempDir } from './helpers.js';

describe('fsutil', () => {
  let tmp: { dir: string; cleanup: () => void };
  beforeEach(() => {
    tmp = makeTempDir('fsutil-');
  });
  afterEach(() => tmp.cleanup());

  it('hard-links on the same filesystem and replaces an existing target', async () => {
    const src = join(tmp.dir, 'media', 'ab', 'x_w640.avif');
    await fsp.mkdir(join(tmp.dir, 'media', 'ab'), { recursive: true });
    writeFileSync(src, 'variant');
    const target = join(tmp.dir, 'out', 'media', 'ab', 'x_w640.avif');
    expect(await linkOrCopy(src, target)).toBe('link');
    expect(statSync(target).ino).toBe(statSync(src).ino);
    expect(await linkOrCopy(src, target)).toBe('link'); // idempotent
  });

  it('falls back to a copy on EXDEV (different mounts) but rethrows other errors', async () => {
    const src = join(tmp.dir, 'a.bin');
    writeFileSync(src, 'payload');
    const exdev: FsOps = {
      link: async () => {
        throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
      },
      copyFile: (a, b, mode) => fsp.copyFile(a, b, mode),
      mkdir: (p, o) => fsp.mkdir(p, o),
      rm: (p, o) => fsp.rm(p, o),
    };
    const target = join(tmp.dir, 'other', 'a.bin');
    expect(await linkOrCopy(src, target, exdev)).toBe('copy');
    expect(readFileSync(target, 'utf8')).toBe('payload');
    expect(statSync(target).ino).not.toBe(statSync(src).ino);

    const enoent: FsOps = {
      ...exdev,
      link: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
    };
    await expect(linkOrCopy(src, join(tmp.dir, 'x', 'a.bin'), enoent)).rejects.toThrow('missing');
  });

  it('copyDurable copies without touching the source and leaves no temp file', async () => {
    const src = join(tmp.dir, 'inbox', 'MSG1', 'original.jpg');
    await fsp.mkdir(join(tmp.dir, 'inbox', 'MSG1'), { recursive: true });
    writeFileSync(src, 'jpeg');
    const target = join(tmp.dir, 'archive', '2026', '11', '15', 'MSG1.jpg');
    await copyDurable(src, target);
    expect(readFileSync(target, 'utf8')).toBe('jpeg');
    expect(existsSync(src)).toBe(true);
    expect(
      (await fsp.readdir(join(tmp.dir, 'archive', '2026', '11', '15'))).filter((f) => f.includes('.tmp-')),
    ).toEqual([]);
  });
});
