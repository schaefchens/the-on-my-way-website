import { describe, expect, it } from 'vitest';
import {
  APP_INBOX_DEFAULTS,
  AppInboxAck,
  AppInboxItem,
  AppPhoneListResponse,
  AppVisibilityRequest,
} from '../src/app-inbox.js';
import { buildAppJsonSchemas } from '../src/json-schema.js';

const ULID = '01JD3ZQ8X4V7N2K5M9P0R6S8TW';
const SHA = 'a'.repeat(64);

const entry = {
  schema: 1,
  entryId: ULID,
  source: 'app',
  kind: 'photo',
  occurredAt: '2026-11-20T09:15:00.000Z',
  tz: 'Asia/Ho_Chi_Minh',
  media: { width: 1600, height: 1200 },
  files: [{ role: 'media', mimetype: 'image/jpeg', bytes: 1000, sha256Hex: SHA }],
  client: { app: '2026.11.20-1a2b3c4', platform: 'android' },
} as const;

describe('app inbox contracts', () => {
  it('describes one entry the backend pulls', () => {
    const item = AppInboxItem.parse({
      entryId: ULID,
      sourceKey: `app:${ULID}`,
      state: 'uploaded',
      occurredAt: '2026-11-20T09:15:01.000Z',
      receivedAt: '2026-11-20T09:15:02.000Z',
      clamped: false,
      heldBack: false,
      phone: { id: 1, name: 'Pixel 8a' },
      entry,
      files: [
        {
          uploadId: 'u_abcdefghijklmnopqrstuv',
          role: 'media',
          mimetype: 'image/jpeg',
          bytes: 1000,
          sha256Hex: SHA,
          state: 'committed',
        },
      ],
      withdrawnAt: null,
    });
    expect(item.files[0]?.state).toBe('committed');
  });

  it('only tightens visibility and acks known roles', () => {
    expect(AppVisibilityRequest.safeParse({ visibility: 'hidden' }).success).toBe(true);
    expect(AppVisibilityRequest.safeParse({ visibility: 'public' }).success).toBe(false);
    expect(AppInboxAck.safeParse({ roles: ['media', 'preview'] }).success).toBe(true);
    expect(AppInboxAck.safeParse({ roles: ['thumbnail'] }).success).toBe(false);
  });

  it('lists phones with the inbox budget', () => {
    const list = AppPhoneListResponse.parse({
      items: [],
      openPairing: null,
      inbox: { usedBytes: 0, maxBytes: APP_INBOX_DEFAULTS.maxBytes },
      archiveOnly: true,
    });
    expect(list.archiveOnly).toBe(true);
  });

  it('exports closed JSON Schemas for the request bodies', () => {
    const schemas = buildAppJsonSchemas();
    for (const name of ['AppVisibilityRequest', 'AppInboxAck', 'AppInboxReject'] as const) {
      expect(schemas[name].additionalProperties).toBe(false);
    }
    expect(Object.keys(schemas)).toContain('AppInboxResponse');
  });
});
