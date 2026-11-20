import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { publicIdForSourceKey, waSourceKey } from '@omw/contracts/ids';
import { pino } from 'pino';
import { type Config, loadConfig } from '../../src/config.js';
import type { Logger } from '../../src/log.js';
import { mediaFilePath, mediaRelPath } from '../../src/paths.js';
import type { CaptureRow, Store } from '../../src/store/index.js';

export const silentLog = (): Logger => pino({ level: 'silent' });

export function testConfig(dir: string, env: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: `${dir}/state`,
    ARCHIVE_DIR: `${dir}/archive`,
    OUT_DIR: `${dir}/out`,
    CONFIG_DIR: `${dir}/config`,
    MEDIA_DIR: `${dir}/media`,
    ...env,
  });
}

export async function insertTextCapture(store: Store, msgId: string, occurredAt: string): Promise<CaptureRow> {
  const sourceKey = waSourceKey(msgId);
  store.captures.insert({
    sourceKey,
    publicId: await publicIdForSourceKey(sourceKey),
    msgId,
    source: 'fixture',
    kind: 'text',
    occurredAt,
    tz: 'Europe/Berlin',
    text: { body: `hello ${msgId}`, bgArgb: null, textArgb: null, font: null },
  });
  store.captures.markReady(sourceKey);
  const row = store.captures.get(sourceKey);
  if (!row) throw new Error('insert failed');
  return row;
}

/** A ready photo with a w640 WebP variant written to MEDIA_DIR (the admin preview). */
export async function insertPhotoCapture(
  store: Store,
  mediaDir: string,
  msgId: string,
  occurredAt: string,
  options: { previewBytes?: number; ready?: boolean } = {},
): Promise<CaptureRow> {
  const sourceKey = waSourceKey(msgId);
  const sha = (msgId.toLowerCase().replace(/[^0-9a-f]/g, '') + 'a'.repeat(64)).slice(0, 64);
  store.captures.insert({
    sourceKey,
    publicId: await publicIdForSourceKey(sourceKey),
    msgId,
    source: 'fixture',
    kind: 'photo',
    occurredAt,
    tz: 'Europe/Berlin',
    caption: 'a photo',
    media: { mimetype: 'image/jpeg', fileSha256B64: Buffer.from(sha, 'hex').toString('base64'), fileLength: 1000 },
    download: { state: 'ok' },
  });
  if (options.ready !== false) {
    const relPath = mediaRelPath(sha, 'w640', 'webp');
    const bytes = options.previewBytes ?? 2048;
    const file = mediaFilePath(mediaDir, relPath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.alloc(bytes, 7));
    store.captures.markArchived(sourceKey, { archivePath: `2026/11/18/${msgId}.jpg`, originalSha256: sha });
    store.captures.markProcessed(sourceKey, {
      variants: [{ role: 'image', variant: 'w640', format: 'webp', w: 640, h: 480, relPath, bytes, sha256: sha }],
      processedMeta: { w: 640, h: 480, color: '#aabbcc' },
    });
    store.captures.markReady(sourceKey);
  }
  const row = store.captures.get(sourceKey);
  if (!row) throw new Error('insert failed');
  return row;
}
