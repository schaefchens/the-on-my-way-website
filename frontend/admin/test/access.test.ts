/**
 * Wave 5 admin (spec-wave5 §7, §8.6): the immediate access client (routes, outcomes, effect
 * rendering), nothing about people persisted (incl. the Home pending cards of AccessStatus and
 * in-flight access mutations), the departure-hold computation, the password strength hint and
 * the small pure helpers of the People / Safety / Privacy screens.
 */
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import {
  type AccessActionResult,
  AccessStatus,
  type AdminFollower,
  FOLLOWER_ID_RE,
  PrivacyNoticeDraft,
  PublicNotice,
  type StoreReport,
} from '@omw/contracts/access';
import { PASSWORD_MIN_LENGTH, SETTINGS_DEFAULTS, type Settings, StatusResponse } from '@omw/contracts/api';
import { dehydrate, MutationObserver, QueryClient } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  accessApi,
  accessErrorCopy,
  applyActionResult,
  effectStore,
  exportFileName,
  noteAccessSummary,
  outcomeOf,
  recordEffect,
  settleEffect,
} from '../src/api/access';
import { ApiRequestError, setCsrfToken } from '../src/api/client';
import { ak, isOwnerWriteKey, mk, qk } from '../src/api/keys';
import { dehydrateOptions } from '../src/api/persist';
import { accessStatusQuery, followerQuery, followersQuery, noticesQuery, privacyQuery } from '../src/api/queries';
import { EffectLine } from '../src/components/effect-badge';
import { personalLinkMessage } from '../src/components/link-sheet';
import { activateLocale } from '../src/i18n';
import { heldPlaces, holdEndFor } from '../src/lib/held-days';
import { PASSWORD_MIN, passwordCore, passwordStrength } from '../src/lib/password-strength';
import {
  deviceChip,
  deviceKind,
  FID_RE,
  formatDaysAgo,
  isFollowerId,
  restoreSummary,
  sortDevices,
} from '../src/lib/people';
import {
  draftFromForm,
  draftMatchesCurrent,
  formFromDraft,
  noticeLocales,
  noticeParagraphs,
  problemLabel,
} from '../src/screens/privacy';
import { accessProvenAt, normalizeSlotTimes } from '../src/screens/safety';

const NOW = Date.parse('2026-11-20T10:00:00.000Z');

function follower(overrides: Partial<AdminFollower> = {}): AdminFollower {
  return {
    id: 'omaomaomaoma',
    name: 'Oma',
    note: null,
    state: 'active',
    createdAt: '2026-11-11T10:00:00.000Z',
    revokedAt: null,
    link: { createdAt: '2026-11-11T10:00:00.000Z' },
    devices: [
      {
        id: 'ipadoma2',
        state: 'active',
        label: 'iPad · Safari',
        first: true,
        createdAt: '2026-11-11T10:00:00.000Z',
        decidedAt: null,
        revokedAt: null,
        revokedBy: null,
        lastSeenAt: '2026-11-20T08:00:00.000Z',
        sessionAt: '2026-11-11T10:00:00.000Z',
      },
    ],
    consent: { version: 1, confirmedAt: '2026-11-11T10:00:00.000Z' },
    lastSeenAt: '2026-11-20T08:00:00.000Z',
    ...overrides,
  };
}

function accessStatus(overrides: Partial<AccessStatus> = {}): AccessStatus {
  return AccessStatus.parse({
    locked: false,
    lockedAt: null,
    lockedBy: null,
    pendingDevices: 1,
    pendingOps: 0,
    oldestPendingOpAt: null,
    writer: { mode: 'direct', blocked: false, error: null },
    restoring: false,
    mismatch: false,
    unreadNotices: 0,
    noticeVersion: 1,
    panicLink: false,
    siteOrigin: 'https://site.example.org',
    cookieMode: 'headers',
    lastReconcile: null,
    lastAppliedAt: null,
    storeId: 'a1b2c3d4e5f60718',
    storeProofAt: null,
    gateCheck: null,
    pending: [
      {
        did: 'phonenew',
        fid: 'omaomaomaoma',
        name: 'Oma',
        label: 'iPhone · Safari',
        createdAt: '2026-11-20T09:55:00.000Z',
      },
    ],
    ...overrides,
  });
}

const settings: Settings = { ...SETTINGS_DEFAULTS, 'timezone.current': 'Asia/Ho_Chi_Minh' };

beforeAll(async () => {
  await activateLocale('de');
});

beforeEach(() => {
  effectStore.set(null);
});

describe('access client routes (spec §3.5, §3.12)', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
    setCsrfToken(null);
  });

  it('calls exactly the admin routes, with CSRF and the bodies of the contracts', async () => {
    setCsrfToken('csrf1');
    const calls: Array<{ url: string; method: string; body: unknown; csrf: string | undefined }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        csrf: headers['X-CSRF-Token'],
      });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await accessApi.status();
    await accessApi.followers();
    await accessApi.follower('omaomaomaoma');
    await accessApi.createFollower({ name: 'Oma', note: 'x' });
    await accessApi.patchFollower('omaomaomaoma', { note: null });
    await accessApi.rotateLink('omaomaomaoma');
    await accessApi.revokeFollower('omaomaomaoma');
    await accessApi.exportFollower('omaomaomaoma');
    await accessApi.deleteFollower('omaomaomaoma');
    await accessApi.approveDevice('phonenew');
    await accessApi.declineDevice('phonenew');
    await accessApi.revokeDevice('phonenew');
    await accessApi.lock({ locked: true });
    await accessApi.lock({ locked: false, password: 'pw' });
    await accessApi.retry();
    await accessApi.storeInit();
    await accessApi.createPanicLink();
    await accessApi.deletePanicLink();
    await accessApi.privacy();
    await accessApi.savePrivacyDraft({ controller: { name: '', email: '' }, texts: {} });
    await accessApi.publishPrivacy('a'.repeat(64));
    await accessApi.notices();
    await accessApi.readNotices([3]);
    await accessApi.changePassword({ currentPassword: 'old', newPassword: 'n'.repeat(12), revokeAppTokens: true });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/v1/admin/access',
      'GET /api/v1/admin/followers',
      'GET /api/v1/admin/followers/omaomaomaoma',
      'POST /api/v1/admin/followers',
      'PATCH /api/v1/admin/followers/omaomaomaoma',
      'POST /api/v1/admin/followers/omaomaomaoma/link',
      'POST /api/v1/admin/followers/omaomaomaoma/revoke',
      'GET /api/v1/admin/followers/omaomaomaoma/export',
      'POST /api/v1/admin/followers/omaomaomaoma/delete',
      'POST /api/v1/admin/devices/phonenew/approve',
      'POST /api/v1/admin/devices/phonenew/decline',
      'POST /api/v1/admin/devices/phonenew/revoke',
      'POST /api/v1/admin/access/lock',
      'POST /api/v1/admin/access/lock',
      'POST /api/v1/admin/access/retry',
      'POST /api/v1/admin/access/store-init',
      'POST /api/v1/admin/access/panic-link',
      'DELETE /api/v1/admin/access/panic-link',
      'GET /api/v1/admin/privacy',
      'PUT /api/v1/admin/privacy/draft',
      'POST /api/v1/admin/privacy/publish',
      'GET /api/v1/admin/notices',
      'POST /api/v1/admin/notices/read',
      'PUT /api/v1/admin/me/password',
    ]);
    const byPath = (m: string, u: string) => calls.find((c) => c.method === m && c.url.endsWith(u));
    expect(byPath('POST', '/delete')?.body).toEqual({ confirm: true });
    expect(byPath('POST', '/revoke')?.body).toEqual({});
    expect(byPath('POST', '/publish')?.body).toEqual({ ifDraftSha256: 'a'.repeat(64) });
    expect(byPath('POST', '/notices/read')?.body).toEqual({ ids: [3] });
    expect(byPath('PATCH', '/followers/omaomaomaoma')?.body).toEqual({ note: null });
    expect(calls.filter((c) => c.method !== 'GET').every((c) => c.csrf === 'csrf1')).toBe(true);
    expect(calls.filter((c) => c.method === 'GET').every((c) => c.csrf === undefined)).toBe(true);
  });
});

describe('outcomes and the effect badge (spec §7.2)', () => {
  const effect = (applied: boolean, pendingOps = 0): Pick<AccessActionResult, 'effect'> => ({
    effect: { applied, via: applied ? 'direct' : 'pending', pendingOps },
  });

  it('maps results and errors: applied, not applied, not sent, login, other errors', () => {
    expect(outcomeOf(effect(true))).toEqual({ kind: 'applied', via: 'direct' });
    expect(outcomeOf(effect(false, 2))).toEqual({ kind: 'not_applied', via: 'pending', pendingOps: 2 });
    expect(outcomeOf(null, new ApiRequestError(0, 'network', 'offline'))).toEqual({ kind: 'unsent' });
    expect(outcomeOf(null, new ApiRequestError(401, 'unauthorized', 'x'))).toEqual({ kind: 'login' });
    expect(outcomeOf(null, new ApiRequestError(409, 'device_limit', 'x')).kind).toBe('error');
  });

  it('never records a success for a network failure, and nothing for 401', () => {
    expect(recordEffect({ id: 'x', message: 'Done' }, { kind: 'login' })).toBeNull();
    expect(effectStore.get()).toBeNull();
    const entry = recordEffect({ id: 'x', message: 'Done' }, outcomeOf(null, new ApiRequestError(0, 'network', 'x')));
    expect(entry?.outcome.kind).toBe('unsent');
    expect(effectStore.get()?.outcome.kind).toBe('unsent');
  });

  it('settles "not in effect yet" only with a status fetched later that has no pending op', () => {
    const entry = recordEffect({ id: 'x', message: 'Done' }, outcomeOf(effect(false, 1)), undefined, 1000);
    if (!entry) throw new Error('no entry');
    const writer = { mode: 'none' as const, blocked: false, error: null };
    expect(settleEffect(entry, { pendingOps: 1, writer }, 2000)).toBe(entry);
    expect(settleEffect(entry, { pendingOps: 0, writer }, 900)).toBe(entry); // fetched before the action
    expect(settleEffect(entry, { pendingOps: 0, writer }, 2000).outcome).toEqual({ kind: 'applied', via: 'mac' });
  });

  it('renders the three states in German', () => {
    const html = (outcome: Parameters<typeof EffectLine>[0]['outcome'], writerMode?: 'direct' | 'none') =>
      renderToString(
        createElement(I18nProvider, { i18n }, createElement(EffectLine, { outcome, writerMode, onRetry: () => {} })),
      );
    expect(html({ kind: 'applied', via: 'direct' })).toContain('Wirksam ✓');
    const pending = html({ kind: 'not_applied', via: 'pending', pendingOps: 1 }, 'direct');
    expect(pending).toContain('Noch nicht wirksam ⏳ – der Website-Speicher ist gerade nicht erreichbar');
    expect(pending).toContain('Erneut versuchen');
    expect(html({ kind: 'not_applied', via: 'pending', pendingOps: 1 }, 'none')).toContain(
      'dein Computer zu Hause überträgt es',
    );
    const unsent = html({ kind: 'unsent' });
    expect(unsent).toContain('Nicht gesendet – keine Verbindung');
    expect(unsent).not.toContain('Wirksam');
  });

  it('explains the access error codes in the owner’s words', () => {
    const de = (code: string, status = 409) => {
      const m = accessErrorCopy(new ApiRequestError(status, code, 'x'));
      return m ? i18n._(m) : null;
    };
    expect(de('wrong_password', 403)).toBe('Das aktuelle Passwort stimmt nicht.');
    expect(de('forbidden', 403)).toBe('Das Passwort stimmt nicht.');
    expect(de('config_missing')).toContain('SITE_ORIGIN');
    expect(de('rate_limited', 429)).toContain('Zu viele Versuche');
    expect(de('validation_failed', 422)).toBeNull();
    const restore = accessErrorCopy(new ApiRequestError(409, 'conflict', 'Restore: checking access… Try again later.'));
    expect(restore ? i18n._(restore) : null).toContain('Wiederherstellung');
  });
});

describe('nothing about people is persisted (spec §7.2, §7.5)', () => {
  it('drops every access query and every non-queue mutation from the IndexedDB copy', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const status = accessStatus();
    await qc.fetchQuery({ ...accessStatusQuery(), queryFn: async () => status });
    await qc.fetchQuery({ ...followersQuery(), queryFn: async () => ({ items: [follower()], tombstones: [] }) });
    await qc.fetchQuery({ ...followerQuery('omaomaomaoma'), queryFn: async () => follower() });
    await qc.fetchQuery({ ...noticesQuery(), queryFn: async () => ({ items: [] }) });
    await qc.fetchQuery({
      ...privacyQuery(),
      queryFn: async () => ({
        draft: { controller: { name: 'Lena', email: 'lena@example.org' }, texts: {} },
        draftSha256: 'a'.repeat(64),
        current: null,
        versions: [],
        problems: [],
      }),
    });
    // The persisted status query carries counts only.
    qc.setQueryData(qk.status, StatusResponse.parse({ backend: null, lastSeenAt: null, publish: [], alerts: [] }));
    noteAccessSummary(qc, status);
    // An access action and the password change in flight, plus a queued owner write.
    const never = () => new Promise<never>(() => {});
    void new MutationObserver(qc, { mutationKey: ak.action, mutationFn: never }).mutate({ name: 'Oma' } as never);
    void new MutationObserver(qc, { mutationKey: ak.password, mutationFn: never }).mutate({
      currentPassword: 'secret-current',
    } as never);
    void new MutationObserver(qc, { mutationKey: mk.patchSettings, mutationFn: never }).mutate({
      patch: { 'site.title': 'x' },
    } as never);
    await Promise.resolve();

    const state = dehydrate(qc, dehydrateOptions);
    const keys = state.queries.map((q) => q.queryKey);
    expect(keys).toEqual([qk.status]);
    expect(state.mutations.map((m) => m.mutationKey)).toEqual([mk.patchSettings]);
    const json = JSON.stringify(state);
    expect(json).not.toContain('Oma');
    expect(json).not.toContain('iPhone');
    expect(json).not.toContain('secret-current');
    expect(json).not.toContain('"pending":[');
    expect(qc.getQueryData<{ access?: { pendingDevices: number } }>(qk.status)?.access?.pendingDevices).toBe(1);
    expect(isOwnerWriteKey(ak.action)).toBe(false);
    expect(isOwnerWriteKey(mk.annotate)).toBe(true);
  });

  it('puts an action result into the caches (follower and device) without touching the status names', () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.access.followers, { items: [follower()], tombstones: [] });
    qc.setQueryData(qk.access.follower('omaomaomaoma'), follower());
    qc.setQueryData(qk.status, StatusResponse.parse({ backend: null, lastSeenAt: null, publish: [], alerts: [] }));
    const base = follower().devices[0];
    if (!base) throw new Error('seed');
    const device = { ...base, state: 'revoked' as const, revokedBy: 'owner' as const };
    applyActionResult(qc, { device, status: accessStatus({ pendingDevices: 0 }) });
    expect(qc.getQueryData<AdminFollower>(qk.access.follower('omaomaomaoma'))?.devices[0]?.state).toBe('revoked');
    const status = qc.getQueryData<StatusResponse>(qk.status);
    expect(status?.access?.pendingDevices).toBe(0);
    expect(JSON.stringify(status)).not.toContain('Oma');
  });
});

describe('departure hold on Home (held days)', () => {
  const hold = (over: Partial<Settings> = {}): Settings => ({
    ...settings,
    'publish.departure_hold': { enabled: true, maxDays: 7 },
    ...over,
  });
  const day = (localDate: string, place: string | null, firstAt: string, lastAt = firstAt, pub = 1) => ({
    localDate,
    day: place === null ? null : { placeName: place },
    counts: { public: pub },
    firstAt,
    lastAt,
  });

  it('is empty while the hold is off', () => {
    expect(heldPlaces([day('2026-11-19', 'Huế', '2026-11-19T02:00:00.000Z')], settings, NOW)).toEqual([]);
  });

  it('holds the current place until she moves on; an earlier place is released by the later day', () => {
    const days = [
      day('2026-11-16', 'Hội An', '2026-11-16T01:00:00.000Z', '2026-11-16T12:00:00.000Z'),
      day('2026-11-17', 'Hội An ', '2026-11-17T01:00:00.000Z', '2026-11-17T12:00:00.000Z'),
      day('2026-11-18', 'Huế', '2026-11-18T03:00:00.000Z', '2026-11-18T09:00:00.000Z'),
      day('2026-11-19', 'huế', '2026-11-19T02:00:00.000Z', '2026-11-19T11:00:00.000Z'),
      day('2026-11-20', 'Huế', '2026-11-20T01:00:00.000Z', '2026-11-20T02:00:00.000Z', 0), // nothing public
    ];
    const held = heldPlaces(days, hold(), NOW);
    expect(held).toEqual([
      {
        place: 'huế',
        days: 2,
        dates: ['2026-11-18', '2026-11-19'],
        until: '2026-11-26T11:00:00.000Z', // the cap (7 days) of the latest item
      },
    ]);
  });

  it('lets "moved on" release everything up to that moment and honours a shorter cap', () => {
    const days = [day('2026-11-19', 'Huế', '2026-11-19T02:00:00.000Z', '2026-11-19T11:00:00.000Z')];
    expect(heldPlaces(days, hold({ 'publish.moved_on_at': '2026-11-20T09:00:00.000Z' }), NOW)).toEqual([]);
    const early = [day('2026-11-19', 'Huế', '2026-11-19T02:00:00.000Z', '2026-11-19T05:00:00.000Z')];
    expect(heldPlaces(early, hold({ 'publish.departure_hold': { enabled: true, maxDays: 1 } }), NOW)).toEqual([]);
    const held = heldPlaces(days, hold({ 'publish.departure_hold': { enabled: true, maxDays: 2 } }), NOW);
    expect(held[0]?.until).toBe('2026-11-21T11:00:00.000Z');
  });

  it('groups dates without a place, and gives the hold end of one photo for the portrait hint', () => {
    const days = [
      day('2026-11-19', null, '2026-11-19T02:00:00.000Z'),
      day('2026-11-20', 'Huế', '2026-11-20T01:00:00.000Z'),
    ];
    const held = heldPlaces(days, hold(), NOW);
    expect(held.map((h) => h.place)).toEqual([null, 'Huế']);
    expect(holdEndFor('2026-11-19T02:00:00.000Z', '2026-11-19', days, settings)).toBeNull();
    expect(holdEndFor('2026-11-19T02:00:00.000Z', '2026-11-19', days, hold())).toBe('2026-11-26T02:00:00.000Z');
    const left = [
      day('2026-11-18', 'Hội An', '2026-11-18T02:00:00.000Z'),
      day('2026-11-19', 'Huế', '2026-11-19T05:00:00.000Z'),
    ];
    expect(holdEndFor('2026-11-18T02:00:00.000Z', '2026-11-18', left, hold())).toBe('2026-11-19T05:00:00.000Z');
  });
});

describe('password strength hint (spec §7.8)', () => {
  const common = new Set(['passwort', 'sommer', 'password', 'qwertzuiop']);

  it('requires the contract minimum and rates the rest', () => {
    expect(PASSWORD_MIN).toBe(PASSWORD_MIN_LENGTH);
    expect(passwordStrength('kurz-123', { common })).toBe('too_short');
    expect(passwordStrength('Passwort1234', { common })).toBe('weak');
    expect(passwordStrength('Sommer2026!!!', { common })).toBe('weak');
    expect(passwordStrength('P4ssw0rd2026', { common })).toBe('weak');
    expect(passwordStrength('123456789012', { common })).toBe('weak');
    expect(passwordStrength('abcdefghijklm', { common })).toBe('weak');
    expect(passwordStrength('lena.beispiel1', { common, email: 'lena.beispiel@example.org' })).toBe('weak');
    expect(passwordStrength('Laternenfest21', { common })).toBe('medium');
    expect(passwordStrength('Laternen-Fest-im-Hafen-21', { common })).toBe('strong');
    expect(passwordStrength('drei kleine boote im nebel', { common })).toBe('strong');
    expect(passwordCore('!!P4ssw0rd2026')).toBe('password');
  });

  it('ships a common-password list of about 1000 entries as a lazy chunk', async () => {
    const { COMMON_PASSWORDS } = await import('../src/lib/common-passwords');
    expect(COMMON_PASSWORDS.size).toBeGreaterThanOrEqual(1000);
    expect(COMMON_PASSWORDS.has('passwort')).toBe(true);
    expect([...COMMON_PASSWORDS].every((w) => w === w.toLowerCase() && !/\s/.test(w))).toBe(true);
  });
});

describe('people helpers', () => {
  it('restates the follower id pattern of the contract', () => {
    for (const v of ['omaomaomaoma', 'abcdefgh2345', 'OMAOMAOMAOMA', 'omaomaomaom', 'omaomaomaoma1', 'omaomaomao0a']) {
      expect(FID_RE.test(v)).toBe(FOLLOWER_ID_RE.test(v));
    }
    expect(isFollowerId('omaomaomaoma')).toBe(true);
    expect(isFollowerId(42)).toBe(false);
  });

  it('labels and orders devices', () => {
    expect(deviceChip({ state: 'revoked', revokedBy: 'follower' })).toBe('signed_out');
    expect(deviceChip({ state: 'revoked', revokedBy: 'system' })).toBe('removed');
    const base = follower().devices[0];
    if (!base) throw new Error('seed');
    const sorted = sortDevices([
      { ...base, id: 'aaaaaaaa', state: 'declined' },
      { ...base, id: 'bbbbbbbb', state: 'active' },
      { ...base, id: 'cccccccc', state: 'pending' },
    ]);
    expect(sorted.map((d) => d.id)).toEqual(['cccccccc', 'bbbbbbbb', 'aaaaaaaa']);
  });

  it('says last seen in days', () => {
    expect(formatDaysAgo('2026-11-20T08:00:00.000Z', 'de', NOW, 'Asia/Ho_Chi_Minh')).toBe('heute');
    expect(formatDaysAgo('2026-11-19T08:00:00.000Z', 'de', NOW, 'Asia/Ho_Chi_Minh')).toBe('gestern');
    expect(formatDaysAgo('2026-11-17T08:00:00.000Z', 'de', NOW, 'Asia/Ho_Chi_Minh')).toBe('vor 3 Tagen');
  });

  it('summarises a restore: devices of known people, people missing from the backup', () => {
    const report: StoreReport = {
      at: '2026-11-20T09:00:00.000Z',
      mode: 'restored_api',
      deleted: 3,
      missing: [],
      orphans: [
        { fid: 'omaomaomaoma', did: 'phone222' },
        { fid: 'omaomaomaoma', did: 'phone333' },
        { fid: 'newnewnewnew', did: 'phone444' },
      ],
      imported: [],
    };
    const people = [{ id: 'omaomaomaoma', name: 'Oma' }];
    const tombstones = [
      { id: 'newnewnewnew', deletedBy: 'restore' as const, deletedAt: '2026-11-20T09:00:00.000Z' },
      { id: 'elseelseelse', deletedBy: 'restore' as const, deletedAt: '2026-11-20T09:00:01.000Z' },
      { id: 'oldoldoldold', deletedBy: 'restore' as const, deletedAt: '2026-10-01T09:00:00.000Z' },
    ];
    expect(restoreSummary(report, people, tombstones)).toEqual({ devices: 2, names: ['Oma'], people: 2, needLink: [] });
    expect(restoreSummary({ ...report, mode: 'normal' }, people, tombstones)).toBeNull();
    expect(restoreSummary(null, people)).toBeNull();
  });

  it('lists the active people whose link the restore reset, until they have a new one', () => {
    const report: StoreReport = {
      at: '2026-11-20T09:00:00.000Z',
      mode: 'restored_api',
      deleted: 0,
      missing: [],
      orphans: [],
      imported: [],
    };
    const people = [
      follower({ link: null }),
      follower({ id: 'opaopaopaopa', name: 'Opa', link: { createdAt: '2026-11-20T09:30:00.000Z' } }),
      follower({ id: 'endendendend', name: 'Ende', state: 'revoked', link: null }),
    ];
    expect(restoreSummary(report, people)).toEqual({
      devices: 0,
      names: [],
      people: 0,
      needLink: [{ id: 'omaomaomaoma', name: 'Oma' }],
    });
    expect(restoreSummary(report, [people[1] as AdminFollower])).toBeNull();
  });

  it("picks the device icon from the label's platform", () => {
    expect(deviceKind('iPhone · Safari')).toBe('phone');
    expect(deviceKind('Android · WhatsApp')).toBe('phone');
    expect(deviceKind('iPad · Safari')).toBe('tablet');
    expect(deviceKind('Mac · Firefox')).toBe('computer');
    expect(deviceKind('Windows · Chrome')).toBe('computer');
    expect(deviceKind('Linux · Firefox')).toBe('computer');
    expect(deviceKind('Gerät · Browser')).toBe('other');
    expect(deviceKind('')).toBe('other');
  });

  it('builds the share message and the export file name', () => {
    expect(personalLinkMessage('Oma', 'https://s/_/join/#t=x', 'de')).toBe(
      'Hallo Oma! Hier ist dein persönlicher Link zu meiner Reise. Bitte gib ihn nicht weiter: https://s/_/join/#t=x',
    );
    expect(personalLinkMessage('Oma', 'u', 'en')).toContain('Please do not pass it on: u');
    expect(exportFileName('Tante Üte', new Date(NOW))).toBe('on-my-way-data-tante-ute-2026-11-20.json');
    expect(exportFileName('😀', new Date(NOW))).toBe('on-my-way-data-2026-11-20.json');
  });
});

describe('safety and privacy helpers', () => {
  it('normalises release slot times (valid, unique, sorted, at most six)', () => {
    expect(normalizeSlotTimes(['20:00', '08:00', '08:00', '25:00', '7:00'])).toEqual(['08:00', '20:00']);
    expect(normalizeSlotTimes(['01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00'])).toHaveLength(6);
  });

  it('takes the later of the store proof and a passed gate check', () => {
    const at = (s: string) => `2026-11-${s}T00:00:00.000Z`;
    expect(accessProvenAt({ storeProofAt: null, gateCheck: null })).toBeNull();
    expect(
      accessProvenAt({ storeProofAt: at('18'), gateCheck: { at: at('19'), by: 'mac', result: 'ok', detail: null } }),
    ).toBe(at('19'));
    expect(
      accessProvenAt({ storeProofAt: at('18'), gateCheck: { at: at('19'), by: 'mac', result: 'error', detail: null } }),
    ).toBe(at('18'));
  });

  it('always asks for German and English, plus the other site languages', () => {
    expect(noticeLocales(['de'])).toEqual(['de', 'en']);
    expect(noticeLocales(['en', 'ar'])).toEqual(['de', 'en', 'ar']);
  });

  it('round-trips the draft through the form and keeps it a valid draft', () => {
    const draft = PrivacyNoticeDraft.parse({
      controller: { name: 'Lena', email: 'lena@example.org' },
      texts: { de: { title: 'Datenschutz', intro: 'Hallo' } },
    });
    const form = formFromDraft(draft, ['de', 'en']);
    expect(form.texts.en?.title).toBe('');
    const back = draftFromForm({ ...form, address: '  ' });
    expect(PrivacyNoticeDraft.safeParse(back).success).toBe(true);
    expect(back.controller).toEqual({ name: 'Lena', email: 'lena@example.org' });
    expect(back.texts.de?.intro).toBe('Hallo');
  });

  it('knows when the saved draft would only repeat the current version', () => {
    const empty = { title: '', intro: '', collected: '', audience: '', purpose: '', retention: '', rights: '' };
    const t = (title: string) => ({
      title,
      intro: 'Hallo',
      collected: 'Name',
      audience: 'Lena',
      purpose: 'Zugang',
      retention: 'Bis zur Löschung',
      rights: 'Auskunft',
    });
    const current = PublicNotice.parse({
      controller: { name: 'Lena', email: 'lena@example.org' },
      texts: { de: t('Datenschutz'), en: t('Privacy') },
      version: 3,
      publishedAt: '2026-11-21T10:00:00Z',
    });
    const draft = PrivacyNoticeDraft.parse({
      controller: { name: ' Lena ', email: 'lena@example.org', address: '' },
      texts: { de: t('Datenschutz '), en: t('Privacy'), ar: empty },
    });
    expect(draftMatchesCurrent(draft, current)).toBe(true);
    expect(draftMatchesCurrent(draft, null)).toBe(false);
    expect(draftMatchesCurrent({ ...draft, texts: { ...draft.texts, en: t('Privacy notice') } }, current)).toBe(false);
    expect(draftMatchesCurrent({ ...draft, controller: { ...draft.controller, address: 'Weg 1' } }, current)).toBe(
      false,
    );
    // A further language with any text counts as a change (errs towards "changed").
    expect(draftMatchesCurrent({ ...draft, texts: { ...draft.texts, ar: { ...empty, intro: 'x' } } }, current)).toBe(
      false,
    );
  });

  it('splits paragraphs like the gate page and names problem paths', () => {
    expect(noticeParagraphs('Eins\nzwei\n\n  \nDrei\r\n\r\nVier')).toEqual(['Eins\nzwei', 'Drei', 'Vier']);
    const label = (p: string) =>
      problemLabel(
        p,
        (k, l) => `${l}:${k}`,
        (f) => `ctl:${f}`,
      );
    expect(label('texts.en.title is empty')).toBe('en:title');
    expect(label('/texts/de/rights: missing')).toBe('de:rights');
    expect(label('controller.email is not an e-mail address')).toBe('ctl:email');
    expect(label('something else')).toBe('something else');
  });
});
