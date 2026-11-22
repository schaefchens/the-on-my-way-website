/**
 * Strength hint for a new admin password (spec-wave5 §7.8). Only the minimum length is a rule
 * (the API checks it too: 12 characters, PASSWORD_MIN_LENGTH in @omw/contracts/api, restated here
 * because a runtime import of the contracts' api module pulls zod into the bundle); "weak /
 * medium / strong" is a hint from the length, the character classes and a list of common
 * passwords (lib/common-passwords.ts, loaded as a lazy chunk).
 */

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 4096;

export type PasswordStrength = 'too_short' | 'weak' | 'medium' | 'strong';

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

/** Length in code points (what the API counts with mb_strlen). */
export function passwordLength(password: string): number {
  return [...password].length;
}

/** The "word" inside a password: lower case, edges of digits/symbols cut, leetspeak undone. */
export function passwordCore(password: string): string {
  const lower = password.normalize('NFKC').toLowerCase();
  const trimmed = lower.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
  return [...trimmed].map((ch) => LEET[ch] ?? ch).join('');
}

function isSequence(s: string): boolean {
  if (s.length < 4) return false;
  const codes = [...s].map((c) => c.codePointAt(0) ?? 0);
  const step = (codes[1] ?? 0) - (codes[0] ?? 0);
  if (Math.abs(step) !== 1) return false;
  return codes.every((c, i) => i === 0 || c - (codes[i - 1] ?? 0) === step);
}

function classes(password: string): number {
  let n = 0;
  if (/\p{Ll}/u.test(password)) n++;
  if (/\p{Lu}/u.test(password)) n++;
  if (/\p{Nd}/u.test(password)) n++;
  if (/[^\p{L}\p{Nd}]/u.test(password)) n++;
  return n;
}

export function passwordStrength(
  password: string,
  opts: { common?: ReadonlySet<string> | null; email?: string | null } = {},
): PasswordStrength {
  const length = passwordLength(password);
  if (length < PASSWORD_MIN) return 'too_short';
  const lower = password.normalize('NFKC').toLowerCase();
  const core = passwordCore(password);
  const unique = new Set(lower).size;
  const common = opts.common;
  const local = opts.email?.split('@')[0]?.toLowerCase() ?? '';
  const weak =
    unique < 5 ||
    isSequence(lower) ||
    /^\d+$/.test(lower) ||
    (local.length >= 4 && lower.includes(local)) ||
    // A common password, also with digits/symbols around it ("Sommer2026!!!", "passwort1234").
    (!!common && (common.has(lower) || common.has(core) || common.has(lower.replace(/[^\p{L}\p{Nd}]/gu, ''))));
  if (weak) return 'weak';
  const n = classes(password);
  if ((length >= 16 && n >= 3) || (length >= 20 && unique >= 10)) return 'strong';
  if (n >= 2 || length >= 16) return 'medium';
  return 'weak';
}
