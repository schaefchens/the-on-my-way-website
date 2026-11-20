/** Signature touches (plan C, "Design system"): passport stamps, the "here now" chip. */
import { Trans } from '@lingui/react/macro';
import type { LocaleCode } from '@omw/contracts/i18n';
import { countryFlag, countryName, formatLocalDate } from '@omw/ui/locale';
import { useNow } from './now';

/** Deterministic small rotation per key, so stamps and polaroids look hand-placed but stable. */
export function tilt(key: string, max = 6): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return ((Math.abs(h) % 1000) / 1000) * 2 * max - max;
}

/** Passport stamp for the first day in a country. Decorative; the day header names the country. */
export function PassportStamp({
  country,
  date,
  locale,
  className = '',
  style,
}: {
  country: string;
  date: string;
  locale: LocaleCode;
  className?: string;
  style?: React.CSSProperties;
}) {
  const rotation = -8 + tilt(`${country}${date}`, 5);
  return (
    <div
      aria-hidden="true"
      className={`passport-stamp pointer-events-none select-none ${className}`}
      style={{ ...style, rotate: `${rotation}deg` }}
    >
      <span className="text-lg leading-none">{countryFlag(country)}</span>
      <span className="max-w-[7.5rem] truncate text-[0.7rem] leading-tight font-extrabold tracking-[0.14em] uppercase">
        {countryName(country, locale)}
      </span>
      <span className="text-[0.6rem] leading-none font-bold tracking-[0.1em] uppercase opacity-80">
        {formatLocalDate(date, locale, 'short')}
      </span>
    </div>
  );
}

/** Pulsing chip on the newest day: "here now" while it is fresh, "last seen here" after. */
export function HereNowChip({ live, className = '' }: { live: boolean; className?: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-pill px-2.5 py-1 text-xs font-bold ${
        live ? 'bg-accent text-on-accent motion-safe:animate-here-now' : 'bg-lilac text-violet'
      } ${className}`}
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${live ? 'bg-on-accent' : 'bg-violet'}`} />
      <span className="truncate">{live ? <Trans>Here now</Trans> : <Trans>Last seen here</Trans>}</span>
    </span>
  );
}

/** The newest day's chip, live while its last moment is recent; it keeps time (W2-19). */
export function LatestDayChip({ lastAt, className }: { lastAt: string; className?: string }) {
  const now = useNow();
  return <HereNowChip live={isLive(lastAt, now)} {...(className ? { className } : {})} />;
}

/** Whether the newest day still counts as "here now" (its last moment within 48 hours). */
export function isLive(lastAt: string, now: number = Date.now()): boolean {
  const t = Date.parse(lastAt);
  return Number.isFinite(t) && now - t < 48 * 3600_000 && now - t > -3600_000;
}
