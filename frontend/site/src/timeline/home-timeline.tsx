/** Timeline data states around the zoomable list: loading, error, empty, ready. */
import { Trans } from '@lingui/react/macro';
import type { LocaleCode } from '@omw/contracts/i18n';
import { PaperPlane } from '../components/icons';
import { useTimeline, useTimelineV } from '../data/hooks';
import type { HomeSearch } from './search';
import { TimelineSkeleton, ZoomableTimeline } from './timeline';

export function HomeTimeline({ locale, search, active }: { locale: LocaleCode; search: HomeSearch; active: boolean }) {
  const { data: timeline, isPending, error, refetch } = useTimeline();
  const v = useTimelineV();

  if (error && !timeline) {
    return (
      <div role="alert" className="mx-auto mt-6 max-w-md px-gutter text-center">
        <div className="rounded-card bg-surface p-8 shadow-soft">
          <p className="font-display text-2xl text-ink soft">
            <Trans>The timeline could not be loaded</Trans>
          </p>
          <p className="mt-2 text-muted">
            <Trans>Maybe the connection dropped for a moment.</Trans>
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="press mt-5 rounded-pill bg-accent px-5 py-2.5 font-bold text-on-accent shadow-soft hover:bg-accent-strong"
          >
            <Trans>Try again</Trans>
          </button>
        </div>
      </div>
    );
  }
  if (isPending || !timeline || !v) return <TimelineSkeleton />;
  if (timeline.days.length === 0) return <EmptyState />;
  return <ZoomableTimeline timeline={timeline} timelineV={v} locale={locale} search={search} active={active} />;
}

export function EmptyState() {
  return (
    <div className="mx-auto max-w-md px-gutter pt-10 pb-24 text-center">
      <div className="relative mx-auto h-40 w-56" aria-hidden="true">
        <svg viewBox="0 0 224 160" aria-hidden="true" className="absolute inset-0 size-full text-lilac-strong">
          <path
            d="M12 140C50 150 70 96 112 104s54 40 92-20"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray="2 10"
          />
          <circle cx="12" cy="140" r="6" fill="var(--omw-accent)" />
        </svg>
        <PaperPlane className="float-gently absolute end-2 top-6 size-16 -rotate-12 text-accent rtl:scale-x-[-1]" />
      </div>
      <h2 className="mt-4 font-display text-3xl text-ink soft">
        <Trans>No moments yet</Trans>
      </h2>
      <p className="mt-2 text-muted">
        <Trans>The journey is about to begin. Come back soon ✨</Trans>
      </p>
    </div>
  );
}
