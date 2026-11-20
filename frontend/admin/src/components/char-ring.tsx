/** Characters left in a limited text (composer notes, the greeting): a ring plus "n left". */
import { Trans } from '@lingui/react/macro';

export function CharRing({ used, max }: { used: number; max: number }) {
  const left = max - used;
  const r = 13;
  const c = 2 * Math.PI * r;
  const ratio = Math.min(1, used / max);
  return (
    <span className="inline-flex items-center gap-2 text-sm font-bold tabular-nums" aria-live="polite">
      <svg viewBox="0 0 32 32" className="size-7 -rotate-90" aria-hidden="true">
        <circle cx="16" cy="16" r={r} fill="none" stroke="var(--omw-line)" strokeWidth="3" />
        <circle
          cx="16"
          cy="16"
          r={r}
          fill="none"
          stroke={left < 0 ? 'var(--omw-danger)' : left < 20 ? 'var(--omw-violet)' : 'var(--omw-accent)'}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${ratio * c} ${c}`}
          className="transition-[stroke-dasharray] duration-200"
        />
      </svg>
      <span className={left < 0 ? 'text-danger' : left < 20 ? 'text-violet' : 'text-muted'}>
        <Trans>{left} left</Trans>
      </span>
    </span>
  );
}
