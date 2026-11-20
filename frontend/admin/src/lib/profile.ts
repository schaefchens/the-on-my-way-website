/**
 * "About you" (owner decision "personal touch"): the settings site.author, site.intro and
 * site.avatar, shown on the site as the home hero, the player's avatar and the day-end sign-off.
 *
 * - Text is cleaned before it is sent (the API validates as sent and never trims): the name is
 *   one line with single spaces, the greeting keeps its line breaks but no other control
 *   characters, both trimmed. Empty means "remove" (null clears the key).
 * - Limits count code points, like the contract (zod 4's string max, AuthorName / IntroText) and
 *   the PHP API (mb_strlen): a flower emoji is one, a family emoji several.
 * - The rules are restated from @omw/contracts/api (no runtime import: it pulls every zod schema
 *   into the bundle); a unit test checks them against the contract.
 * - A 422 on a profile write is shown next to the field it concerns while the About-you section
 *   is on screen (it claims them); elsewhere (the item sheet) the usual error toast tells.
 */
import type { CaptureListItem, SettingsPatch, SiteAvatarSetting } from '@omw/contracts/api';
import { type LocaleCode, pickText } from '@omw/contracts/i18n';
import { ApiRequestError } from '../api/client';
import type { MutationName } from '../api/keys';
import type { WriteVars } from '../api/types';
import { createStore } from './store';

export const AUTHOR_MAX = 60;
export const INTRO_MAX = 160;

export const PROFILE_KEYS = ['site.author', 'site.intro', 'site.avatar'] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];

/** Control characters (C0, DEL, C1) except the line feed. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
const CONTROL_EXCEPT_LF = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

/** The name as one line: any run of whitespace (line breaks, tabs, …) becomes one space. */
export function cleanAuthor(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters become spaces
  return raw.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}

/**
 * A greeting as plain text: line breaks kept (at most one empty line in a row), spaces at the
 * line ends and every other control character removed, trimmed.
 */
export function cleanIntroText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(CONTROL_EXCEPT_LF, '')
    .split('\n')
    .map((line) => line.replace(/[\s\u0085]+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The greeting per locale without empty entries; null when nothing is left (= remove). */
export function cleanIntro(intro: Partial<Record<LocaleCode, string>>): Partial<Record<LocaleCode, string>> | null {
  const out: Partial<Record<LocaleCode, string>> = {};
  for (const [locale, value] of Object.entries(intro) as Array<[LocaleCode, string | undefined]>) {
    const clean = cleanIntroText(value ?? '');
    if (clean) out[locale] = clean;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The greeting the "On your site" preview shows for a visitor in `locale`: the same pick as the
 * site (pickText on the cleaned greeting: that locale, else another one), so a cleared tab shows
 * what visitors really get. Null when no locale has a greeting.
 */
export function previewGreeting(
  form: Partial<Record<LocaleCode, string>>,
  locale: LocaleCode,
): { text: string; locale: LocaleCode } | null {
  const picked = pickText(cleanIntro(form), locale);
  return picked ? { text: picked.text, locale: picked.locale } : null;
}

/** Length as the contract counts it (code points). */
export function textLength(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

export function authorTooLong(clean: string): boolean {
  return textLength(clean) > AUTHOR_MAX;
}

/** Locales whose cleaned greeting is longer than the limit. */
export function introTooLong(intro: Partial<Record<LocaleCode, string>>): LocaleCode[] {
  return (Object.entries(intro) as Array<[LocaleCode, string | undefined]>)
    .filter(([, v]) => textLength(cleanIntroText(v ?? '')) > INTRO_MAX)
    .map(([l]) => l);
}

/** Same JSON value, ignoring key order (the API compares settings the same way). */
export function sameSetting(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// ---------------------------------------------------------------------------------------------
// Which photos can be the portrait

export type PortraitProblem = 'not_photo' | 'revoked' | 'lost' | 'pending';

/**
 * Why a capture cannot be picked as the portrait (the API's rule: a mirrored photo, not revoked,
 * media not lost; a photo still processing is not offered either), null when it can.
 */
export function portraitProblem(c: Pick<CaptureListItem, 'kind' | 'revokedAt' | 'mediaState'>): PortraitProblem | null {
  if (c.kind !== 'photo') return 'not_photo';
  if (c.revokedAt) return 'revoked';
  if (c.mediaState === 'lost') return 'lost';
  if (c.mediaState === 'pending') return 'pending';
  return null;
}

/** The setting for a newly picked photo (a new photo starts centred). */
export function avatarSetting(sourceKey: string): SiteAvatarSetting {
  return { sourceKey };
}

// ---------------------------------------------------------------------------------------------
// Inline errors of rejected profile writes

export type ProfileErrors = Partial<Record<ProfileKey, string>>;

export const profileErrorStore = createStore<ProfileErrors>({});

let inlineClaims = 0;

/** The About-you section shows profile errors itself while it is mounted. Returns the release. */
export function claimProfileErrors(): () => void {
  inlineClaims++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inlineClaims--;
  };
}

/** Forget the error of `key` (the owner edits or saves it again). */
export function clearProfileError(key: ProfileKey): void {
  profileErrorStore.set((errors) => {
    if (!(key in errors)) return errors;
    const { [key]: _gone, ...rest } = errors;
    return rest;
  });
}

export function profileKeysOf(patch: SettingsPatch): ProfileKey[] {
  return PROFILE_KEYS.filter((k) => patch[k] !== undefined);
}

/**
 * The API's messages per profile key: `details.errors` lines like "/site.avatar/sourceKey: …"
 * (PHP), or zod issues with a `path` (the mock API). Lines naming no profile key go to every
 * profile key of the patch.
 */
export function profileErrorsFrom(error: ApiRequestError, keys: readonly ProfileKey[]): ProfileErrors {
  const out: ProfileErrors = {};
  const add = (key: ProfileKey, text: string) => {
    out[key] = out[key] ? `${out[key]}; ${text}` : text;
  };
  const details = error.details as { errors?: unknown } | unknown[] | null | undefined;
  const lines: Array<{ key: string | null; text: string }> = [];
  if (Array.isArray(details)) {
    for (const issue of details as Array<{ path?: unknown[]; message?: unknown }>) {
      const key = Array.isArray(issue?.path) && typeof issue.path[0] === 'string' ? issue.path[0] : null;
      lines.push({ key, text: typeof issue?.message === 'string' ? issue.message : error.message });
    }
  } else if (details && Array.isArray((details as { errors?: unknown }).errors)) {
    for (const line of (details as { errors: unknown[] }).errors) {
      if (typeof line !== 'string') continue;
      const m = /^\/([^/:]+)(?:\/[^:]*)?:\s*(.*)$/.exec(line);
      lines.push({ key: m?.[1] ?? null, text: m?.[2] || line });
    }
  }
  for (const { key, text } of lines) {
    if (key && (keys as readonly string[]).includes(key)) add(key as ProfileKey, text);
  }
  if (Object.keys(out).length === 0) for (const k of keys) add(k, error.message);
  return out;
}

/**
 * onFailedWrite part for profile writes: a 422 (or other 4xx) of a settings patch that touches a
 * profile key goes next to its field while the About-you section is on screen (true = told).
 */
export function handleProfileWriteFailure(name: MutationName, vars: WriteVars[MutationName], error: unknown): boolean {
  if (name !== 'patchSettings' || inlineClaims === 0) return false;
  if (!(error instanceof ApiRequestError) || error.status < 400 || error.status >= 500 || error.status === 401) {
    return false;
  }
  const keys = profileKeysOf((vars as WriteVars['patchSettings']).patch);
  if (keys.length === 0) return false;
  const errors = profileErrorsFrom(error, keys);
  profileErrorStore.set((current) => ({ ...current, ...errors }));
  return true;
}
