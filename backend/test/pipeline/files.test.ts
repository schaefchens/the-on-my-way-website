/** Atomic writes and the cleanup of temp files left by crashed processes. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isOwnTemp, removeStaleTemps, tempPathFor, writeFileDurable } from '../../src/pipeline/files.js';
import { makeTempDir } from '../helpers.js';

describe('pipeline files', () => {
  const tmp = makeTempDir('pipeline-files-');
  afterAll(() => tmp.cleanup());

  it('writes atomically without leaving temp files', async () => {
    const target = join(tmp.dir, 'a', 'b', 'file.json');
    await writeFileDurable(target, '{"x":1}');
    await writeFileDurable(target, '{"x":2}');
    expect(readFileSync(target, 'utf8')).toBe('{"x":2}');
    expect(readdirSync(join(tmp.dir, 'a', 'b'))).toEqual(['file.json']);
  });

  it('removes stale temp files of other processes but keeps its own', async () => {
    const dir = join(tmp.dir, 'media', 'ab');
    mkdirSync(dir, { recursive: true });
    const own = tempPathFor(join(dir, 'ab12cd34ef56ab78_w640.avif'));
    writeFileSync(own, 'own');
    const files = {
      ownCopy: `ab12cd34ef56ab78_video.mp4.tmp-${process.pid}`,
      crashed: 'ab12cd34ef56ab78_w320.webp.tmp-1-0a0b0c0d-11223344', // same pid 1 as a Docker restart
      crashedCopy: 'ab12cd34ef56ab78_og.jpg.tmp-99999999',
      otherCapture: 'ffffffffffffffff_w320.webp.tmp-1-0a0b0c0d-11223344',
      final: 'ab12cd34ef56ab78_w320.webp',
    };
    for (const name of Object.values(files)) writeFileSync(join(dir, name), 'x');
    mkdirSync(join(dir, 'ab12cd34ef56ab78_dir.tmp-1-deadbeef-00'));
    expect(isOwnTemp(own)).toBe(true);
    expect(isOwnTemp(files.crashed)).toBe(false);

    expect(await removeStaleTemps(dir, 'ab12cd34ef56ab78_')).toBe(3);
    expect(existsSync(own)).toBe(true);
    expect(existsSync(join(dir, files.ownCopy))).toBe(true);
    expect(existsSync(join(dir, files.crashed))).toBe(false);
    expect(existsSync(join(dir, files.crashedCopy))).toBe(false);
    expect(existsSync(join(dir, files.otherCapture))).toBe(true);
    expect(existsSync(join(dir, files.final))).toBe(true);
    expect(await removeStaleTemps(join(tmp.dir, 'missing'), '')).toBe(0);
  });
});
