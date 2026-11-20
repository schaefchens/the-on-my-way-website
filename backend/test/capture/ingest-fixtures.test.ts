/**
 * Full ingest of all 18 generated fixture statuses through FixtureSource -> inbox -> store ->
 * archive -> media pipeline: states, time zones, EXIF rotation, HEVC transcode, GIF, voice,
 * text fonts, unsupported, revoke, sync outbox, change notifications, idempotency, determinism
 * and the rebuild of a lost store from ARCHIVE_DIR.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CaptureMirror, CaptureRevoke } from '@omw/contracts/api';
import { AudioMedia, GifEntry, ImageSet, TextStyle, VideoMedia } from '@omw/contracts/site';
import { InboxMeta } from '@omw/contracts/wa';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ArchiveRecord,
  type ArchiveRecord as ArchiveRecordType,
  listArchiveRecords,
} from '../../src/capture/archive.js';
import {
  createIngest,
  createWaSource,
  type Ingest,
  type IngestChange,
  PreviewOutboxPayload,
  type WaSource,
} from '../../src/capture/index.js';
import { mediaFilePath } from '../../src/paths.js';
import {
  audioMediaFromCapture,
  imageSetFromCapture,
  peaksFromWhatsAppWaveform,
  probe,
  sha256File,
  textStyleFromInbox,
  toolPathsFromEnv,
  videoMediaFromCapture,
} from '../../src/pipeline/index.js';
import { type CaptureRow, Store } from '../../src/store/index.js';
import { fakeClock } from '../helpers.js';
import { FIXTURE_INBOX, fixtureByKey, fixtureIndex, fixturesPresent, listFiles, makeEnv, type TestEnv } from './env.js';

// Media encoding is CPU-bound: generous per-test timeouts for parallel runs.
vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!fixturesPresent)('fixture ingest (18 statuses)', () => {
  // Shortly after the last fixture: the pending download is younger than MEDIA_GIVE_UP_HOURS.
  const clock = fakeClock('2026-11-17T15:00:00.000Z');
  let env: TestEnv;
  let source: WaSource;
  let ingest: Ingest;
  const changes: IngestChange[] = [];
  let first: { ingested: number; processed: number; failed: number };
  const get = (key: string): CaptureRow => {
    const row = env.store.captures.get(fixtureByKey(key).sourceKey);
    if (!row) throw new Error(`no capture for ${key}`);
    return row;
  };

  beforeAll(async () => {
    env = makeEnv({ now: clock, prefix: 'ingest-fixtures-' });
    source = createWaSource({ config: env.config, log: env.log, paths: env.paths, store: env.store });
    ingest = createIngest({ config: env.config, log: env.log, paths: env.paths, store: env.store, source });
    ingest.onChange((c) => changes.push(c));
    await source.start();
    first = await ingest.drain();
  }, 120_000);

  afterAll(async () => {
    await ingest?.stop();
    await source?.stop();
    env?.cleanup();
  });

  it('ingests every status into the expected state', () => {
    expect(first).toEqual({ ingested: 18, processed: 16, failed: 0 });
    expect(env.store.captures.countByState()).toEqual({
      awaiting_media: 1,
      received: 0,
      archived: 0,
      processed: 0,
      ready: 16,
      failed: 0,
      media_lost: 1,
    });
    expect(get('saigon-photo-pending').state).toBe('awaiting_media');
    expect(get('saigon-video-lost')).toMatchObject({ state: 'media_lost', downloadPermanent: true });
    expect(ingest.stats()).toMatchObject({ ingested: 18, processed: 16, failed: 0, invalid_meta: 0, media_lost: 1 });
    // No error was logged; the only warning is the permanently lost video.
    expect(env.records.filter((r) => r.level >= 50)).toEqual([]);
    expect(env.records.filter((r) => r.level === 40).map((r) => r.msg)).toEqual(['media lost']);
  });

  it('files each capture under the zone it was captured in', () => {
    for (const s of fixtureIndex().statuses) {
      const row = env.store.captures.get(s.sourceKey);
      expect(row, s.key).toMatchObject({ publicId: s.publicId, tz: s.tz, localDate: s.localDate, kind: s.kind });
    }
    expect(get('berlin-text')).toMatchObject({ tz: 'Europe/Berlin', localDate: '2026-11-12' });
    expect(get('hoian-photo-night').localDate).toBe('2026-11-16'); // 18:30Z = 01:30 next day in HCM
  });

  it('processes the EXIF-rotated photo upright and without upscaling', async () => {
    const row = get('hoian-photo-night');
    expect(row.processedMeta).toMatchObject({ w: 1080, h: 1350 });
    const set = imageSetFromCapture(row, 'image');
    expect(ImageSet.parse(set)).toEqual(set);
    expect(set?.sources.avif.map((s) => s.w)).toEqual([320, 640, 1080]);
    const largest = set?.sources.webp.at(-1)?.src ?? '';
    const meta = await sharp(mediaFilePath(env.config.dirs.media, largest)).metadata();
    expect([meta.width, meta.height, meta.orientation, meta.exif]).toEqual([1080, 1350, undefined, undefined]);
    expect(imageSetFromCapture(get('berlin-photo'), 'image')?.sources.webp.map((s) => s.w)).toEqual([
      320, 640, 1080, 1600,
    ]);
  });

  it('remuxes H.264, transcodes HEVC, mutes the GIF', async () => {
    const tools = toolPathsFromEnv();
    for (const key of ['hanoi-video', 'hoian-video-hevc']) {
      const video = videoMediaFromCapture(get(key));
      expect(VideoMedia.parse(video), key).toEqual(video);
      expect(video?.hasAudio).toBe(true);
      const info = await probe(mediaFilePath(env.config.dirs.media, video?.src ?? ''), tools);
      expect(info.video?.codec, key).toBe('h264');
      expect(info.audio?.codec, key).toBe('aac');
    }
    const gifRow = get('hoian-gif');
    const gif = videoMediaFromCapture(gifRow);
    expect(gif?.hasAudio).toBe(false);
    expect(
      GifEntry.parse({
        id: gifRow.publicId,
        at: gifRow.occurredAt,
        tz: gifRow.tz,
        kind: 'gif',
        video: gif,
        loop: true,
      }),
    ).toBeTruthy();
    expect((await probe(mediaFilePath(env.config.dirs.media, gif?.src ?? ''), tools)).audio).toBeNull();
  });

  it('encodes the voice status with the WhatsApp waveform', () => {
    const row = get('hoian-voice');
    const audio = audioMediaFromCapture(row);
    expect(AudioMedia.parse(audio)).toEqual(audio);
    expect(audio?.peaks).toEqual(peaksFromWhatsAppWaveform(row.media?.waveformB64));
    expect(existsSync(mediaFilePath(env.config.dirs.media, audio?.src ?? ''))).toBe(true);
  });

  it('keeps text styles (fonts, colours, defaults) and stores unsupported statuses without media', () => {
    const fonts = Object.fromEntries(
      ['berlin-text', 'hanoi-text-vi', 'hoian-text-ar', 'hoian-text-en', 'saigon-text-plain'].map((key) => {
        const row = get(key);
        expect(row.state).toBe('ready');
        const style = textStyleFromInbox(row.text ?? { body: '', bgArgb: null, textArgb: null, font: null });
        expect(TextStyle.parse(style)).toEqual(style);
        return [key, style.font];
      }),
    );
    expect(fonts).toEqual({
      'berlin-text': 'CALISTOGA_REGULAR',
      'hanoi-text-vi': 'SYSTEM_BOLD',
      'hoian-text-ar': 'SYSTEM',
      'hoian-text-en': 'COURIERPRIME_BOLD',
      'saigon-text-plain': 'SYSTEM',
    });
    expect(
      textStyleFromInbox(get('berlin-text').text ?? { body: '', bgArgb: 0, textArgb: 0, font: null }),
    ).toMatchObject({
      bg: '#8b6990ff',
      fg: '#ffffffff',
    });
    const unsupported = get('hoian-unsupported');
    expect(unsupported).toMatchObject({ kind: 'unsupported', state: 'ready', variants: [] });
  });

  it('applies the revoke', () => {
    expect(get('hoian-photo-revoked').revokedAt).toBe('2026-11-15T11:20:00.000Z');
    expect(env.store.captures.pendingRevokes()).toEqual([]);
    expect(env.store.captures.list().filter((c) => c.revokedAt)).toHaveLength(1);
  });

  it('archives originals (sha-verified) and self-describing records for every status', async () => {
    const records = await listArchiveRecords(env.config.dirs.archive);
    expect(records).toHaveLength(18);
    for (const rel of records) {
      const record: ArchiveRecordType = ArchiveRecord.parse(
        JSON.parse(readFileSync(join(env.config.dirs.archive, rel), 'utf8')),
      );
      expect(InboxMeta.parse(record.meta)).toBeTruthy();
      const row = env.store.captures.get(record.sourceKey);
      if (row?.state === 'ready') expect(row.archivePath).toBe(rel);
      if (record.original) {
        const file = join(env.config.dirs.archive, rel.replace(/[^/]+$/, record.original.file));
        expect((await sha256File(file)).sha256).toBe(record.original.sha256Hex);
        expect(record.original.sha256Hex).toBe(row?.originalSha256);
      }
    }
    const revoked = records.find((r) => r.includes(fixtureByKey('hoian-photo-revoked').msgId)) ?? '';
    expect(JSON.parse(readFileSync(join(env.config.dirs.archive, revoked), 'utf8')).revokedAt).toBe(
      '2026-11-15T11:20:00.000Z',
    );
    expect(listFiles(env.config.dirs.archive).some((f) => f.includes('.tmp-'))).toBe(false);
    expect(listFiles(env.config.dirs.media).some((f) => f.includes('.tmp-'))).toBe(false);
  });

  it('queues capture mirrors, previews and the revoke for the API', () => {
    const due = env.store.outbox.due(1000);
    const byKind = (kind: string) => due.filter((i) => i.kind === kind);
    expect(byKind('capture')).toHaveLength(18);
    for (const item of byKind('capture')) expect(CaptureMirror.parse(item.payload)).toBeTruthy();
    const mirror = (key: string) => byKind('capture').find((i) => i.key === fixtureByKey(key).sourceKey)?.payload;
    expect(mirror('hoian-photo-night')).toMatchObject({ mediaState: 'ok', media: { w: 1080, h: 1350 } });
    expect(mirror('saigon-photo-pending')).toMatchObject({ mediaState: 'pending' });
    expect(mirror('saigon-video-lost')).toMatchObject({ mediaState: 'lost' });
    expect(mirror('berlin-text')).toMatchObject({ mediaState: 'none', text: { font: 'CALISTOGA_REGULAR' } });
    expect(mirror('hoian-photo-revoked')).toMatchObject({ revokedAt: '2026-11-15T11:20:00.000Z' });

    const previews = byKind('preview').map((i) => PreviewOutboxPayload.parse(i.payload));
    expect(previews.filter((p) => p.role === 'preview')).toHaveLength(6); // ready photos
    expect(previews.filter((p) => p.role === 'poster')).toHaveLength(3); // 2 videos + gif
    for (const p of previews) {
      expect(p.w).toBeLessThanOrEqual(640);
      expect(p.bytes).toBeLessThanOrEqual(512 * 1024);
      expect(existsSync(mediaFilePath(env.config.dirs.media, p.relPath))).toBe(true);
    }
    const revokes = byKind('revoke');
    expect(revokes.map((i) => i.key)).toEqual([fixtureByKey('hoian-photo-revoked').sourceKey]);
    expect(CaptureRevoke.parse(revokes[0]?.payload)).toMatchObject({ at: '2026-11-15T11:20:00.000Z' });
  });

  it('notifies the generator with source keys and local dates', () => {
    const keys = new Set(changes.flatMap((c) => c.sourceKeys));
    const dates = new Set(changes.flatMap((c) => c.localDates));
    expect(keys.size).toBe(16);
    expect([...dates].sort()).toEqual(['2026-11-12', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17']);
  });

  it('is idempotent: a second drain and a restart change nothing', async () => {
    const before = env.store.captures.list().map((r) => [r.sourceKey, r.state, r.updatedAt]);
    expect(await ingest.drain()).toEqual({ ingested: 0, processed: 0, failed: 0 });
    const source2 = createWaSource({ config: env.config, log: env.log, paths: env.paths, store: env.store });
    const ingest2 = createIngest({
      config: env.config,
      log: env.log,
      paths: env.paths,
      store: env.store,
      source: source2,
    });
    await source2.start();
    expect(await ingest2.drain()).toEqual({ ingested: 0, processed: 0, failed: 0 });
    await source2.stop();
    expect(env.store.captures.list().map((r) => [r.sourceKey, r.state, r.updatedAt])).toEqual(before);
  });

  it('reprocesses one capture from the archive with identical output', async () => {
    const before = get('hoian-photo-morning').variants?.map((v) => [v.relPath, v.sha256]);
    expect(await ingest.reprocess(fixtureByKey('hoian-photo-morning').sourceKey)).toBe(1);
    const row = get('hoian-photo-morning');
    expect(row.state).toBe('ready');
    expect(row.variants?.map((v) => [v.relPath, v.sha256])).toEqual(before);
  }, 60_000);

  it('rebuilds a lost store from ARCHIVE_DIR', async () => {
    const reference = new Map(env.store.captures.list().map((r) => [r.sourceKey, r]));
    const storePath = join(env.dir, 'rebuilt.db');
    rmSync(storePath, { force: true });
    const store = Store.open(storePath, { now: clock });
    // No inbox either: everything must come from the archive.
    const paths = {
      ...env.paths,
      inbox: join(env.dir, 'empty-inbox'),
      revokes: join(env.dir, 'empty-inbox', '_revokes'),
    };
    const rebuild = createIngest({
      config: env.config,
      log: env.log,
      paths,
      store,
      source: createWaSource({ config: env.config, log: env.log, paths, store }),
    });
    expect(await rebuild.reprocess()).toBe(16);
    expect(rebuild.stats().restored).toBe(18);
    for (const row of store.captures.list()) {
      const ref = reference.get(row.sourceKey);
      expect(row, row.sourceKey).toMatchObject({
        state: ref?.state,
        kind: ref?.kind,
        tz: ref?.tz,
        localDate: ref?.localDate,
        revokedAt: ref?.revokedAt,
        originalSha256: ref?.originalSha256,
        processedMeta: ref?.processedMeta,
      });
      expect(row.variants?.map((v) => v.sha256)).toEqual(ref?.variants?.map((v) => v.sha256));
    }
    store.close();
  }, 120_000);

  it('keeps fixture originals untouched', () => {
    for (const s of fixtureIndex().statuses.filter((x) => x.file)) {
      expect(existsSync(join(FIXTURE_INBOX, s.msgId, s.file ?? ''))).toBe(true);
    }
  });
});
