import { describe, expect, it } from 'vitest';
import {
  AdminDayDetail,
  AdminDaySummary,
  AnnotationPatch,
  ApiError,
  ApiTokenInfo,
  CaptureListItem,
  CaptureMirror,
  ChangeItem,
  ChangesPage,
  ChangesResponse,
  CLEARABLE_SETTING_KEYS,
  Day,
  DayPatch,
  DepartureHold,
  Heartbeat,
  itemPublishState,
  LoginRequest,
  Me,
  PASSWORD_MIN_LENGTH,
  PasswordChange,
  Post,
  PostCreate,
  PostUpdate,
  PublishedReport,
  parseChangeItem,
  parseSettingValue,
  ReleaseSlots,
  SETTING_KEYS,
  SETTINGS_DEFAULTS,
  Settings,
  SettingsPatch,
  StatusResponse,
  settingsProblems,
  TokenCreate,
  TokenCreated,
  Trip,
  TripUpsert,
  withSettingsDefaults,
} from '../src/api.js';
import {
  accessSummary,
  annotation,
  captureMirror,
  changes,
  day,
  gateCheck,
  heartbeat,
  post,
  publishedReport,
  siteHeartbeat,
  trip,
} from './samples.js';

describe('backend sync bodies', () => {
  it('CaptureMirror accepts valid and rejects invalid', () => {
    expect(CaptureMirror.parse(captureMirror())).toEqual(captureMirror());
    const text = {
      ...captureMirror(),
      kind: 'text',
      media: null,
      mediaState: 'none',
      text: { body: 'Xin chào', bg: '#c1a03fff', fg: '#ffffffff', font: 'SYSTEM' },
    };
    expect(CaptureMirror.safeParse(text).success).toBe(true);
    // NULL columns may be emitted as null
    expect(CaptureMirror.safeParse({ ...captureMirror(), caption: null, revokedAt: null }).success).toBe(true);
    expect(CaptureMirror.safeParse({ ...captureMirror(), publicId: 'p_abc1234' }).success).toBe(false);
    expect(CaptureMirror.safeParse({ ...captureMirror(), sourceKey: '3EB0' }).success).toBe(false);
    expect(CaptureMirror.safeParse({ ...captureMirror(), mediaState: 'downloading' }).success).toBe(false);
    expect(CaptureMirror.safeParse({ ...captureMirror(), contractVersion: 2 }).success).toBe(false);
    const { mediaState: _m, ...withoutMediaState } = captureMirror();
    expect(CaptureMirror.safeParse(withoutMediaState).success).toBe(false);
  });

  it('Heartbeat and PublishedReport', () => {
    expect(Heartbeat.parse(heartbeat())).toEqual(heartbeat());
    const fixtureMode = { ...heartbeat(), wa: { state: 'closed', traveler: { pn: null, lidKnown: false } } };
    expect(Heartbeat.safeParse(fixtureMode).success).toBe(true);
    expect(
      Heartbeat.safeParse({ ...heartbeat(), sync: { feedId: null, feedSeq: 0, lastPullAt: null, quarantined: 0 } })
        .success,
    ).toBe(true);
    expect(Heartbeat.safeParse({ ...heartbeat(), disk: { freeBytes: -1 } }).success).toBe(false);
    const { sync: _s, ...withoutSync } = heartbeat();
    expect(Heartbeat.safeParse(withoutSync).success).toBe(false);
    expect(PublishedReport.parse(publishedReport())).toEqual(publishedReport());
    expect(PublishedReport.safeParse({ ...publishedReport(), capturesThrough: null }).success).toBe(true);
    expect(PublishedReport.safeParse({ ...publishedReport(), uploaded: 1.5 }).success).toBe(false);
  });

  it('wave 5 additions are optional: Heartbeat.site, PublishedReport.gateCheck', () => {
    const withSite = { ...heartbeat(), site: siteHeartbeat() };
    expect(Heartbeat.parse(withSite)).toEqual(withSite);
    expect(Heartbeat.parse(heartbeat())).not.toHaveProperty('site');
    expect(Heartbeat.safeParse({ ...withSite, site: { ...siteHeartbeat(), storeDir: null } }).success).toBe(true);
    expect(
      Heartbeat.safeParse({ ...withSite, site: { ...siteHeartbeat(), origin: 'https://site.example/' } }).success,
    ).toBe(false);
    expect(Heartbeat.safeParse({ ...withSite, site: { ...siteHeartbeat(), cookieMode: 'php' } }).success).toBe(false);
    const withCheck = { ...publishedReport(), gateCheck: gateCheck() };
    expect(PublishedReport.parse(withCheck)).toEqual(withCheck);
    for (const result of ['ok', 'gate_open', 'store_unverified', 'error', 'skipped']) {
      expect(PublishedReport.safeParse({ ...withCheck, gateCheck: { ...gateCheck(), result } }).success, result).toBe(
        true,
      );
    }
    expect(PublishedReport.safeParse({ ...withCheck, gateCheck: { ...gateCheck(), result: 'open' } }).success).toBe(
      false,
    );
    expect(PublishedReport.safeParse({ ...withCheck, gateCheck: { ...gateCheck(), by: 'phone' } }).success).toBe(false);
  });
});

describe('entities', () => {
  it('accept valid samples, also with null for nullable columns', () => {
    expect(Post.parse(post())).toEqual(post());
    expect(Day.parse(day())).toEqual(day());
    expect(Trip.parse(trip())).toEqual(trip());
    expect(Day.safeParse({ ...day(), title: null, placeName: null, lat: null, tz: null }).success).toBe(true);
    expect(Trip.safeParse({ ...trip(), description: null, origLocale: null }).success).toBe(true);
  });

  it('reject invalid samples', () => {
    expect(Post.safeParse({ ...post(), kind: 'photo' }).success).toBe(false);
    expect(Post.safeParse({ ...post(), content: { fr: { body: 'x' } } }).success).toBe(false);
    expect(Post.safeParse({ ...post(), content: {} }).success).toBe(false);
    expect(Post.safeParse({ ...post(), visibility: 'draft' }).success).toBe(false);
    expect(Day.safeParse({ ...day(), countryCode: 'VNM' }).success).toBe(false);
    expect(Day.safeParse({ ...day(), tz: '+07:00' }).success).toBe(false);
    expect(Trip.safeParse({ ...trip(), startDate: '14.11.2026' }).success).toBe(false);
  });

  it('a story needs a non-blank title in every locale, a note has none', () => {
    const story = { ...post(), kind: 'story', content: { de: { title: 'Laternen', body: '# Hi' } } };
    expect(Post.safeParse(story).success).toBe(true);
    expect(Post.safeParse({ ...story, content: { de: { body: '# Hi' } } }).success).toBe(false);
    expect(Post.safeParse({ ...story, content: { de: { title: '   ', body: '# Hi' } } }).success).toBe(false);
  });
});

describe('settings', () => {
  it('defaults are valid and complete', () => {
    expect(Settings.parse(SETTINGS_DEFAULTS)).toEqual(SETTINGS_DEFAULTS);
    expect(SETTINGS_DEFAULTS['publish.mode']).toBe('instant');
    expect(SETTINGS_DEFAULTS['publish.mode_since']).toBe('1970-01-01T00:00:00.000Z');
    expect(SETTINGS_DEFAULTS['publish.delay_minutes']).toBe(720);
    expect(SETTINGS_DEFAULTS['ingest.on_revoke']).toBe('hide');
    expect(SETTINGS_DEFAULTS['site.indexable']).toBe(false);
    expect(SETTING_KEYS).toContain('alerts.ntfy_url');
    expect(settingsProblems(SETTINGS_DEFAULTS)).toEqual([]);
  });

  it('withSettingsDefaults merges valid values, ignores invalid ones and never throws', () => {
    const merged = withSettingsDefaults({
      'publish.mode': 'delayed',
      'publish.delay_minutes': 'soon',
      'timezone.current': 'Asia/Ho_Chi_Minh',
      'alerts.email': 'owner@example.org',
      unknown: 1,
    });
    expect(merged['publish.mode']).toBe('delayed');
    expect(merged['publish.delay_minutes']).toBe(720);
    expect(merged['timezone.current']).toBe('Asia/Ho_Chi_Minh');
    expect(merged['alerts.email']).toBe('owner@example.org');
    expect(withSettingsDefaults(null)).toEqual(SETTINGS_DEFAULTS);
    // default locale not among the locales (e.g. half-applied feed): first locale wins
    expect(withSettingsDefaults({ 'site.locales': ['en', 'ar'] })['site.default_locale']).toBe('en');
    // duplicate locales are invalid and ignored
    expect(withSettingsDefaults({ 'site.locales': ['de', 'de'] })['site.locales']).toEqual(['de', 'en']);
  });

  it('parseSettingValue validates per key', () => {
    expect(parseSettingValue('publish.mode', 'review')).toBe('review');
    expect(() => parseSettingValue('publish.mode', 'later')).toThrow();
    expect(() => parseSettingValue('timezone.current', '+07:00')).toThrow();
    expect(() => parseSettingValue('alerts.ntfy_url', 'ftp://ntfy.example/t')).toThrow();
    expect(parseSettingValue('site.locales', ['de', 'ar'])).toEqual(['de', 'ar']);
  });

  it('settingsProblems reports cross-field rules', () => {
    expect(settingsProblems({ ...SETTINGS_DEFAULTS, 'site.default_locale': 'ar' })).toHaveLength(1);
  });

  it("wave 5 keys: defaults keep today's behaviour (all new options off)", () => {
    expect(SETTINGS_DEFAULTS['publish.release_slots']).toEqual({ enabled: false, times: ['08:00', '20:00'] });
    expect(SETTINGS_DEFAULTS['publish.departure_hold']).toEqual({ enabled: false, maxDays: 7 });
    expect(SETTINGS_DEFAULTS['site.here_now']).toBe('city_badge');
    expect(SETTINGS_DEFAULTS['site.time_precision']).toBe('exact');
    expect(SETTINGS_DEFAULTS).not.toHaveProperty('publish.moved_on_at');
    expect(SETTINGS_DEFAULTS['publish.mode']).toBe('instant');
    expect(CLEARABLE_SETTING_KEYS).toContain('publish.moved_on_at');
    for (const key of [
      'publish.release_slots',
      'publish.departure_hold',
      'publish.moved_on_at',
      'site.here_now',
      'site.time_precision',
    ]) {
      expect(SETTING_KEYS, key).toContain(key);
    }
  });

  it('release slots: 1..6 HH:MM times, ascending and unique; hold: 1..7 days', () => {
    expect(ReleaseSlots.safeParse({ enabled: true, times: ['00:00', '23:59'] }).success).toBe(true);
    expect(
      ReleaseSlots.safeParse({ enabled: true, times: ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00'] }).success,
    ).toBe(true);
    for (const times of [
      [],
      ['8:00'],
      ['24:00'],
      ['12:60'],
      ['08:00:00'],
      ['08:00', '08:00'],
      ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00'],
    ]) {
      expect(ReleaseSlots.safeParse({ enabled: true, times }).success, JSON.stringify(times)).toBe(false);
    }
    // Order is a cross-field rule (JSON Schema cannot say "ascending"): settingsProblems / PHP problems().
    expect(ReleaseSlots.safeParse({ enabled: true, times: ['20:00', '08:00'] }).success).toBe(true);
    const unordered = { ...SETTINGS_DEFAULTS, 'publish.release_slots': { enabled: false, times: ['20:00', '08:00'] } };
    expect(settingsProblems(unordered)).toEqual(['publish.release_slots times must be ascending and unique']);
    const dup = { ...SETTINGS_DEFAULTS, 'publish.release_slots': { enabled: true, times: ['08:00', '08:00'] } };
    expect(settingsProblems(dup)).toEqual(['publish.release_slots times must be ascending and unique']);
    expect(DepartureHold.safeParse({ enabled: true, maxDays: 1 }).success).toBe(true);
    expect(DepartureHold.safeParse({ enabled: true, maxDays: 7 }).success).toBe(true);
    for (const maxDays of [0, 8, 2.5]) expect(DepartureHold.safeParse({ enabled: true, maxDays }).success).toBe(false);
  });

  it('wave 5 keys in SettingsPatch, withSettingsDefaults and the change feed', () => {
    const patch = {
      'publish.release_slots': { enabled: true, times: ['07:30', '19:45'] },
      'publish.departure_hold': { enabled: true, maxDays: 3 },
      'publish.moved_on_at': '2026-11-20T08:00:00.000Z',
      'site.here_now': 'country',
      'site.time_precision': 'part_of_day',
    };
    expect(SettingsPatch.parse(patch)).toEqual(patch);
    expect(SettingsPatch.safeParse({ 'publish.moved_on_at': null }).success).toBe(true);
    for (const key of ['publish.release_slots', 'publish.departure_hold', 'site.here_now', 'site.time_precision']) {
      expect(SettingsPatch.safeParse({ [key]: null }).success, key).toBe(false);
    }
    expect(SettingsPatch.safeParse({ 'publish.moved_on_at': '2026-11-20T09:00:00+01:00' }).success).toBe(false);
    expect(SettingsPatch.safeParse({ 'site.here_now': 'badge' }).success).toBe(false);
    expect(SettingsPatch.safeParse({ 'site.time_precision': 'hour' }).success).toBe(false);
    expect(withSettingsDefaults(patch)).toEqual({ ...SETTINGS_DEFAULTS, ...patch });
    // An older mirror without the new keys reads today's behaviour.
    const { 'site.here_now': _h, 'publish.release_slots': _r, ...older } = SETTINGS_DEFAULTS;
    expect(withSettingsDefaults(older)).toEqual(SETTINGS_DEFAULTS);
    expect(parseChangeItem({ seq: 7, entity: 'setting', key: 'publish.moved_on_at', op: 'delete' })).toMatchObject({
      status: 'ok',
    });
    expect(
      parseChangeItem({
        seq: 8,
        entity: 'setting',
        key: 'publish.release_slots',
        op: 'upsert',
        data: { value: { enabled: true, times: ['25:00'] } },
      }),
    ).toMatchObject({ status: 'invalid', key: 'publish.release_slots' });
  });

  it('SettingsPatch allows clearing optional alert targets, not mode_since', () => {
    expect(SettingsPatch.safeParse({ 'alerts.email': null, 'publish.mode': 'review' }).success).toBe(true);
    expect(SettingsPatch.safeParse({ 'publish.mode': null }).success).toBe(false);
    expect(SettingsPatch.safeParse({ 'alerts.ntfy_url': 'ftp://ntfy.sh/x' }).success).toBe(false);
    expect(SettingsPatch.safeParse({ 'alerts.ntfy_url': 'https://ntfy.sh/x' }).success).toBe(true);
    expect(SettingsPatch.shape).not.toHaveProperty('publish.mode_since');
  });

  it('null clears exactly the optional keys without a default', () => {
    for (const key of SETTING_KEYS) {
      const clearable = (CLEARABLE_SETTING_KEYS as readonly string[]).includes(key);
      if (key === 'publish.mode_since') continue;
      expect(SettingsPatch.safeParse({ [key]: null }).success, key).toBe(clearable);
      expect(key in SETTINGS_DEFAULTS, key).toBe(!clearable);
    }
  });

  it('profile settings: site.author, site.intro, site.avatar', () => {
    const profile = {
      'site.author': 'Lea',
      'site.intro': { de: 'Schön, dass du mitreist!', en: 'So glad you are coming along!' },
      'site.avatar': { sourceKey: 'wa:3EB0ABC', focus: { x: 0.5, y: 0.35 } },
    };
    expect(SettingsPatch.parse(profile)).toEqual(profile);
    expect(Settings.parse({ ...SETTINGS_DEFAULTS, ...profile })).toEqual({ ...SETTINGS_DEFAULTS, ...profile });
    expect(SETTINGS_DEFAULTS).not.toHaveProperty('site.author');
    expect(SettingsPatch.safeParse({ 'site.avatar': { sourceKey: 'wa:3EB0ABC' } }).success).toBe(true);
    const bad: Record<string, unknown>[] = [
      { 'site.author': '' },
      { 'site.author': ' Lea' },
      { 'site.author': 'x'.repeat(61) },
      { 'site.author': 'Lea\nB' },
      { 'site.intro': {} },
      { 'site.intro': { de: '' } },
      { 'site.intro': { de: 'x'.repeat(161) } },
      { 'site.intro': { fr: 'Salut' } },
      { 'site.intro': 'Hallo' },
      { 'site.avatar': { sourceKey: 'not a key' } },
      { 'site.avatar': { sourceKey: 'wa:X', focus: { x: 2, y: 0 } } },
      { 'site.avatar': 'wa:X' },
    ];
    for (const patch of bad) expect(SettingsPatch.safeParse(patch).success, JSON.stringify(patch)).toBe(false);
    // Mirrored values merge like any other key; invalid ones fall back to "unset".
    expect(withSettingsDefaults(profile)).toEqual({ ...SETTINGS_DEFAULTS, ...profile });
    expect(withSettingsDefaults({ 'site.author': ' x ' })).not.toHaveProperty('site.author');
    expect(parseSettingValue('site.intro', { en: 'Hi' })).toEqual({ en: 'Hi' });
  });

  it('feed items of the profile keys parse like any other setting', () => {
    const avatar = { sourceKey: 'wa:3EB0ABC', focus: { x: 0, y: 1 } };
    expect(
      parseChangeItem({ seq: 3, entity: 'setting', key: 'site.avatar', op: 'upsert', data: { value: avatar } }),
    ).toEqual({
      status: 'ok',
      item: { seq: 3, entity: 'setting', key: 'site.avatar', op: 'upsert', data: { value: avatar } },
    });
    expect(parseChangeItem({ seq: 4, entity: 'setting', key: 'site.author', op: 'delete' })).toMatchObject({
      status: 'ok',
    });
    expect(
      parseChangeItem({ seq: 5, entity: 'setting', key: 'site.intro', op: 'upsert', data: { value: { de: ' x' } } }),
    ).toMatchObject({ status: 'invalid', key: 'site.intro' });
  });
});

describe('change feed', () => {
  it('accepts upserts for every entity and tombstones', () => {
    expect(ChangesResponse.parse(changes())).toEqual(changes());
  });

  it('enforces data presence by op and key format by entity', () => {
    expect(ChangeItem.safeParse({ seq: 1, entity: 'post', key: 'p_abcd1234', op: 'upsert' }).success).toBe(false);
    expect(
      ChangeItem.safeParse({ seq: 1, entity: 'post', key: 'p_abcd1234', op: 'delete', data: post() }).success,
    ).toBe(true); // extra data on a delete is stripped, never applied
    expect(ChangeItem.safeParse({ seq: 1, entity: 'day', key: 'yesterday', op: 'delete' }).success).toBe(false);
    expect(ChangeItem.safeParse({ seq: 1, entity: 'setting', key: 'site.colour', op: 'delete' }).success).toBe(false);
    expect(ChangeItem.safeParse({ seq: 0, entity: 'trip', key: 'x', op: 'delete' }).success).toBe(false);
    expect(ChangeItem.safeParse({ seq: 1, entity: 'capture', key: 'wa:X', op: 'delete' }).success).toBe(false);
  });

  it('ChangesResponse / ChangesPage carry the optional access hint (needsWriter)', () => {
    expect(ChangesResponse.parse({ ...changes(), access: { needsWriter: true } })).toEqual({
      ...changes(),
      access: { needsWriter: true },
    });
    expect(ChangesResponse.parse(changes())).not.toHaveProperty('access');
    expect(ChangesResponse.safeParse({ ...changes(), access: { needsWriter: 'yes' } }).success).toBe(false);
    const page = { feedId: changes().feedId, items: [], nextSeq: 3, hasMore: false, access: { needsWriter: false } };
    expect(ChangesPage.parse(page)).toEqual(page);
  });

  it('ChangesPage only checks the envelope', () => {
    const page = { feedId: changes().feedId, items: [{ anything: true }], nextSeq: 3, hasMore: false };
    expect(ChangesPage.safeParse(page).success).toBe(true);
    expect(ChangesPage.safeParse({ ...page, feedId: undefined }).success).toBe(false);
  });

  it('parseChangeItem classifies items one by one and never throws', () => {
    const [first] = changes().items;
    expect(parseChangeItem(first)).toEqual({ status: 'ok', item: first });
    expect(parseChangeItem({ seq: 9, entity: 'comment', key: 'c1', op: 'upsert', data: {} })).toEqual({
      status: 'unknown_entity',
      seq: 9,
      entity: 'comment',
    });
    expect(parseChangeItem({ seq: 10, entity: 'setting', key: 'site.description', op: 'upsert', data: {} })).toEqual({
      status: 'unknown_key',
      seq: 10,
      entity: 'setting',
      key: 'site.description',
    });
    const badUrl = parseChangeItem({
      seq: 11,
      entity: 'setting',
      key: 'alerts.ntfy_url',
      op: 'upsert',
      data: { value: 'ftp://ntfy.example/t' },
    });
    expect(badUrl).toMatchObject({ status: 'invalid', seq: 11, key: 'alerts.ntfy_url' });
    expect(parseChangeItem({ seq: 12, entity: 'day', key: '2026-11-15', op: 'upsert', data: { x: 1 } })).toMatchObject({
      status: 'invalid',
      seq: 12,
    });
    expect(parseChangeItem('nope')).toMatchObject({ status: 'invalid', seq: null });
    expect(parseChangeItem(null)).toMatchObject({ status: 'invalid', seq: null });
    const setting = parseChangeItem({
      seq: 13,
      entity: 'setting',
      key: 'publish.delay_minutes',
      op: 'upsert',
      data: { value: 60 },
    });
    expect(setting).toEqual({
      status: 'ok',
      item: { seq: 13, entity: 'setting', key: 'publish.delay_minutes', op: 'upsert', data: { value: 60 } },
    });
  });
});

describe('admin DTOs', () => {
  const listItem = () => {
    const { contractVersion: _c, ...mirror } = captureMirror();
    return {
      ...mirror,
      annotation: annotation(),
      previewUrl: '/api/v1/admin/captures/wa:3EB0C767D26A1D8B7A3B/preview',
      posterUrl: null,
      effectiveVisibility: 'public',
      effectiveLocalDate: '2026-11-15',
      effectiveTz: 'Asia/Ho_Chi_Minh',
      changeSeq: 2,
    };
  };

  it('accept valid bodies', () => {
    expect(LoginRequest.safeParse({ email: 'owner@example.org', password: 'secret' }).success).toBe(true);
    expect(Me.safeParse({ email: 'owner@example.org', displayName: null, csrfToken: 'c' }).success).toBe(true);
    expect(AnnotationPatch.safeParse({ visibility: null, description: { en: 'x' } }).success).toBe(true);
    expect(AnnotationPatch.safeParse({}).success).toBe(true);
    expect(
      PostCreate.safeParse({
        publicId: 'p_01JDAB3K9X',
        kind: 'note',
        content: { de: { body: 'Hallo' } },
        origLocale: 'de',
      }).success,
    ).toBe(true);
    expect(
      PostUpdate.safeParse({ content: { de: { title: 'T', body: 'x' } }, ifUpdatedAt: '2026-11-15T06:00:00Z' }).success,
    ).toBe(true);
    expect(DayPatch.safeParse({ placeName: null, countryCode: 'VN', lat: 15.8, tz: 'Asia/Bangkok' }).success).toBe(
      true,
    );
    expect(
      TripUpsert.safeParse({
        slug: 'vietnam-2026',
        title: { de: 'Vietnam' },
        startDate: '2026-11-14',
        endDate: '2026-11-30',
      }).success,
    ).toBe(true);
    expect(CaptureListItem.safeParse(listItem()).success).toBe(true);
    expect(
      AdminDaySummary.safeParse({
        localDate: '2026-11-16',
        day: null,
        counts: { captures: 3, posts: 1, public: 3, hidden: 1, pending: 0 },
        firstAt: '2026-11-15T18:30:00Z',
        lastAt: '2026-11-16T15:00:00Z',
        coverSourceKey: null,
        coverPreviewUrl: null,
        trip: 'vietnam-2026',
        changeSeq: 0,
      }).success,
    ).toBe(true);
    expect(
      AdminDayDetail.safeParse({
        localDate: '2026-11-15',
        day: day(),
        captures: [listItem()],
        posts: [{ ...post(), changeSeq: 1 }],
        trip: null,
        changeSeq: 3,
      }).success,
    ).toBe(true);
    expect(
      StatusResponse.safeParse({
        backend: heartbeat(),
        lastSeenAt: '2026-11-19T10:00:00Z',
        publish: [{ ...publishedReport(), lastOkAt: null, consecutiveFailures: 0, receivedAt: '2026-11-19T10:00:01Z' }],
        alerts: [],
      }).success,
    ).toBe(true);
    expect(
      StatusResponse.safeParse({ backend: null, lastSeenAt: null, publish: [], alerts: [], access: accessSummary() })
        .success,
    ).toBe(true);
    expect(ApiError.safeParse({ error: { code: 'not_found', message: 'Not found' } }).success).toBe(true);
    const info = {
      id: 3,
      kind: 'backend',
      name: 'mac-mini',
      hint: 'omw_AbCdEf…',
      scopes: ['backend'],
      createdAt: '2026-11-19T10:00:00Z',
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    expect(ApiTokenInfo.safeParse(info).success).toBe(true);
    expect(TokenCreate.safeParse({ kind: 'app', name: 'iPhone' }).success).toBe(true);
    expect(TokenCreated.safeParse({ token: `omw_${'a'.repeat(43)}`, info }).success).toBe(true);
  });

  it('reject invalid bodies', () => {
    expect(LoginRequest.safeParse({ email: 'owner', password: 'x' }).success).toBe(false);
    expect(LoginRequest.safeParse({ email: `${'a'.repeat(250)}@x.de`, password: 'x' }).success).toBe(false);
    expect(AnnotationPatch.safeParse({ visibility: 'secret' }).success).toBe(false);
    expect(AnnotationPatch.safeParse({ localDateOverride: '2026-11-31' }).success).toBe(false);
    const note = { publicId: 'p_01JDAB3K9X', kind: 'note', content: { de: { body: 'x' } }, origLocale: 'de' };
    expect(PostCreate.safeParse({ ...note, publicId: undefined }).success).toBe(false);
    expect(PostCreate.safeParse({ ...note, content: {} }).success).toBe(false);
    expect(PostCreate.safeParse({ ...note, origLocale: 'en' }).success).toBe(false);
    expect(PostCreate.safeParse({ ...note, origLocale: 'fr' }).success).toBe(false);
    expect(PostCreate.safeParse({ ...note, tz: 'GMT+7' }).success).toBe(false);
    expect(PostCreate.safeParse({ ...note, kind: 'story' }).success).toBe(false); // story without title
    expect(TokenCreate.safeParse({ kind: 'session', name: 'x' }).success).toBe(false);
    expect(
      TripUpsert.safeParse({ slug: 't', title: { de: 'T' }, startDate: '2026-11-19', endDate: '2026-11-18' }).success,
    ).toBe(false);
    expect(ApiError.safeParse({ code: 'x', message: 'y' }).success).toBe(false);
  });
});

describe('change password (owner addition, spec-wave5 §4.4)', () => {
  it('needs the current password and a new one of at least 12 characters', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    const body = { currentPassword: 'old', newPassword: 'twelve chars', revokeAppTokens: true };
    expect(PasswordChange.parse(body)).toEqual(body);
    expect(PasswordChange.safeParse({ ...body, newPassword: 'eleven char' }).success).toBe(false);
    expect(PasswordChange.safeParse({ ...body, currentPassword: '' }).success).toBe(false);
    expect(PasswordChange.safeParse({ ...body, newPassword: 'x'.repeat(4097) }).success).toBe(false);
    expect(PasswordChange.safeParse({ ...body, currentPassword: 'x'.repeat(1001) }).success).toBe(false);
    const { revokeAppTokens: _r, ...withoutChoice } = body;
    expect(PasswordChange.safeParse(withoutChoice).success).toBe(false);
  });
});

describe('itemPublishState ("Live ✓ / publishing…")', () => {
  const report = { ok: true, feedSeq: 10, capturesThrough: '2026-11-19T09:00:00Z' };

  it('is live only when every target contains the item', () => {
    expect(itemPublishState({ visibility: 'public', changeSeq: 10 }, [report])).toBe('live');
    expect(itemPublishState({ visibility: 'public', changeSeq: 11 }, [report])).toBe('publishing');
    expect(itemPublishState({ visibility: 'public', changeSeq: 5 }, [report, { ...report, ok: false }])).toBe(
      'publishing',
    );
    expect(itemPublishState({ visibility: 'public', changeSeq: 0 }, [])).toBe('publishing');
    expect(itemPublishState({ visibility: 'hidden', changeSeq: 0 }, [report])).toBe('not_public');
  });

  it('checks captures against the capture watermark', () => {
    const capture = { visibility: 'public' as const, changeSeq: 0 };
    expect(itemPublishState({ ...capture, occurredAt: '2026-11-19T08:59:00Z' }, [report])).toBe('live');
    expect(itemPublishState({ ...capture, occurredAt: '2026-11-19T09:01:00Z' }, [report])).toBe('publishing');
    expect(
      itemPublishState({ ...capture, occurredAt: '2026-11-19T08:00:00Z' }, [{ ...report, capturesThrough: null }]),
    ).toBe('publishing');
  });

  it('shows media still downloading as publishing and lost media as not public, whatever the watermark', () => {
    const covered = { visibility: 'public' as const, changeSeq: 0, occurredAt: '2026-11-19T08:00:00Z' };
    expect(itemPublishState({ ...covered, mediaState: 'ok' }, [report])).toBe('live');
    expect(itemPublishState({ ...covered, mediaState: 'none' }, [report])).toBe('live');
    expect(itemPublishState({ ...covered, mediaState: 'pending' }, [report])).toBe('publishing');
    expect(itemPublishState({ ...covered, mediaState: 'lost' }, [report])).toBe('not_public');
    expect(itemPublishState({ ...covered, visibility: 'hidden', mediaState: 'pending' }, [report])).toBe('not_public');
  });
});
