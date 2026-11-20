import { join } from 'node:path';
import type { Annotation, ChangesResponse, Day, Post, Trip } from '@omw/contracts/api';
import { publicIdForSourceKey, waSourceKey } from '@omw/contracts/ids';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  capturesForEffectiveDate,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  MigrationError,
  type NewCapture,
  type ProcessedVariant,
  Store,
} from '../src/store/index.js';
import { migrate } from '../src/store/migrations.js';
import { FEED_IGNORED_KEY } from '../src/store/syncState.js';
import { fakeClock, makeTempDir } from './helpers.js';

const SHA = 'ab12cd34ef56ab78901234567890abcdef1234567890abcdef1234567890abcd';

async function newCapture(msgId: string, overrides: Partial<NewCapture> = {}): Promise<NewCapture> {
  const sourceKey = waSourceKey(msgId);
  return {
    sourceKey,
    publicId: await publicIdForSourceKey(sourceKey),
    msgId,
    source: 'fixture',
    kind: 'photo',
    occurredAt: '2026-11-15T18:30:00Z',
    receivedAt: '2026-11-15T18:30:05Z',
    tz: 'Asia/Ho_Chi_Minh',
    caption: 'Hội An',
    media: { mimetype: 'image/jpeg', fileSha256B64: 'AAAA', fileLength: 10, width: 1080, height: 1350 },
    sender: { pn: '4915100000001' },
    ...overrides,
  };
}

const variant = (v: string, format: ProcessedVariant['format'], w?: number): ProcessedVariant => ({
  role: v.startsWith('w') ? 'image' : 'og',
  variant: v,
  format,
  ...(w ? { w, h: Math.round(w * 1.25) } : {}),
  relPath: `media/ab/ab12cd34ef56ab78_${v}.${format}`,
  bytes: 1234,
  sha256: SHA,
});

describe('Store (in-memory)', () => {
  let store: Store;
  const clock = fakeClock();

  beforeEach(() => {
    clock.set('2026-11-19T10:00:00.000Z');
    store = Store.memory({ now: clock });
  });
  afterEach(() => store.close());

  describe('migrations and meta', () => {
    it('migrates a fresh database to the latest version', () => {
      expect(store.migration).toEqual({ from: 0, to: LATEST_SCHEMA_VERSION, applied: [1] });
      expect(store.meta.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
      expect(store.db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(store.db.pragma('busy_timeout', { simple: true })).toBe(5000);
    });

    it('is idempotent', () => {
      expect(migrate(store.db)).toEqual({ from: 1, to: 1, applied: [] });
    });

    it('refuses databases from a newer backend', () => {
      store.db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
      expect(() => migrate(store.db)).toThrow(MigrationError);
    });

    it('rolls back a failing migration', () => {
      const db = new Database(':memory:');
      const broken = [
        ...MIGRATIONS,
        {
          version: 2,
          name: 'broken',
          up(d: typeof db) {
            d.exec('CREATE TABLE half_done (x INTEGER)');
            throw new Error('boom');
          },
        },
      ];
      expect(() => migrate(db, broken)).toThrow('boom');
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").all();
      expect(tables).toEqual([]);
      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: '1' });
      db.close();
    });

    it('increments the site version monotonically', () => {
      expect(store.meta.siteVersion()).toBe(0);
      expect(store.meta.nextSiteVersion()).toBe(1);
      expect(store.meta.nextSiteVersion()).toBe(2);
      expect(store.meta.siteVersion()).toBe(2);
      expect(() => store.meta.set('schema_version', '5')).toThrow();
    });
  });

  describe('captures', () => {
    it('inserts idempotently and derives localDate from tz', async () => {
      const input = await newCapture('3EB0AAA1');
      const first = store.captures.insert(input);
      expect(first.inserted).toBe(true);
      expect(first.row).toMatchObject({
        sourceKey: 'wa:3EB0AAA1',
        msgId: '3EB0AAA1',
        kind: 'photo',
        occurredAt: '2026-11-15T18:30:00.000Z',
        localDate: '2026-11-16', // 01:30 in Ho Chi Minh City
        state: 'received',
        attempts: 0,
        caption: 'Hội An',
        sender: { pn: '4915100000001' },
        createdAt: '2026-11-19T10:00:00.000Z',
      });
      expect(first.row.publicId).toMatch(/^e_[a-z2-7]{12}$/);
      const second = store.captures.insert({ ...input, caption: 'changed' });
      expect(second.inserted).toBe(false);
      expect(second.row.caption).toBe('Hội An');
      expect(store.captures.getByPublicId(first.row.publicId)?.sourceKey).toBe('wa:3EB0AAA1');
      expect(store.captures.getByMsgId('3EB0AAA1')?.sourceKey).toBe('wa:3EB0AAA1');
    });

    it('validates input', async () => {
      await expect(async () => store.captures.insert(await newCapture('X1', { publicId: 'nope' }))).rejects.toThrow();
      await expect(async () => store.captures.insert(await newCapture('X2', { sourceKey: 'bad' }))).rejects.toThrow();
      await expect(async () => store.captures.insert(await newCapture('X3', { tz: 'Mars/Olympus' }))).rejects.toThrow();
    });

    it('walks the state machine received -> archived -> processed -> ready', async () => {
      const { row } = store.captures.insert(await newCapture('3EB0AAA2'));
      expect(
        store.captures.markArchived(row.sourceKey, { archivePath: '2026/11/15/3EB0AAA2.jpg', originalSha256: SHA }),
      ).toBe(true);
      clock.advance(1000);
      const variants = [variant('w320', 'avif', 320), variant('w320', 'webp', 320), variant('og', 'jpg')];
      expect(
        store.captures.markProcessed(row.sourceKey, {
          variants,
          processedMeta: { w: 1080, h: 1350, color: '#aabbcc', thumbhash: 'AAAA' },
        }),
      ).toBe(true);
      expect(store.captures.markReady(row.sourceKey)).toBe(true);
      const done = store.captures.get(row.sourceKey);
      expect(done).toMatchObject({
        state: 'ready',
        archivePath: '2026/11/15/3EB0AAA2.jpg',
        originalSha256: SHA,
        variants,
        processedMeta: { w: 1080, h: 1350, color: '#aabbcc', thumbhash: 'AAAA' },
        updatedAt: '2026-11-19T10:00:01.000Z',
      });
      expect(() =>
        store.captures.markProcessed(row.sourceKey, {
          variants: [{ ...variants[0], relPath: '/etc/passwd' } as ProcessedVariant],
          processedMeta: {},
        }),
      ).toThrow();
      // a late download problem never touches a published capture
      expect(store.captures.markMediaLost(row.sourceKey, 'gone')).toBe(false);
      expect(store.captures.recordFailure(row.sourceKey, 'late', null)).toBe(false);
      expect(
        store.captures.setDownloadResult(row.sourceKey, { state: 'failed', reason: 'expired', permanent: true }),
      ).toBe(false);
      expect(store.captures.get(row.sourceKey)?.state).toBe('ready');
    });

    it('media_lost is terminal for transitions', async () => {
      const { row } = store.captures.insert(await newCapture('3EB0AAA9'));
      expect(store.captures.markMediaLost(row.sourceKey, 'gone')).toBe(true);
      expect(store.captures.markArchived(row.sourceKey, { archivePath: 'x', originalSha256: null })).toBe(false);
      expect(store.captures.recordFailure(row.sourceKey, 'x', null)).toBe(false);
    });

    it('waits for the media download: pending -> ok -> archived', async () => {
      const { row } = store.captures.insert(
        await newCapture('3EB0DL01', { download: { state: 'pending' }, source: 'live' }),
      );
      expect(row).toMatchObject({ state: 'awaiting_media', downloadState: 'pending' });
      expect(store.captures.listDue()).toEqual([]);
      expect(store.captures.listAwaitingMedia().map((c) => c.sourceKey)).toEqual([row.sourceKey]);
      // the original is not there yet: archiving is refused
      expect(store.captures.markArchived(row.sourceKey, { archivePath: 'a.jpg', originalSha256: SHA })).toBe(false);
      // retry receipt sent, then a transient failure: still waiting, attempt counted
      expect(store.captures.setDownloadResult(row.sourceKey, { state: 'retrying' })).toBe(true);
      expect(
        store.captures.setDownloadResult(row.sourceKey, {
          state: 'failed',
          reason: 'network',
          permanent: false,
          error: 'timeout',
          retryAt: '2026-11-19T11:00:00Z',
        }),
      ).toBe(true);
      expect(store.captures.get(row.sourceKey)).toMatchObject({
        state: 'awaiting_media',
        downloadState: 'failed',
        downloadReason: 'network',
        downloadPermanent: false,
        attempts: 1,
        lastError: 'timeout',
      });
      expect(store.captures.setDownloadResult(row.sourceKey, { state: 'ok' })).toBe(true);
      expect(store.captures.get(row.sourceKey)).toMatchObject({ state: 'received', downloadState: 'ok', attempts: 0 });
      expect(store.captures.listDue().map((c) => c.sourceKey)).toEqual([row.sourceKey]);
      expect(store.captures.markArchived(row.sourceKey, { archivePath: 'a.jpg', originalSha256: SHA })).toBe(true);
      // a late failure report cannot regress an archived capture
      expect(
        store.captures.setDownloadResult(row.sourceKey, { state: 'failed', reason: 'expired', permanent: true }),
      ).toBe(false);
      expect(store.captures.get(row.sourceKey)?.state).toBe('archived');
    });

    it('pending -> failed (permanent) -> media_lost, also directly at insert', async () => {
      const { row } = store.captures.insert(await newCapture('3EB0DL02', { download: { state: 'pending' } }));
      expect(
        store.captures.setDownloadResult(row.sourceKey, {
          state: 'failed',
          reason: 'not_on_phone',
          permanent: true,
          error: 'ErrMediaNotAvailableOnPhone',
        }),
      ).toBe(true);
      expect(store.captures.get(row.sourceKey)).toMatchObject({
        state: 'media_lost',
        downloadPermanent: true,
        lastError: 'ErrMediaNotAvailableOnPhone',
      });
      const lost = store.captures.insert(
        await newCapture('3EB0DL03', { download: { state: 'failed', reason: 'expired', permanent: true } }),
      );
      expect(lost.row.state).toBe('media_lost');
      // text has nothing to download
      const text = store.captures.insert(await newCapture('3EB0DL04', { kind: 'text', media: null }));
      expect(text.row).toMatchObject({ state: 'received', downloadState: 'not_applicable' });
      expect(store.captures.setDownloadResult(text.row.sourceKey, { state: 'ok' })).toBe(false);
      expect(store.captures.countByState()).toMatchObject({ media_lost: 2, received: 1 });
    });

    it('applies a revoke that arrives before its status', async () => {
      expect(store.captures.applyRevoke('3EB0RV01', '2026-11-15T19:00:00Z')).toBe('pending');
      expect(store.captures.pendingRevokes()).toEqual([{ msgId: '3EB0RV01', at: '2026-11-15T19:00:00.000Z' }]);
      const { row } = store.captures.insert(await newCapture('3EB0RV01'));
      expect(row.revokedAt).toBe('2026-11-15T19:00:00.000Z');
      expect(store.captures.pendingRevokes()).toEqual([]);
      expect(store.captures.applyRevoke('3EB0RV01', '2026-11-15T20:00:00Z')).toBe('applied');
    });

    it('schedules retries, gives up, and resumes from the furthest step', async () => {
      const { row } = store.captures.insert(await newCapture('3EB0AAA3'));
      store.captures.markArchived(row.sourceKey, { archivePath: 'a.jpg', originalSha256: SHA });
      expect(store.captures.listDue().map((c) => c.sourceKey)).toEqual([row.sourceKey]);

      store.captures.recordFailure(row.sourceKey, 'sharp crashed', '2026-11-19T10:05:00Z');
      let c = store.captures.get(row.sourceKey);
      expect(c).toMatchObject({ state: 'archived', attempts: 1, lastError: 'sharp crashed' });
      expect(store.captures.listDue()).toEqual([]);
      clock.set('2026-11-19T10:05:00.000Z');
      expect(store.captures.listDue()).toHaveLength(1);

      store.captures.recordFailure(row.sourceKey, 'still broken', null);
      c = store.captures.get(row.sourceKey);
      expect(c).toMatchObject({ state: 'failed', attempts: 2, nextAttemptAt: null });
      expect(store.captures.listDue()).toEqual([]);
      expect(store.captures.countByState().failed).toBe(1);

      expect(store.captures.retry(row.sourceKey)).toBe(true);
      expect(store.captures.get(row.sourceKey)).toMatchObject({ state: 'archived', attempts: 0, lastError: null });
      expect(store.captures.retry(row.sourceKey)).toBe(false);
    });

    it('lists by date and state, handles revokes and timezone changes', async () => {
      store.captures.insert(await newCapture('D1', { occurredAt: '2026-11-14T02:00:00Z' }));
      store.captures.insert(await newCapture('D2', { occurredAt: '2026-11-15T02:00:00Z', kind: 'text', media: null }));
      store.captures.insert(await newCapture('D3', { occurredAt: '2026-11-15T03:00:00Z' }));
      expect(store.captures.list({ localDate: '2026-11-15' }).map((c) => c.msgId)).toEqual(['D2', 'D3']);
      expect(store.captures.list({ fromDate: '2026-11-14', toDate: '2026-11-14' }).map((c) => c.msgId)).toEqual(['D1']);
      expect(store.captures.list({ limit: 1 }).map((c) => c.msgId)).toEqual(['D1']);
      store.captures.markReady('wa:D2');
      expect(store.captures.list({ states: ['ready'] }).map((c) => c.msgId)).toEqual(['D2']);
      expect(store.captures.rawLocalDates()).toEqual([
        { localDate: '2026-11-14', count: 1 },
        { localDate: '2026-11-15', count: 2 },
      ]);

      store.captures.setRevoked('wa:D3', '2026-11-15T04:00:00Z');
      expect(store.captures.get('wa:D3')?.revokedAt).toBe('2026-11-15T04:00:00.000Z');
      store.captures.setRevoked('wa:D3', null);
      expect(store.captures.get('wa:D3')?.revokedAt).toBeNull();

      // 2026-11-14T02:00Z is still 2026-11-13 in New York
      store.captures.setTimezone('wa:D1', 'America/New_York');
      expect(store.captures.get('wa:D1')).toMatchObject({ tz: 'America/New_York', localDate: '2026-11-13' });

      expect(store.captures.updateWaMetadata('wa:D1', { caption: 'neu' })).toBe(true);
      expect(store.captures.get('wa:D1')?.caption).toBe('neu');
      expect(store.captures.updateWaMetadata('wa:D1', {})).toBe(false);
    });
  });

  describe('owner mirror and change feed', () => {
    const FEED = '0123456789abcdef0123456789abcdef';
    const post: Post = {
      publicId: 'p_note0001',
      kind: 'note',
      occurredAt: '2026-11-15T06:00:00Z',
      tz: 'Asia/Ho_Chi_Minh',
      localDate: '2026-11-15',
      content: { de: { body: 'Regen.' } },
      origLocale: 'de',
      visibility: 'public',
      updatedAt: '2026-11-15T06:00:00Z',
    };
    const annotation: Annotation = {
      sourceKey: 'wa:D9',
      description: { de: 'Altstadt' },
      origLocale: 'de',
      visibility: 'hidden',
      localDateOverride: '2026-11-17',
      updatedAt: '2026-11-15T07:00:00Z',
    };
    const day: Day = {
      localDate: '2026-11-15',
      title: { de: 'Laternen' },
      placeName: 'Hội An',
      countryCode: 'VN',
      updatedAt: '2026-11-15T08:00:00Z',
    };
    const trip: Trip = {
      slug: 'vietnam-2026',
      title: { de: 'Vietnam 2026' },
      startDate: '2026-11-14',
      endDate: '2026-11-16',
      updatedAt: '2026-11-14T08:00:00Z',
    };
    const page = (): ChangesResponse => ({
      feedId: FEED,
      items: [
        { seq: 1, entity: 'post', key: post.publicId, op: 'upsert', data: post },
        { seq: 2, entity: 'annotation', key: annotation.sourceKey, op: 'upsert', data: annotation },
        { seq: 3, entity: 'day', key: day.localDate, op: 'upsert', data: day },
        { seq: 4, entity: 'trip', key: trip.slug, op: 'upsert', data: trip },
        { seq: 5, entity: 'setting', key: 'publish.mode', op: 'upsert', data: { value: 'delayed' } },
      ],
      nextSeq: 5,
      hasMore: false,
    });

    it('applies a page and advances the cursor atomically', async () => {
      store.captures.insert(await newCapture('D9', { occurredAt: '2026-11-14T02:00:00Z' }));
      const summary = store.owner.applyChanges(page());
      expect(summary).toEqual({
        applied: 5,
        skipped: 0,
        ignored: 0,
        quarantined: 0,
        cursor: 5,
        localDates: ['2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17'],
        trips: ['vietnam-2026'],
        settingsChanged: true,
        reset: false,
        rebuilt: false,
      });
      expect(store.syncState.feedCursor()).toBe(5);
      expect(store.syncState.feedId()).toBe(FEED);
      expect(store.owner.getPost('p_note0001')).toEqual(post);
      expect(store.owner.listPosts({ localDate: '2026-11-15' })).toEqual([post]);
      expect(store.owner.getAnnotation('wa:D9')).toEqual(annotation);
      expect(store.owner.annotationMap().get('wa:D9')).toEqual(annotation);
      expect(store.owner.getDay('2026-11-15')).toEqual(day);
      expect(store.owner.listTrips()).toEqual([trip]);
      expect(store.owner.tripForDate('2026-11-16')).toBe('vietnam-2026');
      expect(store.owner.tripForDate('2026-11-17')).toBeNull();
      expect(store.owner.settings()['publish.mode']).toBe('delayed');
      expect(store.owner.settings()['publish.delay_minutes']).toBe(720);
    });

    it('skips already applied items and applies tombstones', () => {
      store.owner.applyChanges(page());
      const replay = store.owner.applyChanges(page());
      expect(replay).toMatchObject({ applied: 0, skipped: 5, cursor: 5 });
      const deletes = store.owner.applyChanges({
        feedId: FEED,
        items: [
          { seq: 6, entity: 'post', key: post.publicId, op: 'delete' },
          { seq: 7, entity: 'setting', key: 'publish.mode', op: 'delete' },
          { seq: 8, entity: 'trip', key: trip.slug, op: 'delete' },
        ],
        nextSeq: 8,
        hasMore: false,
      });
      expect(deletes).toMatchObject({ applied: 3, cursor: 8, trips: ['vietnam-2026'], settingsChanged: true });
      expect(deletes.localDates).toEqual(['2026-11-14', '2026-11-15', '2026-11-16']);
      expect(store.owner.getPost(post.publicId)).toBeUndefined();
      expect(store.owner.getTrip(trip.slug)).toBeUndefined();
      expect(store.owner.settings()['publish.mode']).toBe('instant');
    });

    it('quarantines invalid items, ignores unknown ones, keeps the last good value and never blocks', () => {
      store.owner.applyChanges(page());
      const result = store.owner.applyChanges({
        feedId: FEED,
        items: [
          { seq: 6, entity: 'setting', key: 'publish.delay_minutes', op: 'upsert', data: { value: 'soon' } },
          { seq: 7, entity: 'setting', key: 'alerts.ntfy_url', op: 'upsert', data: { value: 'ftp://ntfy.example/t' } },
          { seq: 8, entity: 'setting', key: 'site.description', op: 'upsert', data: { value: 'new key' } },
          { seq: 9, entity: 'comment', key: 'c1', op: 'upsert', data: { text: 'newer API' } },
          { seq: 10, entity: 'day', key: '2026-11-15', op: 'upsert', data: { ...day, placeName: null, lat: 999 } },
          { seq: 11, entity: 'post', key: 'p_note0002', op: 'upsert', data: { ...post, publicId: 'p_note0002' } },
        ],
        nextSeq: 11,
        hasMore: false,
      });
      expect(result).toMatchObject({ applied: 1, ignored: 2, quarantined: 3, cursor: 11 });
      expect(store.syncState.feedCursor()).toBe(11);
      expect(store.owner.settings()['publish.delay_minutes']).toBe(720);
      expect(store.owner.getDay('2026-11-15')).toEqual(day); // last good value
      expect(store.owner.getPost('p_note0002')?.publicId).toBe('p_note0002');
      expect(store.owner.quarantineCount()).toBe(3);
      expect(store.owner.quarantined().map((q) => [q.seq, q.entity, q.key])).toEqual([
        [10, 'day', '2026-11-15'],
        [7, 'setting', 'alerts.ntfy_url'],
        [6, 'setting', 'publish.delay_minutes'],
      ]);
      expect(store.events.recent({ type: 'feed.item_ignored' })).toHaveLength(2);
      // The kinds are remembered for a newer version of this backend (replayIgnoredIfKnown).
      expect(store.syncState.getJson(FEED_IGNORED_KEY)).toEqual([
        { entity: 'setting', key: 'site.description' },
        { entity: 'comment' },
      ]);
      // This version still does not know them: no replay.
      expect(store.owner.replayIgnoredIfKnown()).toEqual([]);
      expect(store.syncState.rebuildPending()).toBe(false);
      // null for nullable columns is fine (PHP may emit NULL as null)
      const nulls = store.owner.applyChanges({
        feedId: FEED,
        items: [
          { seq: 12, entity: 'day', key: '2026-11-15', op: 'upsert', data: { ...day, placeName: null, tz: null } },
        ],
        nextSeq: 12,
        hasMore: false,
      });
      expect(nulls.applied).toBe(1);
    });

    it('rejects a malformed envelope before touching the database', () => {
      expect(() =>
        store.owner.applyChanges({ items: [{ seq: 1, entity: 'post', key: 'x', op: 'upsert' }], nextSeq: 1 }),
      ).toThrow();
      expect(store.syncState.feedCursor()).toBe(0);
    });

    it('rebuilds the mirror when the feed changes identity, without dropping data early', () => {
      store.owner.applyChanges(page());
      const restored = '99999999999999999999999999999999';
      const first = store.owner.applyChanges({ feedId: restored, items: [], nextSeq: 3, hasMore: false });
      expect(first).toMatchObject({ reset: true, applied: 0, cursor: 0 });
      expect(store.syncState.feedCursor()).toBe(0);
      expect(store.syncState.feedId()).toBe(restored);
      // the hidden override is still in force while the replay runs
      expect(store.owner.getAnnotation('wa:D9')?.visibility).toBe('hidden');
      const replay1 = store.owner.applyChanges({
        feedId: restored,
        items: [{ seq: 1, entity: 'annotation', key: annotation.sourceKey, op: 'upsert', data: annotation }],
        nextSeq: 1,
        hasMore: true,
      });
      expect(replay1).toMatchObject({ applied: 1, rebuilt: false });
      expect(store.owner.getPost(post.publicId)).toEqual(post); // not swept yet
      const replay2 = store.owner.applyChanges({
        feedId: restored,
        items: [{ seq: 2, entity: 'day', key: day.localDate, op: 'upsert', data: day }],
        nextSeq: 2,
        hasMore: false,
      });
      expect(replay2).toMatchObject({ applied: 1, rebuilt: true, settingsChanged: true, cursor: 2 });
      expect(store.owner.getPost(post.publicId)).toBeUndefined(); // the new feed no longer has it
      expect(store.owner.getTrip(trip.slug)).toBeUndefined();
      expect(store.owner.settings()['publish.mode']).toBe('instant');
      expect(store.owner.getAnnotation('wa:D9')).toEqual(annotation);
      expect(store.syncState.rebuildPending()).toBe(false);
    });

    it('a day tz fix invalidates the neighbouring days and moves captures', async () => {
      // 18:30Z = 01:30 on the 16th in Ho Chi Minh City, 19:30 on the 15th in Berlin
      const { row } = store.captures.insert(await newCapture('TZ1', { occurredAt: '2026-11-15T18:30:00Z' }));
      store.captures.markReady(row.sourceKey);
      expect(capturesForEffectiveDate(store, '2026-11-16').map((p) => p.capture.msgId)).toEqual(['TZ1']);
      const fix = store.owner.applyChanges({
        feedId: FEED,
        items: [
          {
            seq: 1,
            entity: 'day',
            key: '2026-11-16',
            op: 'upsert',
            data: { localDate: '2026-11-16', tz: 'Europe/Berlin', updatedAt: '2026-11-16T09:00:00Z' },
          },
        ],
        nextSeq: 1,
        hasMore: false,
      });
      expect(fix.localDates).toEqual(['2026-11-15', '2026-11-16', '2026-11-17']);
      expect(capturesForEffectiveDate(store, '2026-11-16')).toEqual([]);
      const placed = capturesForEffectiveDate(store, '2026-11-15');
      expect(placed.map((p) => [p.capture.msgId, p.tz])).toEqual([['TZ1', 'Europe/Berlin']]);
      // an override beats the fix
      store.owner.upsertAnnotation({
        sourceKey: row.sourceKey,
        localDateOverride: '2026-11-18',
        updatedAt: '2026-11-16T10:00:00Z',
      });
      expect(capturesForEffectiveDate(store, '2026-11-15')).toEqual([]);
      expect(capturesForEffectiveDate(store, '2026-11-18').map((p) => p.tz)).toEqual(['Asia/Ho_Chi_Minh']);
      // not ready / unsupported captures are never candidates
      store.captures.insert(await newCapture('TZ2', { occurredAt: '2026-11-18T03:00:00Z' }));
      expect(capturesForEffectiveDate(store, '2026-11-18')).toHaveLength(1);
    });

    it('a day tz fix across the date line moves a capture by two days and still finds it (L2-09)', async () => {
      // 10:30Z = 00:30 on the 19th at UTC+14 (Kiritimati), 23:30 on the 17th at UTC-11 (Pago Pago)
      const { row } = store.captures.insert(
        await newCapture('DL1', { occurredAt: '2026-11-18T10:30:00Z', tz: 'Pacific/Kiritimati' }),
      );
      store.captures.markReady(row.sourceKey);
      expect(row.localDate).toBe('2026-11-19');
      store.owner.upsertDay({ localDate: '2026-11-19', tz: 'Pacific/Pago_Pago', updatedAt: '2026-11-20T00:00:00Z' });
      expect(capturesForEffectiveDate(store, '2026-11-19')).toEqual([]);
      const placed = capturesForEffectiveDate(store, '2026-11-17');
      expect(placed.map((p) => [p.capture.msgId, p.tz])).toEqual([['DL1', 'Pacific/Pago_Pago']]);
    });

    it('replays the feed once when items an older version ignored are known now', () => {
      const set = (seq: number, key: string, value: unknown) => ({
        seq,
        entity: 'setting',
        key,
        op: 'upsert',
        data: { value },
      });
      store.owner.applyChanges({
        feedId: FEED,
        items: [set(1, 'site.title', 'Unterwegs')],
        nextSeq: 3,
        hasMore: false,
      });
      // What a backend before the profile settings left behind: events only, the cursor past them.
      store.events.append('feed.item_ignored', { seq: 2, entity: 'setting', key: 'site.author' });
      store.events.append('feed.item_ignored', { seq: 3, entity: 'setting', key: 'site.from_the_future' });
      expect(store.owner.settings()).not.toHaveProperty('site.author');

      expect(store.owner.replayIgnoredIfKnown()).toEqual(['site.author']);
      expect(store.syncState.rebuildPending()).toBe(true);
      expect(store.syncState.feedCursor()).toBe(0);
      expect(store.owner.settings()['site.title']).toBe('Unterwegs'); // rows stay during the replay
      // The replay brings the item in; what is still unknown is remembered again.
      store.owner.applyChanges({
        feedId: FEED,
        items: [set(1, 'site.title', 'Unterwegs'), set(2, 'site.author', 'Lea'), set(3, 'site.from_the_future', true)],
        nextSeq: 3,
        hasMore: false,
      });
      expect(store.syncState.rebuildPending()).toBe(false);
      expect(store.owner.settings()['site.author']).toBe('Lea');
      expect(store.syncState.getJson(FEED_IGNORED_KEY)).toEqual([{ entity: 'setting', key: 'site.from_the_future' }]);
      // Events already looked at and kinds still unknown never start another replay.
      expect(store.owner.replayIgnoredIfKnown()).toEqual([]);
      expect(store.syncState.rebuildPending()).toBe(false);
      expect(store.syncState.feedCursor()).toBe(3);

      // Remembered kinds (a version that already noted them) work the same way.
      store.syncState.setJson(FEED_IGNORED_KEY, [{ entity: 'setting', key: 'site.intro' }, { entity: 'comment' }]);
      expect(store.owner.replayIgnoredIfKnown()).toEqual(['site.intro']);
      expect(store.syncState.rebuildPending()).toBe(true);
    });

    it('does not replay before anything was pulled (the first pull reads everything anyway)', () => {
      store.events.append('feed.item_ignored', { seq: 1, entity: 'setting', key: 'site.avatar' });
      expect(store.owner.replayIgnoredIfKnown()).toEqual(['site.avatar']);
      expect(store.syncState.rebuildPending()).toBe(false);
      expect(store.syncState.feedCursor()).toBe(0);
    });

    it('stores settings with validation', () => {
      store.owner.setSetting('timezone.current', 'Asia/Ho_Chi_Minh');
      expect(store.owner.settings()['timezone.current']).toBe('Asia/Ho_Chi_Minh');
      expect(store.owner.rawSettings()).toEqual({ 'timezone.current': 'Asia/Ho_Chi_Minh' });
      expect(() => store.owner.setSetting('timezone.current', 'Mars/Olympus')).toThrow();
    });
  });

  describe('sync outbox', () => {
    it('coalesces pending items per kind+key and protects in-flight sends via rev', () => {
      const a = store.outbox.enqueue('capture', 'wa:A', { v: 1 });
      expect(a).toMatchObject({ kind: 'capture', key: 'wa:A', payload: { v: 1 }, rev: 1, attempts: 0 });
      const b = store.outbox.enqueue('preview', 'wa:A', { file: 'x' });
      expect(b.id).not.toBe(a.id);

      const [inFlight] = store.outbox.due();
      expect(inFlight?.id).toBe(a.id);
      const updated = store.outbox.enqueue('capture', 'wa:A', { v: 2 });
      expect(updated).toMatchObject({ id: a.id, rev: 2, payload: { v: 2 } });

      // the sender finished the old payload: row stays pending with the new one
      expect(store.outbox.markDone(a.id, 1)).toBe(false);
      expect(store.outbox.pending('capture', 'wa:A')?.payload).toEqual({ v: 2 });
      expect(store.outbox.markDone(a.id, 2)).toBe(true);
      expect(store.outbox.pending('capture', 'wa:A')).toBeUndefined();

      // a new enqueue after completion creates a fresh row
      const c = store.outbox.enqueue('capture', 'wa:A', { v: 3 });
      expect(c.id).not.toBe(a.id);
      expect(c.rev).toBe(1);
    });

    it('backs off failed items and reports stats', () => {
      const item = store.outbox.enqueue('heartbeat', 'heartbeat', { at: 1 });
      expect(store.outbox.stats()).toEqual({ pending: 1, failed: 0, oldestAt: '2026-11-19T10:00:00.000Z' });
      store.outbox.markFailed(item.id, 'HTTP 503', '2026-11-19T10:01:00Z');
      expect(store.outbox.due()).toEqual([]);
      expect(store.outbox.stats()).toMatchObject({ pending: 1, failed: 1 });
      clock.set('2026-11-19T10:01:00.000Z');
      expect(store.outbox.due()).toHaveLength(1);
      expect(store.outbox.get(item.id)).toMatchObject({ attempts: 1, lastError: 'HTTP 503' });
      // re-enqueue makes it due immediately again but keeps attempts
      clock.set('2026-11-19T10:00:30.000Z');
      store.outbox.markFailed(item.id, 'HTTP 503', '2026-11-19T11:00:00Z');
      store.outbox.enqueue('heartbeat', 'heartbeat', { at: 2 });
      expect(store.outbox.due()).toHaveLength(1);
      expect(store.outbox.get(item.id)?.attempts).toBe(2);

      const current = store.outbox.get(item.id);
      store.outbox.markDone(item.id, current?.rev ?? 0);
      expect(store.outbox.stats()).toEqual({ pending: 0, failed: 0, oldestAt: null });
      clock.set('2026-11-20T10:00:00.000Z');
      expect(store.outbox.purgeDone('2026-11-20T00:00:00Z')).toBe(1);
    });
  });

  describe('sync state, deploy manifest, events', () => {
    it('stores key/values and the feed cursor', () => {
      expect(store.syncState.feedCursor()).toBe(0);
      store.syncState.setFeedCursor(42);
      expect(store.syncState.feedCursor()).toBe(42);
      expect(() => store.syncState.setFeedCursor(-1)).toThrow();
      store.syncState.setJson('last_heartbeat', { ok: true });
      expect(store.syncState.getJson('last_heartbeat')).toEqual({ ok: true });
      expect(store.syncState.delete('last_heartbeat')).toBe(true);
      expect(store.syncState.get('last_heartbeat')).toBeUndefined();
    });

    it('tracks deployed files per target', () => {
      store.deploys.upsert('local', [
        { path: 'index.html', sha256: SHA, size: 10 },
        { path: 'data/manifest.json', sha256: SHA, size: 20 },
      ]);
      store.deploys.upsert('sftp', [{ path: 'index.html', sha256: SHA, size: 10 }]);
      expect(store.deploys.targets()).toEqual(['local', 'sftp']);
      const local = store.deploys.get('local');
      expect([...local.keys()]).toEqual(['data/manifest.json', 'index.html']);
      expect(local.get('index.html')).toEqual({
        path: 'index.html',
        sha256: SHA,
        size: 10,
        deployedAt: '2026-11-19T10:00:00.000Z',
      });
      store.deploys.upsert('local', [{ path: 'index.html', sha256: SHA, size: 11 }]);
      expect(store.deploys.get('local').get('index.html')?.size).toBe(11);
      expect(store.deploys.remove('local', ['index.html', 'missing'])).toBe(1);
      store.deploys.replace('sftp', [{ path: 'a.json', sha256: SHA, size: 1, deployedAt: '2026-01-01T00:00:00.000Z' }]);
      expect([...store.deploys.get('sftp').keys()]).toEqual(['a.json']);
      expect(store.deploys.clear('sftp')).toBe(1);
    });

    it('appends, lists and prunes events', () => {
      for (let i = 0; i < 5; i++) store.events.append(i % 2 ? 'wa.state' : 'capture.received', { i });
      store.events.append('note');
      expect(store.events.recent({ limit: 2 }).map((e) => e.data)).toEqual([null, { i: 4 }]);
      expect(store.events.recent({ type: 'wa.state' }).map((e) => e.data)).toEqual([{ i: 3 }, { i: 1 }]);
      expect(store.events.prune(3)).toBe(3);
      expect(store.events.recent().length).toBe(3);
    });
  });

  it('nests transactions as savepoints and rolls back together', async () => {
    const input = await newCapture('T1');
    expect(() =>
      store.transaction(() => {
        store.captures.insert(input);
        store.outbox.enqueue('capture', input.sourceKey, {});
        throw new Error('abort');
      }),
    ).toThrow('abort');
    expect(store.captures.get(input.sourceKey)).toBeUndefined();
    expect(store.outbox.stats().pending).toBe(0);
  });
});

describe('Store (file database)', () => {
  let tmp: { dir: string; cleanup: () => void };
  beforeEach(() => {
    tmp = makeTempDir();
  });
  afterEach(() => tmp.cleanup());

  it('uses WAL, creates parent directories and persists across reopen', async () => {
    const path = join(tmp.dir, 'nested', 'store.db');
    const store = Store.open(path);
    expect(store.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(store.db.pragma('synchronous', { simple: true })).toBe(1);
    store.captures.insert(await newCapture('P1'));
    store.meta.nextSiteVersion();
    store.close();

    const reopened = Store.open(path);
    expect(reopened.migration.applied).toEqual([]);
    expect(reopened.captures.get('wa:P1')?.msgId).toBe('P1');
    expect(reopened.meta.siteVersion()).toBe(1);
    reopened.close();
  });
});
