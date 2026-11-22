/**
 * In-memory mock of the admin API (api/src/Http/Routes.php + packages/contracts api.ts), strict
 * enough to catch client bugs:
 * - cookie session + X-CSRF-Token (base64url(sha256("omw-csrf:" + token))) on mutating requests,
 *   401 "unauthorized" / 403 "csrf" / 415 for non-JSON bodies;
 * - request bodies validated with the contract schemas (422 "validation_failed"), responses
 *   validated against the contract output schemas (a mismatch is a 500, i.e. a mock bug);
 * - ifUpdatedAt -> 409 "conflict", idempotent POST /posts, 204 for deleting a missing post,
 *   trip overlap -> 422, settings cross-field rules, publish.mode_since on mode changes, a newly
 *   picked "site.avatar" must be a photo capture that is not revoked and not lost (422 with the
 *   API's details.errors shape);
 * - effective visibility/date/zone and trips via the shared policy functions;
 * - a simulated backend: heartbeat and a publish report that catches up `publishAfterMs` after
 *   the last owner write (so the UI can show "publishing…" and then "Live").
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  AdminDayDetail,
  AdminPost,
  AdminTrip,
  type Alert,
  type Annotation,
  AnnotationPatch,
  type ApiTokenInfo,
  CaptureListItem,
  CaptureListResponse,
  type Day,
  DayListResponse,
  DayPatch,
  LoginRequest,
  type Me,
  NotePostContent,
  type Post,
  PostCreate,
  PostListResponse,
  PostUpdate,
  type Settings,
  SettingsPatch,
  Settings as SettingsSchema,
  StatusResponse,
  StoryPostContent,
  settingsProblems,
  type TargetPublishStatus,
  TokenCreate,
  TokenCreated,
  TokenListResponse,
  type Trip,
  TripListResponse,
  TripUpsert,
} from '@omw/contracts/api';
import { AppPairingCreated } from '@omw/contracts/app';
import { AppPhoneListResponse } from '@omw/contracts/app-inbox';
import { publicIdFromSha256Hex } from '@omw/contracts/ids';
import {
  effectiveCaptureVisibility,
  effectiveLocalDate,
  effectiveTz,
  overlappingTrips,
  tripForDate,
} from '@omw/contracts/policy';
import { isValidLocalDate, localDateFor } from '@omw/contracts/time';
import { z } from 'zod';
import { modeSinceAfter } from '../../src/lib/mode-since';
import { previewSvg } from './previews';
import { type SeedCapture, type SeedData, seedData } from './seed';

export interface MockRequest {
  method: string;
  /** Path without query, e.g. "/api/v1/admin/days". */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** Raw body text ('' when none). */
  body: string;
}

export interface MockResponse {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  contentType?: string;
}

export const MOCK_OWNER = { email: 'owner@example.org', password: 'reisetagebuch', displayName: 'Lena' } as const;
export const SESSION_COOKIE = 'omw_mock_session';

interface Stored<T> {
  value: T;
  seq: number;
}

export interface MockOptions {
  now?: () => number;
  /** The simulated backend publishes this long after the last owner write (default 2500 ms). */
  publishAfterMs?: number;
}

const ApiErr = (status: number, code: string, message: string, details?: unknown): MockResponse => ({
  status,
  json: { error: { code, message, ...(details !== undefined ? { details } : {}) } },
});

export function csrfFor(sessionToken: string): string {
  return createHash('sha256').update(`omw-csrf:${sessionToken}`).digest('base64url');
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class MockAdminApi {
  readonly now: () => number;
  publishAfterMs: number;
  /** Log of handled API requests (method, path, status) for assertions. */
  readonly log: Array<{ method: string; path: string; status: number; at: number }> = [];

  #sessions = new Set<string>();
  #captures = new Map<string, SeedCapture>();
  #annotations = new Map<string, Stored<Annotation>>();
  #posts = new Map<string, Stored<Post>>();
  #days = new Map<string, Stored<Day>>();
  #trips = new Map<string, Stored<Trip>>();
  #settings: Settings = seedData().settings;
  #tokens: ApiTokenInfo[] = [];
  #nextTokenId = 1;
  #seq = 0;
  #lastStamp = 0;
  #lastWriteAt = 0;
  #publish: TargetPublishStatus | null = null;
  #alerts: Alert[] = [];

  constructor(opts: MockOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.publishAfterMs = opts.publishAfterMs ?? 2500;
    this.reset();
  }

  // -------------------------------------------------------------------------------------------
  // Control (tests)

  reset(seed: SeedData = seedData()): void {
    this.#sessions.clear();
    this.#captures = new Map(seed.captures.map((c) => [c.sourceKey, structuredClone(c)]));
    this.#seq = 0;
    this.#annotations = new Map(
      seed.annotations.map((a) => [a.sourceKey, { value: structuredClone(a) as Annotation, seq: ++this.#seq }]),
    );
    this.#days = new Map(seed.days.map((d) => [d.localDate, { value: structuredClone(d), seq: ++this.#seq }]));
    this.#trips = new Map(seed.trips.map((t) => [t.slug, { value: structuredClone(t), seq: ++this.#seq }]));
    this.#posts = new Map(seed.posts.map((p) => [p.publicId, { value: structuredClone(p), seq: ++this.#seq }]));
    this.#settings = structuredClone(seed.settings);
    ++this.#seq;
    this.#tokens = [];
    this.#nextTokenId = 1;
    this.#createToken({ kind: 'backend', name: 'Backend zu Hause' }, '2026-11-01T10:00:00.000Z');
    this.#lastWriteAt = 0;
    const latest = this.#latestCaptureAt();
    this.#publish = {
      contractVersion: 1,
      version: 41,
      at: new Date(this.now() - 3 * 60_000).toISOString(),
      target: 'sftp-main',
      ok: true,
      uploaded: 12,
      deleted: 0,
      feedSeq: this.#seq,
      capturesThrough: latest,
      lastOkAt: new Date(this.now() - 3 * 60_000).toISOString(),
      consecutiveFailures: 0,
      receivedAt: new Date(this.now() - 3 * 60_000).toISOString(),
    };
    this.#alerts = [];
    this.log.length = 0;
  }

  /** Simulates an edit on another device (no ifUpdatedAt, bumps updatedAt + seq). */
  editDayElsewhere(date: string, patch: Partial<Day>): Day {
    const prev = this.#days.get(date)?.value;
    const next = { ...emptyDay(date), ...prev, ...patch, localDate: date, updatedAt: this.#stamp() } as Day;
    this.#days.set(date, { value: next, seq: this.#bump() });
    return next;
  }

  /** Lets the simulated backend publish everything now. */
  publishNow(): void {
    if (!this.#publish) return;
    const at = new Date(this.now()).toISOString();
    this.#publish = {
      ...this.#publish,
      version: this.#publish.version + 1,
      at,
      receivedAt: at,
      lastOkAt: at,
      ok: true,
      consecutiveFailures: 0,
      feedSeq: this.#seq,
      capturesThrough: this.#latestCaptureAt(),
    };
  }

  setAlerts(alerts: Alert[]): void {
    this.#alerts = alerts;
  }

  /**
   * A status captured "now" (or `minutesAgo` before): a copy of a seed photo with its own key,
   * as the backend would mirror it. Returns the new sourceKey.
   */
  addCapture(opts: { minutesAgo?: number; caption?: string; id?: string } = {}): string {
    const template = [...this.#captures.values()].find((c) => c.kind === 'photo' && c.hasPreview);
    if (!template) throw new Error('no photo in the seed');
    const occurredAt = new Date(this.now() - (opts.minutesAgo ?? 0) * 60_000).toISOString();
    const id = opts.id ?? `3EB0${String(this.#captures.size).padStart(4, '0')}${Date.now().toString(16).toUpperCase()}`;
    const sourceKey = `wa:${id.slice(0, 32)}`;
    const publicId = publicIdFromSha256Hex(createHash('sha256').update(sourceKey).digest('hex'));
    this.#captures.set(sourceKey, {
      ...structuredClone(template),
      sourceKey,
      publicId,
      occurredAt,
      localDate: localDateFor(occurredAt, template.tz),
      caption: opts.caption ?? template.caption,
    });
    return sourceKey;
  }

  /** The backend mirrors a WhatsApp delete of `sourceKey` (sticky revokedAt). */
  revokeCapture(sourceKey: string): boolean {
    const c = this.#captures.get(sourceKey);
    if (!c) return false;
    c.revokedAt ??= new Date(this.now()).toISOString();
    return true;
  }

  /** Overwrites settings as stored (tests: e.g. a publish.mode_since in the past). */
  setSettings(patch: Partial<Settings>): void {
    const merged = SettingsSchema.parse({ ...this.#settings, ...patch });
    this.#settings = merged;
  }

  snapshot() {
    return {
      seq: this.#seq,
      posts: [...this.#posts.values()].map((s) => s.value),
      days: [...this.#days.values()].map((s) => s.value),
      annotations: [...this.#annotations.values()].map((s) => s.value),
      trips: [...this.#trips.values()].map((s) => s.value),
      settings: this.#settings,
      publish: this.#publish,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Helpers

  #bump(): number {
    this.#lastWriteAt = this.now();
    return ++this.#seq;
  }

  /** Strictly increasing ISO timestamps (two writes in the same ms still differ). */
  #stamp(): string {
    const t = Math.max(this.now(), this.#lastStamp + 1);
    this.#lastStamp = t;
    return new Date(t).toISOString();
  }

  /** PublishedReport.capturesThrough: just before the oldest capture still in the pipeline. */
  #latestCaptureAt(): string | null {
    let max: string | null = null;
    let oldestPending: string | null = null;
    for (const c of this.#captures.values()) {
      if (c.mediaState === 'pending') {
        if (!oldestPending || c.occurredAt < oldestPending) oldestPending = c.occurredAt;
      } else if (!max || c.occurredAt > max) max = c.occurredAt;
    }
    if (oldestPending) return new Date(Date.parse(oldestPending) - 1).toISOString();
    return max;
  }

  #dayTz(date: string): string | null {
    return this.#days.get(date)?.value.tz ?? null;
  }

  #previewUrl(c: SeedCapture, role: 'preview' | 'poster'): string | null {
    if (!c.hasPreview) return null;
    if (role === 'poster' && c.kind === 'photo') return null;
    return `/api/v1/admin/captures/${encodeURIComponent(c.sourceKey)}/${role}`;
  }

  #captureItem(c: SeedCapture): CaptureListItem {
    const stored = this.#annotations.get(c.sourceKey);
    const a = stored?.value ?? null;
    const dayTz = this.#dayTz(c.localDate);
    const { hasPreview: _hp, ...mirror } = c;
    return {
      ...mirror,
      annotation: a,
      previewUrl: this.#previewUrl(c, 'preview'),
      posterUrl: this.#previewUrl(c, 'poster'),
      effectiveVisibility: effectiveCaptureVisibility(c, a, this.#settings, this.now()),
      effectiveLocalDate: effectiveLocalDate(c, a, dayTz),
      effectiveTz: effectiveTz(c, a, dayTz),
      changeSeq: stored?.seq ?? 0,
    };
  }

  #allCaptureItems(): CaptureListItem[] {
    return [...this.#captures.values()].map((c) => this.#captureItem(c));
  }

  #adminPost(s: Stored<Post>): AdminPost {
    return { ...s.value, changeSeq: s.seq } as AdminPost;
  }

  #tripsList(): AdminTrip[] {
    return [...this.#trips.values()]
      .map((s) => ({ ...s.value, changeSeq: s.seq }))
      .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : a.slug < b.slug ? -1 : 1));
  }

  #createToken(body: z.infer<typeof TokenCreate>, createdAt = new Date(this.now()).toISOString()): TokenCreated {
    const token = `omw_${randomBytes(32).toString('base64url')}`;
    const info: ApiTokenInfo = {
      id: this.#nextTokenId++,
      kind: body.kind,
      name: body.name,
      hint: `${token.slice(0, 9)}…`,
      scopes: body.kind === 'backend' ? ['backend'] : ['admin'],
      createdAt,
      expiresAt: body.expiresAt ?? null,
      lastUsedAt: body.kind === 'backend' ? new Date(this.now() - 40_000).toISOString() : null,
      revokedAt: null,
    };
    this.#tokens.unshift(info);
    return { token, info };
  }

  // -------------------------------------------------------------------------------------------
  // HTTP

  handle(req: MockRequest): MockResponse {
    let res: MockResponse;
    try {
      res = this.#route(req);
    } catch (err) {
      res = ApiErr(500, 'internal', (err as Error).message);
    }
    this.log.push({ method: req.method, path: req.path, status: res.status, at: this.now() });
    return res;
  }

  #session(req: MockRequest): string | null {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return token && this.#sessions.has(token) ? token : null;
  }

  #json(req: MockRequest): { ok: true; value: unknown } | { ok: false; res: MockResponse } {
    if (!req.body) return { ok: true, value: undefined };
    if (!(req.headers['content-type'] ?? '').includes('application/json')) {
      return { ok: false, res: ApiErr(415, 'unsupported_media_type', 'Send JSON') };
    }
    try {
      return { ok: true, value: JSON.parse(req.body) };
    } catch {
      return { ok: false, res: ApiErr(422, 'validation_failed', 'Body is not valid JSON') };
    }
  }

  #out<T extends z.ZodType>(schema: T, value: unknown, status = 200): MockResponse {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error(`mock response does not match the contract: ${z.prettifyError(parsed.error)}`);
    return { status, json: value };
  }

  #route(req: MockRequest): MockResponse {
    const { method, path } = req;
    if (path === '/api/v1/health' && method === 'GET') {
      return { status: 200, json: { ok: true, version: 'mock', contractVersion: 1 } };
    }
    if (!path.startsWith('/api/v1/admin/')) return ApiErr(404, 'not_found', `No route ${method} ${path}`);
    const sub = path.slice('/api/v1/admin'.length);

    if (sub === '/session' && method === 'POST') {
      const body = this.#json(req);
      if (!body.ok) return body.res;
      const login = LoginRequest.safeParse(body.value);
      if (!login.success || login.data.email !== MOCK_OWNER.email || login.data.password !== MOCK_OWNER.password) {
        return ApiErr(401, 'unauthorized', 'Login failed');
      }
      const token = randomBytes(24).toString('base64url');
      this.#sessions.add(token);
      const me: Me = { email: MOCK_OWNER.email, displayName: MOCK_OWNER.displayName, csrfToken: csrfFor(token) };
      return {
        status: 200,
        json: me,
        headers: { 'set-cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict` },
      };
    }

    const session = this.#session(req);
    if (sub === '/me' && method === 'GET') {
      if (!session) return ApiErr(401, 'unauthorized', 'Not logged in');
      return {
        status: 200,
        json: { email: MOCK_OWNER.email, displayName: MOCK_OWNER.displayName, csrfToken: csrfFor(session) },
      };
    }
    if (!session) return ApiErr(401, 'unauthorized', 'Not logged in');
    if (method !== 'GET' && req.headers['x-csrf-token'] !== csrfFor(session)) {
      return ApiErr(403, 'csrf', 'Missing or wrong CSRF token');
    }
    if (sub === '/session' && method === 'DELETE') {
      this.#sessions.delete(session);
      return { status: 204, headers: { 'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0` } };
    }
    const body = this.#json(req);
    if (!body.ok) return body.res;
    const segs = sub.split('/').filter(Boolean).map(decodeURIComponent);
    const [resource, id, extra] = segs;

    switch (resource) {
      case 'status':
        return this.#status();
      case 'captures':
        return this.#capturesRoute(method, req.query, id, extra, body.value);
      case 'posts':
        return this.#postsRoute(method, req.query, id, body.value);
      case 'days':
        return this.#daysRoute(method, id, body.value);
      case 'trips':
        return this.#tripsRoute(method, id, body.value);
      case 'settings':
        return this.#settingsRoute(method, body.value);
      case 'tokens':
        return this.#tokensRoute(method, id, body.value);
      // Traveler app ("Connect a phone"): no phone in the mock, archive-only like a fresh API.
      case 'app-phones':
        if (method !== 'GET' || id) return ApiErr(404, 'not_found', 'No such phone');
        return this.#out(AppPhoneListResponse, {
          items: [],
          openPairing: null,
          inbox: { usedBytes: 0, maxBytes: 1024 * 1024 * 1024 },
          archiveOnly: true,
        });
      case 'app-pairings':
        if (method !== 'POST') return ApiErr(405, 'method_not_allowed', 'POST only');
        return this.#out(
          AppPairingCreated,
          {
            link: 'omw://pair#01JD3ZQ8X4V7N2K5M9P0R6S8TW',
            typedCode: 'ABCD-EFGH',
            expiresAt: new Date(this.now() + 3_600_000).toISOString(),
          },
          201,
        );
      default:
        return ApiErr(404, 'not_found', `No route ${method} ${path}`);
    }
  }

  #invalid(error: z.ZodError): MockResponse {
    return ApiErr(422, 'validation_failed', z.prettifyError(error), error.issues);
  }

  #status(): MockResponse {
    const now = this.now();
    if (
      this.#publish &&
      this.#lastWriteAt &&
      now - this.#lastWriteAt >= this.publishAfterMs &&
      this.#publish.feedSeq < this.#seq
    ) {
      this.publishNow();
    }
    const lastSeenAt = new Date(now - 40_000).toISOString();
    const latest = this.#latestCaptureAt();
    return this.#out(StatusResponse, {
      backend: {
        contractVersion: 1,
        at: lastSeenAt,
        backendVersion: '0.1.0-mock',
        wa: {
          state: 'open',
          jid: '4915100000002@s.whatsapp.net',
          ...(latest ? { lastStatusAt: latest } : {}),
          traveler: { pn: '4915100000001', lidKnown: true },
        },
        queue: { pending: 0, failed: 0 },
        sync: { feedId: 'mockfeed01', feedSeq: this.#seq, lastPullAt: lastSeenAt, quarantined: 0 },
        captures: { awaitingMedia: 1, failed: 0, mediaLost: 1 },
        stats: { other_senders: 3 },
        disk: { freeBytes: 120_000_000_000 },
        publish: { lastVersion: this.#publish?.version ?? 0, ...(this.#publish ? { lastAt: this.#publish.at } : {}) },
      },
      lastSeenAt,
      publish: this.#publish ? [this.#publish] : [],
      alerts: this.#alerts,
    });
  }

  #capturesRoute(
    method: string,
    query: URLSearchParams,
    key: string | undefined,
    extra: string | undefined,
    body: unknown,
  ): MockResponse {
    if (!key) {
      if (method !== 'GET') return ApiErr(405, 'method_not_allowed', 'GET only');
      const date = query.get('date');
      const visibility = query.get('visibility');
      const kind = query.get('kind');
      const limit = Math.min(200, Math.max(1, Number(query.get('limit') ?? 50) || 50));
      const offset = Number(query.get('cursor') ?? 0) || 0;
      const all = this.#allCaptureItems()
        .filter(
          (c) =>
            (!date || c.effectiveLocalDate === date) &&
            (!visibility || c.effectiveVisibility === visibility) &&
            (!kind || c.kind === kind),
        )
        .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
      const items = all.slice(offset, offset + limit);
      return this.#out(CaptureListResponse, {
        items,
        nextCursor: offset + limit < all.length ? String(offset + limit) : null,
      });
    }
    const c = this.#captures.get(key);
    if (!c) return ApiErr(404, 'not_found', 'Unknown capture');
    if (extra === 'preview' || extra === 'poster') {
      if (method !== 'GET' || !this.#previewUrl(c, extra)) return ApiErr(404, 'not_found', 'No preview');
      return {
        status: 200,
        contentType: 'image/svg+xml',
        text: previewSvg(c),
        headers: { 'cache-control': 'private, max-age=3600' },
      };
    }
    if (method === 'GET') return this.#out(CaptureListItem, this.#captureItem(c));
    if (method !== 'PATCH') return ApiErr(405, 'method_not_allowed', 'GET or PATCH');
    const parsed = AnnotationPatch.safeParse(body);
    if (!parsed.success) return this.#invalid(parsed.error);
    const p = parsed.data;
    const prev = this.#annotations.get(key)?.value;
    if (p.ifUpdatedAt !== undefined && prev?.updatedAt !== p.ifUpdatedAt) {
      return ApiErr(409, 'conflict', 'The annotation was changed elsewhere');
    }
    const next: Annotation = {
      sourceKey: key,
      description: 'description' in p ? p.description : (prev?.description ?? null),
      origLocale: 'origLocale' in p ? p.origLocale : (prev?.origLocale ?? null),
      visibility: 'visibility' in p ? p.visibility : (prev?.visibility ?? null),
      localDateOverride: 'localDateOverride' in p ? p.localDateOverride : (prev?.localDateOverride ?? null),
      updatedAt: this.#stamp(),
    };
    this.#annotations.set(key, { value: next, seq: this.#bump() });
    return this.#out(CaptureListItem, this.#captureItem(c));
  }

  #postsRoute(method: string, query: URLSearchParams, id: string | undefined, body: unknown): MockResponse {
    if (!id) {
      if (method === 'GET') {
        const date = query.get('date');
        const kind = query.get('kind');
        const visibility = query.get('visibility');
        const items = [...this.#posts.values()]
          .filter(
            (s) =>
              (!date || s.value.localDate === date) &&
              (!kind || s.value.kind === kind) &&
              (!visibility || s.value.visibility === visibility),
          )
          .sort((a, b) => (a.value.occurredAt < b.value.occurredAt ? 1 : -1))
          .map((s) => this.#adminPost(s));
        return this.#out(PostListResponse, { items, nextCursor: null });
      }
      if (method !== 'POST') return ApiErr(405, 'method_not_allowed', 'GET or POST');
      const parsed = PostCreate.safeParse(body);
      if (!parsed.success) return this.#invalid(parsed.error);
      const p = parsed.data;
      const existing = this.#posts.get(p.publicId);
      if (existing) return this.#out(AdminPost, this.#adminPost(existing), 200);
      const occurredAt = p.occurredAt ?? new Date(this.now()).toISOString();
      const tz = p.tz ?? this.#settings['timezone.current'];
      const post = {
        publicId: p.publicId,
        kind: p.kind,
        occurredAt,
        tz,
        localDate: localDateFor(occurredAt, tz),
        origLocale: p.origLocale,
        visibility: p.visibility ?? 'public',
        updatedAt: this.#stamp(),
        content: p.content,
      } as Post;
      const stored = { value: post, seq: this.#bump() };
      this.#posts.set(p.publicId, stored);
      return this.#out(AdminPost, this.#adminPost(stored), 201);
    }
    const stored = this.#posts.get(id);
    if (method === 'DELETE') {
      if (stored) {
        this.#posts.delete(id);
        this.#bump();
      }
      return { status: 204 };
    }
    if (!stored) return ApiErr(404, 'not_found', 'Unknown post');
    if (method === 'GET') return this.#out(AdminPost, this.#adminPost(stored));
    if (method !== 'PATCH') return ApiErr(405, 'method_not_allowed', 'GET, PATCH or DELETE');
    const parsed = PostUpdate.safeParse(body);
    if (!parsed.success) return this.#invalid(parsed.error);
    const p = parsed.data;
    if (p.ifUpdatedAt !== undefined && p.ifUpdatedAt !== stored.value.updatedAt) {
      return ApiErr(409, 'conflict', 'The post was changed elsewhere');
    }
    if (p.content) {
      const shape = stored.value.kind === 'note' ? NotePostContent : StoryPostContent;
      const ok = shape.safeParse(p.content);
      if (!ok.success) return this.#invalid(ok.error);
    }
    const prev = stored.value;
    const occurredAt = p.occurredAt ?? prev.occurredAt;
    const tz = p.tz ?? prev.tz;
    const origLocale = p.origLocale ?? prev.origLocale;
    const content = p.content ?? prev.content;
    if (!(origLocale in content)) return ApiErr(422, 'validation_failed', 'content must contain origLocale');
    const next = {
      ...prev,
      occurredAt,
      tz,
      localDate: localDateFor(occurredAt, tz),
      origLocale,
      visibility: p.visibility ?? prev.visibility,
      content,
      updatedAt: this.#stamp(),
    } as Post;
    const s = { value: next, seq: this.#bump() };
    this.#posts.set(id, s);
    return this.#out(AdminPost, this.#adminPost(s));
  }

  #dayDetail(date: string): AdminDayDetail {
    const stored = this.#days.get(date);
    const captures = this.#allCaptureItems()
      .filter((c) => c.effectiveLocalDate === date)
      .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
    const posts = [...this.#posts.values()]
      .filter((s) => s.value.localDate === date)
      .sort((a, b) => (a.value.occurredAt < b.value.occurredAt ? -1 : 1))
      .map((s) => this.#adminPost(s));
    return {
      localDate: date,
      day: stored?.value ?? null,
      captures,
      posts,
      trip: tripForDate(
        date,
        [...this.#trips.values()].map((s) => s.value),
      ),
      changeSeq: stored?.seq ?? 0,
    };
  }

  #daysRoute(method: string, date: string | undefined, body: unknown): MockResponse {
    if (!date) {
      if (method !== 'GET') return ApiErr(405, 'method_not_allowed', 'GET only');
      const captures = this.#allCaptureItems();
      const dates = new Set<string>([
        ...captures.map((c) => c.effectiveLocalDate),
        ...[...this.#posts.values()].map((s) => s.value.localDate),
        ...this.#days.keys(),
      ]);
      const trips = [...this.#trips.values()].map((s) => s.value);
      const items = [...dates].sort().map((d) => {
        const detail = this.#dayDetail(d);
        const vis = [...detail.captures.map((c) => c.effectiveVisibility), ...detail.posts.map((p) => p.visibility)];
        const times = [...detail.captures.map((c) => c.occurredAt), ...detail.posts.map((p) => p.occurredAt)].sort();
        const explicit = detail.day?.coverSourceKey ?? null;
        const auto = detail.captures.find(
          (c) => c.effectiveVisibility === 'public' && (c.kind === 'photo' || c.kind === 'video'),
        );
        const coverKey = explicit ?? auto?.sourceKey ?? null;
        const coverCapture = coverKey ? this.#captures.get(coverKey) : undefined;
        return {
          localDate: d,
          day: detail.day,
          counts: {
            captures: detail.captures.length,
            posts: detail.posts.length,
            public: vis.filter((v) => v === 'public').length,
            hidden: vis.filter((v) => v === 'hidden').length,
            pending: vis.filter((v) => v === 'pending').length,
          },
          firstAt: times[0] ?? null,
          lastAt: times.at(-1) ?? null,
          coverSourceKey: coverKey,
          coverPreviewUrl: coverCapture
            ? (this.#previewUrl(coverCapture, coverCapture.kind === 'photo' ? 'preview' : 'poster') ?? null)
            : null,
          trip: tripForDate(d, trips),
          changeSeq: detail.changeSeq,
        };
      });
      return this.#out(DayListResponse, { items });
    }
    if (!isValidLocalDate(date)) return ApiErr(404, 'not_found', 'Not a date');
    if (method === 'GET') return this.#out(AdminDayDetail, this.#dayDetail(date));
    if (method !== 'PATCH') return ApiErr(405, 'method_not_allowed', 'GET or PATCH');
    const parsed = DayPatch.safeParse(body);
    if (!parsed.success) return this.#invalid(parsed.error);
    const p = parsed.data;
    const prev = this.#days.get(date)?.value;
    if (p.ifUpdatedAt !== undefined && prev?.updatedAt !== p.ifUpdatedAt) {
      return ApiErr(409, 'conflict', 'The day was changed elsewhere');
    }
    const { ifUpdatedAt: _if, ...fields } = p;
    const next = { ...emptyDay(date), ...prev, ...fields, localDate: date, updatedAt: this.#stamp() } as Day;
    this.#days.set(date, { value: next, seq: this.#bump() });
    return this.#out(AdminDayDetail, this.#dayDetail(date));
  }

  #tripsRoute(method: string, slug: string | undefined, body: unknown): MockResponse {
    if (!slug) {
      if (method !== 'GET') return ApiErr(405, 'method_not_allowed', 'GET only');
      return this.#out(TripListResponse, { items: this.#tripsList() });
    }
    const stored = this.#trips.get(slug);
    if (method === 'GET') {
      if (!stored) return ApiErr(404, 'not_found', 'Unknown trip');
      return this.#out(AdminTrip, { ...stored.value, changeSeq: stored.seq });
    }
    if (method === 'DELETE') {
      if (stored) {
        this.#trips.delete(slug);
        this.#bump();
      }
      return { status: 204 };
    }
    if (method !== 'PUT') return ApiErr(405, 'method_not_allowed', 'GET, PUT or DELETE');
    const parsed = TripUpsert.safeParse(body);
    if (!parsed.success) return this.#invalid(parsed.error);
    const p = parsed.data;
    if (p.slug !== slug) return ApiErr(422, 'validation_failed', 'slug must match the URL');
    if (p.ifUpdatedAt !== undefined && stored?.value.updatedAt !== p.ifUpdatedAt) {
      return ApiErr(409, 'conflict', 'The trip was changed elsewhere');
    }
    const overlaps = overlappingTrips(
      p,
      [...this.#trips.values()].map((s) => s.value),
    );
    if (overlaps.length) return ApiErr(422, 'validation_failed', `Overlaps with ${overlaps.join(', ')}`, { overlaps });
    const next: Trip = {
      slug,
      title: p.title,
      description: p.description ?? null,
      origLocale: p.origLocale ?? null,
      startDate: p.startDate,
      endDate: p.endDate,
      coverSourceKey: p.coverSourceKey ?? null,
      updatedAt: this.#stamp(),
    };
    const s = { value: next, seq: this.#bump() };
    this.#trips.set(slug, s);
    return this.#out(AdminTrip, { ...next, changeSeq: s.seq }, stored ? 200 : 201);
  }

  #settingsRoute(method: string, body: unknown): MockResponse {
    if (method === 'GET') return this.#out(SettingsSchema, this.#settings);
    if (method !== 'PATCH') return ApiErr(405, 'method_not_allowed', 'GET or PATCH');
    const parsed = SettingsPatch.safeParse(body);
    if (!parsed.success) return this.#invalid(parsed.error);
    // Like Settings::avatarProblem() (PHP): checked only when the patch picks another photo.
    const avatar = parsed.data['site.avatar'];
    if (avatar && avatar.sourceKey !== this.#settings['site.avatar']?.sourceKey) {
      const problem = this.#avatarProblem(avatar.sourceKey);
      if (problem) {
        return ApiErr(422, 'validation_failed', `site.avatar: ${problem}`, {
          errors: [`/site.avatar/sourceKey: ${problem}`],
        });
      }
    }
    const next: Record<string, unknown> = { ...this.#settings };
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v === undefined) continue;
      if (v === null) delete next[k];
      else next[k] = v;
    }
    // Same cut-off rule as the API (src/lib/mode-since.ts restates it for the admin too).
    next['publish.mode_since'] = modeSinceAfter(this.#settings, parsed.data, this.now());
    const merged = SettingsSchema.safeParse(next);
    if (!merged.success) return this.#invalid(merged.error);
    const problems = settingsProblems(merged.data);
    if (problems.length) return ApiErr(422, 'validation_failed', problems.join('; '), problems);
    this.#settings = merged.data;
    this.#bump();
    return this.#out(SettingsSchema, this.#settings);
  }

  #avatarProblem(sourceKey: string): string | null {
    const c = this.#captures.get(sourceKey);
    if (!c) return `no captured status ${sourceKey} (pick one of your photos)`;
    if (c.kind !== 'photo') return `${sourceKey} is a ${c.kind} status, not a photo`;
    if (c.revokedAt) return `${sourceKey} was deleted on WhatsApp`;
    if (c.mediaState === 'lost') return `the photo of ${sourceKey} could not be downloaded`;
    return null;
  }

  #tokensRoute(method: string, id: string | undefined, body: unknown): MockResponse {
    if (!id) {
      if (method === 'GET')
        return this.#out(TokenListResponse, { items: this.#tokens.filter((t) => t.revokedAt === null) });
      if (method !== 'POST') return ApiErr(405, 'method_not_allowed', 'GET or POST');
      const parsed = TokenCreate.safeParse(body);
      if (!parsed.success) return this.#invalid(parsed.error);
      return this.#out(TokenCreated, this.#createToken(parsed.data), 201);
    }
    if (method !== 'DELETE') return ApiErr(405, 'method_not_allowed', 'DELETE only');
    const token = this.#tokens.find((t) => t.id === Number(id));
    if (!token) return ApiErr(404, 'not_found', 'Unknown token');
    token.revokedAt = new Date(this.now()).toISOString();
    return { status: 204 };
  }
}

function emptyDay(date: string): Day {
  return {
    localDate: date,
    title: null,
    summary: null,
    origLocale: null,
    placeName: null,
    countryCode: null,
    lat: null,
    lng: null,
    coverSourceKey: null,
    tz: null,
    updatedAt: '1970-01-01T00:00:00.000Z',
  };
}
