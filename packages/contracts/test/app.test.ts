import { describe, expect, it } from 'vitest';
import { API_SCHEMAS } from '../src/api.js';
import {
  APP_ENTRY_STATUSES,
  APP_SCHEMAS,
  AppEntryCreate,
  AppEntryState,
  AppPairResponse,
  appPairingLink,
  appSourceKey,
  captureOrigin,
  isAppSourceKey,
} from '../src/app.js';
import { APP_INBOX_SCHEMAS } from '../src/app-inbox.js';
import { publicIdForSourceKey } from '../src/ids.js';
import { buildAllJsonSchemas, buildAppJsonSchemas } from '../src/json-schema.js';

const ULID = '01JD3ZQ8X4V7N2K5M9P0R6S8TW';

describe('app identity', () => {
  it('builds app:<ULID> source keys that hash like any capture', async () => {
    const key = appSourceKey(ULID);
    expect(key).toBe(`app:${ULID}`);
    expect(isAppSourceKey(key)).toBe(true);
    expect(isAppSourceKey(`wa:${ULID}`)).toBe(false);
    expect(await publicIdForSourceKey(key)).toMatch(/^e_[a-z2-7]{12}$/);
    expect(() => appSourceKey('not-a-ulid')).toThrow(RangeError);
    expect(() => appSourceKey(ULID.toLowerCase())).toThrow(RangeError);
  });

  it('derives the origin from the namespace', () => {
    expect(captureOrigin('wa:3EB0ABCDEF')).toBe('whatsapp');
    expect(captureOrigin(`app:${ULID}`)).toBe('app');
    expect(captureOrigin('x:1')).toBeNull();
    expect(captureOrigin('garbage')).toBeNull();
  });

  it('makes pairing links only from 26-char codes', () => {
    expect(appPairingLink(ULID)).toBe(`omw://pair#${ULID}`);
    expect(() => appPairingLink('ABCDEFGH')).toThrow(RangeError);
  });
});

describe('app schemas', () => {
  it('exports every app schema, closed, without colliding with the API schemas', () => {
    const app = buildAppJsonSchemas();
    expect(Object.keys(app).sort()).toEqual([...Object.keys(APP_SCHEMAS), ...Object.keys(APP_INBOX_SCHEMAS)].sort());
    for (const name of Object.keys(app)) expect(Object.keys(API_SCHEMAS)).not.toContain(name);
    const all = buildAllJsonSchemas();
    expect(Object.keys(all).length).toBe(Object.keys(API_SCHEMAS).length + Object.keys(app).length);
    const entry = (app.AppEntryCreate.properties as Record<string, { additionalProperties?: unknown }>).entry;
    expect(entry?.additionalProperties).toBe(false);
    // No coordinates anywhere in what the app sends.
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        const props = (v as { properties?: Record<string, unknown> }).properties;
        if (props) for (const k of Object.keys(props)) keys.add(k.toLowerCase());
        Object.values(v).forEach(walk);
      }
    };
    walk(app.AppEntryCreate);
    expect(keys.has('kind')).toBe(true);
    for (const k of keys) expect(k).not.toMatch(/^(lat|lon|lng|latitude|longitude|location|coords?|coordinates|geo)$/);
  });

  it('keeps the WhatsApp text-status fields of wa.ts', () => {
    const json = JSON.stringify(buildAppJsonSchemas().AppEntryCreate);
    for (const field of ['bgArgb', 'textArgb', 'font', 'CALISTOGA_REGULAR', 'accessibilityLabel']) {
      expect(json).toContain(field);
    }
  });

  it('parses a server state and a pairing response', () => {
    const state = AppEntryState.parse({
      entryId: ULID,
      sourceKey: `app:${ULID}`,
      state: 'receiving',
      occurredAt: '2026-11-20T09:15:00.000Z',
      receivedAt: '2026-11-20T09:15:03.000Z',
      heldBack: false,
      uploads: [{ uploadId: 'u_abcdefghijklmnop', role: 'media', bytes: 1000, offset: 0, committed: false }],
      chunk: { minBytes: 262144, maxBytes: 8388608 },
      backendLastSeenAt: null,
      publish: null,
    });
    expect(state.uploads[0]?.offset).toBe(0);
    const pair = AppPairResponse.safeParse({
      token: `omw_${'A'.repeat(43)}`,
      info: { id: 7, name: 'Pixel 8a', scopes: ['capture'], createdAt: '2026-11-20T09:00:00Z', expiresAt: null },
    });
    expect(pair.success).toBe(true);
    const admin = AppPairResponse.safeParse({
      token: `omw_${'A'.repeat(43)}`,
      info: { id: 7, name: 'Pixel 8a', scopes: ['admin'], createdAt: '2026-11-20T09:00:00Z', expiresAt: null },
    });
    expect(admin.success, 'pairing never hands out an admin token (Q4 a)').toBe(false);
  });

  it('rejects a create without clientNow', () => {
    expect(AppEntryCreate.safeParse({ contractVersion: 1, entry: {} }).success).toBe(false);
  });

  it('has one status vocabulary from preparing to live', () => {
    expect(APP_ENTRY_STATUSES[0]).toBe('preparing');
    expect(APP_ENTRY_STATUSES).toContain('archived');
    expect(APP_ENTRY_STATUSES).toContain('live');
    expect(new Set(APP_ENTRY_STATUSES).size).toBe(APP_ENTRY_STATUSES.length);
  });
});
