/**
 * How long each item of the journey player stays on screen (plan C, "Journey player"):
 *
 *   photo        5–12 s by the length of the visible text (caption + description)
 *   text status  3 s + 45 ms per character, at most 10 s
 *   note         6–10 s by length
 *   story        6 s (a card; "Read the story" opens the sheet)
 *   video, voice their real duration (driven by the media element)
 *   GIF          whole loops until at least 5 s have passed (at most 12 s)
 *
 * Pure functions, no DOM: shared by the player and its tests.
 */
import type { LocaleCode } from '@omw/contracts/i18n';
import { pickText } from '@omw/contracts/i18n';
import type { Entry } from '@omw/contracts/site';

export const DURATIONS = {
  photo: { minMs: 5_000, maxMs: 12_000, perCharMs: 60 },
  text: { baseMs: 3_000, perCharMs: 45, maxMs: 10_000 },
  note: { minMs: 6_000, maxMs: 10_000, perCharMs: 40 },
  storyMs: 6_000,
  gif: { minMs: 5_000, maxMs: 12_000 },
  /** Used when a media file reports no usable duration. */
  mediaFallbackMs: 8_000,
  /** An item that failed to load is skipped after this delay (plan C). */
  errorSkipMs: 3_000,
  /** Countdown on the day-end card before the next day starts. */
  dayEndCountdownMs: 3_000,
  /** An item that has not loaded after this long counts as failed. */
  loadTimeoutMs: 15_000,
  /** A video/voice note that stays stalled ("buffering") this long counts as failed. */
  stallTimeoutMs: 15_000,
} as const;

/** Visible characters (code points, so emoji and accented letters count once). */
export function charCount(text: string | null | undefined): number {
  if (!text) return 0;
  return Array.from(text.trim().replace(/\s+/g, ' ')).length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Photo (and a video poster in data-saver mode): 5 s plus reading time, at most 12 s. */
export function photoDurationMs(textChars: number): number {
  const { minMs, maxMs, perCharMs } = DURATIONS.photo;
  return clamp(minMs + Math.max(0, textChars) * perCharMs, minMs, maxMs);
}

/** WhatsApp text status: 3 s + 45 ms per character, at most 10 s. */
export function textStatusDurationMs(body: string): number {
  const { baseMs, perCharMs, maxMs } = DURATIONS.text;
  return Math.min(maxMs, baseMs + charCount(body) * perCharMs);
}

/** Owner note: 6–10 s by length. */
export function noteDurationMs(text: string): number {
  const { minMs, maxMs, perCharMs } = DURATIONS.note;
  return clamp(minMs + charCount(text) * perCharMs, minMs, maxMs);
}

/** GIF loops: as many whole loops as needed to reach 5 s, capped at 12 s (one long loop wins). */
export function gifDurationMs(loopSeconds: number): number {
  const { minMs, maxMs } = DURATIONS.gif;
  const loopMs = loopSeconds * 1000;
  if (!Number.isFinite(loopMs) || loopMs <= 0) return minMs;
  if (loopMs >= minMs) return Math.round(loopMs);
  const loops = Math.ceil(minMs / loopMs);
  return Math.min(maxMs, loops * loopMs);
}

/** Seconds from a media file -> ms, with a fallback for missing/invalid values. */
export function mediaDurationMs(seconds: number | null | undefined): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return DURATIONS.mediaFallbackMs;
  return Math.round(seconds * 1000);
}

/** The text shown on top of a photo/video: WhatsApp caption plus the owner's description. */
export function overlayTextChars(entry: Entry, locale: LocaleCode): number {
  const description = pickText(entry.description, locale, entry.descriptionOrig)?.text;
  return charCount(entry.caption) + charCount(description);
}

export type Timing = 'timer' | 'media';

export interface ItemTiming {
  /** "timer": the player's clock decides; "media": the <video>/<audio> element does. */
  timing: Timing;
  /** Planned duration in ms (for media: the duration known from the data file). */
  durationMs: number;
}

/**
 * Planned timing of an entry. `dataSaver` turns videos into poster slides (no autoplay), which
 * then last like a photo until the visitor taps "play".
 */
export function itemTiming(entry: Entry, locale: LocaleCode, opts: { dataSaver?: boolean } = {}): ItemTiming {
  switch (entry.kind) {
    case 'photo':
      return { timing: 'timer', durationMs: photoDurationMs(overlayTextChars(entry, locale)) };
    case 'video':
      return opts.dataSaver
        ? { timing: 'timer', durationMs: photoDurationMs(overlayTextChars(entry, locale)) }
        : { timing: 'media', durationMs: mediaDurationMs(entry.video.duration) };
    case 'gif':
      return { timing: 'timer', durationMs: gifDurationMs(entry.video.duration) };
    case 'voice':
      return { timing: 'media', durationMs: mediaDurationMs(entry.audio.duration) };
    case 'text':
      return { timing: 'timer', durationMs: textStatusDurationMs(entry.text.body) };
    case 'note':
      return { timing: 'timer', durationMs: noteDurationMs(pickText(entry.note, locale, entry.orig)?.text ?? '') };
    case 'story':
      return { timing: 'timer', durationMs: DURATIONS.storyMs };
  }
}
