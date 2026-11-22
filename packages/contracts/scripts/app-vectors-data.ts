/**
 * Cross-runtime vectors for the traveler app protocol (./src/app.ts), shared by Vitest and the PHP
 * API (PHPUnit). Every expectation here is written by hand; test/app-vectors.test.ts checks that
 * the TS implementation agrees and that fixtures/vectors/app-*.json are in sync with this file.
 *
 *   pnpm --filter @omw/contracts vectors:app          # write fixtures/vectors/app-*.json
 *   pnpm --filter @omw/contracts vectors:app:check    # exit 1 if they drifted
 */
import { createHash } from 'node:crypto';

const ULID = '01JD3ZQ8X4V7N2K5M9P0R6S8TW';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

const client = { app: '2026.11.20-1a2b3c4', platform: 'android', os: '16' };

const base = {
  photo: {
    schema: 1,
    entryId: ULID,
    source: 'app',
    kind: 'photo',
    occurredAt: '2026-11-20T09:15:00.000Z',
    tz: 'Asia/Ho_Chi_Minh',
    caption: 'Lanterns in Hội An 🏮',
    media: { width: 1600, height: 2880, accessibilityLabel: 'Text on image: Hội An' },
    files: [
      { role: 'media', mimetype: 'image/jpeg', bytes: 812345, sha256Hex: SHA_A },
      { role: 'preview', mimetype: 'image/jpeg', bytes: 48210, sha256Hex: SHA_B },
      { role: 'original', mimetype: 'image/heic', bytes: 3456789, sha256Hex: SHA_C },
    ],
    client,
  },
  video: {
    schema: 1,
    entryId: ULID,
    source: 'app',
    kind: 'video',
    occurredAt: '2026-11-20T09:15:00Z',
    tz: 'Asia/Ho_Chi_Minh',
    media: { width: 1080, height: 1920, seconds: 42.5 },
    files: [
      { role: 'media', mimetype: 'video/mp4', bytes: 24567890, sha256Hex: SHA_A },
      { role: 'original', mimetype: 'video/mp4', bytes: 734003200, sha256Hex: SHA_C },
    ],
    client,
    visibility: 'pending',
  },
  text: {
    schema: 1,
    entryId: ULID,
    source: 'app',
    kind: 'text',
    occurredAt: '2026-11-20T09:15:00Z',
    tz: 'Europe/Berlin',
    text: { body: 'Xin chào Việt Nam! 🍜', bgArgb: 4290660980, textArgb: 4294967295, font: 'CALISTOGA_REGULAR' },
    files: [],
    client,
  },
  voice: {
    schema: 1,
    entryId: ULID,
    source: 'app',
    kind: 'voice',
    occurredAt: '2026-11-20T09:15:00Z',
    tz: 'Asia/Ho_Chi_Minh',
    media: { seconds: 12, ptt: true },
    files: [{ role: 'media', mimetype: 'audio/mp4', bytes: 98765, sha256Hex: SHA_A }],
    client,
    localDate: '2026-11-19',
  },
} satisfies Record<string, Obj>;

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function wrap(entry: Json): Obj {
  return { contractVersion: 1, clientNow: '2026-11-20T09:15:02.000Z', entry };
}

/**
 * stage "schema": the exported JSON Schema (AppEntryCreate.json) rejects it.
 * stage "rules": the schema accepts it, the cross-field rules (appEntryProblems) reject it, at
 * `paths` (dot-joined, relative to `entry`).
 */
type EntryCase =
  | { name: string; body: Obj; valid: true }
  | { name: string; body: Obj; valid: false; stage: 'schema'; note?: string }
  | { name: string; body: Obj; valid: false; stage: 'rules'; paths: string[] };

/** zod strips unknown keys when parsing; the exported JSON Schema (additionalProperties false) rejects them. */
export const UNKNOWN_KEY_NOTE = 'unknown key: rejected by the JSON Schema, stripped by zod';
/** Field rule the JSON Schema cannot express (the IANA zone check of ./api, isValidTimeZone). */
export const ZONE_NOTE = 'IANA zone rule (not expressible in JSON Schema)';

function mutate(kind: keyof typeof base, fn: (e: Obj) => void): Obj {
  const e = clone(base[kind]) as Obj;
  fn(e);
  return wrap(e);
}

const entryCases: EntryCase[] = [
  { name: 'photo with caption, alt, preview and HEIC original', body: wrap(base.photo), valid: true },
  { name: 'video, held back, mp4 original', body: wrap(base.video), valid: true },
  { name: 'text status', body: wrap(base.text), valid: true },
  { name: 'voice on an earlier day', body: wrap(base.voice), valid: true },
  {
    name: 'photo without preview or original',
    body: mutate('photo', (e) => {
      e.files = [(e.files as Obj[])[0] as Obj];
    }),
    valid: true,
  },
  {
    name: 'video exactly 60 s, muted export, hidden',
    body: mutate('video', (e) => {
      (e.media as Obj).seconds = 60;
      e.visibility = 'hidden';
    }),
    valid: true,
  },
  // --- schema stage
  {
    name: 'unknown kind gif',
    body: mutate('photo', (e) => {
      e.kind = 'gif';
    }),
    valid: false,
    stage: 'schema',
  },
  {
    name: 'source must be app',
    body: mutate('photo', (e) => {
      e.source = 'whatsapp';
    }),
    valid: false,
    stage: 'schema',
  },
  {
    name: 'lowercase ULID',
    body: mutate('photo', (e) => {
      e.entryId = ULID.toLowerCase();
    }),
    valid: false,
    stage: 'schema',
  },
  {
    name: 'ULID with I',
    body: mutate('photo', (e) => {
      e.entryId = '01JD3ZQ8X4V7N2K5M9P0R6S8TI';
    }),
    valid: false,
    stage: 'schema',
  },
  {
    name: 'offset instead of UTC',
    body: mutate('photo', (e) => {
      e.occurredAt = '2026-11-20T16:15:00+07:00';
    }),
    valid: false,
    stage: 'schema',
  },
  {
    name: 'translucent text background',
    body: mutate('text', (e) => {
      (e.text as Obj).bgArgb = 0x80123456;
    }),
    valid: false,
    stage: 'schema',
  },
  {
    name: 'unknown font',
    body: mutate('text', (e) => {
      (e.text as Obj).font = 'COMIC_SANS';
    }),
    valid: false,
    stage: 'schema',
  },
  {
    name: 'text body too long (701)',
    body: mutate('text', (e) => {
      (e.text as Obj).body = 'x'.repeat(701);
    }),
    valid: false,
    stage: 'schema',
  },
  {
    name: 'empty text body',
    body: mutate('text', (e) => {
      (e.text as Obj).body = '';
    }),
    valid: false,
    stage: 'schema',
  },
  {
    name: 'caption too long (1025)',
    body: mutate('photo', (e) => {
      e.caption = 'y'.repeat(1025);
    }),
    valid: false,
    stage: 'schema',
  },
  {
    name: 'coordinates are not part of the contract',
    body: mutate('photo', (e) => {
      e.location = { lat: 15.88, lon: 108.33 };
    }),
    valid: false,
    stage: 'schema',
    note: UNKNOWN_KEY_NOTE,
  },
  {
    name: 'visibility public is not an app choice',
    body: mutate('photo', (e) => {
      e.visibility = 'public';
    }),
    valid: false,
    stage: 'schema',
  },
  {
    name: 'four files',
    body: mutate('photo', (e) => {
      (e.files as Obj[]).push(clone((e.files as Obj[])[0] as Obj));
    }),
    valid: false,
    stage: 'schema',
  },
  {
    name: 'uppercase sha256',
    body: mutate('photo', (e) => {
      ((e.files as Obj[])[0] as Obj).sha256Hex = 'A'.repeat(64);
    }),
    valid: false,
    stage: 'schema',
  },
  {
    name: 'zero-byte file',
    body: mutate('photo', (e) => {
      ((e.files as Obj[])[0] as Obj).bytes = 0;
    }),
    valid: false,
    stage: 'schema',
  },
  {
    name: 'missing client',
    body: mutate('photo', (e) => {
      delete e.client;
    }),
    valid: false,
    stage: 'schema',
  },
  {
    name: 'unknown time zone',
    body: mutate('photo', (e) => {
      e.tz = 'Mars/Olympus_Mons';
    }),
    valid: false,
    stage: 'schema',
    note: ZONE_NOTE,
  },
  // --- rules stage
  {
    name: 'text kind without text',
    body: mutate('text', (e) => {
      delete e.text;
    }),
    valid: false,
    stage: 'rules',
    paths: ['text'],
  },
  {
    name: 'photo carrying text',
    body: mutate('photo', (e) => {
      e.text = clone(base.text.text);
    }),
    valid: false,
    stage: 'rules',
    paths: ['text'],
  },
  {
    name: 'text status with a caption and a file',
    body: mutate('text', (e) => {
      e.caption = 'hi';
      e.files = [{ role: 'media', mimetype: 'image/jpeg', bytes: 1, sha256Hex: SHA_A }];
    }),
    valid: false,
    stage: 'rules',
    paths: ['caption', 'files.0'],
  },
  {
    name: 'voice with a caption',
    body: mutate('voice', (e) => {
      e.caption = 'listen';
    }),
    valid: false,
    stage: 'rules',
    paths: ['caption'],
  },
  {
    name: 'photo without media facts',
    body: mutate('photo', (e) => {
      delete e.media;
    }),
    valid: false,
    stage: 'rules',
    paths: ['media'],
  },
  {
    name: 'photo without height',
    body: mutate('photo', (e) => {
      delete (e.media as Obj).height;
    }),
    valid: false,
    stage: 'rules',
    paths: ['media'],
  },
  {
    name: 'photo too large (1601 short side)',
    body: mutate('photo', (e) => {
      (e.media as Obj).width = 1601;
    }),
    valid: false,
    stage: 'rules',
    paths: ['media'],
  },
  {
    name: 'video longer than 60 s',
    body: mutate('video', (e) => {
      (e.media as Obj).seconds = 60.5;
    }),
    valid: false,
    stage: 'rules',
    paths: ['media.seconds'],
  },
  {
    name: 'video without seconds',
    body: mutate('video', (e) => {
      delete (e.media as Obj).seconds;
    }),
    valid: false,
    stage: 'rules',
    paths: ['media.seconds'],
  },
  {
    name: 'video above 1920 px',
    body: mutate('video', (e) => {
      (e.media as Obj).height = 2160;
    }),
    valid: false,
    stage: 'rules',
    paths: ['media'],
  },
  {
    name: 'voice with alt text',
    body: mutate('voice', (e) => {
      (e.media as Obj).accessibilityLabel = 'a voice note';
    }),
    valid: false,
    stage: 'rules',
    paths: ['media.accessibilityLabel'],
  },
  {
    name: 'ptt on a photo',
    body: mutate('photo', (e) => {
      (e.media as Obj).ptt = true;
    }),
    valid: false,
    stage: 'rules',
    paths: ['media.ptt'],
  },
  {
    name: 'photo published as PNG',
    body: mutate('photo', (e) => {
      ((e.files as Obj[])[0] as Obj).mimetype = 'image/png';
    }),
    valid: false,
    stage: 'rules',
    paths: ['files.0.mimetype'],
  },
  {
    name: 'voice as OGG/Opus (the app records AAC)',
    body: mutate('voice', (e) => {
      ((e.files as Obj[])[0] as Obj).mimetype = 'audio/ogg';
    }),
    valid: false,
    stage: 'rules',
    paths: ['files.0.mimetype'],
  },
  {
    name: 'two media files',
    body: mutate('voice', (e) => {
      (e.files as Obj[]).push(clone((e.files as Obj[])[0] as Obj));
    }),
    valid: false,
    stage: 'rules',
    paths: ['files.1.role'],
  },
  {
    name: 'photo without a media file',
    body: mutate('photo', (e) => {
      e.files = (e.files as Obj[]).slice(1);
    }),
    valid: false,
    stage: 'rules',
    paths: ['files'],
  },
  {
    name: 'media file above 100 MiB',
    body: mutate('video', (e) => {
      ((e.files as Obj[])[0] as Obj).bytes = 104857601;
    }),
    valid: false,
    stage: 'rules',
    paths: ['files.0.bytes'],
  },
  {
    name: 'preview above 512 KiB',
    body: mutate('photo', (e) => {
      ((e.files as Obj[])[1] as Obj).bytes = 524289;
    }),
    valid: false,
    stage: 'rules',
    paths: ['files.1.bytes'],
  },
  {
    name: 'voice with an original',
    body: mutate('voice', (e) => {
      (e.files as Obj[]).push({ role: 'original', mimetype: 'audio/ogg', bytes: 5, sha256Hex: SHA_C });
    }),
    valid: false,
    stage: 'rules',
    paths: ['files.1.role'],
  },
  {
    name: 'video original as MKV',
    body: mutate('video', (e) => {
      ((e.files as Obj[])[1] as Obj).mimetype = 'video/x-matroska';
    }),
    valid: false,
    stage: 'rules',
    paths: ['files.1.mimetype'],
  },
  {
    name: 'original above 4 GiB',
    body: mutate('video', (e) => {
      ((e.files as Obj[])[1] as Obj).bytes = 4294967297;
    }),
    valid: false,
    stage: 'rules',
    paths: ['files.1.bytes'],
  },
];

// ---------------------------------------------------------------------------------------------

const timeCases = [
  {
    name: 'small skew is corrected',
    input: { occurredAt: '2026-11-20T10:00:00Z', clientNow: '2026-11-20T10:00:05Z', serverNow: '2026-11-20T10:00:15Z' },
    expected: { occurredAt: '2026-11-20T10:00:10.000Z', clamped: false, heldBack: false },
  },
  {
    name: 'phone clock ahead by 3 minutes',
    input: {
      occurredAt: '2026-11-20T10:03:00.250Z',
      clientNow: '2026-11-20T10:03:01.000Z',
      serverNow: '2026-11-20T10:00:01.000Z',
    },
    expected: { occurredAt: '2026-11-20T10:00:00.250Z', clamped: false, heldBack: false },
  },
  {
    name: 'manual queue: shared 2 days ago, sent now',
    input: { occurredAt: '2026-11-18T08:00:00Z', clientNow: '2026-11-20T10:00:00Z', serverNow: '2026-11-20T10:00:02Z' },
    expected: { occurredAt: '2026-11-18T08:00:02.000Z', clamped: false, heldBack: false },
  },
  {
    name: 'phone set to the wrong year cannot backdate',
    input: { occurredAt: '2025-11-20T09:59:00Z', clientNow: '2025-11-20T10:00:00Z', serverNow: '2026-11-20T10:00:00Z' },
    expected: { occurredAt: '2026-11-20T10:00:00.000Z', clamped: true, heldBack: false },
  },
  {
    name: 'skew of exactly 24 h is still corrected',
    input: { occurredAt: '2026-11-19T09:00:00Z', clientNow: '2026-11-19T10:00:00Z', serverNow: '2026-11-20T10:00:00Z' },
    expected: { occurredAt: '2026-11-20T09:00:00.000Z', clamped: false, heldBack: false },
  },
  {
    name: 'skew 1 ms beyond 24 h is clamped',
    input: {
      occurredAt: '2026-11-19T09:00:00Z',
      clientNow: '2026-11-19T09:59:59.999Z',
      serverNow: '2026-11-20T10:00:00Z',
    },
    expected: { occurredAt: '2026-11-20T10:00:00.000Z', clamped: true, heldBack: false },
  },
  {
    name: 'occurredAt after clientNow lands in the future: clamped',
    input: { occurredAt: '2026-11-20T10:05:00Z', clientNow: '2026-11-20T10:00:00Z', serverNow: '2026-11-20T10:00:00Z' },
    expected: { occurredAt: '2026-11-20T10:00:00.000Z', clamped: true, heldBack: false },
  },
  {
    name: 'forgotten manual queue: 40 days old arrives as Hold back',
    input: { occurredAt: '2026-10-11T10:00:00Z', clientNow: '2026-11-20T10:00:00Z', serverNow: '2026-11-20T10:00:00Z' },
    expected: { occurredAt: '2026-10-11T10:00:00.000Z', clamped: false, heldBack: true },
  },
  {
    name: 'exactly 30 days is not held back',
    input: { occurredAt: '2026-10-21T10:00:00Z', clientNow: '2026-11-20T10:00:00Z', serverNow: '2026-11-20T10:00:00Z' },
    expected: { occurredAt: '2026-10-21T10:00:00.000Z', clamped: false, heldBack: false },
  },
  {
    name: '30 days and 1 ms is held back',
    input: {
      occurredAt: '2026-10-21T09:59:59.999Z',
      clientNow: '2026-11-20T10:00:00Z',
      serverNow: '2026-11-20T10:00:00Z',
    },
    expected: { occurredAt: '2026-10-21T09:59:59.999Z', clamped: false, heldBack: true },
  },
];

// ---------------------------------------------------------------------------------------------

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const canonicalValues: { name: string; value: Json; canonical: string }[] = [
  {
    name: 'keys sorted, no whitespace',
    value: { b: 1, a: [true, null], c: 'x' },
    canonical: '{"a":[true,null],"b":1,"c":"x"}',
  },
  { name: 'nested objects sorted', value: { z: { y: 2, x: 1 }, a: {} }, canonical: '{"a":{},"z":{"x":1,"y":2}}' },
  { name: 'uppercase sorts before lowercase', value: { b: 1, B: 2, a: 3 }, canonical: '{"B":2,"a":3,"b":1}' },
  {
    name: 'numbers',
    value: { i: 42, f: 12.5, z: 0, n: -3, big: 4294967295 },
    canonical: '{"big":4294967295,"f":12.5,"i":42,"n":-3,"z":0}',
  },
  { name: 'integral float has no fraction', value: { s: 12.0 }, canonical: '{"s":12}' },
  { name: 'unicode stays raw, slashes unescaped', value: { t: 'Hội An 🏮 a/b' }, canonical: '{"t":"Hội An 🏮 a/b"}' },
  {
    name: 'control characters and quotes',
    value: { t: 'a"b\\c\nd\te\u0001\u001f' },
    canonical: '{"t":"a\\"b\\\\c\\nd\\te\\u0001\\u001f"}',
  },
  { name: 'line and paragraph separators stay raw', value: { t: 'x y z' }, canonical: '{"t":"x y z"}' },
  { name: 'DEL and NBSP stay raw', value: { t: '\u007f ' }, canonical: '{"t":"\u007f "}' },
];

const canonicalCases = [
  ...canonicalValues.map((c) => ({ ...c, sha256Hex: sha(c.canonical) })),
  ...(['photo', 'video', 'text', 'voice'] as const).map((kind) => {
    const value = base[kind] as Json;
    return { name: `entry hash: ${kind}`, value, canonical: null as string | null, sha256Hex: '' };
  }),
];

// ---------------------------------------------------------------------------------------------

const pairingCases = {
  normalize: [
    { input: 'ABCD-EFGH', expected: 'ABCDEFGH' },
    { input: ' abcd efgh ', expected: 'ABCDEFGH' },
    { input: 'abcd efgh', expected: 'ABCDEFGH' },
    { input: 'O0IL-1234', expected: '00111234' },
    { input: 'ABCD-EFGU', expected: null },
    { input: 'ABCDEFG', expected: null },
    { input: 'ABCDEFGHJ', expected: null },
    { input: '01jd3zq8x4v7n2k5m9p0r6s8tw', expected: '01JD3ZQ8X4V7N2K5M9P0R6S8TW' },
    { input: 'ÄBCDEFGH', expected: null },
    { input: '', expected: null },
  ],
  link: [
    { url: 'omw://pair#01JD3ZQ8X4V7N2K5M9P0R6S8TW', expected: '01JD3ZQ8X4V7N2K5M9P0R6S8TW' },
    { url: 'omw://pair/#01jd3zq8x4v7n2k5m9p0r6s8tw', expected: '01JD3ZQ8X4V7N2K5M9P0R6S8TW' },
    { url: 'OMW://PAIR#01JD3ZQ8X4V7N2K5M9P0R6S8TW', expected: '01JD3ZQ8X4V7N2K5M9P0R6S8TW' },
    { url: 'omw://pair#ABCD-EFGH', expected: null },
    { url: 'omw://pair?api=https://evil.example#01JD3ZQ8X4V7N2K5M9P0R6S8TW', expected: null },
    { url: 'https://example.org/pair#01JD3ZQ8X4V7N2K5M9P0R6S8TW', expected: null },
    { url: 'omw://pair#', expected: null },
    { url: 'omw://pair#%E0%A4%A', expected: null },
  ],
  format: [
    { code: 'ABCDEFGH', expected: 'ABCD-EFGH' },
    { code: '01JD3ZQ8X4V7N2K5M9P0R6S8TW', expected: '01JD3ZQ8X4V7N2K5M9P0R6S8TW' },
  ],
};

// ---------------------------------------------------------------------------------------------

const KiB = 1024;
const MiB = 1024 * KiB;

const chunkCases = {
  next: [
    { name: 'fast link doubles', current: 1 * MiB, outcome: { ok: true, bytes: 1 * MiB, ms: 500 }, expected: 2 * MiB },
    {
      name: 'doubling stops at 8 MiB',
      current: 8 * MiB,
      outcome: { ok: true, bytes: 8 * MiB, ms: 1000 },
      expected: 8 * MiB,
    },
    {
      name: '64 kbit/s link: 15 s worth (120000 B) rounds down, then clamps to 256 KiB',
      current: 1 * MiB,
      outcome: { ok: true, bytes: 1 * MiB, ms: 131072 },
      expected: 256 * KiB,
    },
    {
      name: '1 Mbit/s: 15 s worth = 1875024 B, rounded down to 64 KiB steps',
      current: 2 * MiB,
      outcome: { ok: true, bytes: 2 * MiB, ms: 16777 },
      expected: 1792 * KiB,
    },
    { name: 'failure halves', current: 2 * MiB, outcome: { ok: false }, expected: 1 * MiB },
    { name: 'failure at the floor stays at 256 KiB', current: 256 * KiB, outcome: { ok: false }, expected: 256 * KiB },
    { name: 'odd size halves to a 64 KiB step', current: 1000 * KiB, outcome: { ok: false }, expected: 448 * KiB },
    {
      name: 'zero ms counts as fast',
      current: 4 * MiB,
      outcome: { ok: true, bytes: 4 * MiB, ms: 0 },
      expected: 8 * MiB,
    },
    {
      name: 'tighter server bounds win',
      current: 1 * MiB,
      outcome: { ok: true, bytes: 1 * MiB, ms: 100 },
      bounds: { minBytes: 512 * KiB, maxBytes: 1536 * KiB },
      expected: 1536 * KiB,
    },
  ],
  checksum: [
    {
      name: 'sha256 of the empty string',
      hex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      header: 'sha256 47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
    },
    {
      name: 'sha256 of "abc"',
      hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      header: 'sha256 ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=',
    },
  ],
  badHeaders: ['md5 1B2M2Y8AsgTpgAmY7PhCfg==', 'sha256 47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU', 'sha256 xyz', ''],
};

export interface AppVectorFiles {
  'app-entries.json': unknown;
  'app-time.json': unknown;
  'app-canonical.json': unknown;
  'app-pairing.json': unknown;
  'app-chunks.json': unknown;
}

/**
 * The vector files. `canonical` of the entry-hash cases is filled with `canonicalize` (the
 * implementation under test) only because writing four long strings by hand adds nothing; the
 * hash next to it comes from node:crypto, so PHP still checks canonicalization + sha256 end to end.
 */
export function buildAppVectors(canonicalize: (v: unknown) => string): AppVectorFiles {
  const canonical = canonicalCases.map((c) => {
    const text = c.canonical ?? canonicalize(c.value);
    return { name: c.name, value: c.value, canonical: text, sha256Hex: sha(text) };
  });
  return {
    'app-entries.json': {
      description:
        'AppEntryCreate bodies (packages/contracts/src/app.ts). stage "schema": api/schemas/AppEntryCreate.json rejects the body; stage "rules": the schema accepts it and appEntryProblems() rejects it at `paths` (dot-joined, relative to entry).',
      cases: entryCases,
    },
    'app-time.json': {
      description:
        'correctAppOccurredAt(): skew correction, the 24 h clamp and the 30-day Hold back rule. Output instants use milliseconds ("…T10:00:00.000Z").',
      cases: timeCases,
    },
    'app-canonical.json': {
      description:
        'appCanonicalJson() and appEntryHash() = sha256 hex of the canonical JSON (idempotent POST /app/entries). PHP: decode objects as objects (an empty {} must stay {}), sort keys recursively (ksort SORT_STRING), json_encode(JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS).',
      cases: canonical,
    },
    'app-pairing.json': {
      description:
        'normalizeAppPairingCode(), appPairingCodeFromLink() (only omw://pair#<26-char code>; a link never sets the API base) and formatAppTypedPairingCode().',
      ...pairingCases,
    },
    'app-chunks.json': {
      description:
        'nextChunkBytes() (adaptive chunk size, default bounds 256 KiB–8 MiB, 15 s target, 64 KiB steps) and the Upload-Checksum header format.',
      ...chunkCases,
    },
  };
}
