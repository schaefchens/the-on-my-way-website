/**
 * Errors in the owner's language: an ApiRequestError's status and code mapped to warm,
 * localized copy. The technical text (English API message, "HTTP 502") is kept as `detail` for
 * a "Details" disclosure, never shown as the main text.
 */
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { ApiRequestError } from '../api/client';

export type ErrorKind =
  | 'network'
  | 'server'
  | 'rate_limited'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rejected'
  | 'unknown';

export function errorKind(err: unknown): ErrorKind {
  if (!(err instanceof ApiRequestError)) return 'unknown';
  if (err.status === 0) return 'network';
  if (err.status === 429) return 'rate_limited';
  if (err.status >= 500) return 'server';
  if (err.status === 401) return 'unauthorized';
  if (err.status === 403) return 'forbidden';
  if (err.status === 404) return 'not_found';
  if (err.status === 409) return 'conflict';
  if (err.status >= 400) return 'rejected';
  return 'unknown';
}

const COPY: Record<ErrorKind, MessageDescriptor> = {
  network: msg`No connection – we will try again in a moment`,
  server: msg`The server has a problem right now`,
  rate_limited: msg`Just a moment – too many requests at once`,
  unauthorized: msg`Please log in again`,
  forbidden: msg`This is not allowed – reload the app and try again`,
  not_found: msg`This no longer exists`,
  conflict: msg`It was changed elsewhere in the meantime`,
  rejected: msg`The server did not accept this`,
  unknown: msg`Something went wrong`,
};

export interface FriendlyError {
  kind: ErrorKind;
  message: MessageDescriptor;
  /** Technical text for a "Details" disclosure (null when there is nothing more to say). */
  detail: string | null;
}

export function friendlyError(err: unknown): FriendlyError {
  const kind = errorKind(err);
  const raw = err instanceof Error ? err.message : err === undefined || err === null ? '' : String(err);
  // The code only when it adds something ("network" and "http_502" repeat what the status says).
  const code =
    err instanceof ApiRequestError && err.code !== 'network' && err.code !== `http_${err.status}` ? err.code : null;
  const status = err instanceof ApiRequestError && err.status > 0 ? `HTTP ${err.status}` : null;
  const detail = [raw, code && !raw.includes(code) ? code : null, status && !raw.includes(status) ? status : null]
    .filter((x): x is string => !!x && x.trim() !== '')
    .join(' · ');
  return { kind, message: COPY[kind], detail: detail || null };
}

/**
 * Translates outside React (mutation callbacks compose toast text): the active locale, or the
 * English source text before a locale is active (tests, a write failing during boot).
 */
export function translate(message: MessageDescriptor): string {
  if (!i18n.locale) return message.message ?? message.id ?? '';
  return i18n._(message);
}
