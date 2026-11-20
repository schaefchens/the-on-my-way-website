/**
 * Guards the pre-installed runtime dependencies (native modules in particular) so later phases can
 * rely on them: each must load on this Node version and do one trivial thing.
 */
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { Client } from 'ssh2';
import SftpClient from 'ssh2-sftp-client';
import { rgbaToThumbHash, thumbHashToAverageRGBA } from 'thumbhash';
import { describe, expect, it } from 'vitest';

describe('runtime dependencies', () => {
  it('better-sqlite3 (prebuilt N-API binary)', () => {
    const db = new Database(':memory:');
    expect(db.prepare('SELECT sqlite_version() AS v').get()).toMatchObject({ v: expect.any(String) });
    db.close();
  });

  it('sharp encodes AVIF and WebP; thumbhash hashes the pixels', async () => {
    const img = sharp({ create: { width: 32, height: 24, channels: 4, background: '#c88a6aff' } });
    const avif = await img.clone().avif({ quality: 50 }).toBuffer();
    const webp = await img.clone().webp({ quality: 75 }).toBuffer();
    expect((await sharp(avif).metadata()).format).toBe('heif');
    expect((await sharp(webp).metadata()).format).toBe('webp');
    const { data, info } = await img.clone().raw().toBuffer({ resolveWithObject: true });
    const hash = rgbaToThumbHash(info.width, info.height, data);
    const avg = thumbHashToAverageRGBA(hash);
    expect(Math.round(avg.r * 255)).toBeGreaterThan(150);
  });

  it('fastify, qrcode, ssh2, ssh2-sftp-client load', async () => {
    const app = Fastify();
    app.get('/health', async () => ({ ok: true }));
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ ok: true });
    await app.close();
    expect(await QRCode.toString('2@abc', { type: 'svg' })).toContain('<svg');
    expect(typeof Client).toBe('function');
    expect(typeof new SftpClient('probe').connect).toBe('function');
  });
});
