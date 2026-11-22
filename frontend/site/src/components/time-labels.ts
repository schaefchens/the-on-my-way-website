/**
 * Coarse time labels for the setting "site.time_precision" = part_of_day (spec-wave5 §5.2, §6.3):
 * the generator already moved every published time into its 3-hour bucket (coarsenToBucket); the
 * SPA then names the part of the day ("morgens", "in the morning") instead of a clock time, and
 * the hero's relative time shows whole days only ("heute", "gestern", "vor 3 Tagen").
 */
import { msg } from '@lingui/core/macro';
import type { LocaleCode } from '@omw/contracts/i18n';
import { type PartOfDay, timeBucket } from '@omw/contracts/time';
import { intlLocale } from '@omw/ui/locale';
import { i18n } from '../i18n';

const PART_OF_DAY = {
  night: msg`at night`,
  morning: msg`in the morning`,
  midday: msg`at midday`,
  afternoon: msg`in the afternoon`,
  evening: msg`in the evening`,
} as const satisfies Record<PartOfDay, unknown>;

/** "morgens" / "in the morning" for an instant in the traveler's zone ("" when it is unusable). */
export function partOfDayLabel(at: string, tz: string): string {
  try {
    return i18n._(PART_OF_DAY[timeBucket(at, tz).partOfDay]);
  } catch {
    return '';
  }
}

/** Start of the calendar day of `t` in the viewer's zone, as a UTC day number. */
function dayNumber(t: number): number {
  const d = new Date(t);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

/** "heute" / "gestern" / "vor 3 Tagen": whole calendar days between `instant` and `now`. */
export function formatRelativeDays(instant: string, locale: LocaleCode, now: number = Date.now()): string {
  const t = Date.parse(instant);
  if (!Number.isFinite(t)) return '';
  const days = dayNumber(now) - dayNumber(t);
  return new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' }).format(-days, 'day');
}
