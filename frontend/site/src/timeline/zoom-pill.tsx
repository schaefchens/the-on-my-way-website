/** Floating zoom pill "Jahre · Monate · Tage" (plan C). Keys +/- and 1-3 do the same. */
import { useLingui } from '@lingui/react/macro';
import { ZOOM_LEVELS, type ZoomLevel } from './search';

export function ZoomPill({
  level,
  onSelect,
  disabled,
}: {
  level: ZoomLevel;
  onSelect: (level: ZoomLevel) => void;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const labels: Record<ZoomLevel, string> = { trips: t`Years`, months: t`Months`, days: t`Days` };
  const index = ZOOM_LEVELS.indexOf(level);
  return (
    <div className="zoom-pill-dock pointer-events-none fixed inset-x-0 bottom-0 z-10 flex justify-center px-gutter">
      <fieldset
        aria-label={t`Zoom (keys + and −, 1 to 3)`}
        className="pointer-events-auto relative grid grid-cols-3 rounded-pill border border-line/70 bg-surface/85 p-1 shadow-float backdrop-blur-md"
        style={{ '--i': index } as React.CSSProperties}
      >
        <span aria-hidden="true" className="zoom-pill-thumb absolute inset-y-1 rounded-pill bg-accent shadow-soft" />
        {ZOOM_LEVELS.map((z, i) => (
          <button
            key={z}
            type="button"
            disabled={disabled}
            aria-pressed={z === level}
            aria-keyshortcuts={String(i + 1)}
            onClick={() => onSelect(z)}
            className="press relative z-[1] min-w-[5.25rem] rounded-pill px-3 py-2 text-sm font-bold text-muted hover:text-ink aria-pressed:text-on-accent sm:min-w-24"
          >
            {labels[z]}
          </button>
        ))}
      </fieldset>
    </div>
  );
}
