/**
 * Settings → "Connect a phone" (app-plan §3.6–3.7, owner decisions Q4 a, Q8 a): a one-time code for
 * the On My Way app (typed "ABCD-EFGH" or the omw:// link), the connected phones with Disconnect,
 * and what the API's app inbox holds. A phone's token can only send and hide its own moments.
 *
 * The code is shown once, kept only in this component's state (never cached), single use and
 * valid 1 h or 24 h; making a new one cancels the open one.
 */
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AppPairingCreated } from '@omw/contracts/app';
import type { AppPhone } from '@omw/contracts/app-inbox';
import { formatDateTime, formatNumber, formatRelative } from '@omw/ui/locale';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { appKeys, appPhonesApi, appPhonesQuery, type PAIRING_TTLS } from '../api/app-phones';
import { PhoneIcon } from '../components/app-badge';
import { CheckIcon, CopyIcon, ShareIcon, TrashIcon } from '../components/icons';
import { Badge, Button, cx, Dialog, IconButton, QueryError, Section, Segmented, Skeleton } from '../components/ui';
import { friendlyError } from '../lib/errors';
import { useLocale } from '../lib/hooks';
import { notify } from '../lib/notices';
import { deviceTimeZone } from '../lib/places';

type Ttl = `${(typeof PAIRING_TTLS)[number]}`;

function notifyError(err: unknown) {
  const friendly = friendlyError(err);
  notify({ tone: 'error', message: friendly.message, ...(friendly.detail ? { detail: friendly.detail } : {}) });
}

function megabytes(bytes: number, locale: ReturnType<typeof useLocale>): string {
  return formatNumber(bytes / (1024 * 1024), locale, { maximumFractionDigits: bytes < 10 * 1024 * 1024 ? 1 : 0 });
}

function PhoneRow({ phone, onDisconnect }: { phone: AppPhone; onDisconnect: () => void }) {
  const { t } = useLingui();
  const locale = useLocale();
  const off = phone.revokedAt !== null;
  return (
    <li
      className={cx('flex items-center gap-3 rounded-tile bg-bg px-3 py-2.5', off && 'opacity-70')}
      data-testid="app-phone"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-pill bg-lilac text-violet">
        <PhoneIcon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-bold" dir="auto">
          {phone.name}
        </span>
        <span className="block text-xs text-muted">
          {off ? (
            <Trans>disconnected {formatRelative(phone.revokedAt ?? phone.createdAt, locale)}</Trans>
          ) : phone.lastUsedAt ? (
            <Trans>last seen {formatRelative(phone.lastUsedAt, locale)}</Trans>
          ) : (
            <Trans>connected {formatRelative(phone.createdAt, locale)}</Trans>
          )}
          {' · '}
          <Trans>
            {phone.entries.total} moments, {phone.entries.inInbox} on the way
          </Trans>
        </span>
      </span>
      {!off && <IconButton label={t`Disconnect ${phone.name}`} icon={TrashIcon} size="sm" onClick={onDisconnect} />}
    </li>
  );
}

function NewCode({ code, onDone }: { code: AppPairingCreated; onDone: () => void }) {
  const { t } = useLingui();
  const locale = useLocale();
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  return (
    <div
      role="status"
      className="mt-4 rounded-card border-2 border-dashed border-accent bg-blush p-4"
      data-testid="app-pairing-code"
    >
      <p className="font-bold">
        <Trans>On the phone, open On My Way and type this code:</Trans>
      </p>
      <p dir="ltr" className="mt-2 font-mono text-3xl font-bold tracking-[0.2em] select-all">
        {code.typedCode}
      </p>
      <p className="mt-3 text-sm">
        <Trans>Or send this link to the phone (it opens the app):</Trans>
      </p>
      <div className="mt-1 flex items-center gap-2">
        <code dir="ltr" className="min-w-0 flex-1 rounded-tile bg-surface px-3 py-2 text-sm break-all select-all">
          {code.link}
        </code>
        <IconButton
          label={copied ? t`Copied` : t`Copy the link`}
          icon={copied ? CheckIcon : CopyIcon}
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(code.link).then(() => setCopied(true));
          }}
        />
        {canShare && (
          <IconButton
            label={t`Share the link`}
            icon={ShareIcon}
            variant="secondary"
            onClick={() => {
              void navigator.share({ text: code.link }).catch(() => {});
            }}
          />
        )}
      </div>
      <p className="mt-3 text-xs text-muted">
        <Trans>
          Works once, until {formatDateTime(code.expiresAt, deviceTimeZone(), locale)}. Anyone with the code can connect
          a phone, so only send it to the phone you mean.
        </Trans>
      </p>
      <Button variant="ghost" size="sm" className="mt-2" onClick={onDone}>
        <Trans>Done</Trans>
      </Button>
    </div>
  );
}

export function ConnectPhoneSection() {
  const { t } = useLingui();
  const locale = useLocale();
  const qc = useQueryClient();
  const q = useQuery(appPhonesQuery());
  const [ttl, setTtl] = useState<Ttl>('60');
  const [code, setCode] = useState<AppPairingCreated | null>(null);
  const [disconnecting, setDisconnecting] = useState<AppPhone | null>(null);
  const create = useMutation({
    mutationFn: () => appPhonesApi.createPairing(Number(ttl)),
    onSuccess: (res) => {
      setCode(res);
      void qc.invalidateQueries({ queryKey: appKeys.phones });
    },
    onError: (err) => notifyError(err),
  });
  const disconnect = useMutation({
    mutationFn: (id: number) => appPhonesApi.disconnect(id),
    onSuccess: () => {
      notify({ tone: 'success', message: msg`Phone disconnected` });
      void qc.invalidateQueries({ queryKey: appKeys.phones });
    },
    onError: (err) => notifyError(err),
  });
  const data = q.data;
  return (
    <Section
      icon={PhoneIcon}
      title={<Trans>Connect a phone</Trans>}
      description={
        <Trans>
          The On My Way app sends moments here, also when WhatsApp is not used. A connected phone can only share and
          hide its own moments.
        </Trans>
      }
      actions={
        data?.archiveOnly ? (
          <Badge tone="lilac">
            <Trans>Archive only</Trans>
          </Badge>
        ) : undefined
      }
    >
      <QueryError error={q.error} onRetry={() => void q.refetch()} />
      {q.isPending && <Skeleton className="h-14" />}
      {data?.archiveOnly && (
        <p className="mb-3 text-sm text-muted">
          <Trans>Moments from the app go to the archive at home. Nothing from the app is published yet.</Trans>
        </p>
      )}
      {data && data.items.length === 0 && (
        <p className="text-sm text-muted">
          <Trans>No phone connected yet.</Trans>
        </p>
      )}
      <ul className="space-y-2">
        {data?.items.map((phone) => (
          <PhoneRow key={phone.id} phone={phone} onDisconnect={() => setDisconnecting(phone)} />
        ))}
      </ul>
      {data && (
        <p className="mt-3 text-xs text-muted">
          <Trans>
            Inbox on the server: {megabytes(data.inbox.usedBytes, locale)} of {megabytes(data.inbox.maxBytes, locale)}{' '}
            MB in use.
          </Trans>
          {data.openPairing && !code && (
            <>
              {' '}
              <Trans>
                An unused code is valid until {formatDateTime(data.openPairing.expiresAt, deviceTimeZone(), locale)}.
              </Trans>
            </>
          )}
        </p>
      )}
      {code && <NewCode code={code} onDone={() => setCode(null)} />}
      <div className="mt-5 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center">
        <Segmented<Ttl>
          label={t`Code valid for`}
          value={ttl}
          size="sm"
          options={[
            { value: '60', label: t`1 hour` },
            { value: '1440', label: t`24 hours` },
          ]}
          onChange={setTtl}
        />
        <Button
          variant="secondary"
          icon={PhoneIcon}
          busy={create.isPending}
          onClick={() => create.mutate()}
          className="sm:ms-auto"
        >
          {data?.openPairing || code ? <Trans>New code</Trans> : <Trans>Create code</Trans>}
        </Button>
      </div>
      <Dialog
        open={disconnecting !== null}
        onClose={() => setDisconnecting(null)}
        closeLabel={t`Close`}
        title={<Trans>Disconnect “{disconnecting?.name}”?</Trans>}
        description={
          <Trans>
            The phone can no longer send or hide anything. What it already sent stays. Moments still waiting on the
            phone go out once you connect it again with a new code.
          </Trans>
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setDisconnecting(null)}>
              <Trans>Keep connected</Trans>
            </Button>
            <Button
              className="bg-danger hover:bg-danger"
              icon={TrashIcon}
              busy={disconnect.isPending}
              onClick={() => {
                if (disconnecting) disconnect.mutate(disconnecting.id, { onSettled: () => setDisconnecting(null) });
              }}
            >
              <Trans>Disconnect</Trans>
            </Button>
          </>
        }
      />
    </Section>
  );
}
