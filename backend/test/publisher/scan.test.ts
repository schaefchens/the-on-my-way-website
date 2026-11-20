import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HashCache, scanOutDir } from '../../src/publisher/scan.js';
import { makeTempDir } from '../helpers.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('scanOutDir', () => {
  let tmp: ReturnType<typeof makeTempDir>;
  let out: string;

  const put = (rel: string, content: string) => {
    mkdirSync(join(out, rel, '..'), { recursive: true });
    writeFileSync(join(out, rel), content);
  };

  beforeEach(() => {
    tmp = makeTempDir('publisher-scan-');
    out = join(tmp.dir, 'out');
    put('data/manifest.json', '{"version":12}');
    put('de/index.html', '<html>');
    put('media/ab/abcdef0123456789_w320.avif', 'img');
  });
  afterEach(() => tmp.cleanup());

  it('hashes every publishable file and reads the manifest version', async () => {
    put('.htaccess', 'Options -Indexes');
    put('.omw-deploy.json', '{}');
    put('de/.omw-tmp.index.html', 'partial');
    put('.DS_Store', 'junk');
    put('bad name.html', 'x');
    const r = await scanOutDir(out, new HashCache());
    expect([...r.files.keys()]).toEqual([
      '.htaccess',
      'data/manifest.json',
      'de/index.html',
      'media/ab/abcdef0123456789_w320.avif',
    ]);
    expect(r.files.get('de/index.html')).toMatchObject({ sha256: sha('<html>'), size: 6 });
    expect(r.manifestVersion).toBe(12);
    expect(r.skipped).toEqual(['bad name.html']);
    expect(r.hashed).toBe(4);
  });

  it('missing or invalid manifest gives version null; a missing OUT_DIR is empty', async () => {
    put('data/manifest.json', '{"version":0}');
    expect((await scanOutDir(out, new HashCache())).manifestVersion).toBeNull();
    put('data/manifest.json', 'nope');
    expect((await scanOutDir(out, new HashCache())).manifestVersion).toBeNull();
    const empty = await scanOutDir(join(tmp.dir, 'missing'), new HashCache());
    expect(empty.files.size).toBe(0);
  });

  it('reuses cached hashes by (inode, size, mtime), persists them, and notices replaced files', async () => {
    const file = join(tmp.dir, 'state', 'hash-cache.json');
    const cache = new HashCache(file);
    expect((await scanOutDir(out, cache)).hashed).toBe(3);
    expect((await scanOutDir(out, cache)).hashed).toBe(0);
    // A new process reads the persisted cache.
    expect((await scanOutDir(out, new HashCache(file))).hashed).toBe(0);
    // The generator replaces files via rename: new inode -> re-hashed.
    writeFileSync(join(out, 'de', 'tmp'), '<html lang="de">');
    renameSync(join(out, 'de', 'tmp'), join(out, 'de', 'index.html'));
    const r = await scanOutDir(out, new HashCache(file));
    expect(r.hashed).toBe(1);
    expect(r.files.get('de/index.html')?.sha256).toBe(sha('<html lang="de">'));
  });

  it('follows symlinked files, skips symlinked directories', async () => {
    writeFileSync(join(tmp.dir, 'outside.txt'), 'linked');
    symlinkSync(join(tmp.dir, 'outside.txt'), join(out, 'linked.txt'));
    mkdirSync(join(tmp.dir, 'dir'));
    symlinkSync(join(tmp.dir, 'dir'), join(out, 'linkdir'));
    const r = await scanOutDir(out, new HashCache());
    expect(r.files.get('linked.txt')?.sha256).toBe(sha('linked'));
    expect(r.skipped).toEqual(['linkdir/']);
  });

  it('pruning only affects entries below the scanned directory', async () => {
    const cache = new HashCache();
    await scanOutDir(out, cache);
    const other = join(tmp.dir, 'other');
    mkdirSync(other);
    writeFileSync(join(other, 'a.txt'), 'a');
    await scanOutDir(other, cache);
    expect((await scanOutDir(out, cache)).hashed).toBe(0);
  });
});
