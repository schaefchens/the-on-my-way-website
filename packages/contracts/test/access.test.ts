import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ACCESS_TOKEN_RE,
  AccessStatus,
  AccessSummary,
  AccessToken,
  AdminFollower,
  CookieMode,
  DeviceId,
  DevicePollResponse,
  Epoch,
  FollowerId,
  FollowerListResponse,
  GATE_COOKIE_MAX_AGE,
  GATE_COOKIE_NAMES,
  GateBoot,
  GateSession,
  gateCookies,
  gateCookieValue,
  HANDOFF_FAILED_PATH,
  HANDOFF_PATH,
  HandoffPath,
  isLoopbackHost,
  isSafeStoreDir,
  isValidStoreOpPath,
  JoinRequest,
  JoinResponse,
  LockRequest,
  MeDeleteRequest,
  NOTICE_TEXT_KEYS,
  NoticeTexts,
  ORIGIN_RE,
  Origin,
  PrivacyNotice,
  PrivacyNoticeDraft,
  PUBLIC_API_BASE_RE,
  PublicApiBase,
  panicLinkUrl,
  parseGateSession,
  parseLinkFragment,
  personalLinkUrl,
  ServiceSession,
  type SiteAccessConfig,
  SiteAccessConfig as SiteAccessConfigSchema,
  STORE_DIR_RE,
  STORE_OP_PATH_KINDS,
  STORE_PATH_PATTERNS,
  STORE_PATHS,
  StoreId,
  StoreListing,
  StoreOp,
  type StoreOpKind,
  siteAccessProblems,
  storePathKind,
  TRANSFER_COOKIE_MAX_AGE,
} from '../src/access.js';
import { API_SCHEMAS, type ApiSchemaName, StatusResponse } from '../src/api.js';
import { BootAccess } from '../src/site.js';
import {
  ACCESS_IDS,
  accessSamples,
  accessStatus,
  adminFollower,
  GATE_SESSION_SAMPLE,
  privacyNotice,
} from './samples.js';

const { fid, did, sid, t, k } = ACCESS_IDS;

/** The access entries of API_SCHEMAS (spec-wave5 §4.2), in the spec's order. */
const ACCESS_SCHEMA_NAMES = [
  'JoinCheckRequest',
  'JoinCheckResponse',
  'JoinRequest',
  'JoinResponse',
  'DeviceKeyRequest',
  'DevicePollResponse',
  'MeHelloResponse',
  'MeNoticeResponse',
  'MeConsentRequest',
  'MeDeleteRequest',
  'MeSimpleResponse',
  'MeDataResponse',
  'FollowerDataExport',
  'PanicRequest',
  'PanicResponse',
  'FollowerListResponse',
  'AdminFollower',
  'FollowerCreate',
  'FollowerPatch',
  'FollowerCreated',
  'PersonalLinkCreated',
  'FollowerDeleteRequest',
  'AccessActionResult',
  'AccessStatus',
  'LockRequest',
  'PanicLinkCreated',
  'PrivacyNoticeDraft',
  'PrivacyNotice',
  'PrivacyState',
  'PrivacyPublishRequest',
  'OwnerNoticeList',
  'NoticeReadRequest',
  'AccessClaimRequest',
  'AccessClaim',
  'AccessRenewRequest',
  'AccessLease',
  'StoreListingUpload',
  'AccessAck',
  'ServiceSession',
  'StoreMarker',
  'StoreTombstone',
  'StoreLock',
] as const satisfies readonly ApiSchemaName[];

const INPUTS = new Set([
  'JoinCheckRequest',
  'JoinRequest',
  'DeviceKeyRequest',
  'MeConsentRequest',
  'MeDeleteRequest',
  'PanicRequest',
  'FollowerCreate',
  'FollowerPatch',
  'FollowerDeleteRequest',
  'LockRequest',
  'PrivacyNoticeDraft',
  'PrivacyPublishRequest',
  'NoticeReadRequest',
  'AccessClaimRequest',
  'AccessRenewRequest',
  'StoreListingUpload',
  'AccessAck',
]);

const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;

describe('access schemas: registry and samples', () => {
  it('registers every access payload with the io of spec §4.2', () => {
    for (const name of ACCESS_SCHEMA_NAMES) {
      expect(API_SCHEMAS[name], name).toBeDefined();
      expect(API_SCHEMAS[name][1], name).toBe(INPUTS.has(name) ? 'input' : 'output');
    }
    expect(API_SCHEMAS.PasswordChange[1]).toBe('input');
  });

  it('every access schema accepts its samples unchanged (every union variant covered)', () => {
    const samples = accessSamples();
    expect(Object.keys(samples).sort()).toEqual([...ACCESS_SCHEMA_NAMES].sort());
    for (const name of ACCESS_SCHEMA_NAMES) {
      const [schema] = API_SCHEMAS[name];
      for (const sample of samples[name] ?? []) {
        const parsed = schema.safeParse(sample);
        expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
        expect(parsed.data, name).toEqual(sample);
      }
    }
  });
});

describe('ids and tokens', () => {
  it('follower and device ids are lowercase base32 of the exact length', () => {
    for (const id of [fid, 'aaaaaaaaaaaa', '234567234567']) expect(ok(FollowerId, id), id).toBe(true);
    for (const id of ['abcdefgh234', 'abcdefgh23456', 'ABCDEFGH2345', 'abcdefgh2341', 'abcdefgh2348', 'abcdefgh-345']) {
      expect(ok(FollowerId, id), id).toBe(false);
    }
    for (const id of [did, '22222222']) expect(ok(DeviceId, id), id).toBe(true);
    for (const id of ['qrst234', 'qrst23456', 'QRST2345', 'qrst2340', 'qrst_345', '']) {
      expect(ok(DeviceId, id), id).toBe(false);
    }
  });

  it('tokens are exactly 43 base64url characters (no padding, no + or /)', () => {
    for (const token of [t, k, sid, 'a'.repeat(43), '-'.repeat(43)]) expect(ok(AccessToken, token)).toBe(true);
    for (const token of [
      'a'.repeat(42),
      'a'.repeat(44),
      `${'a'.repeat(42)}=`,
      `${'a'.repeat(42)}+`,
      `${'a'.repeat(42)}/`,
      ` ${'a'.repeat(42)}`,
    ]) {
      expect(ok(AccessToken, token), token).toBe(false);
    }
    expect(ACCESS_TOKEN_RE.test(`${t}\n`)).toBe(false);
  });

  it('epoch and store id are 16 lowercase hex characters', () => {
    expect(ok(Epoch, '0123456789abcdef')).toBe(true);
    expect(ok(StoreId, '0123456789abcdef')).toBe(true);
    for (const bad of ['0123456789ABCDEF', '0123456789abcde', '0123456789abcdef0', 'g123456789abcdef']) {
      expect(ok(Epoch, bad), bad).toBe(false);
      expect(ok(StoreId, bad), bad).toBe(false);
    }
  });

  it('a gate session is exactly "<fid>.<did>.<sid>" (never a fourth part)', () => {
    expect(ok(GateSession, GATE_SESSION_SAMPLE)).toBe(true);
    for (const bad of [
      `${GATE_SESSION_SAMPLE}.${k}`,
      `${fid}.${did}`,
      `${fid}.${did}.${sid}x`,
      `${fid}:${did}:${sid}`,
      `${fid.toUpperCase()}.${did}.${sid}`,
      `"${GATE_SESSION_SAMPLE}"`,
    ]) {
      expect(ok(GateSession, bad), bad).toBe(false);
    }
  });

  it('origins are lowercase "http(s)://host[:port]" without path, credentials or IPv6', () => {
    for (const origin of ['https://site.example', 'http://127.0.0.1:4173', 'https://a.b-c.example:8443']) {
      expect(ok(Origin, origin), origin).toBe(true);
    }
    for (const origin of [
      'https://site.example/',
      'https://site.example/x',
      'HTTPS://site.example',
      'https://Site.example',
      'https://user@site.example',
      'ftp://site.example',
      'http://[::1]:8080',
      'https://-site.example',
    ]) {
      expect(ok(Origin, origin), origin).toBe(false);
    }
  });

  it('the public API base ends in /api/v1/public/', () => {
    for (const base of ['https://api.example/api/v1/public/', 'http://127.0.0.1:8080/omw/api/v1/public/']) {
      expect(ok(PublicApiBase, base), base).toBe(true);
    }
    for (const base of [
      'https://api.example/api/v1/public',
      'https://api.example/api/v1/admin/',
      'https://api.example/api/v1/public/?x=1',
      '/api/v1/public/',
      'javascript:alert(1)//api/v1/public/',
    ]) {
      expect(ok(PublicApiBase, base), base).toBe(false);
    }
  });
});

describe('cookies, handoff and links', () => {
  it('cookie names and lifetimes match spec §2.3.1', () => {
    expect(GATE_COOKIE_NAMES.secure).toEqual({
      session: '__Host-omw',
      key: '__Host-omw_k',
      transfer: '__Host-omw_s',
      handoff: '__Host-omw_h',
      resume: '__Host-omw_r',
    });
    expect(GATE_COOKIE_NAMES.insecure).toEqual({
      session: 'omw',
      key: 'omw_k',
      transfer: 'omw_s',
      handoff: 'omw_h',
      resume: 'omw_r',
    });
    expect(GATE_COOKIE_MAX_AGE).toEqual({
      session: 34_560_000,
      key: 34_560_000,
      keyJs: 1_209_600,
      transfer: 120,
      handoff: 600,
      resume: 300,
    });
    expect(TRANSFER_COOKIE_MAX_AGE).toBe(120);
    expect(GATE_COOKIE_MAX_AGE.session).toBe(400 * 86_400);
  });

  it('gateCookies: __Host- names only for https + headers mode; Secure follows the scheme', () => {
    expect(gateCookies('https://site.example', 'headers')).toEqual({ ...GATE_COOKIE_NAMES.secure, secure: true });
    expect(gateCookies('https://site.example', 'co')).toEqual({ ...GATE_COOKIE_NAMES.insecure, secure: true });
    expect(gateCookies('https://site.example', 'parent')).toEqual({ ...GATE_COOKIE_NAMES.insecure, secure: true });
    expect(gateCookies('http://127.0.0.1:4173', 'headers')).toEqual({ ...GATE_COOKIE_NAMES.insecure, secure: false });
    expect(() => gateCookies('https://site.example/', 'headers')).toThrow(RangeError);
  });

  it('the handoff path is fixed and carries no secret', () => {
    expect(HANDOFF_PATH).toBe('/_/h/');
    expect(HANDOFF_FAILED_PATH).toBe('/_/join/#handoff-failed');
    expect(ok(HandoffPath, '/_/h/')).toBe(true);
    expect(ok(HandoffPath, '/')).toBe(true);
    for (const bad of [
      '/_/h',
      '/_/h/x',
      '/_/h/?s=1',
      '/_/h/#x',
      `/_/h/${fid}.${did}.${sid}.${k}`, // revision 1's 4-part handoff URL
      `/_/h/${GATE_SESSION_SAMPLE}`,
      '//_/h/',
      'https://site.example/_/h/',
    ]) {
      expect(ok(HandoffPath, bad), bad).toBe(false);
    }
  });

  it('an active answer carries session exactly with handoff "/_/h/"', () => {
    for (const schema of [JoinResponse, DevicePollResponse]) {
      expect(ok(schema, { status: 'active', handoff: '/_/h/', session: GATE_SESSION_SAMPLE })).toBe(true);
      expect(ok(schema, { status: 'active', handoff: '/' })).toBe(true);
      expect(ok(schema, { status: 'active', handoff: '/_/h/' })).toBe(false);
      expect(ok(schema, { status: 'active', handoff: '/', session: GATE_SESSION_SAMPLE })).toBe(false);
      expect(ok(schema, { status: 'active', handoff: '/_/h/x', session: GATE_SESSION_SAMPLE })).toBe(false);
      expect(ok(schema, { status: 'active', handoff: '/_/h/', session: `${GATE_SESSION_SAMPLE}.${k}` })).toBe(false);
      expect(ok(schema, { status: 'pending', pollAfterMs: 100 })).toBe(false);
      expect(ok(schema, { status: 'activating', pollAfterMs: 60_001 })).toBe(false);
    }
  });

  it('gateCookieValue and parseGateSession round-trip and refuse malformed parts', () => {
    const value = gateCookieValue(fid, did, sid);
    expect(value).toBe(GATE_SESSION_SAMPLE);
    expect(value).toHaveLength(65);
    expect(parseGateSession(value)).toEqual({ fid, did, sid });
    expect(parseGateSession(`${value}.${k}`)).toBeNull();
    expect(parseGateSession(`${fid}.${did}`)).toBeNull();
    expect(() => gateCookieValue(fid.toUpperCase(), did, sid)).toThrow(RangeError);
    expect(() => gateCookieValue(fid, `${did}x`, sid)).toThrow(RangeError);
    expect(() => gateCookieValue(fid, did, `${sid}.`)).toThrow(RangeError);
  });

  it('personal and panic links keep their secret in the fragment and round-trip', () => {
    const link = personalLinkUrl('https://site.example', t);
    expect(link).toBe(`https://site.example/_/join/#t=${t}`);
    const url = new URL(link);
    expect(url.pathname).toBe('/_/join/');
    expect(url.search).toBe('');
    expect(parseLinkFragment(url.hash)).toEqual({ t });
    const panic = panicLinkUrl('http://127.0.0.1:4173', k);
    expect(panic).toBe(`http://127.0.0.1:4173/_/panic/#k=${k}`);
    expect(parseLinkFragment(new URL(panic).hash)).toEqual({ k });
    expect(() => personalLinkUrl('https://site.example/', t)).toThrow(RangeError);
    expect(() => personalLinkUrl('https://site.example', `${t}x`)).toThrow(RangeError);
    expect(() => panicLinkUrl('ftp://site.example', k)).toThrow(RangeError);
  });

  it('parseLinkFragment reads modes, tokens and only safe return paths', () => {
    expect(parseLinkFragment('#resume')).toEqual({ mode: 'resume' });
    expect(parseLinkFragment('#reconfirm')).toEqual({ mode: 'reconfirm' });
    expect(parseLinkFragment('#view')).toEqual({ mode: 'view' });
    expect(parseLinkFragment('#handoff-failed')).toEqual({ mode: 'handoff-failed' });
    expect(parseLinkFragment('handoff-failed')).toEqual({ mode: 'handoff-failed' });
    expect(parseLinkFragment('#resume&handoff-failed')).toEqual({ mode: 'resume' });
    expect(parseLinkFragment(`#t=${t}&k=${k}`)).toEqual({ t, k });
    expect(parseLinkFragment(`#t=${t}&t=${k}`)).toEqual({ t });
    expect(parseLinkFragment(`#t=${t.slice(1)}`)).toEqual({});
    expect(parseLinkFragment('#unknown')).toEqual({});
    expect(parseLinkFragment('#')).toEqual({});
    expect(parseLinkFragment('')).toEqual({});
    expect(parseLinkFragment('#reconfirm&return=%2Fabcdefghij0123456789%2Fde%2F')).toEqual({
      mode: 'reconfirm',
      returnPath: '/abcdefghij0123456789/de/',
    });
    for (const unsafe of [
      '//evil.example/',
      '%2F%2Fevil.example%2F',
      'https%3A%2F%2Fevil.example%2F',
      '%2F%5Cevil.example',
      'javascript%3Aalert(1)',
      '%E0%A4%A',
      'relative%2Fpath',
    ]) {
      expect(parseLinkFragment(`#reconfirm&return=${unsafe}`), unsafe).toEqual({ mode: 'reconfirm' });
    }
  });
});

describe('store layout', () => {
  it('STORE_PATHS build the paths of spec §2.2, each of its own kind', () => {
    const built = {
      marker: STORE_PATHS.marker,
      locked: STORE_PATHS.locked,
      htaccess: STORE_PATHS.htaccess,
      session: STORE_PATHS.session(fid, did, sid),
      sessionDir: STORE_PATHS.sessionDir(fid),
      sessionPrefix: `${STORE_PATHS.sessionDir(fid)}/${STORE_PATHS.sessionPrefix(did)}`,
      handoff: STORE_PATHS.handoff(did),
      personTombstone: STORE_PATHS.personTombstone(fid),
      deviceTombstone: STORE_PATHS.deviceTombstone(fid, did),
    } as const;
    expect(built).toEqual({
      marker: '.omw-store.json',
      locked: 'locked',
      htaccess: '.htaccess',
      session: `s/${fid}/${did}.${sid}`,
      sessionDir: `s/${fid}`,
      sessionPrefix: `s/${fid}/${did}.`,
      handoff: `h/${did}`,
      personTombstone: `t/${fid}`,
      deviceTombstone: `t/${fid}.${did}`,
    });
    for (const [kind, path] of Object.entries(built)) expect(storePathKind(path), path).toBe(kind);
  });

  it('refuses traversal, absolute paths, dot segments, upper case and control characters', () => {
    for (const path of [
      '',
      '/locked',
      '../locked',
      'locked/',
      `s/../t/${fid}`,
      's/.hidden',
      's/..',
      `s//${fid}`,
      `S/${fid}`,
      `s/${fid}/${did}.${sid}\n`,
      `s/${fid}/${did}/x`,
      `t/${fid}.${did}.x`,
      `x/${fid}`,
      '.omw-store.json.tmp',
      `s/${'a'.repeat(250)}`,
    ]) {
      expect(storePathKind(path), JSON.stringify(path)).toBeNull();
    }
    expect(storePathKind('s/tmp.1')).toBe('stray');
    expect(storePathKind(`s/${fid}/garbage`)).toBe('stray');
  });

  it('ops may only name the paths of their kind (puts are exclusive except the marker)', () => {
    const session = STORE_PATHS.session(fid, did, sid);
    const table: [StoreOpKind, string, boolean, boolean][] = [
      ['init', '.omw-store.json', true, true],
      ['init', 'locked', true, false],
      ['put', '.omw-store.json', false, true],
      ['put', '.omw-store.json', true, false],
      ['put', session, true, true],
      ['put', session, false, false],
      ['put', `h/${did}`, true, true],
      ['put', 'locked', true, true],
      ['put', `t/${fid}`, true, true],
      ['put', `t/${fid}.${did}`, true, true],
      ['put', `s/${fid}`, true, false],
      ['put', 's/tmp.1', true, false],
      ['put', '.htaccess', true, false],
      ['delete', session, true, true],
      ['delete', `h/${did}`, true, true],
      ['delete', 'locked', true, true],
      ['delete', 's/tmp.1', true, true],
      ['delete', `t/${fid}`, true, false],
      ['delete', '.omw-store.json', true, false],
      ['delete_prefix', `s/${fid}/${did}.`, true, true],
      ['delete_prefix', `s/${fid}/`, true, false],
      ['delete_prefix', `s/${fid}`, true, false],
      ['delete_tree', `s/${fid}`, true, true],
      ['delete_tree', 's', true, false],
      ['delete_tree', 't', true, false],
      ['delete_tree', `t/${fid}`, true, false],
    ];
    for (const [op, path, exclusive, valid] of table) {
      expect(isValidStoreOpPath(op, path, exclusive), `${op} ${path} ${exclusive}`).toBe(valid);
    }
    // Tombstones and the marker are never deleted by any op.
    for (const kinds of [
      STORE_OP_PATH_KINDS.delete,
      STORE_OP_PATH_KINDS.delete_prefix,
      STORE_OP_PATH_KINDS.delete_tree,
    ]) {
      for (const never of ['marker', 'personTombstone', 'deviceTombstone'] as const) expect(kinds).not.toContain(never);
    }
    expect(ok(StoreOp, { id: 1, op: 'put', path: session, content: null, exclusive: true })).toBe(true);
    expect(ok(StoreOp, { id: 0, op: 'put', path: session, content: null, exclusive: true })).toBe(false);
    expect(ok(StoreOp, { id: 1, op: 'rename', path: session, content: null, exclusive: true })).toBe(false);
  });

  it('a listing carries only well-formed session, handoff and tombstone paths', () => {
    const listing = { marker: null, locked: null, sessions: [], handoffs: [], tombstones: [], strays: [] };
    expect(ok(StoreListing, listing)).toBe(true);
    expect(ok(StoreListing, { ...listing, sessions: [STORE_PATHS.session(fid, did, sid)] })).toBe(true);
    expect(ok(StoreListing, { ...listing, sessions: [`s/${fid}/${did}.short`] })).toBe(false);
    expect(ok(StoreListing, { ...listing, handoffs: [`h/${did}`] })).toBe(false);
    expect(ok(StoreListing, { ...listing, tombstones: [{ path: `t/${fid}/x`, content: '{}' }] })).toBe(false);
    expect(STORE_PATH_PATTERNS.session.test(STORE_PATHS.session(fid, did, sid))).toBe(true);
  });

  it('ACCESS_STORE_DIR: absolute, [A-Za-z0-9._/-], no "..", no "//", no trailing slash', () => {
    for (const dir of ['/usr/home/omw/omw-store/site1', '/var/www/html/.omw-store', '/a', '/a.b/c_d-e', '/...']) {
      expect(isSafeStoreDir(dir), dir).toBe(true);
      expect(STORE_DIR_RE.test(dir), dir).toBe(true);
    }
    for (const dir of [
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
      '/ä',
      '/a\\b',
    ]) {
      expect(isSafeStoreDir(dir), dir).toBe(false);
    }
    // The schema's regex alone already refuses the characters RewriteCond would interpret.
    for (const dir of ['/a%b', '/a$b', '/a b']) {
      expect(ok(SiteAccessConfigSchema.shape.storeDir, dir), dir).toBe(false);
    }
  });
});

describe('siteAccessProblems (Q9 cross-field rules)', () => {
  const gate = (overrides: Partial<SiteAccessConfig> = {}): SiteAccessConfig => ({
    mode: 'gate',
    siteOrigin: 'https://site.example.org',
    contentPath: '/abcdefghij0123456789/',
    apiPublicBase: 'https://api.example.org/api/v1/public/',
    cookieMode: 'headers',
    storeDir: '/usr/home/omw/omw-store/site1',
    httpsRedirect: true,
    ...overrides,
  });

  it('accepts consistent configurations', () => {
    expect(SiteAccessConfigSchema.parse(gate())).toEqual(gate());
    const consistent: SiteAccessConfig[] = [
      gate(),
      gate({ httpsRedirect: false }),
      gate({ cookieMode: 'co', cookieDomain: 'site.example.org' }),
      gate({ cookieMode: 'parent', cookieDomain: 'example.org' }),
      gate({
        siteOrigin: 'http://127.0.0.1:4173',
        apiPublicBase: 'http://127.0.0.1:8080/api/v1/public/',
        httpsRedirect: false,
      }),
      gate({
        siteOrigin: 'http://localhost:4173',
        apiPublicBase: 'http://localhost:8080/api/v1/public/',
        httpsRedirect: false,
      }),
      {
        mode: 'open',
        siteOrigin: 'https://site.example.org',
        contentPath: '/',
        apiPublicBase: 'https://api.example.org/api/v1/public/',
        cookieMode: 'headers',
        httpsRedirect: false,
      },
      {
        mode: 'open',
        siteOrigin: 'http://site.example.org',
        contentPath: '/travel/',
        apiPublicBase: 'http://api.example.org/api/v1/public/',
        cookieMode: 'headers',
        httpsRedirect: false,
      },
    ];
    for (const cfg of consistent) expect(siteAccessProblems(cfg), JSON.stringify(cfg)).toEqual([]);
  });

  it('reports every inconsistency', () => {
    const { storeDir: _s, ...withoutStore } = gate();
    const table: [string, SiteAccessConfig, RegExp][] = [
      ['gate without storeDir', withoutStore, /storeDir/],
      ['storeDir with ".."', gate({ storeDir: '/a/../b' }), /storeDir/],
      ['storeDir with "//"', gate({ storeDir: '/a//b' }), /storeDir/],
      ['contentPath "/"', gate({ contentPath: '/' }), /contentPath/],
      ['contentPath with 19 chars', gate({ contentPath: '/abcdefghij012345678/' }), /contentPath/],
      ['contentPath with two segments', gate({ contentPath: '/abcdefghij/0123456789/' }), /contentPath/],
      ['contentPath upper case', gate({ contentPath: '/ABCDEFGHIJ0123456789/' }), /contentPath/],
      ['http site in gate mode', gate({ siteOrigin: 'http://site.example.org', httpsRedirect: false }), /siteOrigin/],
      ['http API in gate mode', gate({ apiPublicBase: 'http://api.example.org/api/v1/public/' }), /apiPublicBase/],
      ['http 10.0.0.1 is not loopback', gate({ siteOrigin: 'http://10.0.0.1', httpsRedirect: false }), /siteOrigin/],
      ['httpsRedirect on http', { ...gate(), mode: 'open', siteOrigin: 'http://127.0.0.1:4173' }, /httpsRedirect/],
      ['headers with a cookieDomain', gate({ cookieDomain: 'site.example.org' }), /cookieDomain/],
      ['co without cookieDomain', gate({ cookieMode: 'co' }), /"co"/],
      ['co with the parent domain', gate({ cookieMode: 'co', cookieDomain: 'example.org' }), /"co"/],
      ['parent without cookieDomain', gate({ cookieMode: 'parent' }), /"parent"/],
      ['parent with one label', gate({ cookieMode: 'parent', cookieDomain: 'org' }), /"parent"/],
      ['parent with an empty label', gate({ cookieMode: 'parent', cookieDomain: '.example.org' }), /"parent"/],
      [
        'parent not shared by the API host',
        gate({
          cookieMode: 'parent',
          cookieDomain: 'example.org',
          apiPublicBase: 'https://api.other.net/api/v1/public/',
        }),
        /"parent"/,
      ],
      ['parent that only looks like a suffix', gate({ cookieMode: 'parent', cookieDomain: 'ple.org' }), /"parent"/],
      [
        'parent on an IP address',
        gate({
          cookieMode: 'parent',
          cookieDomain: '0.0.1',
          siteOrigin: 'http://127.0.0.1',
          apiPublicBase: 'http://127.0.0.1/api/v1/public/',
          httpsRedirect: false,
        }),
        /"parent"/,
      ],
      [
        'API base with credentials',
        gate({ apiPublicBase: 'https://u:p@api.example.org/api/v1/public/' }),
        /credentials/,
      ],
      ['siteOrigin with a path', gate({ siteOrigin: 'https://site.example.org/x' }), /siteOrigin/],
    ];
    for (const [label, cfg, expected] of table) {
      const problems = siteAccessProblems(cfg);
      expect(problems.length, label).toBeGreaterThan(0);
      expect(
        problems.some((p) => expected.test(p)),
        `${label}: ${problems.join('; ')}`,
      ).toBe(true);
    }
  });

  it('loopback means localhost and 127.0.0.0/8 only', () => {
    for (const host of ['localhost', '127.0.0.1', '127.255.0.9']) expect(isLoopbackHost(host), host).toBe(true);
    for (const host of ['localhost.example', '127.0.0.256', '128.0.0.1', '10.0.0.1', '::1', '[::1]']) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe('gate boot (GateBoot) and the SPA copy (Boot.access)', () => {
  const boot = {
    page: 'join',
    api: 'https://api.example.org/api/v1/public/',
    locales: ['de', 'en'],
    defaultLocale: 'de',
    cookies: { ...GATE_COOKIE_NAMES.secure, secure: true },
    cookieMode: 'headers',
    cookieDomain: null,
    build: 'a1b2c3d4',
  };

  it('accepts the generator boot and refuses unsafe values', () => {
    expect(GateBoot.parse(boot)).toEqual(boot);
    expect(ok(GateBoot, { ...boot, page: 'h' })).toBe(false);
    expect(ok(GateBoot, { ...boot, locales: [] })).toBe(false);
    expect(ok(GateBoot, { ...boot, cookieDomain: 'Site.Example' })).toBe(false);
    expect(ok(GateBoot, { ...boot, cookies: { ...boot.cookies, key: 'omw_k; Domain=evil' } })).toBe(false);
    expect(ok(GateBoot, { ...boot, api: 'https://api.example.org/' })).toBe(false);
  });

  it('Boot.access (defined inline in site.ts) uses the same patterns and values as access.ts', () => {
    const shape = BootAccess.shape;
    const pattern = (schema: z.ZodType): unknown => z.toJSONSchema(schema).pattern;
    expect(pattern(shape.api)).toBe(PUBLIC_API_BASE_RE.source);
    expect(pattern(shape.api)).toBe(pattern(PublicApiBase));
    expect(pattern(shape.cookies.shape.key)).toBe(pattern(GateBoot.shape.cookies.shape.key));
    expect(pattern(shape.cookies.shape.transfer)).toBe(pattern(GateBoot.shape.cookies.shape.transfer));
    expect(pattern(shape.cookies.shape.handoff)).toBe(pattern(GateBoot.shape.cookies.shape.handoff));
    expect(shape.cookieMode.options).toEqual(CookieMode.options);
    expect(pattern(shape.cookieDomain.unwrap())).toBe(pattern(GateBoot.shape.cookieDomain.unwrap()));
    const access = {
      api: boot.api,
      cookies: { key: '__Host-omw_k', transfer: '__Host-omw_s', handoff: '__Host-omw_h' },
      cookieMode: 'co',
      cookieDomain: 'site.example.org',
    };
    expect(BootAccess.parse(access)).toEqual(access);
    expect(ok(BootAccess, { ...access, cookieMode: 'none' })).toBe(false);
    expect(ok(BootAccess, { ...access, api: 'https://api.example.org/api/v1/admin/' })).toBe(false);
    expect(ORIGIN_RE.test('https://site.example.org')).toBe(true);
  });
});

describe('privacy notice (D11, Q7)', () => {
  it('needs at least one locale and every section in each locale', () => {
    expect(ok(PrivacyNotice, privacyNotice())).toBe(true);
    expect(ok(PrivacyNotice, { ...privacyNotice(), texts: {} })).toBe(false);
    expect(ok(PrivacyNotice, { ...privacyNotice(), texts: { fr: privacyNotice().texts.de } })).toBe(false);
    const de = privacyNotice().texts.de;
    for (const key of NOTICE_TEXT_KEYS) {
      expect(ok(PrivacyNotice, { ...privacyNotice(), texts: { de: { ...de, [key]: '' } } }), key).toBe(false);
      const { [key]: _drop, ...without } = de ?? {};
      expect(ok(PrivacyNotice, { ...privacyNotice(), texts: { de: without } }), key).toBe(false);
    }
    expect(Object.keys(NoticeTexts.shape)).toEqual([...NOTICE_TEXT_KEYS]);
    expect(ok(PrivacyNotice, { ...privacyNotice(), texts: { de: { ...de, intro: 'x'.repeat(4001) } } })).toBe(false);
  });

  it('needs a controller name and a valid e-mail address', () => {
    const notice = privacyNotice();
    expect(ok(PrivacyNotice, { ...notice, controller: { name: '', email: 'lea@example.org' } })).toBe(false);
    expect(ok(PrivacyNotice, { ...notice, controller: { name: 'Lea', email: 'lea@' } })).toBe(false);
    expect(ok(PrivacyNotice, { ...notice, controller: { name: 'Lea', email: 'lea@example.org' } })).toBe(true);
  });

  it('a draft may be empty or partial, but not oversized', () => {
    expect(ok(PrivacyNoticeDraft, { controller: { name: '', email: '' }, texts: {} })).toBe(true);
    expect(ok(PrivacyNoticeDraft, { controller: { name: '', email: '' }, texts: { de: { rights: '' } } })).toBe(true);
    expect(ok(PrivacyNoticeDraft, { controller: { name: 'x'.repeat(121), email: '' }, texts: {} })).toBe(false);
    expect(ok(PrivacyNoticeDraft, { controller: { name: '', email: '' }, texts: { fr: {} } })).toBe(false);
  });
});

describe('public and admin bodies', () => {
  it('JoinRequest: a new device (t + consentVersion) or a resume (resume + k), nothing else', () => {
    const valid = [
      { t, consentVersion: 1, locale: 'de' },
      { t, k, consentVersion: 3, locale: 'ar' },
      { resume: true, k, locale: 'en' },
    ];
    for (const body of valid) expect(ok(JoinRequest, body), JSON.stringify(body)).toBe(true);
    const invalid = [
      { locale: 'de' },
      { t, locale: 'de' },
      { consentVersion: 1, locale: 'de' },
      { k, consentVersion: 1, locale: 'de' },
      { t, consentVersion: 0, locale: 'de' },
      { t, consentVersion: 1 },
      { t, consentVersion: 1, locale: 'fr' },
      { resume: true, locale: 'de' },
      { resume: true, k, t, locale: 'de' },
      { resume: true, k, consentVersion: 1, locale: 'de' },
      { resume: false, k, locale: 'de' },
      { t: `${t}x`, consentVersion: 1, locale: 'de' },
    ];
    for (const body of invalid) expect(ok(JoinRequest, body), JSON.stringify(body)).toBe(false);
  });

  it('LockRequest: unlocking needs the password', () => {
    expect(ok(LockRequest, { locked: true })).toBe(true);
    expect(ok(LockRequest, { locked: false, password: 'pw' })).toBe(true);
    expect(ok(LockRequest, { locked: false })).toBe(false);
    expect(ok(LockRequest, { locked: false, password: '' })).toBe(false);
    expect(ok(LockRequest, { locked: 'false', password: 'pw' })).toBe(false);
  });

  it('delete-me needs the literal confirmation', () => {
    expect(ok(MeDeleteRequest, { k, confirm: 'delete-all-my-data' })).toBe(true);
    for (const confirm of [true, 'yes', 'DELETE-ALL-MY-DATA', '']) {
      expect(ok(MeDeleteRequest, { k, confirm }), String(confirm)).toBe(false);
    }
  });

  it('a tombstone carries no name and no invitation date (D12)', () => {
    const list = FollowerListResponse.parse({
      items: [],
      tombstones: [
        {
          id: 'zzzzzzzzzzzz',
          state: 'deleted',
          deletedAt: '2026-11-19T12:00:00.000Z',
          deletedBy: 'owner',
          name: 'Oma',
          createdAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    });
    expect(list.tombstones[0]).toEqual({
      id: 'zzzzzzzzzzzz',
      state: 'deleted',
      deletedAt: '2026-11-19T12:00:00.000Z',
      deletedBy: 'owner',
    });
    expect(ok(AdminFollower, { ...adminFollower(), state: 'deleted' })).toBe(false);
  });

  it('the persisted status summary has no names; the live access status has at most 3 cards', () => {
    expect(Object.keys(AccessSummary.shape).some((key) => /name/i.test(key))).toBe(false);
    expect(StatusResponse.shape.access.unwrap()).toBe(AccessSummary);
    const status = accessStatus();
    const card = status.pending[0];
    expect(ok(AccessStatus, { ...status, pending: [card, card, card] })).toBe(true);
    expect(ok(AccessStatus, { ...status, pending: [card, card, card, card] })).toBe(false);
    // StatusResponse.access strips the cards (names) if an API ever sent the full AccessStatus.
    const parsed = AccessSummary.parse(status);
    expect(parsed).not.toHaveProperty('pending');
    expect(parsed).not.toHaveProperty('siteOrigin');
  });

  it('the service session names a safe cookie', () => {
    const session = {
      cookieName: '__Host-omw',
      cookieValue: GATE_SESSION_SAMPLE,
      expiresAt: '2026-11-21T10:00:00.000Z',
    };
    expect(ok(ServiceSession, session)).toBe(true);
    expect(ok(ServiceSession, { ...session, cookieName: '' })).toBe(false);
    expect(ok(ServiceSession, { ...session, cookieName: 'omw; Path=/' })).toBe(false);
    expect(ok(ServiceSession, { ...session, cookieValue: `${GATE_SESSION_SAMPLE}.${k}` })).toBe(false);
  });
});
