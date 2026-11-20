import { Trans, useLingui } from '@lingui/react/macro';
import { useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { useNewMoments } from '../data/hooks';
import { useSite } from '../site';
import { CloseIcon, SparkleIcon } from './icons';

/**
 * "New moments ✨" when the manifest changed since the page loaded (plan C, polled every 5 min).
 * Accepting switches to the new timeline; `onAccepted` then shows its top, where the new moments
 * are (newest first).
 */
export function NewMomentsToast({ onAccepted }: { onAccepted?: () => void }) {
  const { newTimelineV } = useNewMoments();
  const site = useSite();
  const router = useRouter();
  const { t } = useLingui();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const pending = newTimelineV && newTimelineV !== dismissed ? newTimelineV : null;
  // The live region is always mounted (screen readers announce changes inside an existing region,
  // not a region that appears together with its content).
  return (
    <div
      className="toast-dock pointer-events-none fixed inset-x-0 z-30 flex justify-center px-gutter"
      aria-live="polite"
    >
      {pending && (
        <div className="toast-in pointer-events-auto flex items-center gap-1 rounded-pill bg-accent p-1 text-on-accent shadow-float">
          <button
            type="button"
            onClick={() => {
              site.timelineVersion.set(pending);
              void router.invalidate();
              onAccepted?.();
            }}
            className="press flex items-center gap-2 rounded-pill py-2 ps-3 pe-4 font-bold hover:bg-accent-strong"
          >
            <SparkleIcon className="size-5" />
            <Trans>New moments</Trans>
          </button>
          <button
            type="button"
            onClick={() => setDismissed(pending)}
            aria-label={t`Dismiss`}
            className="press grid size-9 place-items-center rounded-full hover:bg-accent-strong"
          >
            <CloseIcon className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
