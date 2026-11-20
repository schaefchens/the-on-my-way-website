import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, ApiRequestError } from '../../src/sync/client.js';
import { type FakeApi, startFakeApi, TOKEN } from './fake-api.js';

// Backend test ports 19200-19219 (client tests use 19201; 19207 has nothing listening).
const PORT = 19201;
let api: FakeApi;

beforeAll(async () => {
  api = await startFakeApi(PORT);
});
afterAll(async () => {
  await api.close();
});

const client = (opts: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}) =>
  new ApiClient({ baseUrl: `${api.url}/`, token: TOKEN, timeoutMs: 2_000, ...opts });

async function caught(p: Promise<unknown>): Promise<ApiRequestError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiRequestError) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

describe('ApiClient', () => {
  it('URL-encodes source keys and sends the Bearer token', async () => {
    expect(ApiClient.capturePath('wa:ABC_12-x')).toBe('/api/v1/backend/captures/wa%3AABC_12-x');
    const err = await caught(
      new ApiClient({ baseUrl: api.url, token: 'wrong' }).revoke('wa:X1', {
        contractVersion: 1,
        at: '2026-11-18T10:00:00.000Z',
      }),
    );
    expect(err.status).toBe(401);
    expect(err.errorClass).toBe('auth');
  });

  it('classifies API errors', async () => {
    const c = client();
    let err = await caught(c.revoke('wa:NOPE', { contractVersion: 1, at: '2026-11-18T10:00:00.000Z' }));
    expect(err).toMatchObject({ status: 404, code: 'capture_not_mirrored' });
    expect(err.errorClass).toBe('ordering');

    api.feed = [];
    err = await caught(c.changes(5));
    expect(err).toMatchObject({ status: 409, code: 'feed_reset' });
    expect(err.errorClass).toBe('feed_reset');

    api.fail('POST heartbeat', { status: 503, retryAfter: '7' });
    err = await caught(c.heartbeat({} as never));
    expect(err.errorClass).toBe('transient');
    expect(err.retryAfterMs).toBe(7_000);

    api.fail('POST published', { status: 422, code: 'validation_failed' });
    err = await caught(c.published({} as never));
    expect(err.errorClass).toBe('permanent');

    api.fail('POST published', { status: 429 });
    err = await caught(c.published({} as never));
    expect(err.errorClass).toBe('transient');
  });

  it('times out slow requests and reports network errors', async () => {
    api.fail('GET changes', { status: 200, delayMs: 600 });
    const err = await caught(client({ timeoutMs: 150 }).changes(0));
    expect(err.kind).toBe('timeout');
    expect(err.errorClass).toBe('transient');

    const down = await caught(new ApiClient({ baseUrl: 'http://127.0.0.1:19207', token: TOKEN }).changes(0));
    expect(down.kind).toBe('network');
  });

  it('aborts in-flight requests on abortAll()', async () => {
    api.fail('GET changes', { status: 200, delayMs: 1_000 });
    const c = client();
    const p = caught(c.changes(0));
    setTimeout(() => c.abortAll(), 50);
    const err = await p;
    expect(err.kind).toBe('aborted');
    expect((await caught(c.changes(0))).kind).toBe('aborted');
  });

  it('uploads previews as multipart with role and file', async () => {
    const c = client();
    await c.putCapture({
      contractVersion: 1,
      sourceKey: 'wa:P1',
      publicId: 'e_aaaaaaaaaaaa',
      kind: 'photo',
      occurredAt: '2026-11-18T10:00:00.000Z',
      tz: 'Europe/Berlin',
      localDate: '2026-11-18',
      mediaState: 'ok',
    });
    await c.uploadPreview('wa:P1', 'preview', {
      bytes: new Uint8Array(100),
      mime: 'image/webp',
      filename: 'preview.webp',
    });
    expect(api.previews.at(-1)).toEqual({
      sourceKey: 'wa:P1',
      role: 'preview',
      filename: 'preview.webp',
      type: 'image/webp',
      size: 100,
    });
  });
});
