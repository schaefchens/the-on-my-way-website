import { Trans, useLingui } from '@lingui/react/macro';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { ApiRequestError, adminApi, isNetworkError } from '../api/client';
import { authQueryOptions, safeRedirect } from '../auth';
import { CloudOffIcon, EyeIcon, EyeOffIcon, PlaneIcon } from '../components/icons';
import { Button, Field, IconButton, TextInput } from '../components/ui';
import { friendlyError } from '../lib/errors';
import { completeLogin } from '../session';

export function LoginScreen() {
  const { t, i18n } = useLingui();
  const search = useSearch({ from: '/login' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: auth } = useQuery(authQueryOptions);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const me = await adminApi.login({
        email: String(form.get('email') ?? '').trim(),
        password: String(form.get('password') ?? ''),
      });
      await completeLogin(queryClient, me);
      await navigate({ href: safeRedirect(search.redirect) });
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) setError(t`E-mail or password is not right.`);
      else if (err instanceof ApiRequestError && err.status === 429)
        setError(t`Too many attempts. Please wait a few minutes.`);
      else if (isNetworkError(err)) setError(t`No connection to the server. Check your internet and try again.`);
      else setError(i18n._(friendlyError(err).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-5 py-12">
      <div className="mb-8 text-center">
        <span className="mx-auto mb-5 grid size-16 rotate-[-6deg] place-items-center rounded-[1.25rem] bg-linear-to-br from-rose-600 to-violet-700 text-cream shadow-lift">
          <PlaneIcon className="size-8" />
        </span>
        <h1 className="display-soft text-[2.6rem] leading-none font-semibold">On My Way</h1>
        <p className="mt-3 font-hand text-lg text-accent">
          <Trans>Your travel journal is waiting for you</Trans>
        </p>
      </div>
      {auth?.error && (
        <p role="status" className="mb-5 flex items-start gap-3 rounded-card bg-lilac p-4 text-sm">
          <CloudOffIcon className="mt-0.5 size-5 text-violet" />
          <span>
            <Trans>The server is not reachable right now. You can still log in once it answers again.</Trans>
          </span>
        </p>
      )}
      <form
        onSubmit={onSubmit}
        className="washi-tape mt-3 space-y-5 rounded-sheet bg-surface p-6 shadow-lift sm:p-8"
        noValidate={false}
      >
        <Field label={<Trans>E-mail</Trans>}>
          {(ids) => (
            <TextInput
              {...ids}
              name="email"
              type="email"
              dir="ltr"
              autoComplete="username"
              inputMode="email"
              required
              autoFocus
            />
          )}
        </Field>
        <Field label={<Trans>Password</Trans>}>
          {(ids) => (
            <div className="relative">
              <TextInput
                {...ids}
                name="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                required
                className="pe-12"
              />
              <IconButton
                label={showPassword ? t`Hide password` : t`Show password`}
                icon={showPassword ? EyeOffIcon : EyeIcon}
                size="sm"
                className="absolute end-1 top-1/2 -translate-y-1/2"
                onClick={() => setShowPassword((v) => !v)}
              />
            </div>
          )}
        </Field>
        {error && (
          <p className="rounded-tile bg-danger/10 px-3 py-2 text-sm font-semibold text-danger" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" busy={busy} className="w-full">
          <Trans>Log in</Trans>
        </Button>
      </form>
      <p className="mt-6 text-center text-xs text-muted">
        <Trans>Only for you. You stay logged in on this device.</Trans>
      </p>
    </main>
  );
}
