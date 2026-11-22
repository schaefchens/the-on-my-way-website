/**
 * What the last access action achieved (spec-wave5 §7.2):
 *   applied        → "In effect ✓"
 *   not applied    → "Not in effect yet ⏳ – …" + [Try again] (POST /admin/access/retry); polls
 *                    GET /admin/access every few seconds and turns into "In effect ✓" once no op is
 *                    pending any more
 *   network error  → "Not sent – no connection" (never a success state)
 * Rendered where the owner acted (People, a person, Home, Safety).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  type ActionOutcome,
  accessApi,
  dismissEffect,
  type EffectEntry,
  effectStore,
  noteAccessSummary,
  notifyAccessError,
  settleEffect,
} from '../api/access';
import { ak, qk } from '../api/keys';
import { accessStatusQuery } from '../api/queries';
import { useStore } from '../lib/store';
import { AlertIcon, CheckIcon, ClockIcon, CloseIcon, RefreshIcon } from './icons';
import { Button, cx, IconButton } from './ui';

/** How long a settled "In effect ✓" stays on screen. */
const APPLIED_VISIBLE_MS = 6000;
const PENDING_POLL_MS = 3000;

/** The visible line for one outcome (pure: also used by tests). */
export function EffectLine({
  outcome,
  writerMode,
  onRetry,
  retrying = false,
}: {
  outcome: ActionOutcome;
  /** 'none': the Mac at home writes the store, so the wait has another reason. */
  writerMode?: 'direct' | 'sftp' | 'none' | undefined;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  switch (outcome.kind) {
    case 'applied':
      return (
        <span className="inline-flex items-center gap-1.5 font-bold text-success-strong" data-effect="applied">
          <CheckIcon className="size-4" />
          <Trans>In effect ✓</Trans>
        </span>
      );
    case 'not_applied':
      return (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-2" data-effect="pending">
          <span className="inline-flex items-start gap-1.5 font-bold text-violet">
            <ClockIcon className="mt-0.5 size-4 shrink-0" />
            {writerMode === 'none' ? (
              <Trans>Not in effect yet ⏳ – your computer at home applies it as soon as it runs</Trans>
            ) : (
              <Trans>Not in effect yet ⏳ – the website storage cannot be reached right now</Trans>
            )}
          </span>
          {onRetry && (
            <Button size="sm" variant="secondary" icon={RefreshIcon} busy={retrying} onClick={onRetry}>
              <Trans>Retry</Trans>
            </Button>
          )}
        </span>
      );
    case 'unsent':
      return (
        <span className="inline-flex items-center gap-1.5 font-bold text-danger" data-effect="unsent">
          <AlertIcon className="size-4" />
          <Trans>Not sent – no connection</Trans>
        </span>
      );
    default:
      return null;
  }
}

/** The last access action's effect, settling itself while the store catches up. */
export function EffectBadge({ className }: { className?: string }) {
  const { i18n, t } = useLingui();
  const qc = useQueryClient();
  const entry = useStore(effectStore);
  const pending = entry?.outcome.kind === 'not_applied';
  const status = useQuery({
    ...accessStatusQuery(),
    enabled: pending,
    refetchInterval: pending ? PENDING_POLL_MS : false,
  });
  const retry = useMutation({
    mutationKey: ak.action,
    retry: 0,
    networkMode: 'always',
    gcTime: 0,
    mutationFn: () => accessApi.retry(),
    onSuccess: (fresh) => {
      qc.setQueryData(qk.access.status, fresh);
      noteAccessSummary(qc, fresh);
    },
    onError: (err) => notifyAccessError(err),
  });

  // Settle "not applied" once a status fetched after the action shows no pending op.
  useEffect(() => {
    if (entry?.outcome.kind !== 'not_applied' || !status.data) return;
    const settled = settleEffect(entry, status.data, status.dataUpdatedAt);
    if (settled !== entry) effectStore.set(settled);
  }, [entry, status.data, status.dataUpdatedAt]);

  // A settled success goes away by itself; failures stay until dismissed.
  useEffect(() => {
    if (entry?.outcome.kind !== 'applied') return;
    const id = entry.id;
    const timer = setTimeout(() => dismissEffect(id), APPLIED_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [entry]);

  if (!entry) return null;
  return (
    <EffectCard
      entry={entry}
      what={i18n._(entry.values ? { ...entry.what, values: { ...entry.what.values, ...entry.values } } : entry.what)}
      writerMode={status.data?.writer.mode}
      className={className}
      closeLabel={t`Close`}
      onRetry={() => retry.mutate()}
      retrying={retry.isPending}
    />
  );
}

export function EffectCard({
  entry,
  what,
  writerMode,
  className,
  closeLabel,
  onRetry,
  retrying,
}: {
  entry: EffectEntry;
  what: string;
  writerMode?: 'direct' | 'sftp' | 'none' | undefined;
  className?: string | undefined;
  closeLabel: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const tone =
    entry.outcome.kind === 'applied' ? 'bg-success/12' : entry.outcome.kind === 'unsent' ? 'bg-danger/10' : 'bg-lilac';
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="effect-badge"
      className={cx('flex items-start gap-3 rounded-card px-4 py-3 text-sm shadow-soft', tone, className)}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-semibold text-ink">{what}</p>
        <EffectLine
          outcome={entry.outcome}
          writerMode={writerMode}
          {...(onRetry ? { onRetry } : {})}
          {...(retrying !== undefined ? { retrying } : {})}
        />
      </div>
      <IconButton
        label={closeLabel}
        icon={CloseIcon}
        size="sm"
        className="-me-2 -mt-1"
        onClick={() => dismissEffect(entry.id)}
      />
    </div>
  );
}
