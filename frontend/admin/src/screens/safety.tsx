/**
 * Settings → Safety (spec-wave5 §7.6, Q1/Q2/Q6): when new things appear (release slots, the
 * departure hold), how much of the current place the site shows ("here now"), exact times or
 * parts of the day, the lock and the panic link, and how the access machinery is doing (writer,
 * pending changes, repair report, store, gate check). The options save through the existing
 * queued settings write; lock, panic link and store set-up are immediate actions.
 */
import { msg } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { AccessStatus } from '@omw/contracts/access';
import type { Settings, SettingsPatch } from '@omw/contracts/api';
import type { HereNow, TimePrecision } from '@omw/contracts/site';
import { countryFlag, countryName, formatDateTime, formatRelative } from '@omw/ui/locale';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { accessApi, noteAccessSummary, notifyAccessError, useAccessAction, useAccessRequest } from '../api/access';
import { ApiRequestError } from '../api/client';
import { ak, qk } from '../api/keys';
import { accessStatusQuery, daysQuery, settingsQuery, statusQuery } from '../api/queries';
import { ConfirmSheet } from '../components/confirm-sheet';
import { EffectBadge } from '../components/effect-badge';
import {
  AlertIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  KeyIcon,
  PinIcon,
  PlusIcon,
  RefreshIcon,
  SendIcon,
  ShieldIcon,
  TrashIcon,
} from '../components/icons';
import { LinkSheet } from '../components/link-sheet';
import { LockCard } from '../components/lock-card';
import {
  Button,
  buttonClass,
  cx,
  Field,
  QueryError,
  ScreenHeader,
  Section,
  Segmented,
  Skeleton,
  Switch,
  TextInput,
} from '../components/ui';
import { useLocale, useNotifyWrite, useNow, useWrite } from '../lib/hooks';
import { deviceTimeZone, zoneLabel } from '../lib/places';

const MAX_SLOTS = 6;
const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** Release slot times as the contract wants them: valid, unique, ascending, at most six. */
export function normalizeSlotTimes(times: readonly string[]): string[] {
  return [...new Set(times.filter((t) => HHMM_RE.test(t)))].sort().slice(0, MAX_SLOTS);
}

function usePatchSettings() {
  const patch = useWrite('patchSettings');
  const notifyWrite = useNotifyWrite();
  return (p: SettingsPatch, message = msg`Saved`) => {
    patch({ patch: p });
    notifyWrite('settings', message);
  };
}

function ReleaseSlotsSection({ settings }: { settings: Settings }) {
  const { t } = useLingui();
  const locale = useLocale();
  const save = usePatchSettings();
  const slots = settings['publish.release_slots'];
  const [adding, setAdding] = useState('12:00');
  const zone = zoneLabel(settings['timezone.current'], locale);
  const canAdd = slots.times.length < MAX_SLOTS && HHMM_RE.test(adding) && !slots.times.includes(adding);
  function setTimes(times: string[]) {
    const next = normalizeSlotTimes(times);
    if (next.length === 0) return;
    save({ 'publish.release_slots': { ...slots, times: next } }, msg`Release times saved`);
  }
  return (
    <Section
      icon={ClockIcon}
      title={<Trans>Release times</Trans>}
      description={<Trans>Off by default: everything appears as your publish mode says.</Trans>}
    >
      <Switch
        checked={slots.enabled}
        onChange={(on) =>
          save(
            { 'publish.release_slots': { ...slots, enabled: on } },
            on ? msg`Release times on` : msg`Release times off`,
          )
        }
        label={<Trans>Only at fixed times</Trans>}
        description={<Trans>New things appear only at these times ({zone}). Removing something works at once.</Trans>}
      />
      <ul className="mt-4 flex flex-wrap gap-2" aria-label={t`Release times`}>
        {slots.times.map((time) => (
          <li
            key={time}
            className={cx(
              'inline-flex min-h-9 items-center gap-1 rounded-pill ps-3.5 pe-1 text-sm font-bold pointer-coarse:min-h-11',
              slots.enabled ? 'bg-accent text-on-accent' : 'bg-blush text-ink',
            )}
          >
            <span dir="ltr">{time}</span>
            <button
              type="button"
              aria-label={t`Remove ${time}`}
              disabled={slots.times.length <= 1}
              onClick={() => setTimes(slots.times.filter((x) => x !== time))}
              className="press grid size-7 place-items-center rounded-pill hover:bg-surface/30 disabled:opacity-40 pointer-coarse:size-9"
            >
              <CloseIcon className="size-4" />
            </button>
          </li>
        ))}
      </ul>
      {slots.times.length < MAX_SLOTS && (
        <div className="mt-3 flex items-end gap-2">
          <Field label={<Trans>Add a time</Trans>} className="max-w-40">
            {(ids) => (
              <TextInput
                {...ids}
                type="time"
                dir="ltr"
                step={60}
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
              />
            )}
          </Field>
          <Button
            variant="secondary"
            icon={PlusIcon}
            disabled={!canAdd}
            onClick={() => setTimes([...slots.times, adding])}
          >
            <Trans>Add</Trans>
          </Button>
        </div>
      )}
      <p className="mt-2 text-xs text-muted">
        <Plural value={MAX_SLOTS} other="Up to # times a day." />
      </p>
    </Section>
  );
}

function DepartureHoldSection({ settings }: { settings: Settings }) {
  const { t } = useLingui();
  const locale = useLocale();
  const save = usePatchSettings();
  const hold = settings['publish.departure_hold'];
  const movedOn = settings['publish.moved_on_at'];
  const movedOnAt = movedOn ? formatDateTime(movedOn, deviceTimeZone(), locale) : null;
  const maxDays = hold.maxDays;
  return (
    <Section
      icon={PinIcon}
      title={<Trans>Wait until she has moved on</Trans>}
      description={
        <Trans>
          New entries wait until she has left the place (a later day at another place), until you tap “She has moved
          on”, or at most {maxDays} days.
        </Trans>
      }
    >
      <Switch
        checked={hold.enabled}
        onChange={(on) =>
          save(
            { 'publish.departure_hold': { ...hold, enabled: on } },
            on ? msg`Departure hold on` : msg`Departure hold off`,
          )
        }
        label={<Trans>Departure hold</Trans>}
        description={<Trans>Nobody sees where she is right now, only where she has been.</Trans>}
      />
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="min-w-0">
          <p className="mb-1.5 text-sm font-bold">
            <Plural value={maxDays} one="At most # day" other="At most # days" />
          </p>
          <Segmented<string>
            label={t`Maximum number of days`}
            size="sm"
            value={String(maxDays)}
            onChange={(v) =>
              save({ 'publish.departure_hold': { ...hold, maxDays: Number(v) } }, msg`Departure hold saved`)
            }
            options={[1, 2, 3, 4, 5, 6, 7].map((n) => ({ value: String(n), label: String(n) }))}
          />
        </div>
        <MovedOnButton />
      </div>
      {movedOnAt && (
        <p className="mt-2 text-xs text-muted">
          <Trans>Last “moved on”: {movedOnAt}</Trans>
        </p>
      )}
    </Section>
  );
}

/** [She has moved on]: releases everything the hold keeps back (publish.moved_on_at = now). */
export function MovedOnButton({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const save = usePatchSettings();
  return (
    <Button
      size={size}
      variant="secondary"
      icon={SendIcon}
      onClick={() => save({ 'publish.moved_on_at': new Date().toISOString() }, msg`Marked as moved on`)}
    >
      <Trans>She has moved on</Trans>
    </Button>
  );
}

function HereNowPreview({ mode, place, country }: { mode: HereNow; place: string; country: string | null }) {
  const locale = useLocale();
  const pill = 'inline-flex max-w-full items-center gap-1 truncate rounded-pill px-2.5 py-1 text-xs font-bold';
  switch (mode) {
    case 'city_badge':
      return (
        <span className={cx(pill, 'bg-accent text-on-accent')}>
          <span className="size-1.5 animate-pulse-dot rounded-pill bg-on-accent" aria-hidden="true" />
          <bdi>{place}</bdi> · <Trans>here now</Trans>
        </span>
      );
    case 'city':
      return (
        <span className={cx(pill, 'bg-blush text-ink')}>
          <Trans>Last in {place}</Trans>
        </span>
      );
    case 'country': {
      const name = country ? `${countryFlag(country)} ${countryName(country, locale)}` : '…';
      return (
        <span className={cx(pill, 'bg-blush text-ink')}>
          <Trans>Last in {name}</Trans>
        </span>
      );
    }
    case 'none':
      return <span className={cx(pill, 'border border-dashed border-line text-muted')}>—</span>;
  }
}

function HereNowSection({ settings }: { settings: Settings }) {
  const save = usePatchSettings();
  const days = useQuery(daysQuery());
  const value = settings['site.here_now'];
  const latest = [...(days.data?.items ?? [])].reverse().find((d) => d.day?.placeName);
  const place = latest?.day?.placeName ?? 'Hội An';
  const country = latest?.day?.countryCode ?? (latest ? null : 'VN');
  const options: Array<{ value: HereNow; label: ReactNode }> = [
    { value: 'city_badge', label: <Trans>Place + badge (as before)</Trans> },
    { value: 'city', label: <Trans>Place without badge</Trans> },
    { value: 'country', label: <Trans>Only the country</Trans> },
    { value: 'none', label: <Trans>Nothing</Trans> },
  ];
  return (
    <Section
      icon={PinIcon}
      title={<Trans>“Here now” on the site</Trans>}
      description={<Trans>How much of the current place the start of your site shows.</Trans>}
    >
      <fieldset>
        <legend className="sr-only">
          <Trans>“Here now” on the site</Trans>
        </legend>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {options.map((o) => {
            const selected = o.value === value;
            return (
              <label
                key={o.value}
                className={cx(
                  'press relative flex cursor-pointer flex-col gap-2 rounded-tile p-3.5',
                  'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
                  selected ? 'bg-blush ring-2 ring-accent' : 'bg-bg ring-1 ring-line hover:ring-blush-strong',
                )}
              >
                <input
                  type="radio"
                  name="here-now"
                  value={o.value}
                  checked={selected}
                  onChange={() => save({ 'site.here_now': o.value }, msg`Saved`)}
                  className="sr-only"
                />
                <span className="flex items-center justify-between gap-2 text-sm font-bold">
                  {o.label}
                  {selected && <CheckIcon className="size-4 text-accent" />}
                </span>
                <span className="min-w-0" aria-hidden="true">
                  <HereNowPreview mode={o.value} place={place} country={country} />
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <p className="mt-3 text-xs text-muted">
        <Trans>Your own titles and captions are not changed.</Trans>
      </p>
    </Section>
  );
}

function TimePrecisionSection({ settings }: { settings: Settings }) {
  const { t } = useLingui();
  const save = usePatchSettings();
  return (
    <Section
      icon={ClockIcon}
      title={<Trans>Times on the site</Trans>}
      description={<Trans>Exact times or only the part of the day.</Trans>}
    >
      <Segmented<TimePrecision>
        label={t`Times on the site`}
        value={settings['site.time_precision']}
        className="w-full"
        onChange={(v) => save({ 'site.time_precision': v }, msg`Saved`)}
        options={[
          { value: 'exact', label: t`Exact` },
          { value: 'part_of_day', label: t`Part of the day only` },
        ]}
      />
      <p className="mt-3 rounded-tile bg-bg px-4 py-3 text-sm">
        {settings['site.time_precision'] === 'exact' ? (
          <Trans>Followers see the time, e.g. 08:40.</Trans>
        ) : (
          <Trans>Followers see only “in the morning”, “in the evening” …</Trans>
        )}
      </p>
    </Section>
  );
}

function PanicLinkSection({ status }: { status: AccessStatus }) {
  const qc = useQueryClient();
  const request = useAccessRequest<{ url: string } | undefined>();
  const [url, setUrl] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  function create() {
    request.mutate(() => accessApi.createPanicLink(), {
      onSuccess: (res) => {
        if (res) setUrl(res.url);
        void qc.invalidateQueries({ queryKey: qk.access.status });
      },
      onError: (err) => notifyAccessError(err),
    });
  }
  return (
    <Section
      icon={KeyIcon}
      title={<Trans>Panic link</Trans>}
      description={
        <Trans>
          A secret link that locks the website without logging in, e.g. for someone you trust. Unlocking works only
          here.
        </Trans>
      }
    >
      <p className="mb-3 text-sm font-bold" data-testid="panic-state">
        {status.panicLink ? <Trans>A panic link exists.</Trans> : <Trans>No panic link yet.</Trans>}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" icon={KeyIcon} busy={request.isPending} onClick={create}>
          {status.panicLink ? <Trans>Create a new one</Trans> : <Trans>Create panic link</Trans>}
        </Button>
        {status.panicLink && (
          <Button variant="danger" icon={TrashIcon} onClick={() => setConfirmOff(true)}>
            <Trans>Turn off</Trans>
          </Button>
        )}
      </div>
      <LinkSheet
        open={url !== null}
        title={<Trans>Your panic link</Trans>}
        description={<Trans>Whoever opens it can lock the website with one tap.</Trans>}
        url={url}
        shareText={null}
        note={<Trans>The link is shown only now. A new one replaces it; the old one stops working.</Trans>}
        onClose={() => setUrl(null)}
      />
      <ConfirmSheet
        open={confirmOff}
        danger
        title={<Trans>Turn off the panic link?</Trans>}
        description={<Trans>The link stops working at once.</Trans>}
        confirmLabel={<Trans>Turn off</Trans>}
        confirmIcon={TrashIcon}
        busy={request.isPending}
        onClose={() => setConfirmOff(false)}
        onConfirm={() =>
          request.mutate(
            async () => {
              await accessApi.deletePanicLink();
              return undefined;
            },
            {
              onSuccess: () => {
                setConfirmOff(false);
                void qc.invalidateQueries({ queryKey: qk.access.status });
              },
              onError: (err) => {
                setConfirmOff(false);
                notifyAccessError(err);
              },
            },
          )
        }
      />
    </Section>
  );
}

const DAY_MS = 86_400_000;

/** When access was last proven end to end: the API's store proof or a passed gate check. */
export function accessProvenAt(status: Pick<AccessStatus, 'storeProofAt' | 'gateCheck'>): string | null {
  const gate = status.gateCheck?.result === 'ok' ? status.gateCheck.at : null;
  // ISO instants sort as text: the later of the two.
  return (
    [gate, status.storeProofAt]
      .filter((x): x is string => !!x)
      .sort()
      .at(-1) ?? null
  );
}

function Row({ label, children, testId }: { label: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2" data-testid={testId}>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-sm font-semibold">{children}</dd>
    </div>
  );
}

function AccessStatusSection({ status, storeAlert }: { status: AccessStatus; storeAlert: boolean }) {
  const locale = useLocale();
  const now = useNow();
  const qc = useQueryClient();
  const tz = deviceTimeZone();
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
  const proven = accessProvenAt(status);
  const gate = status.gateCheck;
  const ago = (iso: string | null) => (iso ? formatRelative(iso, locale, now) : null);
  const blind = gate && (gate.result === 'error' || gate.result === 'skipped');
  const blindSince = blind ? (proven ?? gate.at) : null;
  const blindLong = blindSince ? now - Date.parse(blindSince) > DAY_MS : false;
  const blindOn = blindSince ? formatDateTime(blindSince, tz, locale) : '…';
  const provenOn = proven ? formatDateTime(proven, tz, locale) : null;
  const report = status.lastReconcile;
  return (
    <Section icon={ShieldIcon} title={<Trans>Access status</Trans>}>
      <dl className="divide-y divide-line">
        <Row label={<Trans>Who writes the access list</Trans>}>
          {status.writer.mode === 'direct' ? (
            <Trans>The server, directly</Trans>
          ) : status.writer.mode === 'sftp' ? (
            <Trans>The server, via SFTP</Trans>
          ) : (
            <Trans>Your computer at home</Trans>
          )}
        </Row>
        <Row label={<Trans>Last change applied</Trans>}>{ago(status.lastAppliedAt) ?? <Trans>not yet</Trans>}</Row>
        <Row label={<Trans>Changes waiting</Trans>} testId="access-pending-ops">
          {status.pendingOps > 0 ? (
            <span className="text-violet">
              <Plural value={status.pendingOps} one="# change" other="# changes" />
              {status.oldestPendingOpAt ? ` · ${ago(status.oldestPendingOpAt)}` : ''}
            </span>
          ) : (
            <Trans>none</Trans>
          )}
        </Row>
        {report && (
          <Row label={<Trans>Last repair check</Trans>}>
            {ago(report.at)} ·{' '}
            <Plural value={report.deleted} _0="nothing to fix" one="# file fixed" other="# files fixed" />
            {report.missing.length > 0 && (
              <>
                {' · '}
                <Plural value={report.missing.length} one="# device missing" other="# devices missing" />
              </>
            )}
          </Row>
        )}
        <Row label={<Trans>Website storage</Trans>} testId="access-store">
          {status.storeId && !storeAlert ? (
            <span className="inline-flex items-center gap-1 text-success-strong">
              <CheckIcon className="size-4" />
              <Trans>set up</Trans>
            </span>
          ) : (
            <Button
              size="sm"
              busy={action.isPending}
              onClick={() => action.mutate({ what: msg`Website storage set up`, call: () => accessApi.storeInit() })}
            >
              <Trans>Set up the website storage</Trans>
            </Button>
          )}
        </Row>
        <Row label={<Trans>Access proven</Trans>} testId="access-proven">
          {proven ? (
            <Trans>Access checked on {provenOn}</Trans>
          ) : (
            <span className="text-violet">
              <Trans>Access not checked yet</Trans>
            </span>
          )}
        </Row>
        <Row label={<Trans>Last gate check</Trans>} testId="access-gate-check">
          {!gate ? (
            <Trans>not checked</Trans>
          ) : gate.result === 'ok' ? (
            <span className="text-success-strong">
              <Trans>ok</Trans> · {ago(gate.at)}
            </span>
          ) : gate.result === 'gate_open' ? (
            <span className="text-danger">
              <Trans>open!</Trans> · {ago(gate.at)}
            </span>
          ) : gate.result === 'store_unverified' ? (
            <span className="text-danger">
              <Trans>access not confirmed!</Trans> · {ago(gate.at)}
            </span>
          ) : (
            <span className={blindLong ? 'text-danger' : 'text-violet'}>
              <Trans>Gate check not possible (since {blindOn})</Trans>
            </span>
          )}
        </Row>
      </dl>
      {(status.writer.blocked || status.writer.error) && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-tile bg-danger/10 px-3 py-2.5 text-sm text-danger"
        >
          <AlertIcon className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            {status.writer.blocked && (
              <p className="font-bold">
                <Trans>The server stopped writing after a failed login. Check the access data, then try again.</Trans>
              </p>
            )}
            {status.writer.error && (
              <p className="font-mono text-xs break-words" dir="ltr">
                {status.writer.error}
              </p>
            )}
          </div>
        </div>
      )}
      <Button
        variant="secondary"
        icon={RefreshIcon}
        className="mt-4"
        busy={retry.isPending}
        onClick={() => retry.mutate()}
      >
        <Trans>Retry</Trans>
      </Button>
    </Section>
  );
}

export function SafetyScreen() {
  const { t } = useLingui();
  const settings = useQuery(settingsQuery());
  const access = useQuery(accessStatusQuery());
  const status = useQuery(statusQuery());
  const storeAlert = (status.data?.alerts ?? []).some(
    (a) => a.kind === 'access_store_unverified' && a.resolvedAt === null,
  );
  const noAccessApi = access.error instanceof ApiRequestError && access.error.status === 404;
  return (
    <>
      <ScreenHeader
        back={{ to: '/settings', label: t`Settings` }}
        eyebrow={<Trans>what others can see</Trans>}
        title={<Trans>Safety</Trans>}
      />
      <EffectBadge className="mb-4" />
      <QueryError
        error={settings.error && !settings.data ? settings.error : null}
        onRetry={() => void settings.refetch()}
      />
      {settings.isPending && <Skeleton className="h-48 rounded-card" />}
      <div className="grid items-start gap-5 xl:grid-cols-2">
        <div className="space-y-5">
          <Section icon={SendIcon} title={<Trans>Publish mode</Trans>}>
            <Link to="/settings" className="press flex items-center justify-between gap-3 rounded-tile bg-bg px-4 py-3">
              <span className="text-sm">
                <Trans>Instant, delayed or after your review: in Settings → Publishing.</Trans>
              </span>
              <ChevronRightIcon className="size-5 text-muted" flip />
            </Link>
          </Section>
          {settings.data && (
            <>
              <ReleaseSlotsSection settings={settings.data} />
              <DepartureHoldSection settings={settings.data} />
              <HereNowSection settings={settings.data} />
              <TimePrecisionSection settings={settings.data} />
            </>
          )}
        </div>
        <div className="space-y-5">
          {access.data && (
            <>
              <LockCard access={access.data} />
              <PanicLinkSection status={access.data} />
              <AccessStatusSection status={access.data} storeAlert={storeAlert} />
            </>
          )}
          {access.isPending && <Skeleton className="h-40 rounded-card" />}
          {noAccessApi ? (
            <p className="rounded-card bg-surface p-5 text-sm text-muted shadow-soft">
              <Trans>The server does not offer access control yet. Update the API first.</Trans>
            </p>
          ) : (
            <QueryError
              error={access.error && !access.data ? access.error : null}
              onRetry={() => void access.refetch()}
            />
          )}
          <Link to="/people" className={buttonClass('secondary', 'md', 'w-full')}>
            <Trans>People and access</Trans>
          </Link>
        </div>
      </div>
    </>
  );
}
