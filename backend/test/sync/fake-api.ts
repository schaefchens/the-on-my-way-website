/**
 * In-process fake of the PHP API's backend endpoints (contracts api.ts, api/src/Http/Routes.php),
 * on node:http so the real fetch/FormData code paths run. Validates request bodies with the
 * contracts and lets tests script failures.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { CaptureMirror, CaptureRevoke, Heartbeat, PublishedReport } from '@omw/contracts/api';

export const TOKEN = 'omw_test_backend_token';

export interface Failure {
  status: number;
  code?: string;
  retryAfter?: string;
  /** Delay before answering (ms), e.g. to trigger client timeouts. */
  delayMs?: number;
  /** Only for GET changes with this ?after= (e.g. fail the second page only). */
  whenAfter?: number;
}

export interface PreviewUpload {
  sourceKey: string;
  role: string;
  filename: string;
  type: string;
  size: number;
}

export interface FakeApi {
  url: string;
  port: number;
  feedId: string;
  /** Raw change items (seq ascending); tests may push invalid ones. */
  feed: unknown[];
  captures: Map<string, CaptureMirror>;
  previews: PreviewUpload[];
  revokes: { sourceKey: string; at: string }[];
  heartbeats: Heartbeat[];
  published: PublishedReport[];
  /** Every request: "METHOD path". */
  log: string[];
  /** Scripted failures per route key ("PUT capture", "POST preview", "GET changes", …), consumed FIFO. */
  failures: Map<string, Failure[]>;
  fail(route: string, ...failures: Failure[]): void;
  /** Delays (ms) before answering normally, per route key, consumed FIFO. */
  delays: Map<string, number[]>;
  /** GET backup/latest: the newest backup (null = 404 "no backup yet"); etag defaults to "\"<sha256>\"". */
  backup: { bytes: Buffer; etag?: string } | null;
  invalidBodies: string[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const apiError = (code: string, message = code) => ({ error: { code, message } });

/** Minimal multipart parser (enough for the preview upload). */
function parseMultipart(
  body: Buffer,
  contentType: string,
): Map<string, { value: Buffer; filename?: string; type?: string }> {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = m?.[1] ?? m?.[2];
  const out = new Map<string, { value: Buffer; filename?: string; type?: string }>();
  if (!boundary) return out;
  const delimiter = Buffer.from(`--${boundary}`);
  let pos = body.indexOf(delimiter);
  while (pos !== -1) {
    const start = pos + delimiter.length;
    if (body.subarray(start, start + 2).toString() === '--') break;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    const part = body.subarray(start + 2, next - 2); // skip CRLF after delimiter and before next
    const headerEnd = part.indexOf('\r\n\r\n');
    const headers = part.subarray(0, headerEnd).toString();
    const value = part.subarray(headerEnd + 4);
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/.exec(headers)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1];
    if (name) out.set(name, { value, ...(filename !== undefined ? { filename } : {}), ...(type ? { type } : {}) });
    pos = next;
  }
  return out;
}

export async function startFakeApi(port: number, options: { feedId?: string } = {}): Promise<FakeApi> {
  const api: FakeApi = {
    url: `http://127.0.0.1:${port}`,
    port,
    feedId: options.feedId ?? 'feed_aaaaaaaa',
    feed: [],
    captures: new Map(),
    previews: [],
    revokes: [],
    heartbeats: [],
    published: [],
    log: [],
    failures: new Map(),
    delays: new Map(),
    backup: null,
    invalidBodies: [],
    fail(route, ...failures) {
      const list = this.failures.get(route) ?? [];
      list.push(...failures);
      this.failures.set(route, list);
    },
    close: async () => {},
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', api.url);
    const path = url.pathname;
    api.log.push(`${req.method} ${path}${url.search}`);
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, apiError('unauthorized'));

    let route = '';
    let sourceKey = '';
    const capture = /^\/api\/v1\/backend\/captures\/([^/]+)(\/preview|\/revoke)?$/.exec(path);
    if (capture) {
      sourceKey = decodeURIComponent(capture[1] ?? '');
      route = capture[2] === '/preview' ? 'POST preview' : capture[2] === '/revoke' ? 'POST revoke' : 'PUT capture';
    } else if (path === '/api/v1/backend/changes') route = 'GET changes';
    else if (path === '/api/v1/backend/heartbeat') route = 'POST heartbeat';
    else if (path === '/api/v1/backend/published') route = 'POST published';
    else if (path === '/api/v1/backend/backup/latest') route = 'GET backup';
    else return send(res, 404, apiError('not_found'));

    const queue = api.failures.get(route) ?? [];
    const at = queue.findIndex(
      (f) => f.whenAfter === undefined || url.searchParams.get('after') === String(f.whenAfter),
    );
    const failure = at >= 0 ? queue.splice(at, 1)[0] : undefined;
    if (failure) {
      if (failure.delayMs) await new Promise((r) => setTimeout(r, failure.delayMs));
      return send(res, failure.status, apiError(failure.code ?? `http_${failure.status}`), {
        ...(failure.retryAfter ? { 'retry-after': failure.retryAfter } : {}),
      });
    }

    const delay = api.delays.get(route)?.shift();
    if (delay) await new Promise((r) => setTimeout(r, delay));

    const body = await readBody(req);
    const jsonBody = () => {
      try {
        return JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        return undefined;
      }
    };

    switch (route) {
      case 'PUT capture': {
        const parsed = CaptureMirror.safeParse(jsonBody());
        if (!parsed.success || parsed.data.sourceKey !== sourceKey) {
          api.invalidBodies.push(route);
          return send(res, 422, apiError('validation_failed'));
        }
        const prev = api.captures.get(sourceKey);
        api.captures.set(sourceKey, { ...parsed.data, revokedAt: prev?.revokedAt ?? parsed.data.revokedAt ?? null });
        return send(res, 200, { ok: true });
      }
      case 'POST preview': {
        if (!api.captures.has(sourceKey)) return send(res, 404, apiError('capture_not_mirrored'));
        const parts = parseMultipart(body, String(req.headers['content-type'] ?? ''));
        const role = parts.get('role')?.value.toString();
        const file = parts.get('file');
        if (!role || !file) return send(res, 422, apiError('validation_failed'));
        if (file.value.length > 512 * 1024) return send(res, 413, apiError('payload_too_large'));
        api.previews.push({
          sourceKey,
          role,
          filename: file.filename ?? '',
          type: file.type ?? '',
          size: file.value.length,
        });
        return send(res, 204);
      }
      case 'POST revoke': {
        const parsed = CaptureRevoke.safeParse(jsonBody());
        if (!parsed.success) return send(res, 422, apiError('validation_failed'));
        if (!api.captures.has(sourceKey)) return send(res, 404, apiError('capture_not_mirrored'));
        api.revokes.push({ sourceKey, at: parsed.data.at });
        return send(res, 204);
      }
      case 'GET changes': {
        const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10);
        const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 500);
        const seqOf = (i: unknown) => ((i as { seq?: unknown }).seq as number) ?? 0;
        const maxSeq = api.feed.reduce<number>((m, i) => Math.max(m, seqOf(i)), 0);
        if (after > maxSeq) return send(res, 409, apiError('feed_reset'));
        const items = api.feed.filter((i) => seqOf(i) > after).slice(0, limit);
        const last = items.at(-1);
        const nextSeq = last ? seqOf(last) : after;
        return send(res, 200, {
          feedId: api.feedId,
          items,
          nextSeq,
          hasMore: api.feed.some((i) => seqOf(i) > nextSeq),
        });
      }
      case 'POST heartbeat': {
        const parsed = Heartbeat.safeParse(jsonBody());
        if (!parsed.success) {
          api.invalidBodies.push(route);
          return send(res, 422, apiError('validation_failed'));
        }
        api.heartbeats.push(parsed.data);
        return send(res, 204);
      }
      case 'GET backup': {
        const b = api.backup;
        if (!b) return send(res, 404, apiError('not_found', 'No backup yet'));
        const etag = b.etag ?? `"${createHash('sha256').update(b.bytes).digest('hex')}"`;
        if ((req.headers['if-none-match'] ?? '') === etag) return send(res, 304, undefined, { etag });
        res.writeHead(200, {
          'content-type': 'application/vnd.sqlite3',
          'content-length': String(b.bytes.length),
          etag,
        });
        res.end(b.bytes);
        return;
      }
      case 'POST published': {
        const parsed = PublishedReport.safeParse(jsonBody());
        if (!parsed.success) {
          api.invalidBodies.push(route);
          return send(res, 422, apiError('validation_failed'));
        }
        api.published.push(parsed.data);
        return send(res, 204);
      }
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => send(res, 500, apiError('internal', String(err))));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  api.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return api;
}

// ---------------------------------------------------------------------------------------------
// Feed item builders

let seqCounter = 0;
export function resetSeq(n = 0): void {
  seqCounter = n;
}

export function postItem(publicId: string, localDate: string, seq = ++seqCounter) {
  return {
    seq,
    entity: 'post',
    key: publicId,
    op: 'upsert',
    data: {
      publicId,
      kind: 'note',
      occurredAt: `${localDate}T10:00:00.000Z`,
      tz: 'Europe/Berlin',
      localDate,
      origLocale: 'en',
      visibility: 'public',
      content: { en: { body: `note ${publicId}` } },
      updatedAt: '2026-11-19T10:00:00.000Z',
    },
  };
}

export function settingItem(key: string, value: unknown, seq = ++seqCounter) {
  return { seq, entity: 'setting', key, op: 'upsert', data: { value } };
}

export function deleteItem(entity: string, key: string, seq = ++seqCounter) {
  return { seq, entity, key, op: 'delete' };
}

export function annotationItem(sourceKey: string, data: Record<string, unknown>, seq = ++seqCounter) {
  return {
    seq,
    entity: 'annotation',
    key: sourceKey,
    op: 'upsert',
    data: { sourceKey, updatedAt: '2026-11-19T10:00:00.000Z', ...data },
  };
}
