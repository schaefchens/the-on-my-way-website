/**
 * Wave 5 cross-runtime vectors (spec-wave5 §4.3), written by fixtures/generate.ts (`pnpm fixtures`,
 * also `--owner-only`):
 *
 *   fixtures/vectors/release.json        release slots, departure hold, portrait release (TS)
 *   fixtures/vectors/time-buckets.json   3-hour buckets and coarsened times (TS)
 *   fixtures/vectors/access-paths.json   ids, cookie values, links, store layout (TS + PHP StoreLayout)
 *   fixtures/vectors/ids.json            + `publishedPost` (published post ids, E16)
 *
 * Every expected value is computed by the TypeScript implementation; packages/contracts/test keeps
 * them in sync and checks the interesting cases (DST gaps and overlaps, …) against hand-computed
 * instants.
 */
import {
  type CookieMode,
  gateCookies,
  gateCookieValue,
  isSafeStoreDir,
  isValidStoreOpPath,
  panicLinkUrl,
  parseGateSession,
  parseLinkFragment,
  personalLinkUrl,
  STORE_PATHS,
  type StoreOpKind,
  storePathKind,
} from '@omw/contracts/access';
import { publishedPostId } from '@omw/contracts/ids';
import {
  entryReleaseAt,
  type HoldDay,
  holdEndAt,
  leftPlaceAt,
  nextReleaseSlot,
  type PolicySettings,
  placeKey,
  portraitReleaseAt,
  type ReleaseSettings,
} from '@omw/contracts/policy';
import { coarsenToBucket, timeBucket, zonedWallTimeToUtc } from '@omw/contracts/time';

const BERLIN = 'Europe/Berlin';
const NEW_YORK = 'America/New_York';
const HCM = 'Asia/Ho_Chi_Minh';

// ---------------------------------------------------------------------------------------------
// release.json

const OFF = { enabled: false, times: ['08:00', '20:00'] };
const TWICE = { enabled: true, times: ['08:00', '20:00'] };

function release(overrides: Partial<ReleaseSettings> = {}): ReleaseSettings {
  return {
    'publish.release_slots': OFF,
    'publish.departure_hold': { enabled: false, maxDays: 7 },
    'timezone.current': BERLIN,
    ...overrides,
  };
}

export async function releaseVectors(): Promise<unknown> {
  const cases: { fn: string; args: unknown[]; expected: unknown }[] = [];
  const add = (fn: string, args: unknown[], expected: unknown) => cases.push({ fn, args, expected });

  const wallTimes: [string, string, string][] = [
    ['2026-11-20', '08:00', BERLIN],
    ['2026-03-29', '01:59', BERLIN],
    ['2026-03-29', '02:00', BERLIN], // gap (02:00-03:00 CET does not exist)
    ['2026-03-29', '02:30', BERLIN],
    ['2026-03-29', '03:00', BERLIN],
    ['2026-10-25', '02:30', BERLIN], // ambiguous (CEST, then CET)
    ['2026-10-25', '03:00', BERLIN],
    ['2026-03-08', '02:30', NEW_YORK],
    ['2026-11-01', '01:30', NEW_YORK],
    ['2026-11-15', '00:00', HCM],
    ['2026-10-04', '02:15', 'Australia/Lord_Howe'], // 30-minute gap
    ['2026-04-05', '01:45', 'Australia/Lord_Howe'], // 30-minute overlap
    ['2011-12-30', '08:00', 'Pacific/Apia'], // a skipped calendar day
    ['2026-11-18', '23:59', 'Pacific/Kiritimati'],
  ];
  for (const [date, hhmm, tz] of wallTimes)
    add('zonedWallTimeToUtc', [date, hhmm, tz], zonedWallTimeToUtc(date, hhmm, tz));

  const slots: [string, { enabled: boolean; times: string[] }, string][] = [
    ['2026-11-20T10:17:33.123Z', OFF, BERLIN],
    ['2026-11-20T10:17:33Z', { enabled: true, times: [] }, BERLIN],
    ['2026-11-20T06:59:59.999Z', TWICE, BERLIN],
    ['2026-11-20T07:00:00.000Z', TWICE, BERLIN],
    ['2026-11-20T07:00:00.001Z', TWICE, BERLIN],
    ['2026-11-20T19:00:00.001Z', TWICE, BERLIN],
    ['2026-11-20T23:30:00Z', TWICE, BERLIN],
    ['2026-03-28T23:00:00Z', { enabled: true, times: ['02:30'] }, BERLIN],
    ['2026-03-28T23:00:00Z', { enabled: true, times: ['01:59', '02:00', '03:00'] }, BERLIN],
    ['2026-03-29T00:59:00.001Z', { enabled: true, times: ['01:59', '02:00', '03:00'] }, BERLIN],
    ['2026-10-24T22:00:00Z', { enabled: true, times: ['02:30'] }, BERLIN],
    ['2026-10-25T00:30:00.001Z', { enabled: true, times: ['02:30'] }, BERLIN],
    ['2026-03-08T05:00:00Z', { enabled: true, times: ['02:30'] }, NEW_YORK],
    ['2026-11-01T04:00:00Z', { enabled: true, times: ['01:30'] }, NEW_YORK],
    ['2026-11-15T05:00:01Z', { enabled: true, times: ['12:00'] }, HCM],
    ['2026-11-18T18:14:00Z', { enabled: true, times: ['00:00'] }, 'Asia/Kathmandu'],
    ['2026-10-03T13:30:00Z', { enabled: true, times: ['02:15'] }, 'Australia/Lord_Howe'],
    ['2011-12-29T20:00:00Z', { enabled: true, times: ['08:00'] }, 'Pacific/Apia'],
    ['2026-11-20T12:00:00Z', { enabled: true, times: ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00'] }, BERLIN],
  ];
  for (const [at, s, tz] of slots) add('nextReleaseSlot', [at, s, tz], nextReleaseSlot(at, s, tz));

  for (const place of ['Hội An ', 'hội an', 'Hội An', '  Hội   An ', '', '   ', null, 'SAIGON']) {
    add('placeKey', [place], placeKey(place));
  }

  const dayLists: HoldDay[][] = [
    [],
    [
      { date: '2026-11-14', place: 'Hanoi', firstAt: '2026-11-14T01:00:00Z' },
      { date: '2026-11-15', place: 'Hội An ', firstAt: '2026-11-15T02:12:00Z' },
      { date: '2026-11-16', place: 'hội an', firstAt: '2026-11-16T00:30:00Z' },
      { date: '2026-11-17', place: null, firstAt: '2026-11-17T03:00:00Z' },
      { date: '2026-11-18', place: 'Saigon', firstAt: '2026-11-18T04:00:00Z' },
      { date: '2026-11-19', place: 'saigon', firstAt: '2026-11-19T05:00:00Z' },
    ],
    [
      // unsorted input, decomposed vs composed spelling, a blank place
      { date: '2026-12-03', place: 'Hội An', firstAt: '2026-12-03T09:00:00Z' },
      { date: '2026-12-01', place: 'Hội An', firstAt: '2026-12-01T09:00:00Z' },
      { date: '2026-12-02', place: '  ', firstAt: '2026-12-02T09:00:00Z' },
      { date: '2026-12-04', place: 'Huế', firstAt: '2026-12-04T09:00:00.500Z' },
    ],
  ];
  for (const days of dayLists) add('leftPlaceAt', [days], Object.fromEntries(leftPlaceAt(days)));

  const entryAt = '2026-11-15T02:12:00Z';
  const holdOn = (maxDays = 7) => ({ enabled: true, maxDays });
  const holds: [string, string | null, ReleaseSettings][] = [
    [entryAt, null, release()],
    [entryAt, null, release({ 'publish.departure_hold': holdOn() })],
    [entryAt, '2026-11-18T04:00:00Z', release({ 'publish.departure_hold': holdOn() })],
    [entryAt, '2026-11-30T04:00:00Z', release({ 'publish.departure_hold': holdOn() })],
    [entryAt, null, release({ 'publish.departure_hold': holdOn(1) })],
    [entryAt, null, release({ 'publish.departure_hold': holdOn(), 'publish.moved_on_at': '2026-11-16T10:00:00.000Z' })],
    [entryAt, null, release({ 'publish.departure_hold': holdOn(), 'publish.moved_on_at': '2026-11-15T02:11:59.999Z' })],
    [entryAt, null, release({ 'publish.departure_hold': holdOn(), 'publish.moved_on_at': entryAt })],
    [
      entryAt,
      '2026-11-17T00:00:00Z',
      release({ 'publish.departure_hold': holdOn(), 'publish.moved_on_at': '2026-11-16T10:00:00.000Z' }),
    ],
    [entryAt, '2026-11-14T23:00:00Z', release({ 'publish.departure_hold': holdOn() })],
  ];
  for (const [at, leftAt, s] of holds) add('holdEndAt', [at, leftAt, s], holdEndAt(at, leftAt, s));

  const slotted = release({ 'publish.release_slots': TWICE });
  const entries: [string | null, string | null, ReleaseSettings][] = [
    [null, null, slotted],
    ['2026-11-15T02:12:00Z', null, release()],
    ['2026-11-15T02:12:00Z', null, slotted],
    ['2026-11-15T02:12:00Z', '2026-11-18T04:00:00.000Z', release()],
    ['2026-11-15T02:12:00Z', '2026-11-18T04:00:00.000Z', slotted],
    ['2026-11-20T09:00:00Z', '2026-11-18T04:00:00.000Z', slotted],
  ];
  for (const [publishAt, holdEnd, s] of entries) {
    add('entryReleaseAt', [publishAt, holdEnd, s], entryReleaseAt(publishAt, holdEnd, s));
  }

  const occurredAt = '2026-11-18T02:00:00Z';
  for (const mode of ['instant', 'delayed', 'review'] as const) {
    for (const onRevoke of ['hide', 'keep'] as const) {
      for (const revokedAt of [null, '2026-11-18T03:00:00Z']) {
        for (const override of [null, 'public', 'hidden', 'pending'] as const) {
          // plain, and with release slots + a departure hold that ends later
          for (const [extra, holdEnd] of [
            [{}, null],
            [{ 'publish.release_slots': TWICE }, '2026-11-19T06:00:00.000Z'],
          ] as const) {
            const settings: PolicySettings & ReleaseSettings = {
              'publish.mode': mode,
              'publish.delay_minutes': 720,
              'ingest.on_revoke': onRevoke,
              ...release(extra),
            };
            const capture = { occurredAt, revokedAt };
            const annotation = { visibility: override };
            add(
              'portraitReleaseAt',
              [capture, annotation, settings, holdEnd],
              portraitReleaseAt(capture, annotation, settings, holdEnd),
            );
          }
        }
      }
    }
  }

  return {
    description:
      'Release slots and the departure hold (spec-wave5 §4.2, contracts/src/policy.ts): each case calls ' +
      '`fn(...args)` and expects `expected` (ISO instants with ms; leftPlaceAt as {date: firstAt|null}). ' +
      'Slot times are wall clock in tz: a slot in a DST gap fires at the first instant after the gap, an ' +
      'ambiguous one at the earlier instant.',
    cases,
  };
}

// ---------------------------------------------------------------------------------------------
// time-buckets.json

export function timeBucketVectors(): unknown {
  const inputs: [string, string, number][] = [
    // every bucket boundary in a zone without DST (UTC+7)
    ['2026-11-15T17:00:00Z', HCM, 0],
    ['2026-11-15T16:59:59.999Z', HCM, 0],
    ['2026-11-15T19:59:59Z', HCM, 0],
    ['2026-11-15T20:00:00Z', HCM, 0],
    ['2026-11-15T23:00:00Z', HCM, 0],
    ['2026-11-16T02:00:00Z', HCM, 0],
    ['2026-11-16T05:00:00Z', HCM, 0],
    ['2026-11-16T08:00:00Z', HCM, 0],
    ['2026-11-16T11:00:00Z', HCM, 0],
    ['2026-11-16T14:00:00Z', HCM, 0],
    // index ordering inside one bucket, milliseconds dropped
    ['2026-11-15T05:47:12.345Z', HCM, 0],
    ['2026-11-15T05:47:12.345Z', HCM, 1],
    ['2026-11-15T05:47:12.345Z', HCM, 7],
    ['2026-11-15T07:59:59Z', HCM, 2],
    // Europe/Berlin: spring forward (2026-03-29 02:00 CET -> 03:00 CEST) and fall back
    // (2026-10-25 03:00 CEST -> 02:00 CET)
    ['2026-03-28T23:00:00Z', BERLIN, 0],
    ['2026-03-29T00:30:00Z', BERLIN, 0],
    ['2026-03-29T00:59:59Z', BERLIN, 1],
    ['2026-03-29T01:00:00Z', BERLIN, 0],
    ['2026-03-29T01:30:00Z', BERLIN, 0],
    ['2026-10-24T22:00:00Z', BERLIN, 0],
    ['2026-10-25T00:30:00Z', BERLIN, 0],
    ['2026-10-25T01:30:00Z', BERLIN, 1],
    ['2026-10-25T02:30:00Z', BERLIN, 0],
    // America/New_York: 2026-03-08 02:00 EST -> 03:00 EDT, 2026-11-01 02:00 EDT -> 01:00 EST
    ['2026-03-08T06:30:00Z', NEW_YORK, 0],
    ['2026-03-08T07:30:00Z', NEW_YORK, 0],
    ['2026-11-01T05:30:00Z', NEW_YORK, 0],
    ['2026-11-01T06:30:00Z', NEW_YORK, 1],
    // quarter-hour offset
    ['2026-11-18T18:14:00Z', 'Asia/Kathmandu', 0],
    ['2026-11-18T18:15:00Z', 'Asia/Kathmandu', 0],
    // midnight in UTC
    ['2026-01-01T00:00:00Z', 'UTC', 0],
    ['2026-12-31T23:59:59.999Z', 'UTC', 3],
  ];
  return {
    description:
      'timeBucket(at, tz) -> {startHour, partOfDay} (3-hour local buckets: 00,03,21 night, 06,09 morning, ' +
      '12 midday, 15 afternoon, 18 evening) and coarsenToBucket(at, tz, index) = at - (local (hour mod 3)' +
      '·3600 + minute·60 + second + ms) + index seconds (site.time_precision = part_of_day).',
    cases: inputs.map(([at, tz, index]) => ({
      at,
      tz,
      index,
      ...timeBucket(at, tz),
      coarsened: coarsenToBucket(at, tz, index),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// ids.json: published post ids

export async function publishedPostVectors(): Promise<{ publicId: string; publishedId: string }[]> {
  const ids = ['p_note0001', 'p_story001', 'p_01JDAB3K9XQZ7Y8W6V5T4S3R2N', 'p_01KA0000000000000000000000', 'p_x-_y'];
  const out = [];
  for (const publicId of ids) out.push({ publicId, publishedId: await publishedPostId(publicId) });
  return out;
}

// ---------------------------------------------------------------------------------------------
// access-paths.json

const FID = 'abcdefgh2345';
const DID = 'qrst2345';
const SID = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0-_z';
const T = 'tTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtT-_0';
const K = 'kKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkKkK_-9';

export function accessPathVectors(): unknown {
  const tokens = {
    accept: [SID, T, K, 'a'.repeat(43), '-'.repeat(43), '_'.repeat(43), `${'Z'.repeat(42)}9`],
    reject: [
      'a'.repeat(42),
      'a'.repeat(44),
      `${'a'.repeat(42)}=`,
      `${'a'.repeat(42)}+`,
      `${'a'.repeat(42)}/`,
      `${'a'.repeat(42)}.`,
      `${'a'.repeat(42)} `,
      '',
    ],
  };
  const followerIds = {
    accept: [FID, 'aaaaaaaaaaaa', '222222777777', 'zzzzzzzzzzzz'],
    reject: [
      'abcdefgh234',
      'abcdefgh23456',
      'ABCDEFGH2345',
      'abcdefgh2341',
      'abcdefgh2348',
      'abcdefgh2340',
      'abcdefgh-345',
      '',
    ],
  };
  const deviceIds = {
    accept: [DID, 'aaaaaaaa', '27272727'],
    reject: ['qrst234', 'qrst23456', 'QRST2345', 'qrst2341', 'qrst_345', ''],
  };
  const gateSessions = {
    accept: [`${FID}.${DID}.${SID}`, `aaaaaaaaaaaa.aaaaaaaa.${'a'.repeat(43)}`],
    reject: [
      `${FID}.${DID}.${SID}.${K}`, // the old 4-part handoff value
      `${FID}.${DID}`,
      `${FID}.${DID}.${SID.slice(1)}`,
      `${FID}.${DID}.${SID}x`,
      `${FID.toUpperCase()}.${DID}.${SID}`,
      `${FID}:${DID}:${SID}`,
      `${FID}..${DID}.${SID}`,
      ` ${FID}.${DID}.${SID}`,
      `"${FID}.${DID}.${SID}"`,
    ],
  };
  const cookieValues = [{ fid: FID, did: DID, sid: SID, value: gateCookieValue(FID, DID, SID) }];
  for (const value of gateSessions.accept) {
    const parts = parseGateSession(value);
    if (parts) cookieValues.push({ ...parts, value });
  }

  const origins = ['https://site.example', 'http://127.0.0.1:4173', 'https://the-site.example.org:8443'];
  const personalLinks = origins.map((origin) => ({ origin, t: T, url: personalLinkUrl(origin, T) }));
  const panicLinks = origins.map((origin) => ({ origin, k: K, url: panicLinkUrl(origin, K) }));
  const badOrigins = [
    'https://site.example/',
    'https://site.example/x',
    'HTTPS://site.example',
    'https://Site.example',
    'ftp://site.example',
    'site.example',
    'https://user@site.example',
  ];

  const storePaths = {
    marker: STORE_PATHS.marker,
    locked: STORE_PATHS.locked,
    htaccess: STORE_PATHS.htaccess,
    session: STORE_PATHS.session(FID, DID, SID),
    sessionDir: STORE_PATHS.sessionDir(FID),
    sessionPrefix: `${STORE_PATHS.sessionDir(FID)}/${STORE_PATHS.sessionPrefix(DID)}`,
    handoff: STORE_PATHS.handoff(DID),
    personTombstone: STORE_PATHS.personTombstone(FID),
    deviceTombstone: STORE_PATHS.deviceTombstone(FID, DID),
  };

  const paths = [
    ...Object.values(storePaths),
    // strays (deletable only)
    's/xyz',
    's/UPPERCASE_DIR',
    `s/${FID}/garbage`,
    `s/${FID}/${DID}.short`,
    'h/tmp.123',
    'h/QRST2345',
    // nothing of the layout
    '',
    's',
    'h',
    't',
    's/',
    'h/',
    `/${STORE_PATHS.locked}`,
    'locked/',
    '../locked',
    `s/../t/${FID}`,
    's/.hidden',
    `s/${FID}/.${DID}`,
    's/..',
    's/.',
    `s//${FID}`,
    `s/${FID}/${DID}/x`,
    `t/${FID}.${DID}.x`,
    `t/${FID}/x`,
    `x/${FID}`,
    `S/${FID}`,
    '.omw-store.json.tmp',
    'locked.tmp',
    `s/${FID}/${DID}.${SID}\n`,
    `s/${'a'.repeat(101)}`,
    `h/${DID} `,
  ];
  const pathKinds = paths.map((path) => ({ path, kind: storePathKind(path) }));

  const ops: StoreOpKind[] = ['init', 'put', 'delete', 'delete_prefix', 'delete_tree'];
  const opPaths = [];
  for (const op of ops) {
    for (const path of paths) {
      for (const exclusive of op === 'put' ? [true, false] : [true]) {
        opPaths.push({ op, path, exclusive, valid: isValidStoreOpPath(op, path, exclusive) });
      }
    }
  }

  const dirs = [
    '/usr/home/omw/omw-store/site1',
    '/var/www/html/.omw-store',
    '/a',
    '/a.b/c_d-e',
    '/...',
    '/a/.b',
    '',
    '/',
    'relative/store',
    '/a/',
    '/a//b',
    '//a',
    '/a/../b',
    '/..',
    '/a/..',
    '/a b',
    '/a%2fb',
    '/a$b',
    "/a'b",
    '/a"b',
    '/a;b',
    '/ä',
    '/a\\b',
  ];
  const storeDirs = dirs.map((dir) => ({ dir, safe: isSafeStoreDir(dir) }));

  const hashes = [
    `#t=${T}`,
    `t=${T}`,
    `#t=${T}&k=${K}`,
    `#k=${K}`,
    '#resume',
    '#reconfirm',
    '#reconfirm&return=%2Fabcdefghij0123456789%2Fde%2Fday%2F2026-11-15%2F',
    '#reconfirm&return=//evil.example/',
    '#reconfirm&return=%2F%2Fevil.example%2F',
    '#reconfirm&return=https%3A%2F%2Fevil.example%2F',
    '#reconfirm&return=%2F%5Cevil.example',
    '#reconfirm&return=%E0%A4%A',
    '#view',
    '#handoff-failed',
    '#resume&handoff-failed',
    `#t=${T.slice(1)}`,
    `#t=${T}x`,
    '#unknown',
    '#',
    '',
    `#t=${T}&t=${K}`,
  ];
  const fragments = hashes.map((hash) => ({ hash, parsed: parseLinkFragment(hash) }));

  const cookieModes: CookieMode[] = ['headers', 'co', 'parent'];
  const cookies = [];
  for (const origin of origins) {
    for (const cookieMode of cookieModes)
      cookies.push({ origin, cookieMode, cookies: gateCookies(origin, cookieMode) });
  }

  return {
    description:
      'Access ids, gate cookie values, personal/panic links and the site-store layout (spec-wave5 §0.3, §2.2, ' +
      '§4.1; contracts/src/access.ts, PHP Domain\\Access\\StoreLayout). tokens/followerIds/deviceIds/' +
      'gateSessions: accept/reject lists of the id and token patterns. cookieValues: gateCookieValue(fid, ' +
      'did, sid) = value and parseGateSession(value) = {fid, did, sid}. personalLinks/panicLinks: ' +
      'personalLinkUrl(origin, t) / panicLinkUrl(origin, k) = url; badOrigins are refused. storePaths: the ' +
      'STORE_PATHS of the sample ids (sessionPrefix as a full delete_prefix path). pathKinds: storePathKind(path) ' +
      '(null = not a store path). opPaths: isValidStoreOpPath(op, path, exclusive). storeDirs: ' +
      'isSafeStoreDir(dir) (ACCESS_STORE_DIR). fragments: parseLinkFragment(hash). cookies: gateCookies(' +
      'origin, cookieMode) (cookie names and the Secure attribute).',
    ids: { fid: FID, did: DID, sid: SID, t: T, k: K },
    tokens,
    followerIds,
    deviceIds,
    gateSessions,
    cookieValues,
    personalLinks,
    panicLinks,
    badOrigins,
    storePaths,
    pathKinds,
    opPaths,
    storeDirs,
    fragments,
    cookies,
  };
}
