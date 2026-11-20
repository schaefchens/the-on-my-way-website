import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  archiveRelPath,
  inboxMessageDir,
  inboxMetaPath,
  isMediaVariant,
  mediaFilePath,
  mediaRelPath,
  revokeRecordPath,
  statePaths,
} from '../src/paths.js';

const sha = 'ab12cd34ef56ab78901234567890abcdef1234567890abcdef1234567890abcd';

describe('paths', () => {
  it('lays out DATA_DIR (D7)', () => {
    expect(statePaths('/data')).toEqual({
      root: '/data',
      storeDb: '/data/store.db',
      inbox: '/data/inbox',
      revokes: '/data/inbox/_revokes',
      wa: '/data/wa',
      waSession: '/data/wa/session.db',
    });
  });

  it('builds inbox paths and rejects traversal', () => {
    expect(inboxMessageDir('/data/inbox', '3EB0C767')).toBe(join('/data/inbox', '3EB0C767'));
    expect(inboxMetaPath('/data/inbox', '3EB0C767')).toBe('/data/inbox/3EB0C767/meta.json');
    expect(revokeRecordPath('/data/inbox', '3EB0C767')).toBe('/data/inbox/_revokes/3EB0C767.json');
    expect(() => inboxMessageDir('/data/inbox', '../etc')).toThrow();
    expect(() => inboxMessageDir('/data/inbox', '_revokes')).toThrow();
  });

  it('archives by UTC date of occurredAt', () => {
    expect(archiveRelPath('2026-11-15T18:30:00Z', '3EB0C767', 'jpg')).toBe('2026/11/15/3EB0C767.jpg');
    expect(() => archiveRelPath('2026-11-15T18:30:00Z', '3EB0C767', 'j/pg')).toThrow();
  });

  it('names media variants per D8', () => {
    expect(mediaRelPath(sha, 'w640', 'avif')).toBe('media/ab/ab12cd34ef56ab78_w640.avif');
    expect(mediaRelPath(sha, 'poster_w1080', 'webp')).toBe('media/ab/ab12cd34ef56ab78_poster_w1080.webp');
    expect(mediaRelPath(sha, 'video', 'mp4')).toBe('media/ab/ab12cd34ef56ab78_video.mp4');
    expect(mediaRelPath(sha, 'voice', 'm4a')).toBe('media/ab/ab12cd34ef56ab78_voice.m4a');
    expect(mediaRelPath(sha, 'og', 'jpg')).toBe('media/ab/ab12cd34ef56ab78_og.jpg');
    expect(() => mediaRelPath(sha, 'video', 'webp')).toThrow();
    expect(() => mediaRelPath(sha.toUpperCase(), 'w640', 'avif')).toThrow();
    expect(() => mediaRelPath(sha, 'w800' as 'w640', 'avif')).toThrow();
    expect(isMediaVariant('poster_w320')).toBe(true);
    expect(isMediaVariant('w100')).toBe(false);
    const rel = mediaRelPath(sha, 'w640', 'avif');
    expect(mediaFilePath('/srv/media', rel)).toBe('/srv/media/ab/ab12cd34ef56ab78_w640.avif');
    expect(() => mediaFilePath('/srv/media', '../etc/passwd')).toThrow();
  });
});
