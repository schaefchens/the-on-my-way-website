/**
 * The "app:" capture source against a fake API inbox (real ApiClient, injected fetch): download
 * with Range resume, sha256 checks, the archive layout, the capture row and its mirror, acks,
 * originals that follow later (Q2 c), withdrawals, rejects, pauses, the archive-only report, the
 * restore from the archive, and the ingest taking an app capture through the real pipeline.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AppEntry } from '@omw/contracts/app';
import type { AppInboxAck, AppInboxItem } from '@omw/contracts/app-inbox';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appRecordRelPath, readAppRecord } from '../../src/capture/app-archive.js';
import { AppSource } from '../../src/capture/app-source.js';
import { CaptureIngest } from '../../src/capture/ingest.js';
import { publishableCaptures } from '../../src/generator/generate.js';
import { ApiClient } from '../../src/sync/client.js';
import { fakeClock } from '../helpers.js';
import { FakeSource, makeEnv, type TestEnv } from './env.js';

const E1 = '01JD3ZQ8X4V7N2K5M9P0R6S8TW';
const E2 = '01JD3ZQ8X4V7N2K5M9P0R6S8TX';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

type Mode = 'cut' | 'busy' | 'corrupt' | 'gone';

/** The API's app inbox, in memory. */
class FakeInbox {
  readonly items = new Map<string, AppInboxItem>();
  readonly bytes = new Map<string, Uint8Array>();
  readonly acks: { entryId: string; body: AppInboxAck }[] = [];
  readonly rejects: { entryId: string; reason: string }[] = [];
  readonly queries: URLSearchParams[] = [];
  readonly ranges: { uploadId: string; range: string | null }[] = [];
  /** Next content answers per upload id. */
  readonly script = new Map<string, Mode[]>();

  add(
    entry: AppEntry,
    files: {
      role: 'media' | 'preview' | 'original';
      mimetype: string;
      data: Uint8Array;
      state?: 'open' | 'committed';
    }[],
    extra: Partial<AppInboxItem> = {},
  ): AppInboxItem {
    entry.files = files.map((f) => ({
      role: f.role,
      mimetype: f.mimetype,
      bytes: f.data.length,
      sha256Hex: sha(f.data),
    }));
    const item: AppInboxItem = {
      entryId: entry.entryId,
      sourceKey: `app:${entry.entryId}`,
      state: 'uploaded',
      occurredAt: entry.occurredAt,
      receivedAt: '2026-11-20T10:00:05.000Z',
      clamped: false,
      heldBack: false,
      phone: { id: 1, name: 'Pixel 8a' },
      entry,
      files: files.map((f, i) => {
        const uploadId = `u_${entry.entryId.slice(-10)}${f.role}${i}xxxxxxx`;
        this.bytes.set(uploadId, f.data);
        return {
          uploadId,
          role: f.role,
          mimetype: f.mimetype,
          bytes: f.data.length,
          sha256Hex: sha(f.data),
          state: f.state ?? 'committed',
        };
      }),
      withdrawnAt: null,
      ...extra,
    };
    this.items.set(entry.entryId, item);
    return item;
  }

  listed(): AppInboxItem[] {
    return [...this.items.values()].filter(
      (i) =>
        i.withdrawnAt !== null ||
        i.state === 'uploaded' ||
        i.state === 'fetching' ||
        (i.state === 'archived' && i.files.some((f) => f.role === 'original' && f.state === 'committed')),
    );
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
    if (method === 'GET' && url.pathname === '/api/v1/backend/app/entries') {
      this.queries.push(url.searchParams);
      return json(200, { items: this.listed(), hasMore: false, serverNow: '2026-11-20T10:00:10.000Z' });
    }
    const content = /^\/api\/v1\/backend\/app\/uploads\/([^/]+)\/content$/.exec(url.pathname);
    if (content?.[1]) {
      const uploadId = decodeURIComponent(content[1]);
      const range = new Headers(init?.headers).get('range');
      this.ranges.push({ uploadId, range });
      const mode = this.script.get(uploadId)?.shift();
      if (mode === 'busy')
        return json(503, { error: { code: 'transfer_busy', message: 'busy' } }, { 'retry-after': '7' });
      if (mode === 'gone') return json(410, { error: { code: 'gone', message: 'gone' } });
      let data = this.bytes.get(uploadId);
      if (!data) return json(404, { error: { code: 'not_found', message: 'no' } });
      if (mode === 'corrupt') data = data.map((b) => b ^ 0xff);
      const start = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0) : 0;
      const body = data.subarray(start);
      const headers = {
        'content-type': 'application/octet-stream',
        'x-omw-sha256': sha(this.bytes.get(uploadId) ?? data),
      };
      if (mode === 'cut') {
        const half = body.subarray(0, Math.floor(body.length / 2));
        let sent = false;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) controller.error(new Error('connection reset'));
            else {
              sent = true;
              controller.enqueue(half);
            }
          },
        });
        return new Response(stream, { status: range ? 206 : 200, headers });
      }
      return new Response(new Uint8Array(body), { status: range ? 206 : 200, headers });
    }
    const ack = /^\/api\/v1\/backend\/app\/entries\/([^/]+)\/(ack|reject)$/.exec(url.pathname);
    if (ack?.[1] && method === 'POST') {
      const item = this.items.get(ack[1]);
      if (!item) return json(404, { error: { code: 'not_found', message: 'no' } });
      const body = JSON.parse(String(init?.body)) as AppInboxAck & { reason?: string };
      if (ack[2] === 'reject') {
        this.rejects.push({ entryId: ack[1], reason: String(body.reason) });
        item.state = 'rejected';
        return new Response(null, { status: 204 });
      }
      this.acks.push({ entryId: ack[1], body });
      if (item.state === 'withdrawn' && body.roles.length > 0)
        return json(410, { error: { code: 'gone', message: 'withdrawn' } });
      for (const f of item.files) if (body.roles.includes(f.role) && f.state === 'committed') f.state = 'archived';
      if (
        (item.state === 'uploaded' || item.state === 'fetching') &&
        (body.roles.includes('media') || !item.files.some((f) => f.role === 'media'))
      ) {
        item.state = 'archived';
      }
      if (body.withdrawal) item.withdrawnAt = null;
      return new Response(null, { status: 204 });
    }
    return json(404, { error: { code: 'not_found', message: `${method} ${url.pathname}` } });
  };
}

function photo(entryId: string, extra: Partial<AppEntry> = {}): AppEntry {
  return {
    schema: 1,
    entryId,
    source: 'app',
    kind: 'photo',
    occurredAt: '2026-11-20T09:59:00.000Z',
    tz: 'Asia/Ho_Chi_Minh',
    caption: 'Lanterns in Hội An',
    media: { width: 64, height: 48, accessibilityLabel: 'Text on image: Hội An' },
    files: [],
    client: { app: '2026.11.20-test', platform: 'android' },
    ...extra,
  };
}

function text(entryId: string): AppEntry {
  return {
    schema: 1,
    entryId,
    source: 'app',
    kind: 'text',
    occurredAt: '2026-11-20T09:59:30.000Z',
    tz: 'Asia/Ho_Chi_Minh',
    text: { body: 'Arrived!', bgArgb: 0xff7e57c2, textArgb: 0xffffffff, font: 'SYSTEM' },
    files: [],
    client: { app: '2026.11.20-test', platform: 'android' },
  };
}

/** A small JPEG that carries GPS EXIF (as an unredacted camera file would). */
async function jpegWithGps(): Promise<Uint8Array> {
  const buf = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c0396b' } })
    .jpeg()
    .withExif({
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '15/1 52/1 48/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '108/1 19/1 30/1',
      },
    })
    .toBuffer();
  return new Uint8Array(buf);
}

describe('app source', () => {
  let env: TestEnv;
  let inbox: FakeInbox;
  let source: AppSource;
  const clock = fakeClock('2026-11-20T10:01:00.000Z');

  const makeSource = (publish = false) =>
    new AppSource({
      config: { ...env.config, app: { publish, pollSeconds: 60 } },
      log: env.log,
      store: env.store,
      client: new ApiClient({ baseUrl: 'http://127.0.0.1:9', token: 'omw_test', fetch: inbox.fetch }),
      now: clock,
      backoffBaseMs: 1_000,
    });

  beforeEach(() => {
    env = makeEnv({
      prefix: 'app-source-',
      env: { API_BASE_URL: 'http://127.0.0.1:9', API_TOKEN: 'omw_test' },
      now: clock,
    });
    inbox = new FakeInbox();
    source = makeSource();
  });
  afterEach(async () => {
    await source.stop();
    env.cleanup();
  });

  it('archives a photo with its preview and original, inserts the capture and acks', async () => {
    const media = await jpegWithGps();
    const preview = new Uint8Array([1, 2, 3, 4]);
    const original = new Uint8Array(200_000).map((_, i) => i % 251);
    inbox.add(photo(E1), [
      { role: 'media', mimetype: 'image/jpeg', data: media },
      { role: 'preview', mimetype: 'image/jpeg', data: preview },
      { role: 'original', mimetype: 'image/heic', data: original },
    ]);
    const handled = await source.pollNow();
    expect(source.status().lastError).toBeNull();
    expect(env.records.filter((r) => r.level >= 40).map((r) => r.msg)).toEqual([]);
    expect(handled).toBe(1);
    expect(inbox.queries[0]?.get('archiveOnly')).toBe('1');

    const rel = appRecordRelPath('2026-11-20T09:59:00.000Z', E1);
    expect(rel).toBe(`app/2026/11/20/app-${E1}.json`);
    const record = await readAppRecord(env.config.dirs.archive, rel);
    expect(record.type).toBe('omw.app-entry');
    expect(record.entry.media?.accessibilityLabel).toBe('Text on image: Hội An');
    expect(Object.keys(record.files).sort()).toEqual(['media', 'original', 'preview']);
    const dir = join(env.config.dirs.archive, 'app/2026/11/20');
    expect(sha(readFileSync(join(dir, `app-${E1}.jpg`)))).toBe(sha(media));
    expect(sha(readFileSync(join(dir, `app-${E1}.original.heic`)))).toBe(sha(original));
    expect(existsSync(join(dir, `app-${E1}.preview.jpg`))).toBe(true);

    const row = env.store.captures.get(`app:${E1}`);
    expect(row).toMatchObject({
      source: 'app',
      kind: 'photo',
      state: 'archived',
      msgId: null,
      caption: 'Lanterns in Hội An',
    });
    expect(row?.originalSha256).toBe(sha(media));
    expect(row?.localDate).toBe('2026-11-20');
    expect(row?.media).toMatchObject({ mimetype: 'image/jpeg', fileLength: media.length, width: 64, height: 48 });
    expect(env.store.outbox.due(100).some((o) => o.kind === 'capture' && o.key === `app:${E1}`)).toBe(true);

    expect(inbox.acks).toEqual([{ entryId: E1, body: { roles: ['media', 'preview', 'original'] } }]);
    expect(existsSync(join(env.config.dirs.data, 'inbox-app', E1))).toBe(false);
    expect(await source.pollNow()).toBe(0);
  });

  it('resumes a cut download with Range, and the original that arrives later', async () => {
    const media = await jpegWithGps();
    const original = new Uint8Array(100_000).map((_, i) => (i * 7) % 256);
    const item = inbox.add(photo(E1), [
      { role: 'media', mimetype: 'image/jpeg', data: media },
      { role: 'original', mimetype: 'image/heic', data: original, state: 'open' },
    ]);
    const mediaId = item.files[0]?.uploadId ?? '';
    inbox.script.set(mediaId, ['cut']);
    expect(await source.pollNow()).toBe(0);
    expect(inbox.acks).toEqual([]);
    expect(source.status().pausedUntil).not.toBeNull();
    clock.advance(2_000);
    expect(await source.pollNow()).toBe(1);
    expect(inbox.ranges.filter((r) => r.uploadId === mediaId).map((r) => r.range)).toEqual([
      null,
      `bytes=${Math.floor(media.length / 2)}-`,
    ]);
    expect(inbox.acks[0]?.body.roles).toEqual(['media']);

    // On Wi-Fi, hours later: the original is committed and follows on its own.
    const slot = item.files[1];
    if (slot) slot.state = 'committed';
    expect(await source.pollNow()).toBe(1);
    expect(inbox.acks[1]?.body.roles).toEqual(['original']);
    const record = await readAppRecord(env.config.dirs.archive, appRecordRelPath(item.occurredAt, E1));
    expect(record.files.original?.sha256Hex).toBe(sha(original));
  });

  it('rejects an entry whose media never matches its sha256', async () => {
    const item = inbox.add(photo(E1), [{ role: 'media', mimetype: 'image/jpeg', data: await jpegWithGps() }]);
    inbox.script.set(item.files[0]?.uploadId ?? '', ['corrupt', 'corrupt', 'corrupt']);
    for (let i = 0; i < 3; i++) await source.pollNow();
    expect(inbox.rejects).toHaveLength(1);
    expect(inbox.rejects[0]?.reason).toMatch(/sha256/);
    expect(env.store.captures.get(`app:${E1}`)).toBeUndefined();
    expect(inbox.acks).toEqual([]);
  });

  it('pauses for Retry-After while the transfer slot is busy', async () => {
    const item = inbox.add(photo(E1), [{ role: 'media', mimetype: 'image/jpeg', data: await jpegWithGps() }]);
    inbox.script.set(item.files[0]?.uploadId ?? '', ['busy']);
    expect(await source.pollNow()).toBe(0);
    expect(source.status().pausedUntil).toBe(new Date(clock().getTime() + 7_000).toISOString());
    expect(await source.pollNow()).toBe(0);
    expect(inbox.queries).toHaveLength(1);
    clock.advance(7_000);
    expect(await source.pollNow()).toBe(1);
  });

  it('archives a text status and relays her withdrawal as a revoke', async () => {
    inbox.add(text(E2), []);
    const changes: string[][] = [];
    source.onChange((c) => changes.push(c.sourceKeys));
    expect(await source.pollNow()).toBe(1);
    expect(env.store.captures.get(`app:${E2}`)).toMatchObject({
      kind: 'text',
      state: 'archived',
      text: { body: 'Arrived!', font: 'SYSTEM' },
    });
    expect(inbox.acks[0]).toEqual({ entryId: E2, body: { roles: [] } });

    const item = inbox.items.get(E2);
    if (item) {
      item.state = 'withdrawn';
      item.withdrawnAt = '2026-11-20T11:00:00.000Z';
    }
    expect(await source.pollNow()).toBe(1);
    expect(env.store.captures.get(`app:${E2}`)?.revokedAt).toBe('2026-11-20T11:00:00.000Z');
    expect(env.store.outbox.due(100).some((o) => o.kind === 'revoke' && o.key === `app:${E2}`)).toBe(true);
    expect(inbox.acks[1]).toEqual({ entryId: E2, body: { roles: [], withdrawal: true } });
    expect(changes).toEqual([[`app:${E2}`]]);
    const record = await readAppRecord(env.config.dirs.archive, appRecordRelPath('2026-11-20T09:59:30.000Z', E2));
    expect(record.withdrawnAt).toBe('2026-11-20T11:00:00.000Z');
  });

  it('reports the archive-only switch and restores lost captures from the archive', async () => {
    inbox.add(text(E2), []);
    await source.pollNow();
    const publishing = makeSource(true);
    await publishing.pollNow();
    expect(inbox.queries.map((q) => q.get('archiveOnly'))).toEqual(['1', '0']);

    env.store.db.prepare('DELETE FROM captures').run();
    expect(await source.restoreFromArchive()).toBe(1);
    expect(env.store.captures.get(`app:${E2}`)).toMatchObject({ source: 'app', state: 'archived' });
  });

  it('feeds the same pipeline as WhatsApp captures: GPS is gone from every variant', async () => {
    inbox.add(photo(E1), [{ role: 'media', mimetype: 'image/jpeg', data: await jpegWithGps() }]);
    await source.pollNow();
    const ingest = new CaptureIngest({
      config: env.config,
      log: env.log,
      paths: env.paths,
      store: env.store,
      source: new FakeSource(),
      now: clock,
    });
    try {
      const result = await ingest.drain();
      expect(env.store.captures.get(`app:${E1}`)?.lastError ?? null).toBeNull();
      expect(env.store.captures.get(`app:${E1}`)?.state).toBe('ready');
      expect(env.records.filter((r) => r.level >= 40).map((r) => r.msg)).toEqual([]);
      expect(result.processed).toBe(1);
      // A reprocess from the archive works for app captures too.
      expect(await ingest.reprocess(`app:${E1}`)).toBe(1);
    } finally {
      await ingest.stop();
    }
    const row = env.store.captures.get(`app:${E1}`);
    expect(row?.state).toBe('ready');
    expect(row?.variants?.length).toBeGreaterThan(0);
    for (const v of row?.variants ?? []) {
      const meta = await sharp(join(env.config.dirs.media, v.relPath.replace(/^media\//, ''))).metadata();
      expect(meta.exif, v.relPath).toBeUndefined();
    }
  });

  it('keeps app captures out of the site while APP_PUBLISH is off', () => {
    const captures = [{ sourceKey: 'wa:3EB0' }, { sourceKey: `app:${E1}` }];
    expect(publishableCaptures(captures, {}).map((c) => c.sourceKey)).toEqual(['wa:3EB0']);
    expect(publishableCaptures(captures, { app: { publish: false, pollSeconds: 60 } })).toHaveLength(1);
    expect(publishableCaptures(captures, { app: { publish: true, pollSeconds: 60 } })).toHaveLength(2);
  });

  it('stays idle without an API', async () => {
    const idle = new AppSource({ config: env.config, log: env.log, store: env.store, client: null });
    await idle.start();
    expect(await idle.pollNow()).toBe(0);
    expect(idle.status().enabled).toBe(false);
    await idle.stop();
    rmSync(join(env.config.dirs.data, 'inbox-app'), { recursive: true, force: true });
  });
});
