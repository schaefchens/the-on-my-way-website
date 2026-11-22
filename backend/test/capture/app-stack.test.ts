/**
 * The traveler app's inbox across the real stack: scripts/app/dev-api.sh (the PHP API under php -S,
 * with a throwaway state) between a scripted phone (fetch, the tus subset of ./app) and the real
 * AppSource + ApiClient. The PHPUnit and fake-inbox tests check each side alone; this one proves they
 * agree on the wire: chunk bodies through php -S, 409/460 + Upload-Offset, HEAD, the
 * X-HTTP-Method-Override fallback, Range downloads (206), X-Omw-Sha256, the PHP JSON schemas against
 * the Zod contracts, acks that free the inbox, an original that follows later (Q2 c) and a
 * withdrawal relayed as a revoke. Skipped where php or api/vendor is missing.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { CONTRACT_VERSION } from '@omw/contracts';
import {
  type AppEntry,
  AppEntryState,
  AppPairResponse,
  appPairingCodeFromLink,
  formatUploadChecksum,
} from '@omw/contracts/app';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appRecordRelPath, readAppRecord } from '../../src/capture/app-archive.js';
import { AppSource } from '../../src/capture/app-source.js';
import { REPO_ROOT } from '../../src/paths.js';
import { ApiClient } from '../../src/sync/client.js';
import { makeEnv, type TestEnv } from './env.js';

const DEV_API = join(REPO_ROOT, 'scripts', 'app', 'dev-api.sh');
const phpReady =
  spawnSync('php', ['-r', 'exit(PHP_VERSION_ID >= 80300 ? 0 : 1);']).status === 0 &&
  existsSync(join(REPO_ROOT, 'api', 'vendor', 'autoload.php'));

const PHOTO = '01JD3ZQ8X4V7N2K5M9P0R6S8TW';
const TEXT = '01JD3ZQ8X4V7N2K5M9P0R6S8TX';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

async function jpeg(width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp({ create: { width, height, channels: 3, background: { r: 196, g: 120, b: 160 } } })
    .jpeg({ quality: 90 })
    .toBuffer();
  return new Uint8Array(buf);
}

describe.skipIf(!phpReady)('app inbox across the real stack (php -S + AppSource)', () => {
  let api: ChildProcess | null = null;
  let apiLog = '';
  let base = '';
  let link = '';
  let state = '';
  let env: TestEnv;
  let phoneToken = '';
  let source: AppSource;

  beforeAll(async () => {
    env = makeEnv({ prefix: 'app-stack-' });
    state = join(env.dir, 'api');
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const { OMW_APP_DEV_STATE: _ignored, ...parentEnv } = process.env;
    const child = spawn('bash', [DEV_API, '--port', String(port), '--state', state, '--pair'], {
      env: { ...parentEnv, PHP_CLI_SERVER_WORKERS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    api = child;
    child.stdout?.on('data', (d: Buffer) => {
      apiLog += d.toString();
      const m = /omw:\/\/pair#[0-9A-Z]{26}/.exec(apiLog);
      if (m && !link) link = m[0];
    });
    child.stderr?.on('data', (d: Buffer) => {
      apiLog += d.toString();
    });
    const deadline = Date.now() + 40_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev-api.sh exited early:\n${apiLog}`);
      const ok = await fetch(`${base}/api/v1/health`)
        .then((r) => r.ok)
        .catch(() => false);
      if (ok && link) break;
      if (Date.now() > deadline) throw new Error(`dev API did not come up:\n${apiLog}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    const backendToken = readFileSync(join(state, 'backend-token'), 'utf8').trim();
    source = new AppSource({
      config: env.config,
      log: env.log,
      store: env.store,
      client: new ApiClient({ baseUrl: base, token: backendToken }),
      backoffBaseMs: 100,
    });
  }, 60_000);

  afterAll(async () => {
    await source?.stop();
    if (api && api.exitCode === null) {
      const exited = new Promise((r) => api?.once('exit', r));
      api.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))]);
      if (api.exitCode === null) api.kill('SIGKILL');
    }
    env?.cleanup();
  });

  const phone = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${phoneToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const chunk = (
    uploadId: string,
    offset: number,
    bytes: Uint8Array,
    opts: { checksum?: string; override?: boolean } = {},
  ) =>
    fetch(`${base}/api/v1/app/uploads/${uploadId}`, {
      method: opts.override ? 'POST' : 'PATCH',
      headers: {
        authorization: `Bearer ${phoneToken}`,
        'tus-resumable': '1.0.0',
        'content-type': 'application/offset+octet-stream',
        'upload-offset': String(offset),
        'upload-checksum': opts.checksum ?? formatUploadChecksum(sha(bytes)),
        ...(opts.override ? { 'x-http-method-override': 'PATCH' } : {}),
      },
      body: Buffer.from(bytes),
    });

  const entryState = async (entryId: string) => {
    const res = await phone('GET', `/api/v1/app/entries/${entryId}`);
    expect(res.status).toBe(200);
    return AppEntryState.parse(await res.json());
  };

  it('pairs the phone with the link code (capture scope only)', async () => {
    const code = appPairingCodeFromLink(link);
    expect(code).not.toBeNull();
    const res = await fetch(`${base}/api/v1/app/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contractVersion: CONTRACT_VERSION,
        code,
        deviceName: 'Stack test phone',
        platform: 'android',
        appVersion: '0.5.0-test',
      }),
    });
    expect(res.status).toBe(201);
    const paired = AppPairResponse.parse(await res.json());
    expect(paired.info.scopes).toEqual(['capture']);
    phoneToken = paired.token;
    // Single use.
    const again = await fetch(`${base}/api/v1/app/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contractVersion: CONTRACT_VERSION,
        code,
        deviceName: 'x',
        platform: 'android',
        appVersion: '1',
      }),
    });
    expect(again.status).toBe(401);
  });

  it('carries a photo phone -> inbox -> home archive, then its original on its own (Q2 c)', async () => {
    const media = await jpeg(320, 240);
    const preview = await jpeg(64, 48);
    const original = new Uint8Array(await sharp(Buffer.from(media)).png().toBuffer());
    const entry: AppEntry = {
      schema: 1,
      entryId: PHOTO,
      source: 'app',
      kind: 'photo',
      occurredAt: new Date(Date.now() - 60_000).toISOString(),
      tz: 'Asia/Ho_Chi_Minh',
      caption: 'Phở at the corner',
      media: { width: 320, height: 240 },
      files: [
        { role: 'media', mimetype: 'image/jpeg', bytes: media.length, sha256Hex: sha(media) },
        { role: 'preview', mimetype: 'image/jpeg', bytes: preview.length, sha256Hex: sha(preview) },
        { role: 'original', mimetype: 'image/png', bytes: original.length, sha256Hex: sha(original) },
      ],
      client: { app: '0.5.0-test', platform: 'android', os: '16' },
    };
    const created = await phone('POST', '/api/v1/app/entries', {
      contractVersion: CONTRACT_VERSION,
      clientNow: new Date().toISOString(),
      entry,
    });
    expect(created.status).toBe(201);
    const slots = Object.fromEntries(
      AppEntryState.parse(await created.json()).uploads.map((u) => [u.role, u.uploadId]),
    );
    const mediaId = slots.media as string;

    // Media in two chunks, with the failures a flaky link produces in between.
    const half = Math.floor(media.length / 2);
    expect((await chunk(mediaId, 0, media.subarray(0, half))).status).toBe(204);
    const stale = await chunk(mediaId, 0, media.subarray(0, half));
    expect(stale.status).toBe(409);
    expect(stale.headers.get('upload-offset')).toBe(String(half));
    const corrupt = await chunk(mediaId, half, media.subarray(half), { checksum: formatUploadChecksum(sha(preview)) });
    expect(corrupt.status).toBe(460);
    const head = await fetch(`${base}/api/v1/app/uploads/${mediaId}`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${phoneToken}`, 'tus-resumable': '1.0.0' },
    });
    expect(head.headers.get('upload-offset')).toBe(String(half));
    const rest = await chunk(mediaId, half, media.subarray(half), { override: true });
    expect(rest.status).toBe(204);
    expect(rest.headers.get('upload-offset')).toBe(String(media.length));
    expect((await chunk(slots.preview as string, 0, preview)).status).toBe(204);
    const committed = await phone('POST', `/api/v1/app/entries/${PHOTO}/commit`, { roles: ['media', 'preview'] });
    expect(committed.status).toBe(200);
    expect(AppEntryState.parse(await committed.json()).state).toBe('uploaded');

    // A download that was cut off before: the backend resumes it with Range (206 through php -S).
    const partDir = join(env.config.dirs.data, 'inbox-app', PHOTO);
    mkdirSync(partDir, { recursive: true });
    writeFileSync(join(partDir, `${mediaId}.part`), media.subarray(0, 1000));

    expect(await source.pollNow()).toBe(1);
    const row = env.store.captures.get(`app:${PHOTO}`);
    expect(row).toMatchObject({ source: 'app', kind: 'photo', state: 'archived', caption: 'Phở at the corner' });
    if (!row?.archivePath) throw new Error('no archive path');
    expect(row.archivePath).toBe(appRecordRelPath(row.occurredAt, PHOTO));
    let record = await readAppRecord(env.config.dirs.archive, row.archivePath);
    expect(record.files.media?.sha256Hex).toBe(sha(media));
    expect(record.files.preview?.sha256Hex).toBe(sha(preview));
    expect(record.files.original).toBeUndefined();
    expect(existsSync(partDir)).toBe(false);
    let st = await entryState(PHOTO);
    expect(st.state).toBe('archived');
    expect(st.uploads.find((u) => u.role === 'media')?.archived).toBe(true);
    expect(existsSync(join(state, 'var', 'app-inbox', PHOTO, `${mediaId}.part`))).toBe(false);

    // Later, on Wi-Fi: the untouched original.
    expect((await chunk(slots.original as string, 0, original)).status).toBe(204);
    expect((await phone('POST', `/api/v1/app/entries/${PHOTO}/commit`, { roles: ['original'] })).status).toBe(200);
    expect(await source.pollNow()).toBe(1);
    record = await readAppRecord(env.config.dirs.archive, row.archivePath);
    expect(record.files.original).toMatchObject({ sha256Hex: sha(original), mimetype: 'image/png' });
    st = await entryState(PHOTO);
    expect(st.uploads.find((u) => u.role === 'original')?.archived).toBe(true);
    expect(await source.pollNow()).toBe(0);
  });

  it('archives a text status and relays her withdrawal as a revoke; archive-only is reported', async () => {
    const created = await phone('POST', '/api/v1/app/entries', {
      contractVersion: CONTRACT_VERSION,
      clientNow: new Date().toISOString(),
      entry: {
        schema: 1,
        entryId: TEXT,
        source: 'app',
        kind: 'text',
        occurredAt: new Date(Date.now() - 5_000).toISOString(),
        tz: 'Asia/Ho_Chi_Minh',
        text: { body: 'Xin chào Việt Nam!', bgArgb: 4290660980, textArgb: 4294967295, font: 'CALISTOGA_REGULAR' },
        files: [],
        client: { app: '0.5.0-test', platform: 'android' },
      } satisfies AppEntry,
    });
    expect(created.status).toBe(201);
    expect(await source.pollNow()).toBe(1);
    expect(env.store.captures.get(`app:${TEXT}`)).toMatchObject({ kind: 'text', state: 'archived', revokedAt: null });

    expect((await phone('DELETE', `/api/v1/app/entries/${TEXT}`)).status).toBe(204);
    expect(await source.pollNow()).toBe(1);
    const row = env.store.captures.get(`app:${TEXT}`);
    expect(row?.revokedAt).toBeTruthy();
    if (!row?.archivePath) throw new Error('no archive path');
    expect((await readAppRecord(env.config.dirs.archive, row.archivePath)).withdrawnAt).toBeTruthy();
    expect(await source.pollNow()).toBe(0);

    const hints = await phone('GET', '/api/v1/app/hints');
    expect(((await hints.json()) as { archiveOnly: boolean }).archiveOnly).toBe(true);
  });
});
