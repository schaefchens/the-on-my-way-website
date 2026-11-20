import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTempDir } from '../helpers.js';
import { startPreviewInRange } from './harness.js';

// Backend test ports 19200-19219: this file uses 19210-19213, the browser test 19214-19216.
const PORTS = [19210, 19211, 19212, 19213];

describe('preview server', () => {
  const tmp = makeTempDir('serve-');
  let server: Awaited<ReturnType<typeof startPreviewInRange>> | null = null;
  const url = (p: string) => `http://127.0.0.1:${server?.port ?? 0}${p}`;

  beforeAll(async () => {
    const files: Record<string, string> = {
      '404.html': '<!doctype html><title>404</title>',
      'index.html': 'root',
      'de/index.html': 'de home',
      'de/day/2026-11-15/index.html': 'day',
      'data/manifest.json': '{"version":1}',
      'media/ab/ab12cd34ef56ab78_w320.avif': 'AVIFDATA0123456789',
      'media/ab/ab12cd34ef56ab78_voice.m4a': 'm4a',
      'assets/index-abc.js': 'console.log(1)',
      'assets/font-x.woff2': 'w',
      '.htaccess': 'secret',
    };
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(tmp.dir, rel, '..'), { recursive: true });
      writeFileSync(join(tmp.dir, rel), body);
    }
    server = await startPreviewInRange(PORTS, { dir: tmp.dir, basePath: '/travel/' });
  });
  afterAll(async () => {
    await server?.close();
    tmp.cleanup();
  });

  it('serves directory indexes below the base path', async () => {
    const res = await fetch(url('/travel/de/day/2026-11-15/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe('day');
    expect(await (await fetch(url('/travel/'))).text()).toBe('root');
  });

  it('redirects directories without a trailing slash', async () => {
    const res = await fetch(url('/travel/de/day/2026-11-15?x=1'), { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('/travel/de/day/2026-11-15/?x=1');
    const base = await fetch(url('/travel'), { redirect: 'manual' });
    expect(base.headers.get('location')).toBe('/travel/');
  });

  it('sends the right MIME types and immutable caching for hashed files', async () => {
    const cases: [string, string][] = [
      ['/travel/data/manifest.json', 'application/json; charset=utf-8'],
      ['/travel/media/ab/ab12cd34ef56ab78_w320.avif', 'image/avif'],
      ['/travel/media/ab/ab12cd34ef56ab78_voice.m4a', 'audio/mp4'],
      ['/travel/assets/index-abc.js', 'text/javascript; charset=utf-8'],
      ['/travel/assets/font-x.woff2', 'font/woff2'],
    ];
    for (const [p, type] of cases) {
      const res = await fetch(url(p));
      expect(res.status, p).toBe(200);
      expect(res.headers.get('content-type'), p).toBe(type);
    }
    expect((await fetch(url('/travel/assets/index-abc.js'))).headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
    // L1-12: media of items the owner may hide later must not be kept by shared caches
    for (const p of ['/travel/media/ab/ab12cd34ef56ab78_w320.avif', '/travel/media/ab/ab12cd34ef56ab78_voice.m4a']) {
      expect((await fetch(url(p))).headers.get('cache-control'), p).toBe('private, max-age=31536000, immutable');
    }
  });

  it('answers unknown paths, paths outside the base and dotfiles with 404.html', async () => {
    for (const p of ['/travel/de/nope/', '/de/', '/travel/.htaccess', '/travel/%2e%2e/etc/passwd', '/travel/../x']) {
      const res = await fetch(url(p));
      expect(res.status, p).toBe(404);
      expect(await res.text(), p).toBe('<!doctype html><title>404</title>');
    }
  });

  it('supports byte ranges and HEAD', async () => {
    const res = await fetch(url('/travel/media/ab/ab12cd34ef56ab78_w320.avif'), { headers: { range: 'bytes=4-7' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 4-7/18');
    expect(await res.text()).toBe('DATA');
    const suffix = await fetch(url('/travel/media/ab/ab12cd34ef56ab78_w320.avif'), { headers: { range: 'bytes=-4' } });
    expect(await suffix.text()).toBe('6789');
    const bad = await fetch(url('/travel/media/ab/ab12cd34ef56ab78_w320.avif'), { headers: { range: 'bytes=99-' } });
    expect(bad.status).toBe(416);
    const head = await fetch(url('/travel/data/manifest.json'), { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe('13');
    expect(await head.text()).toBe('');
    expect((await fetch(url('/travel/'), { method: 'POST' })).status).toBe(405);
  });
});
