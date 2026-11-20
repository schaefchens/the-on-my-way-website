/**
 * "About you": cleaning name and greeting into contract-valid values, the portrait rules, the
 * inline error routing of rejected profile writes, the trips hint and the mock API's avatar
 * check (the same rule as the PHP API).
 */
import { CLEARABLE_SETTING_KEYS, SiteAvatarSetting } from '@omw/contracts/api';
import { AuthorName, IntroI18n, IntroText } from '@omw/contracts/site';
import { afterEach, describe, expect, it } from 'vitest';
import { csrfFor, MockAdminApi, type MockRequest, SESSION_COOKIE } from '../e2e/mock/api';
import { settingsLocally } from '../src/api/cache';
import { ApiRequestError } from '../src/api/client';
import {
  AUTHOR_MAX,
  authorTooLong,
  claimProfileErrors,
  cleanAuthor,
  cleanIntro,
  cleanIntroText,
  clearProfileError,
  handleProfileWriteFailure,
  INTRO_MAX,
  introTooLong,
  PROFILE_KEYS,
  portraitProblem,
  previewGreeting,
  profileErrorStore,
  profileErrorsFrom,
  sameSetting,
  textLength,
} from '../src/lib/profile';
import { tripIsPublished } from '../src/screens/trips';
import { capture, settings } from './helpers';

describe('name and greeting are cleaned into what the contract accepts', () => {
  it('the name: one line, single spaces, trimmed', () => {
    for (const [raw, clean] of [
      ['  Lea ', 'Lea'],
      ['Lea\n  und\tTom', 'Lea und Tom'],
      [' Léa 🌸　', 'Léa 🌸'],
      ['Lea\u0000\u0007', 'Lea'],
      ['مرحبا', 'مرحبا'],
    ] as const) {
      expect(cleanAuthor(raw)).toBe(clean);
      expect(AuthorName.safeParse(clean).success, JSON.stringify(clean)).toBe(true);
    }
    expect(cleanAuthor(' \n\t ')).toBe('');
  });

  it('the greeting: line breaks kept (no more than one empty line), no other control characters', () => {
    const messy = '  Hallo ihr Lieben!  \r\n\r\n\r\n\tSchön, dass ihr da seid.\u0007  \n';
    const clean = cleanIntroText(messy);
    expect(clean).toBe('Hallo ihr Lieben!\n\n Schön, dass ihr da seid.');
    expect(IntroText.safeParse(clean).success).toBe(true);
    expect(cleanIntro({ de: '  Hallo  ', en: '   ' })).toEqual({ de: 'Hallo' });
    expect(cleanIntro({ de: '', en: ' \n ' })).toBeNull();
    expect(IntroI18n.safeParse(cleanIntro({ de: ' Hallo ', en: 'Hi\r\n' })).success).toBe(true);
  });

  it('the "On your site" preview picks the greeting like the site does (a cleared tab falls back)', () => {
    expect(previewGreeting({ de: 'Hallo ihr Lieben!', en: 'Hello!' }, 'de')).toEqual({
      text: 'Hallo ihr Lieben!',
      locale: 'de',
    });
    // The German tab was cleared: German visitors get the English greeting, so the preview shows it.
    expect(previewGreeting({ de: '', en: 'Hello lovely people!' }, 'de')).toEqual({
      text: 'Hello lovely people!',
      locale: 'en',
    });
    expect(previewGreeting({ de: '  \n ', en: ' Hi ' }, 'de')).toEqual({ text: 'Hi', locale: 'en' });
    expect(previewGreeting({ de: 'Hallo', en: '' }, 'en')).toEqual({ text: 'Hallo', locale: 'de' });
    expect(previewGreeting({ de: '', en: '' }, 'de')).toBeNull();
  });

  it('limits are the contract’s (code points: a flower emoji is one, a family emoji five)', () => {
    expect(AuthorName.safeParse('a'.repeat(AUTHOR_MAX)).success).toBe(true);
    expect(AuthorName.safeParse('a'.repeat(AUTHOR_MAX + 1)).success).toBe(false);
    expect(IntroText.safeParse('x'.repeat(INTRO_MAX)).success).toBe(true);
    expect(IntroText.safeParse('x'.repeat(INTRO_MAX + 1)).success).toBe(false);
    expect(IntroText.safeParse('🌸'.repeat(INTRO_MAX)).success).toBe(true);
    expect(IntroText.safeParse('🌸'.repeat(INTRO_MAX + 1)).success).toBe(false);
    expect(textLength('👩‍👩‍👧 Hội An')).toBe(12);
    expect(IntroText.safeParse('👩‍👩‍👧'.repeat(32)).success).toBe(textLength('👩‍👩‍👧'.repeat(32)) <= INTRO_MAX);
    expect(IntroText.safeParse('👩‍👩‍👧'.repeat(33)).success).toBe(textLength('👩‍👩‍👧'.repeat(33)) <= INTRO_MAX);
    expect(authorTooLong('a'.repeat(AUTHOR_MAX))).toBe(false);
    expect(authorTooLong('a'.repeat(AUTHOR_MAX + 1))).toBe(true);
    expect(introTooLong({ de: `${'🌸'.repeat(INTRO_MAX)}   `, en: 'x'.repeat(INTRO_MAX + 1) })).toEqual(['en']);
  });

  it('the profile keys are the clearable ones of the contract; null removes them locally too', () => {
    for (const k of PROFILE_KEYS) expect(CLEARABLE_SETTING_KEYS).toContain(k);
    const before = { ...settings, 'site.author': 'Lea', 'site.avatar': { sourceKey: 'wa:3EB0B028C9D92EFF4C5B' } };
    const after = settingsLocally(before, { 'site.author': null, 'site.avatar': null }, Date.now());
    expect(after).not.toHaveProperty('site.author');
    expect(after).not.toHaveProperty('site.avatar');
  });

  it('settings compare by value, not by key order', () => {
    expect(sameSetting({ de: 'a', en: 'b' }, { en: 'b', de: 'a' })).toBe(true);
    expect(
      sameSetting({ sourceKey: 'x', focus: { y: 0.4, x: 0.5 } }, { focus: { x: 0.5, y: 0.4 }, sourceKey: 'x' }),
    ).toBe(true);
    expect(sameSetting(null, undefined)).toBe(true);
    expect(sameSetting({ de: 'a' }, null)).toBe(false);
  });
});

describe('portrait', () => {
  it('only a photo that is not deleted, lost or still processing can be picked', () => {
    expect(portraitProblem(capture())).toBeNull();
    // Hidden in the timeline is fine: the owner's choice wins.
    expect(portraitProblem(capture({ effectiveVisibility: 'hidden' }))).toBeNull();
    expect(portraitProblem(capture({ kind: 'video' }))).toBe('not_photo');
    expect(portraitProblem(capture({ revokedAt: '2026-11-15T03:00:00.000Z' }))).toBe('revoked');
    expect(portraitProblem(capture({ mediaState: 'lost' }))).toBe('lost');
    expect(portraitProblem(capture({ mediaState: 'pending' }))).toBe('pending');
    expect(SiteAvatarSetting.safeParse({ sourceKey: capture().sourceKey }).success).toBe(true);
  });
});

describe('rejected profile writes', () => {
  const vars = { patch: { 'site.avatar': { sourceKey: 'wa:3EB0B028C9D92EFF4C5B' } } };
  const rejected = new ApiRequestError(422, 'validation_failed', 'site.avatar: was deleted on WhatsApp', {
    errors: ['/site.avatar/sourceKey: wa:3EB0B028C9D92EFF4C5B was deleted on WhatsApp'],
  });
  afterEach(() => {
    for (const k of PROFILE_KEYS) clearProfileError(k);
  });

  it('maps the API’s and the mock’s error details to the field', () => {
    expect(profileErrorsFrom(rejected, ['site.avatar'])).toEqual({
      'site.avatar': 'wa:3EB0B028C9D92EFF4C5B was deleted on WhatsApp',
    });
    const zodLike = new ApiRequestError(422, 'validation_failed', 'invalid', [
      { path: ['site.intro', 'de'], message: 'Too big' },
    ]);
    expect(profileErrorsFrom(zodLike, ['site.author', 'site.intro'])).toEqual({ 'site.intro': 'Too big' });
    const vague = new ApiRequestError(422, 'validation_failed', 'The request does not match the contract.');
    expect(profileErrorsFrom(vague, ['site.author'])).toEqual({
      'site.author': 'The request does not match the contract.',
    });
  });

  it('go to the About-you section while it is on screen, else to the usual toast', () => {
    expect(handleProfileWriteFailure('patchSettings', vars, rejected)).toBe(false);
    const release = claimProfileErrors();
    try {
      expect(handleProfileWriteFailure('patchSettings', vars, rejected)).toBe(true);
      expect(profileErrorStore.get()['site.avatar']).toContain('deleted on WhatsApp');
      // Not a profile write, a server error or a lost session: not ours.
      expect(handleProfileWriteFailure('patchSettings', { patch: { 'site.title': 'x' } }, rejected)).toBe(false);
      expect(handleProfileWriteFailure('patchSettings', vars, new ApiRequestError(503, 'http_503', 'down'))).toBe(
        false,
      );
      expect(handleProfileWriteFailure('patchSettings', vars, new ApiRequestError(401, 'unauthorized', 'x'))).toBe(
        false,
      );
      expect(handleProfileWriteFailure('patchDay', vars as never, rejected)).toBe(false);
    } finally {
      release();
      release(); // idempotent
    }
    expect(handleProfileWriteFailure('patchSettings', vars, rejected)).toBe(false);
  });
});

describe('trips list hint', () => {
  const day = (trip: string | null, pub: number) =>
    ({
      localDate: '2026-11-15',
      day: null,
      counts: { captures: 1, posts: 0, public: pub, hidden: 1 - pub, pending: 0 },
      firstAt: null,
      lastAt: null,
      coverSourceKey: null,
      coverPreviewUrl: null,
      trip,
      changeSeq: 0,
    }) as const;
  it('a trip is on the site once one of its days has something public', () => {
    expect(tripIsPublished('japan', [])).toBe(false);
    expect(tripIsPublished('japan', [day('japan', 0), day('vn', 1)])).toBe(false);
    expect(tripIsPublished('japan', [day('japan', 0), day('japan', 1)])).toBe(true);
  });
});

describe('mock API: the portrait rule of the PHP API', () => {
  function call(api: MockAdminApi, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const url = new URL(`http://x${path}`);
    const req: MockRequest = {
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? '' : JSON.stringify(body),
    };
    return api.handle(req);
  }
  function login(api: MockAdminApi) {
    const res = call(api, 'POST', '/api/v1/admin/session', { email: 'owner@example.org', password: 'reisetagebuch' });
    const token = /omw_mock_session=([^;]+)/.exec(res.headers?.['set-cookie'] ?? '')?.[1] ?? '';
    return { cookie: `${SESSION_COOKIE}=${token}`, 'x-csrf-token': csrfFor(token) };
  }
  const PATH = '/api/v1/admin/settings';
  const avatar = (sourceKey: string) => ({ 'site.avatar': { sourceKey } });

  it('accepts a photo (also a hidden one), refuses others; re-sending the stored choice is never re-checked', () => {
    const api = new MockAdminApi();
    const auth = login(api);
    const hanoi = 'wa:3EB0CCAE0F9B4D04143F';
    expect(call(api, 'PATCH', PATH, avatar(hanoi), auth).status).toBe(200);
    const video = call(api, 'PATCH', PATH, avatar('wa:3EB04F6CD4B59C4BBA47'), auth);
    expect(video.status).toBe(422);
    expect(video.json).toMatchObject({
      error: {
        code: 'validation_failed',
        details: { errors: [expect.stringMatching(/^\/site\.avatar\/sourceKey: /)] },
      },
    });
    expect(call(api, 'PATCH', PATH, avatar('wa:3EB029F28898501FA172'), auth).status).toBe(422); // revoked
    expect(call(api, 'PATCH', PATH, avatar('wa:NOPE'), auth).status).toBe(422);
    // Revoked after it was chosen: moving its focus still works; null clears it.
    expect(api.revokeCapture(hanoi)).toBe(true);
    expect(
      call(api, 'PATCH', PATH, { 'site.avatar': { sourceKey: hanoi, focus: { x: 0.5, y: 0.3 } } }, auth).status,
    ).toBe(200);
    const cleared = call(api, 'PATCH', PATH, { 'site.avatar': null, 'site.author': 'Lea' }, auth);
    expect(cleared.status).toBe(200);
    expect(cleared.json).not.toHaveProperty('site.avatar');
    expect(cleared.json).toMatchObject({ 'site.author': 'Lea' });
  });
});
