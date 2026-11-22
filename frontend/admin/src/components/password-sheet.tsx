/**
 * Settings → Account → "Change password" (spec-wave5 §7.8, owner addition): current password,
 * new password, repeat; a strength hint (≥ 12 characters required; weak/medium/strong from the
 * length, the character classes and a common-password list loaded on first open); with app tokens
 * a pre-ticked box to end them too. PUT /admin/me/password → 204: the other devices are logged out
 * (this session stays). The passwords live in this sheet's state only and are dropped on close;
 * the request runs outside the offline queue and is never persisted.
 */
import { msg } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { accessApi, accessErrorMessage } from '../api/access';
import { ApiRequestError } from '../api/client';
import { ak, qk } from '../api/keys';
import { tokensQuery } from '../api/queries';
import { notify } from '../lib/notices';
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  type PasswordStrength,
  passwordLength,
  passwordStrength,
} from '../lib/password-strength';
import { EyeIcon, EyeOffIcon, KeyIcon } from './icons';
import { Button, cx, Dialog, ErrorDetails, Field, TextInput } from './ui';

let commonList: Promise<ReadonlySet<string>> | null = null;
function loadCommonList(): Promise<ReadonlySet<string>> {
  commonList ??= import('../lib/common-passwords').then((m) => m.COMMON_PASSWORDS);
  return commonList;
}

function StrengthMeter({ strength }: { strength: PasswordStrength | null }) {
  const level = strength === 'strong' ? 3 : strength === 'medium' ? 2 : strength === 'weak' ? 1 : 0;
  const tone =
    strength === 'strong' ? 'bg-success' : strength === 'medium' ? 'bg-violet' : strength ? 'bg-danger' : 'bg-line';
  return (
    <div className="mt-2" data-testid="password-strength" data-strength={strength ?? 'empty'}>
      <div className="flex gap-1" aria-hidden="true">
        {[1, 2, 3].map((i) => (
          <span key={i} className={cx('h-1.5 flex-1 rounded-pill', i <= level ? tone : 'bg-line')} />
        ))}
      </div>
      <p className="mt-1 text-xs font-semibold text-muted" aria-live="polite">
        {strength === 'too_short' ? (
          <Trans>Too short: at least 12 characters</Trans>
        ) : strength === 'weak' ? (
          <Trans>Weak – easy to guess. Longer is better, e.g. a few words.</Trans>
        ) : strength === 'medium' ? (
          <Trans>Medium</Trans>
        ) : strength === 'strong' ? (
          <Trans>Strong</Trans>
        ) : null}
      </p>
    </div>
  );
}

function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  error,
  hint,
  testId,
}: {
  label: ReactNode;
  value: string;
  onChange: (v: string) => void;
  autoComplete: 'current-password' | 'new-password';
  error?: ReactNode;
  hint?: ReactNode;
  testId: string;
}) {
  const { t } = useLingui();
  const [shown, setShown] = useState(false);
  return (
    <Field label={label} error={error} hint={hint}>
      {(ids) => (
        <div className="relative">
          <TextInput
            {...ids}
            data-testid={testId}
            type={shown ? 'text' : 'password'}
            autoComplete={autoComplete}
            dir="ltr"
            spellCheck={false}
            maxLength={PASSWORD_MAX}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="pe-12"
          />
          <button
            type="button"
            aria-label={shown ? t`Hide password` : t`Show password`}
            aria-pressed={shown}
            onClick={() => setShown((v) => !v)}
            className="press absolute inset-y-0 end-0 grid w-11 place-items-center rounded-pill text-muted hover:text-ink"
          >
            {shown ? <EyeOffIcon className="size-5" /> : <EyeIcon className="size-5" />}
          </button>
        </div>
      )}
    </Field>
  );
}

export function PasswordSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useLingui();
  const qc = useQueryClient();
  const { me } = useRouteContext({ from: '/authed' });
  const tokens = useQuery({ ...tokensQuery(), enabled: open });
  const appTokens = (tokens.data?.items ?? []).filter((tk) => tk.kind === 'app' && tk.revokedAt === null).length;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [revokeApps, setRevokeApps] = useState(true);
  const [common, setCommon] = useState<ReadonlySet<string> | null>(null);
  const [error, setError] = useState<{ text: string; detail: string | null } | null>(null);
  const checkId = useId();

  useEffect(() => {
    if (!open) {
      // Closing forgets everything typed.
      setCurrent('');
      setNext('');
      setRepeat('');
      setRevokeApps(true);
      setError(null);
      return;
    }
    let alive = true;
    void loadCommonList()
      .then((set) => alive && setCommon(set))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open]);

  const strength = next ? passwordStrength(next, { common, email: me.email }) : null;
  const longEnough = passwordLength(next) >= PASSWORD_MIN;
  const same = next !== '' && next === current;
  const mismatch = repeat !== '' && repeat !== next;
  const ready = current !== '' && longEnough && !same && repeat === next;

  const change = useMutation({
    mutationKey: ak.password,
    retry: 0,
    networkMode: 'always',
    gcTime: 0,
    // The passwords stay in this closure: no mutation variables.
    mutationFn: () =>
      accessApi.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeAppTokens: appTokens > 0 && revokeApps,
      }),
    onSuccess: () => {
      notify({ tone: 'success', message: msg`Password changed. Other devices were logged out.` });
      void qc.invalidateQueries({ queryKey: qk.tokens });
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiRequestError && err.status === 0) {
        setError({ text: i18n._(msg`Not sent – no connection`), detail: null });
        return;
      }
      if (err instanceof ApiRequestError && err.status === 422) {
        // The API's reason (too weak, same as before, the e-mail address) is the useful part.
        const reason = err.message;
        setError({ text: i18n._(msg`The server did not accept the new password: ${reason}`), detail: null });
        return;
      }
      const m = accessErrorMessage(err);
      setError({ text: i18n._(m.message), detail: m.detail });
    },
  });

  return (
    <Dialog
      open={open}
      onClose={() => !change.isPending && onClose()}
      closeLabel={t`Close`}
      title={<Trans>Change password</Trans>}
      description={<Trans>Afterwards every other device that is logged in has to log in again.</Trans>}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={change.isPending}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            type="submit"
            form="password-change"
            icon={KeyIcon}
            busy={change.isPending}
            disabled={!ready || change.isPending}
          >
            <Trans>Change password</Trans>
          </Button>
        </>
      }
    >
      <form
        id="password-change"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready || change.isPending) return;
          setError(null);
          change.mutate();
        }}
      >
        {/* Lets password managers attach the new password to the right account. */}
        <input type="text" name="username" autoComplete="username" value={me.email} readOnly hidden />
        <PasswordField
          label={<Trans>Current password</Trans>}
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
          testId="password-current"
        />
        <div>
          <PasswordField
            label={<Trans>New password</Trans>}
            value={next}
            onChange={setNext}
            autoComplete="new-password"
            testId="password-new"
            error={same ? <Trans>The new password is the same as the current one.</Trans> : undefined}
          />
          <StrengthMeter strength={strength} />
        </div>
        <PasswordField
          label={<Trans>Repeat the new password</Trans>}
          value={repeat}
          onChange={setRepeat}
          autoComplete="new-password"
          testId="password-repeat"
          error={mismatch ? <Trans>The two new passwords are not the same.</Trans> : undefined}
        />
        {appTokens > 0 && (
          <label
            htmlFor={checkId}
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-tile bg-bg px-3 py-2.5"
          >
            <input
              id={checkId}
              type="checkbox"
              data-testid="password-revoke-apps"
              checked={revokeApps}
              onChange={(e) => setRevokeApps(e.target.checked)}
              className="mt-0.5 size-5 shrink-0 accent-[var(--omw-accent)]"
            />
            <span className="text-sm">
              <span className="block font-bold">
                <Plural
                  value={appTokens}
                  one="Also end all app access (# token)"
                  other="Also end all app access (# tokens)"
                />
              </span>
              <span className="block text-muted">
                <Trans>Recommended. Your computer at home keeps its access.</Trans>
              </span>
            </span>
          </label>
        )}
        {error && (
          <div role="alert" className="rounded-tile bg-danger/10 px-3 py-2.5 text-sm text-danger">
            <p className="font-bold">{error.text}</p>
            <ErrorDetails detail={error.detail} />
          </div>
        )}
      </form>
    </Dialog>
  );
}
