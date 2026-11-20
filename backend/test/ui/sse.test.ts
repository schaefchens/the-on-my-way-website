import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ControlServer, createControlServer } from '../../src/ui/server.js';
import { silentLog } from '../sync/helpers.js';
import { type FakeBackend, fakeBackend } from './fake-backend.js';

// An ephemeral port (the OS picks a free one above every agent's fixed range): parallel runs
// of the backend suite never collide.
const TOKEN = 'control-token-for-tests-123';
let backend: FakeBackend;
let server: ControlServer;
let base = '';

beforeAll(async () => {
  backend = fakeBackend();
  server = await createControlServer({
    backend,
    token: TOKEN,
    host: '127.0.0.1',
    port: 0,
    log: silentLog(),
    version: 'test',
    sseKeepAliveMs: 100,
  });
  base = await server.listen();
});

afterAll(async () => {
  await server.close();
  backend.store.close();
});

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, pattern: RegExp, timeoutMs = 3_000) {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (!pattern.test(text)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${pattern}; got ${text}`);
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe('live QR stream (SSE)', () => {
  it('pushes state, QR (as SVG), keep-alives and pairing codes as they happen', async () => {
    const abort = new AbortController();
    const res = await fetch(`${base}/api/wa/stream`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: abort.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    expect(await readUntil(reader, /event: state\ndata: \{"state":"qr"/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(backend.wa.subscribers).toBe(1);

    backend.source.emit({ type: 'qr', code: '2@live,qr,code', expiresAt: new Date(Date.now() + 20_000).toISOString() });
    const qr = await readUntil(reader, /event: qr\ndata: \{"svg":"<svg[^\n]*\n\n/);
    expect(qr).toContain('expiresAt');
    expect(await readUntil(reader, /: keep-alive/)).toBeTruthy();

    backend.source.emit({ type: 'pair_code', code: 'WXYZ-1234' });
    expect(await readUntil(reader, /event: pair_code\ndata: \{"code":"WXYZ-1234"\}/)).toBeTruthy();

    backend.source.emit({ type: 'state', state: 'open', at: new Date().toISOString() });
    expect(await readUntil(reader, /event: state\ndata: \{"state":"open"/)).toBeTruthy();

    abort.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(backend.wa.subscribers).toBe(0);
  });
});

describe('link page lifecycle over SSE', () => {
  it('tells an open page when the QR window ended (helper stopped, exit 7) and when it restarts', async () => {
    backend.source.update({ wa: 'qr', process: 'running', qr: null });
    const abort = new AbortController();
    const res = await fetch(`${base}/api/wa/stream`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: abort.signal,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await readUntil(reader, /event: state\ndata: \{"state":"qr","label":"Waiting for scan"/);

    // What HelperSource does on exit 7: stopped, QR cleared, state closed, no restart scheduled.
    backend.source.update({
      process: 'stopped',
      wa: 'closed',
      qr: null,
      lastExit: { code: 7, signal: null, at: new Date().toISOString(), meaning: 'pairing window ended without a link' },
    });
    const stopped = await readUntil(reader, /"step":"renew"[^\n]*\n\n/);
    expect(stopped).toContain('"label":"Disconnected"');
    expect(stopped).toContain('"renewText":"This code expired — show a new one."');
    expect(stopped).toContain('"process":"stopped"');
    expect(stopped).toMatch(/"lastExit":\{"code":7/);

    // "Show a new QR code" restarts it: the page goes back to waiting for the next code.
    backend.source.update({ process: 'starting' });
    expect(await readUntil(reader, /"step":"waiting"/)).toBeTruthy();
    abort.abort();
  });
});
