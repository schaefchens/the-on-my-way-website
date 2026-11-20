import { publicIdForSourceKey, waSourceKey } from '@omw/contracts/ids';
import { describe, expect, it } from 'vitest';
import { Store } from '../../src/store/index.js';
import { capturesThrough, lastCaptureAt } from '../../src/sync/watermarks.js';
import { insertTextCapture } from './helpers.js';

/** A photo whose media WhatsApp has not delivered yet (capture state awaiting_media). */
async function insertAwaitingPhoto(store: Store, msgId: string, occurredAt: string): Promise<void> {
  const sourceKey = waSourceKey(msgId);
  store.captures.insert({
    sourceKey,
    publicId: await publicIdForSourceKey(sourceKey),
    msgId,
    source: 'fixture',
    kind: 'photo',
    occurredAt,
    tz: 'Europe/Berlin',
    media: { mimetype: 'image/jpeg', fileSha256B64: Buffer.alloc(32, 9).toString('base64'), fileLength: 1000 },
    download: { state: 'pending' },
  });
  expect(store.captures.get(sourceKey)?.state).toBe('awaiting_media');
}

describe('capturesThrough (PublishedReport watermark)', () => {
  it('is null without captures', () => {
    expect(capturesThrough(Store.memory())).toBeNull();
  });

  it('stops 1 ms before the oldest capture the pipeline is still working on', async () => {
    const store = Store.memory();
    await insertTextCapture(store, 'A1', '2026-11-18T08:00:00.000Z');
    store.captures.insert({
      sourceKey: waSourceKey('B2'),
      publicId: await publicIdForSourceKey(waSourceKey('B2')),
      msgId: 'B2',
      source: 'fixture',
      kind: 'text',
      occurredAt: '2026-11-18T09:00:00.000Z',
      tz: 'Europe/Berlin',
      text: { body: 'not processed yet', bgArgb: null, textArgb: null, font: null },
    });
    expect(store.captures.get(waSourceKey('B2'))?.state).toBe('received');
    await insertTextCapture(store, 'C3', '2026-11-18T10:00:00.000Z');
    expect(capturesThrough(store)).toBe('2026-11-18T08:59:59.999Z');
  });

  it('is not held back by a capture waiting for its media download (hours, until MEDIA_GIVE_UP_HOURS)', async () => {
    const store = Store.memory();
    await insertTextCapture(store, 'A1', '2026-11-18T08:00:00.000Z');
    await insertAwaitingPhoto(store, 'B2', '2026-11-18T09:00:00.000Z');
    await insertTextCapture(store, 'C3', '2026-11-18T10:00:00.000Z');
    // The newer ready capture C3 is covered; B2 is not ready, so no deploy contains it anyway
    // (the admin shows it as waiting from the mirror's mediaState 'pending').
    expect(capturesThrough(store)).toBe('2026-11-18T10:00:00.000Z');
  });

  it('equals the newest capture of any state otherwise, i.e. the heartbeat lastStatusAt', async () => {
    const store = Store.memory();
    await insertTextCapture(store, 'A1', '2026-11-18T08:00:00.000Z');
    await insertAwaitingPhoto(store, 'B2', '2026-11-18T11:00:00.000Z');
    expect(capturesThrough(store)).toBe('2026-11-18T11:00:00.000Z');
    expect(capturesThrough(store)).toBe(lastCaptureAt(store));
  });
});
