/**
 * Full-screen states of the access layer (spec-wave5 §6.3): "checking" while the SPA asks the API
 * why a request was refused, and "locked" / "unavailable" afterwards. Renders no data and starts
 * no query (the cache was just emptied; a refetch would only be refused again).
 */
import { Trans } from '@lingui/react/macro';
import type { AccessState } from './access';

export function AccessEndedScreen({ state, gate }: { state: Exclude<AccessState, 'ok'>; gate: boolean }) {
  if (state === 'checking') {
    return (
      <div className="grid min-h-dvh place-items-center" aria-busy="true">
        <span role="status" className="flex items-center gap-3 text-muted">
          <span aria-hidden="true" className="size-3 rounded-full bg-accent motion-safe:animate-pulse" />
          <Trans>One moment …</Trans>
        </span>
      </div>
    );
  }
  return (
    <div className="relative grid min-h-dvh place-items-center px-gutter py-section">
      <div aria-hidden="true" className="page-grain pointer-events-none fixed inset-0" />
      <main className="relative w-full max-w-md rounded-card bg-surface p-8 text-center shadow-soft" role="alert">
        <h1 className="font-display text-3xl font-semibold text-balance text-ink soft">
          <Trans>The journey is not available right now.</Trans>
        </h1>
        <p className="mt-3 text-muted">
          <Trans>Please try again in a moment.</Trans>
        </p>
        <div className="mt-7 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="press inline-flex h-11 items-center rounded-pill bg-accent px-6 font-bold text-on-accent shadow-soft hover:bg-accent-strong"
          >
            <Trans>Try again</Trans>
          </button>
          {gate && (
            <a
              href="/_/me/"
              className="press rounded-pill px-3 py-2 font-semibold text-violet underline underline-offset-4"
            >
              <Trans>Your data</Trans>
            </a>
          )}
        </div>
      </main>
    </div>
  );
}
