#!/usr/bin/env node
/**
 * A deliberately bad link for the traveler app's end-to-end run (scripts/app/e2e.sh): an HTTP
 * reverse proxy between the phone (adb reverse) and the local PHP API that can throttle, delay,
 * drop connections every N bytes and go offline, and that logs every request the app sends.
 * Local only: it binds 127.0.0.1 and forwards to 127.0.0.1.
 *
 *   node scripts/app/e2e-proxy.mjs --listen 18090 --upstream 18080 --control 18091 --log FILE.jsonl
 *
 * Control (127.0.0.1:<control>, JSON):
 *   POST /config {kbps?, delayMs?, dropEveryBytes?, offline?}   kbps 0 = unlimited, drop 0 = never
 *   GET  /stats   counters + the current config
 *   GET  /log?since=<seq>   the requests logged after <seq>
 *
 * Throttling is one shared link for all connections (like one radio): request and response
 * bodies pass in slices of at most 4 KiB at `kbps`. A drop resets the connection that carries the
 * byte where the counter crosses the next `dropEveryBytes` (request bodies, all connections).
 * Offline refuses new connections and cuts the open ones.
 */

import { appendFileSync } from 'node:fs';
import http from 'node:http';
import { Transform } from 'node:stream';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const LISTEN = Number(opt('listen', '18090'));
const UPSTREAM = Number(opt('upstream', '18080'));
const CONTROL = Number(opt('control', '18091'));
const LOG = opt('log', '');

const config = { kbps: 0, delayMs: 0, dropEveryBytes: 0, offline: false };
const stats = { requests: 0, drops: 0, refused: 0, bytesUp: 0, bytesDown: 0, startedAt: new Date().toISOString() };
const entries = [];
let seq = 0;
let dropCounter = 0;
let linkFreeAt = 0;
const t0 = Date.now();
const open = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for the shared link to carry `bytes` at the configured rate. */
async function carry(bytes) {
  if (config.kbps <= 0) return;
  const bytesPerMs = (config.kbps * 1000) / 8 / 1000;
  const now = Date.now();
  linkFreeAt = Math.max(linkFreeAt, now) + bytes / bytesPerMs;
  const wait = linkFreeAt - now;
  if (wait > 0) await sleep(wait);
}

function throttle(direction, onDrop) {
  return new Transform({
    transform(chunk, _enc, done) {
      (async () => {
        for (let i = 0; i < chunk.length; i += 4096) {
          if (config.offline) throw new Error('offline');
          let slice = chunk.subarray(i, Math.min(chunk.length, i + 4096));
          if (direction === 'up' && config.dropEveryBytes > 0) {
            const room = config.dropEveryBytes - dropCounter;
            if (slice.length >= room) {
              slice = slice.subarray(0, room);
              await carry(slice.length);
              this.push(slice);
              dropCounter = 0;
              onDrop();
              return;
            }
            dropCounter += slice.length;
          }
          await carry(slice.length);
          if (direction === 'up') stats.bytesUp += slice.length;
          else stats.bytesDown += slice.length;
          this.push(slice);
        }
      })().then(
        () => done(),
        (e) => done(e),
      );
    },
  });
}

function record(e) {
  seq += 1;
  const row = { seq, t: Date.now() - t0, at: new Date().toISOString(), ...e };
  entries.push(row);
  if (entries.length > 20000) entries.shift();
  if (LOG) appendFileSync(LOG, `${JSON.stringify(row)}\n`);
}

const server = http.createServer(async (req, res) => {
  stats.requests += 1;
  const started = Date.now();
  const method = String(req.headers['x-http-method-override'] ?? req.method).toUpperCase();
  const base = {
    method,
    viaOverride: req.headers['x-http-method-override'] ? true : undefined,
    path: (req.url ?? '').split('?')[0],
    uploadOffset: req.headers['upload-offset'] !== undefined ? Number(req.headers['upload-offset']) : undefined,
    contentLength: req.headers['content-length'] !== undefined ? Number(req.headers['content-length']) : undefined,
    kbps: config.kbps || undefined,
  };
  let finished = false;
  let dropped = false;
  const finish = (extra) => {
    if (finished) return;
    finished = true;
    record({ ...base, ...extra, ms: Date.now() - started });
  };
  if (config.delayMs > 0) await sleep(config.delayMs);
  const up = http.request(
    { host: '127.0.0.1', port: UPSTREAM, method: req.method, path: req.url, headers: req.headers },
    (ures) => {
      res.writeHead(ures.statusCode ?? 502, ures.headers);
      const down = throttle('down', () => {});
      down.on('error', () => {
        res.destroy();
        finish({ status: ures.statusCode, cut: 'offline' });
      });
      ures.pipe(down).pipe(res);
      res.on('finish', () =>
        finish({ status: ures.statusCode, uploadOffsetAfter: numberOr(ures.headers['upload-offset']) }),
      );
    },
  );
  up.on('error', () => {
    if (!res.headersSent && !dropped && !config.offline) {
      res.writeHead(502);
      res.end();
    }
    finish({ status: dropped ? 'dropped' : config.offline ? 'offline' : 502 });
  });
  const body = throttle('up', () => {
    dropped = true;
    stats.drops += 1;
    finish({ status: 'dropped' });
    up.destroy();
    req.socket.destroy();
  });
  body.on('error', () => {
    finish({ status: 'offline' });
    up.destroy();
    req.socket.destroy();
  });
  req.on('aborted', () => finish({ status: 'client_aborted' }));
  req.pipe(body).pipe(up);
});

function numberOr(v) {
  return v === undefined ? undefined : Number(v);
}

server.on('connection', (socket) => {
  if (config.offline) {
    stats.refused += 1;
    socket.destroy();
    return;
  }
  open.add(socket);
  socket.on('close', () => open.delete(socket));
});
server.keepAliveTimeout = 5000;
server.listen(LISTEN, '127.0.0.1');

const control = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const json = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(`${JSON.stringify(body)}\n`);
  };
  if (req.method === 'GET' && url.pathname === '/stats') return json(200, { ...stats, config, seq });
  if (req.method === 'GET' && url.pathname === '/log') {
    const since = Number(url.searchParams.get('since') ?? 0);
    return json(
      200,
      entries.filter((e) => e.seq > since),
    );
  }
  if (req.method === 'POST' && url.pathname === '/config') {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      try {
        const patch = JSON.parse(raw || '{}');
        for (const k of ['kbps', 'delayMs', 'dropEveryBytes']) {
          if (patch[k] !== undefined) config[k] = Math.max(0, Number(patch[k]) || 0);
        }
        if (patch.offline !== undefined) config.offline = Boolean(patch.offline);
        if (patch.dropEveryBytes !== undefined) dropCounter = 0;
        if (config.offline) for (const s of open) s.destroy();
        record({ method: 'CONFIG', path: '-', config: { ...config } });
        json(200, config);
      } catch (e) {
        json(400, { error: String(e) });
      }
    });
    return;
  }
  json(404, { error: 'not found' });
});
control.listen(CONTROL, '127.0.0.1');

const stop = () => {
  server.close();
  control.close();
  for (const s of open) s.destroy();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stderr.write(`e2e-proxy: 127.0.0.1:${LISTEN} -> 127.0.0.1:${UPSTREAM}, control 127.0.0.1:${CONTROL}\n`);
