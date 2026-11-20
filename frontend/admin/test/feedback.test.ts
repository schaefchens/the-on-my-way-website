/**
 * Owner-facing feedback: localized error copy, the toast store rules, field-draft keys and the
 * story preview's markdown (no images, like the generator).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ApiRequestError } from '../src/api/client';
import {
  type FieldDraft,
  fieldDraftKey,
  fieldDraftStore,
  findFieldDraft,
  removeFieldDrafts,
  saveFieldDraft,
  settleFieldDraft,
} from '../src/lib/drafts';
import { errorKind, friendlyError } from '../src/lib/errors';
import { renderMarkdown } from '../src/lib/markdown';
import {
  clearNoticesOnNavigation,
  NAVIGATION_GRACE_MS,
  noticeStore,
  notify,
  notifyWrite,
  settleWriteNotice,
} from '../src/lib/notices';

afterEach(() => {
  noticeStore.set([]);
  fieldDraftStore.set({});
});

describe('errors in the owner language', () => {
  it.each([
    [new ApiRequestError(0, 'network', 'API unreachable: Failed to fetch'), 'network'],
    [new ApiRequestError(502, 'http_502', 'PATCH /captures/x: HTTP 502'), 'server'],
    [new ApiRequestError(503, 'locked', 'Database is locked'), 'server'],
    [new ApiRequestError(429, 'rate_limited', 'Too many requests'), 'rate_limited'],
    [new ApiRequestError(401, 'unauthorized', 'Not logged in'), 'unauthorized'],
    [new ApiRequestError(404, 'not_found', 'Unknown capture'), 'not_found'],
    [new ApiRequestError(409, 'conflict', 'changed elsewhere'), 'conflict'],
    [new ApiRequestError(422, 'validation_failed', 'Invalid settings.'), 'rejected'],
    [new Error('boom'), 'unknown'],
    ['nope', 'unknown'],
  ] as const)('%s -> %s', (err, kind) => {
    expect(errorKind(err)).toBe(kind);
  });

  it('keeps the technical text out of the message, for a Details disclosure', () => {
    const net = friendlyError(new ApiRequestError(0, 'network', 'API unreachable: Failed to fetch'));
    expect(net.message.message).toBe('No connection – we will try again in a moment');
    expect(net.detail).toBe('API unreachable: Failed to fetch');
    const server = friendlyError(new ApiRequestError(502, 'http_502', 'GET /status: HTTP 502'));
    expect(server.message.message).toBe('The server has a problem right now');
    expect(server.detail).toBe('GET /status: HTTP 502');
    const locked = friendlyError(new ApiRequestError(500, 'internal', 'Database is locked'));
    expect(locked.detail).toBe('Database is locked · internal · HTTP 500');
    expect(friendlyError(new ApiRequestError(429, 'rate_limited', '')).message.message).toBe(
      'Just a moment – too many requests at once',
    );
  });
});

describe('toasts', () => {
  it('shows one status toast at a time and one undo offer', () => {
    notify({ tone: 'undo', message: 'Hidden' });
    notify({ tone: 'success', message: 'Description saved' });
    notify({ tone: 'success', message: 'Day saved' });
    notify({ tone: 'info', message: 'Merged' });
    notify({ tone: 'success', message: 'Time zone updated' });
    expect(noticeStore.get().map((n) => [n.tone, n.message])).toEqual([
      ['undo', 'Hidden'],
      ['success', 'Time zone updated'],
    ]);
    notify({ tone: 'undo', message: 'Moved' });
    expect(noticeStore.get().map((n) => n.message)).toEqual(['Time zone updated', 'Moved']);
  });

  it('keeps at most two errors, newest last', () => {
    for (const m of ['e1', 'e2', 'e3']) notify({ tone: 'error', message: m });
    expect(noticeStore.get().map((n) => n.message)).toEqual(['e2', 'e3']);
  });

  it('clears everything but the undo offer on navigation, except what the navigation caused', () => {
    const t0 = 1_000_000;
    notify({ tone: 'undo', message: 'Hidden' }, t0);
    notify({ tone: 'error', message: 'Could not save' }, t0);
    notify({ tone: 'success', message: 'Day saved' }, t0);
    clearNoticesOnNavigation(t0 + NAVIGATION_GRACE_MS + 1);
    expect(noticeStore.get().map((n) => n.message)).toEqual(['Hidden']);
    notify({ tone: 'success', message: 'Published' }, t0 + 5000);
    clearNoticesOnNavigation(t0 + 5100);
    expect(noticeStore.get().map((n) => n.message)).toEqual(['Hidden', 'Published']);
  });

  it('says "sending" for a queued write and confirms it when the server answered', () => {
    notifyWrite('day:2026-11-20', { id: 'done', message: 'Day saved' }, true);
    const [sending] = noticeStore.get();
    expect(sending?.message).toMatchObject({ message: 'Saved – sending…' });
    expect(sending?.waitFor).toBe('day:2026-11-20');
    settleWriteNotice('day:2026-11-20', true);
    expect(noticeStore.get().map((n) => [n.tone, n.message])).toEqual([
      ['success', { id: 'done', message: 'Day saved' }],
    ]);

    notifyWrite('capture:wa:X', { id: 'd', message: 'Description saved' }, true);
    settleWriteNotice('capture:wa:X', false);
    expect(noticeStore.get().some((n) => n.waitFor)).toBe(false);

    notifyWrite('settings', { id: 's', message: 'Saved' }, false);
    expect(noticeStore.get().at(-1)?.message).toMatchObject({
      message: 'Saved on this device, sent when you are online',
    });
  });
});

describe('field drafts', () => {
  const draft = (entity: string, base: string | null, savedAt: string): FieldDraft => ({
    key: fieldDraftKey(entity, base),
    entity,
    base,
    original: { placeName: null },
    form: { placeName: 'Bangkok' },
    savedAt,
  });

  it('are keyed by entity and the version the edit started from', () => {
    expect(fieldDraftKey('day:2026-11-20', null)).toBe('day:2026-11-20@-');
    expect(fieldDraftKey('day:2026-11-20', '2026-11-20T08:00:00.000Z')).toBe('day:2026-11-20@2026-11-20T08:00:00.000Z');
    expect(fieldDraftKey('capture:wa:3EB0A9', null)).toBe('capture:wa:3EB0A9@-');
  });

  it('keep one draft per entity (the newest edit) and leave other entities alone', () => {
    saveFieldDraft(draft('day:2026-11-20', null, '2026-11-20T08:00:00.000Z'));
    saveFieldDraft(draft('day:2026-11-21', null, '2026-11-20T08:00:00.000Z'));
    saveFieldDraft(draft('day:2026-11-20', 'v2', '2026-11-20T09:00:00.000Z'));
    expect(Object.keys(fieldDraftStore.get()).sort()).toEqual(['day:2026-11-20@v2', 'day:2026-11-21@-']);
    expect(findFieldDraft(fieldDraftStore.get(), 'day:2026-11-20')?.base).toBe('v2');
    removeFieldDrafts('day:2026-11-20');
    expect(findFieldDraft(fieldDraftStore.get(), 'day:2026-11-20')).toBeNull();
    expect(findFieldDraft(fieldDraftStore.get(), 'day:2026-11-21')).not.toBeNull();
  });

  it('are dropped once their write is confirmed, unless edited after it was sent', () => {
    const d = draft('day:2026-11-20', null, '2026-11-20T08:00:00.000Z');
    saveFieldDraft(d);
    settleFieldDraft({ key: d.key, savedAt: '2026-11-20T08:00:00.000Z' });
    expect(fieldDraftStore.get()).toEqual({});
    saveFieldDraft({ ...d, savedAt: '2026-11-20T08:05:00.000Z' });
    settleFieldDraft({ key: d.key, savedAt: '2026-11-20T08:00:00.000Z' });
    expect(findFieldDraft(fieldDraftStore.get(), 'day:2026-11-20')?.savedAt).toBe('2026-11-20T08:05:00.000Z');
  });
});

describe('story preview markdown', () => {
  it('renders no images (like the generator and the site CSP), links stay', () => {
    const html = renderMarkdown('Look: ![pixel](https://evil.example/pixel.gif) and [a link](https://example.org)');
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://example.org"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('never passes raw HTML through', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain('<img');
  });
});
