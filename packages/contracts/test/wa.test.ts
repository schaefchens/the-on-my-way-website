import { describe, expect, it } from 'vitest';
import {
  argbToRgbaHex,
  FONT_NAMES,
  FONT_TYPE_NUMBERS,
  fontNameFromType,
  InboxMeta,
  isTerminalDownload,
  parseWaEventLine,
  RevokeRecord,
  serializeWaCommand,
  WaCommand,
  WaEvent,
} from '../src/wa.js';
import { inboxPhoto } from './samples.js';

describe('fonts (D10)', () => {
  it('maps WAProto FontType numbers', () => {
    expect(FONT_TYPE_NUMBERS).toEqual({
      SYSTEM: 0,
      SYSTEM_TEXT: 1,
      FB_SCRIPT: 2,
      SYSTEM_BOLD: 6,
      MORNINGBREEZE_REGULAR: 7,
      CALISTOGA_REGULAR: 8,
      EXO2_EXTRABOLD: 9,
      COURIERPRIME_BOLD: 10,
    });
    for (const name of FONT_NAMES) expect(fontNameFromType(FONT_TYPE_NUMBERS[name])).toBe(name);
    expect(fontNameFromType(3)).toBeNull();
    expect(fontNameFromType(null)).toBeNull();
  });

  it('converts ARGB uint32 to #rrggbbaa', () => {
    expect(argbToRgbaHex(0xff8b6990)).toBe('#8b6990ff');
    expect(argbToRgbaHex(0x00000000)).toBe('#00000000');
    expect(argbToRgbaHex(0xffffffff)).toBe('#ffffffff');
    expect(argbToRgbaHex(0x80123456)).toBe('#12345680');
    expect(() => argbToRgbaHex(-1)).toThrow(RangeError);
    expect(() => argbToRgbaHex(0x100000000)).toThrow(RangeError);
  });
});

describe('WaEvent', () => {
  const valid: unknown[] = [
    { type: 'ready', version: '0.1.0' },
    { type: 'state', state: 'open', jid: '4915100000002:12@s.whatsapp.net', at: '2026-11-19T10:00:00Z' },
    { type: 'state', state: 'logged_out', code: 401, detail: '401', at: '2026-11-19T10:00:00.123Z' },
    {
      type: 'state',
      state: 'banned',
      reason: 'temporary_ban',
      code: 101,
      until: '2026-11-20T10:00:00Z',
      at: '2026-11-19T10:00:00Z',
    },
    { type: 'state', state: 'closed', reason: 'keepalive_timeout', code: 3, at: '2026-11-19T10:00:00Z' },
    { type: 'qr', code: '2@abc,def,ghi', expiresAt: '2026-11-19T10:01:00Z' },
    { type: 'pair_code', code: 'ABCD-EFGH' },
    { type: 'status', msgId: '3EB0C767D26A1D8B7A3B', source: 'live' },
    { type: 'status', msgId: 'AC2F9A', source: 'history' },
    { type: 'media', msgId: '3EB0C767D26A1D8B7A3B', state: 'ok' },
    { type: 'media', msgId: '3EB0C767D26A1D8B7A3B', state: 'failed', reason: 'expired', permanent: true },
    { type: 'media', msgId: '3EB0C767D26A1D8B7A3B', state: 'retrying' },
    { type: 'revoke', msgId: '3EB0C767D26A1D8B7A3B', at: '2026-11-19T10:00:00Z' },
    { type: 'traveler', pn: '4915100000001', lid: '100000000000001' },
    { type: 'traveler', pn: '4915100000001' },
    { type: 'stats', counters: { statuses: 3, ignored: 1 } },
  ];
  it.each(valid.map((v) => [JSON.stringify(v), v]))('accepts %s', (_s, value) => {
    expect(WaEvent.safeParse(value).success).toBe(true);
  });

  const invalid: unknown[] = [
    { type: 'nope' },
    { type: 'ready' },
    { type: 'state', state: 'sleeping', at: '2026-11-19T10:00:00Z' },
    { type: 'state', state: 'open', at: '2026-11-19T11:00:00+01:00' },
    { type: 'status', msgId: '../../etc/passwd', source: 'live' },
    { type: 'status', msgId: 'ABC', source: 'carrier-pigeon' },
    { type: 'media', msgId: 'ABC', state: 'pending' },
    { type: 'media', msgId: 'ABC', state: 'failed', reason: 'gone' },
    { type: 'status', msgId: '_revokes', source: 'live' },
    { type: 'state', state: 'error', reason: 'whatever', at: '2026-11-19T10:00:00Z' },
    { type: 'traveler', pn: '+49 151 0000' },
    { type: 'stats', counters: { a: 'x' } },
  ];
  it.each(invalid.map((v) => [JSON.stringify(v), v]))('rejects %s', (_s, value) => {
    expect(WaEvent.safeParse(value).success).toBe(false);
  });

  it('parses stdout lines without throwing', () => {
    const ok = parseWaEventLine('{"type":"status","msgId":"ABC123","source":"live"}');
    expect(ok).toEqual({ ok: true, value: { type: 'status', msgId: 'ABC123', source: 'live' } });
    const bad = parseWaEventLine('panic: runtime error');
    expect(bad.ok).toBe(false);
    const wrong = parseWaEventLine('{"type":"status"}');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toContain('msgId');
  });
});

describe('WaCommand', () => {
  it('serializes valid commands as JSON lines', () => {
    expect(serializeWaCommand({ type: 'pair_code', phone: '4915100000002' })).toBe(
      '{"type":"pair_code","phone":"4915100000002"}\n',
    );
    for (const cmd of [
      { type: 'logout' },
      { type: 'mark_read', msgId: 'ABC' },
      { type: 'redownload', msgId: 'ABC' },
      { type: 'stats' },
      { type: 'shutdown' },
    ] as const) {
      expect(WaCommand.safeParse(cmd).success).toBe(true);
    }
  });

  it('rejects invalid commands', () => {
    expect(WaCommand.safeParse({ type: 'send_message', text: 'hi' }).success).toBe(false);
    expect(WaCommand.safeParse({ type: 'mark_read' }).success).toBe(false);
    expect(() => serializeWaCommand({ type: 'pair_code', phone: 'abc' })).toThrow();
  });
});

describe('InboxMeta', () => {
  it('accepts a downloaded photo', () => {
    expect(InboxMeta.parse(inboxPhoto())).toEqual(inboxPhoto());
  });

  it('accepts text, voice, unsupported and pending downloads', () => {
    const base = inboxPhoto();
    const text: InboxMeta = {
      ...base,
      kind: 'text',
      media: undefined,
      caption: undefined,
      text: { body: 'مرحبا', bgArgb: 0xff8b6990, textArgb: 0xffffffff, font: 'SYSTEM_BOLD' },
      download: { state: 'not_applicable', attempts: 0 },
    };
    expect(InboxMeta.safeParse(text).success).toBe(true);
    const voice: InboxMeta = {
      ...base,
      kind: 'voice',
      media: {
        mimetype: 'audio/ogg; codecs=opus',
        fileSha256B64: base.media?.fileSha256B64 ?? '',
        fileLength: 9000,
        seconds: 3,
        ptt: true,
        waveformB64: 'AAECAwQ=',
      },
      download: { state: 'pending', attempts: 0 },
    };
    expect(InboxMeta.safeParse(voice).success).toBe(true);
    const unsupported: InboxMeta = {
      ...base,
      kind: 'unsupported',
      media: undefined,
      unsupportedType: 'pollCreationMessageV3',
      rawProtoB64: 'CgVoZWxsbw==',
      download: { state: 'not_applicable', attempts: 0 },
    };
    expect(InboxMeta.safeParse(unsupported).success).toBe(true);
  });

  it('enforces kind/media/download consistency', () => {
    const base = inboxPhoto();
    const text = { body: 'x', bgArgb: null, textArgb: null, font: null };
    expect(InboxMeta.safeParse({ ...base, media: undefined }).success).toBe(false);
    expect(InboxMeta.safeParse({ ...base, kind: 'text' }).success).toBe(false);
    expect(InboxMeta.safeParse({ ...base, download: { state: 'ok', attempts: 1 } }).success).toBe(false);
    expect(InboxMeta.safeParse({ ...base, download: { state: 'not_applicable', attempts: 0 } }).success).toBe(false);
    expect(
      InboxMeta.safeParse({
        ...base,
        kind: 'text',
        media: undefined,
        text,
        download: { state: 'pending', attempts: 0 },
      }).success,
    ).toBe(false);
    expect(
      InboxMeta.safeParse({ ...base, kind: 'text', text, download: { state: 'not_applicable', attempts: 0 } }).success,
    ).toBe(false); // text must not carry media
    expect(InboxMeta.safeParse({ ...base, text }).success).toBe(false); // only text carries text
    expect(InboxMeta.safeParse({ ...base, download: { state: 'failed', attempts: 3 } }).success).toBe(false);
    expect(
      InboxMeta.safeParse({
        ...base,
        download: { state: 'failed', attempts: 3, reason: 'not_on_phone', permanent: true },
      }).success,
    ).toBe(true);
    expect(
      InboxMeta.safeParse({
        ...base,
        download: { state: 'retrying', attempts: 1, retryRequestedAt: '2026-11-15T03:00:00Z' },
      }).success,
    ).toBe(true);
  });

  it('requires the raw proto and the sender JID for live and history statuses', () => {
    const { rawProtoB64: _r, ...noProto } = inboxPhoto();
    expect(InboxMeta.safeParse(noProto).success).toBe(false);
    expect(InboxMeta.safeParse({ ...noProto, source: 'fixture' }).success).toBe(true);
    const noJid = { ...inboxPhoto(), sender: { pn: '4915100000001' } };
    expect(InboxMeta.safeParse(noJid).success).toBe(false);
    expect(InboxMeta.safeParse({ ...inboxPhoto(), sender: { jid: '4915100000001:12@s.whatsapp.net' } }).success).toBe(
      false,
    ); // device part must be stripped
    expect(
      InboxMeta.safeParse({ ...inboxPhoto(), source: 'history', sender: { lid: '1', jid: '1@lid' } }).success,
    ).toBe(true);
  });

  it('isTerminalDownload', () => {
    expect(isTerminalDownload({ state: 'ok', attempts: 1 })).toBe(true);
    expect(isTerminalDownload({ state: 'not_applicable', attempts: 0 })).toBe(true);
    expect(isTerminalDownload({ state: 'failed', attempts: 2, reason: 'expired', permanent: true })).toBe(true);
    expect(isTerminalDownload({ state: 'failed', attempts: 2, reason: 'network', permanent: false })).toBe(false);
    expect(isTerminalDownload({ state: 'retrying', attempts: 1 })).toBe(false);
    expect(isTerminalDownload({ state: 'pending', attempts: 0 })).toBe(false);
  });

  it('rejects malformed fields', () => {
    const base = inboxPhoto();
    expect(InboxMeta.safeParse({ ...base, schema: 2 }).success).toBe(false);
    expect(InboxMeta.safeParse({ ...base, timestamp: '2026-11-15 02:12:00' }).success).toBe(false);
    expect(InboxMeta.safeParse({ ...base, download: { ...base.download, file: '../x.jpg' } }).success).toBe(false);
    expect(InboxMeta.safeParse({ ...base, download: { ...base.download, sha256Hex: 'ABC' } }).success).toBe(false);
    expect(
      InboxMeta.safeParse({ ...base, text: { body: 'x', bgArgb: -1, textArgb: null, font: null }, kind: 'text' })
        .success,
    ).toBe(false);
    expect(InboxMeta.safeParse({ ...base, media: { ...base.media, fileSha256B64: 'not base64!' } }).success).toBe(
      false,
    );
  });
});

describe('RevokeRecord', () => {
  it('validates', () => {
    expect(RevokeRecord.safeParse({ schema: 1, msgId: 'ABC', at: '2026-11-19T10:00:00Z' }).success).toBe(true);
    expect(RevokeRecord.safeParse({ schema: 1, msgId: 'ABC' }).success).toBe(false);
  });
});
