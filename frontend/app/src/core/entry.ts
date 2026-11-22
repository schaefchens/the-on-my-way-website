/**
 * Manifest -> the wire entry (AppEntry of @omw/contracts/app), plus the day helpers of "Put it on
 * that day?" (app-plan §3.3: occurredAt = the Share tap, never the EXIF time; the time a photo was
 * taken only drives the suggestion, which writes localDate).
 *
 * Framework-free.
 */
import { APP_LIMITS, AppEntry, type AppEntryProblem, type AppMedia } from '@omw/contracts/app';
import { type OutboxFile, type OutboxManifest, wireIdOf } from './outbox-machine';

export interface ClientInfo {
  /** versionName of the build. */
  app: string;
  /** Android release, e.g. "16". */
  os?: string;
}

/** The caption as published: trimmed, and absent when empty (photo and video only). */
export function normalizeCaption(caption: string | undefined): string | undefined {
  const c = caption?.replace(/\r\n?/g, '\n').trim();
  return c ? c.slice(0, APP_LIMITS.captionChars) : undefined;
}

export type BuildResult = { ok: true; entry: AppEntry } | { ok: false; problems: AppEntryProblem[] };

/**
 * The AppEntry of a shared manifest with its prepared files. Validated with the contract's zod
 * schema (the same rules the PHP API enforces); problems come back instead of an exception.
 */
export function buildAppEntry(
  m: OutboxManifest,
  prepared: { files: OutboxFile[]; media?: AppMedia },
  client: ClientInfo,
): BuildResult {
  if (!m.sharedAt || !m.tz) return { ok: false, problems: [{ path: ['occurredAt'], message: 'not shared yet' }] };
  const visual = m.kind === 'photo' || m.kind === 'video';
  const caption = visual ? normalizeCaption(m.caption) : undefined;
  const candidate = {
    schema: 1,
    // The id the API knows this moment by (a new one after Undo or "Try again").
    entryId: wireIdOf(m),
    source: 'app',
    kind: m.kind,
    occurredAt: m.sharedAt,
    tz: m.tz,
    ...(caption ? { caption } : {}),
    ...(m.kind === 'text' && m.text ? { text: m.text } : {}),
    ...(m.kind !== 'text' && prepared.media ? { media: prepared.media } : {}),
    ...(m.choice.localDate ? { localDate: m.choice.localDate } : {}),
    ...(m.choice.visibility ? { visibility: m.choice.visibility } : {}),
    files: prepared.files.map(({ role, mimetype, bytes, sha256Hex }) => ({ role, mimetype, bytes, sha256Hex })),
    client: { app: client.app.slice(0, 40), platform: 'android', ...(client.os ? { os: client.os.slice(0, 32) } : {}) },
  };
  const parsed = AppEntry.safeParse(candidate);
  if (parsed.success) return { ok: true, entry: parsed.data };
  return {
    ok: false,
    problems: parsed.error.issues.map((i) => ({
      path: i.path.map((p) => (typeof p === 'number' ? p : String(p))),
      message: i.message,
    })),
  };
}

// ---- days

/** "YYYY-MM-DD" of an instant in an IANA zone. */
export function localDateIn(instant: Date | string, timeZone: string): string {
  const date = typeof instant === 'string' ? new Date(instant) : instant;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * The local date in an EXIF "DateTimeOriginal" ("2026:11:17 18:42:05", the camera's wall clock),
 * or null when absent or malformed.
 */
export function exifLocalDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * The day to suggest for "Put it on that day?": the day a gallery photo was taken, when that is
 * an earlier day than the Share day (never a future day, never the same day).
 */
export function suggestedDay(takenOn: string | null | undefined, shareDay: string): string | null {
  if (!takenOn) return null;
  return takenOn < shareDay ? takenOn : null;
}

/** Groups the suggestion over a batch: one chip per day ("2 photos are from Tue 17 Nov"). */
export function suggestionsByDay(
  items: readonly { entryId: string; takenOn?: string | null }[],
  shareDay: string,
): { day: string; entryIds: string[] }[] {
  const byDay = new Map<string, string[]>();
  for (const item of items) {
    const day = suggestedDay(item.takenOn, shareDay);
    if (day) byDay.set(day, [...(byDay.get(day) ?? []), item.entryId]);
  }
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? 1 : -1)).map(([day, entryIds]) => ({ day, entryIds }));
}

// ---- sizes

/** Fits a photo inside the published limits (long ≤ 2880, short ≤ 1600), never upscaling. */
export function fitPhoto(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const scale = Math.min(1, APP_LIMITS.photoMaxLongSide / long, APP_LIMITS.photoMaxShortSide / short);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/** "184 MB" style sizes (decimal units, like Android's own storage screens). */
export function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'kB', 'MB', 'GB'];
  let value = Math.max(0, bytes);
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  const digits = i >= 2 && value < 10 ? 1 : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${units[i]}`;
}

/** 42_000 -> "0:42", 61_500 -> "1:01". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
