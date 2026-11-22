/**
 * The shield card (spec-wave5 §7.5, also on Safety §7.6): who sees the journey, the lock switch
 * (Q6) and whether access changes are in effect yet.
 *   unlocked → "Only invited people see the journey" [Lock now] (confirm first)
 *   locked   → "Locked since {time} (admin / panic link / computer at home)" [Unlock] (password)
 *   ops pending or the writer blocked → "Changes not in effect yet" [Try again]
 * Lock and unlock are immediate actions (api/access.ts); the unlock password lives only in this
 * card's state and in the one request's closure.
 */
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AccessSummary } from '@omw/contracts/access';
import { formatDateTime, formatRelative } from '@omw/ui/locale';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { accessApi, accessErrorMessage, noteAccessSummary, notifyAccessError, useAccessAction } from '../api/access';
import { ApiRequestError } from '../api/client';
import { ak, qk } from '../api/keys';
import { useLocale, useNow } from '../lib/hooks';
import { deviceTimeZone } from '../lib/places';
import { ConfirmSheet } from './confirm-sheet';
import { ClockIcon, LockIcon, RefreshIcon, ShieldIcon, UnlockIcon } from './icons';
import { Button, cx, Dialog, Field, TextInput } from './ui';

function LockedBy({ by }: { by: AccessSummary['lockedBy'] }) {
  switch (by) {
    case 'admin':
      return <Trans>by you in the admin</Trans>;
    case 'panic':
      return <Trans>with the panic link</Trans>;
    case 'mac':
      return <Trans>on your computer at home</Trans>;
    default:
      return null;
  }
}

/** Password re-entry before unlocking (Q6). */
function UnlockDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useLingui();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const action = useAccessAction();
  function close() {
    setPassword('');
    setError(null);
    onClose();
  }
  function submit() {
    if (!password || action.isPending) return;
    setError(null);
    const typed = password;
    action.mutate(
      {
        what: msg`Website unlocked`,
        call: () => accessApi.lock({ locked: false, password: typed }),
        handles: () => true,
      },
      {
        onSuccess: () => close(),
        onError: (err) => {
          if (err instanceof ApiRequestError && err.status === 0) {
            setError(i18n._(msg`Not sent – no connection`));
            return;
          }
          setError(i18n._(accessErrorMessage(err).message));
        },
      },
    );
  }
  return (
    <Dialog
      open={open}
      onClose={close}
      closeLabel={t`Close`}
      title={<Trans>Unlock the website?</Trans>}
      description={<Trans>Enter your password. Invited people then see the journey again right away.</Trans>}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            <Trans>Keep locked</Trans>
          </Button>
          <Button type="submit" form="unlock-form" icon={UnlockIcon} busy={action.isPending} disabled={!password}>
            <Trans>Unlock</Trans>
          </Button>
        </>
      }
    >
      <form
        id="unlock-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label={<Trans>Password</Trans>} error={error}>
          {(ids) => (
            <TextInput
              {...ids}
              data-testid="unlock-password"
              type="password"
              autoComplete="current-password"
              dir="ltr"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

export function LockCard({ access, className }: { access: AccessSummary; className?: string }) {
  const locale = useLocale();
  const now = useNow();
  const qc = useQueryClient();
  const [confirmLock, setConfirmLock] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const action = useAccessAction();
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
  const behind = access.pendingOps > 0 || access.writer.blocked;
  const lockedSince = access.lockedAt ? formatDateTime(access.lockedAt, deviceTimeZone(), locale) : null;
  return (
    <section
      aria-labelledby="shield-h"
      data-testid="lock-card"
      className={cx('min-w-0 rounded-card p-5 shadow-soft', access.locked ? 'bg-ink text-bg' : 'bg-surface', className)}
    >
      <div className="flex items-start gap-4">
        <span
          className={cx(
            'grid size-12 shrink-0 place-items-center rounded-pill',
            access.locked ? 'bg-bg/15 text-bg' : 'bg-success/14 text-success-strong',
          )}
        >
          {access.locked ? <LockIcon className="size-6" /> : <ShieldIcon className="size-6" />}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="shield-h" className="display-soft text-xl leading-tight font-semibold">
            {access.locked ? (
              lockedSince ? (
                <Trans>Locked since {lockedSince}</Trans>
              ) : (
                <Trans>Locked</Trans>
              )
            ) : (
              <Trans>Only invited people see the journey</Trans>
            )}
          </h2>
          <p className={cx('mt-1 text-sm', access.locked ? 'text-bg/80' : 'text-muted')}>
            {access.locked ? (
              <>
                <LockedBy by={access.lockedBy} />
                {access.lockedBy ? ' · ' : ''}
                <Trans>Everyone sees only the neutral page, invited people too.</Trans>
              </>
            ) : (
              <Trans>Everyone else sees a neutral page.</Trans>
            )}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {access.locked ? (
              <Button size="md" variant="secondary" icon={UnlockIcon} onClick={() => setUnlocking(true)}>
                <Trans>Unlock</Trans>
              </Button>
            ) : (
              <Button size="md" variant="secondary" icon={LockIcon} onClick={() => setConfirmLock(true)}>
                <Trans>Lock now</Trans>
              </Button>
            )}
          </div>
        </div>
      </div>
      {behind && (
        <div
          className={cx(
            'mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-tile px-3 py-2.5 text-sm',
            access.locked ? 'bg-bg/10' : 'bg-lilac text-ink',
          )}
          data-testid="access-behind"
        >
          <ClockIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 font-semibold">
            <Trans>Changes not in effect yet</Trans>
            {access.oldestPendingOpAt && (
              <span className="font-normal opacity-80"> · {formatRelative(access.oldestPendingOpAt, locale, now)}</span>
            )}
          </span>
          <Button
            size="sm"
            variant="secondary"
            icon={RefreshIcon}
            busy={retry.isPending}
            onClick={() => retry.mutate()}
          >
            <Trans>Retry</Trans>
          </Button>
        </div>
      )}
      <ConfirmSheet
        open={confirmLock}
        title={<Trans>Lock the website now?</Trans>}
        description={
          <Trans>Everyone immediately sees only the neutral page, invited people too. Nothing is deleted.</Trans>
        }
        confirmLabel={<Trans>Lock now</Trans>}
        confirmIcon={LockIcon}
        busy={action.isPending}
        onClose={() => setConfirmLock(false)}
        onConfirm={() =>
          action.mutate(
            { what: msg`Website locked`, call: () => accessApi.lock({ locked: true }) },
            { onSettled: () => setConfirmLock(false) },
          )
        }
      />
      <UnlockDialog open={unlocking} onClose={() => setUnlocking(false)} />
    </section>
  );
}
