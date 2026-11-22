/**
 * Home: is the site live, is WhatsApp connected, did the backend check in, any alerts, and a
 * gentle nudge for today's page of the journal. Wave 5: new devices waiting for the owner's OK
 * (names come from GET /admin/access, never persisted), the shield/lock card, owner notices, the
 * People tile and the departure hold card.
 */
import { msg } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { AccessSummary, PendingDeviceCard } from '@omw/contracts/access';
import type { Settings, StatusResponse } from '@omw/contracts/api';
import { pickText } from '@omw/contracts/i18n';
import { localDateFor } from '@omw/contracts/time';
import { countryFlag, formatDateTime, formatLocalDate, formatNumber, formatRelative, formatTime } from '@omw/ui/locale';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouteContext } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { accessApi, notifyAccessError, useAccessAction, useAccessRequest } from '../api/access';
import { qk } from '../api/keys';
import {
  ACCESS_POLL_MS,
  accessStatusQuery,
  capturesQuery,
  daysQuery,
  followersQuery,
  noticesQuery,
  settingsQuery,
} from '../api/queries';
import { CaptureVisual } from '../components/capture';
import { EffectBadge } from '../components/effect-badge';
import {
  AlertIcon,
  BookIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  CloseIcon,
  CloudOffIcon,
  FeatherIcon,
  InboxIcon,
  PencilIcon,
  PeopleIcon,
  PhoneIcon,
  PinIcon,
  RefreshIcon,
  SendIcon,
  SparklesIcon,
  WifiIcon,
} from '../components/icons';
import { InstallCard } from '../components/install';
import { KIND_LABEL, WA_STATE_LABEL } from '../components/labels';
import { LockCard } from '../components/lock-card';
import { Badge, Button, Card, cx, IconButton, QueryError, ScreenHeader, Skeleton, Spinner } from '../components/ui';
import { draftPreview, draftSearch, draftStore, listDrafts } from '../lib/drafts';
import { heldPlaces } from '../lib/held-days';
import { useLocale, useNotifyWrite, useNow, usePublishSummary, useWrite } from '../lib/hooks';
import { deviceTimeZone, zoneCity, zoneLabel, zoneOffset } from '../lib/places';
import { lastPublishStore, type PublishSummary } from '../lib/publish';
import { inboxSeenStore, isNew } from '../lib/seen';
import { localStore, useStore } from '../lib/store';

const TZ_DISMISSED_KEY = 'omw.admin.tzNudgeDismissed';

/**
 * The device is in another zone than the one new statuses are sorted by (a border crossing):
 * offer the switch right here, one tap. "Not now" is remembered for that zone only.
 */
function TimeZoneNudge({ current }: { current: string }) {
  const { t } = useLingui();
  const locale = useLocale();
  const patch = useWrite('patchSettings');
  const notifyWrite = useNotifyWrite();
  const device = deviceTimeZone();
  const [dismissed, setDismissed] = useState(() => localStore.read<string | null>(TZ_DISMISSED_KEY, null));
  if (device === current || dismissed === device) return null;
  const city = zoneCity(device);
  const offset = zoneOffset(device);
  const currentLabel = zoneLabel(current, locale);
  return (
    <section
      aria-labelledby="tz-nudge"
      className="flex items-start gap-3 rounded-card bg-lilac p-4 shadow-soft sm:col-span-2 lg:col-span-3"
    >
      <span className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-pill bg-surface text-violet">
        <ClockIcon className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p id="tz-nudge" className="font-bold">
          <Trans>
            You are in {city} now ({offset}) – use this time zone?
          </Trans>
        </p>
        <p className="mt-0.5 text-sm text-muted">
          <Trans>New statuses are sorted into days by it. Set now: {currentLabel}.</Trans>
        </p>
        <Button
          size="md"
          icon={ClockIcon}
          className="mt-3"
          onClick={() => {
            patch({ patch: { 'timezone.current': device } });
            notifyWrite('settings', msg`Time zone updated`);
          }}
        >
          <Trans>Use {city}</Trans>
        </Button>
      </div>
      <IconButton
        label={t`Not now`}
        icon={CloseIcon}
        className="-me-2 -mt-1"
        onClick={() => {
          localStore.write(TZ_DISMISSED_KEY, device);
          setDismissed(device);
        }}
      />
    </section>
  );
}

function useAgo() {
  const locale = useLocale();
  const now = useNow();
  return (iso: string | null | undefined) => (iso ? formatRelative(iso, locale, now) : null);
}

function Greeting({ name }: { name: string }) {
  const hour = new Date().getHours();
  if (hour < 5 || hour >= 22)
    return (
      <Trans>
        Good night, <bdi>{name}</bdi>
      </Trans>
    );
  if (hour < 11)
    return (
      <Trans>
        Good morning, <bdi>{name}</bdi>
      </Trans>
    );
  if (hour < 17)
    return (
      <Trans>
        Hello, <bdi>{name}</bdi>
      </Trans>
    );
  return (
    <Trans>
      Good evening, <bdi>{name}</bdi>
    </Trans>
  );
}

function SiteHeadline({ summary }: { summary: PublishSummary }) {
  switch (summary.state) {
    case 'live':
      return <Trans>Everything is live</Trans>;
    case 'publishing':
      return <Trans>Publishing…</Trans>;
    case 'failing':
      return <Trans>Publishing is failing</Trans>;
    case 'never':
      return <Trans>Not published yet</Trans>;
    case 'unknown':
      return <Trans>Status unknown right now</Trans>;
  }
}

function SiteCard({
  summary,
  loading,
  fetching,
  onRefresh,
}: {
  summary: PublishSummary;
  loading: boolean;
  fetching: boolean;
  onRefresh: () => void;
}) {
  const { t } = useLingui();
  const ago = useAgo();
  const locale = useLocale();
  const lastKnown = useStore(lastPublishStore);
  const lastAt = ago(summary.lastAt);
  // Without a status (request failed, nothing cached): the last deploy this device saw, if any.
  const knownAt = summary.state === 'unknown' ? ago(lastKnown?.at) : null;
  const tone =
    summary.state === 'live'
      ? 'bg-success/14 text-success-strong'
      : summary.state === 'failing'
        ? 'bg-danger/12 text-danger'
        : summary.state === 'unknown'
          ? 'bg-surface-2 text-muted'
          : 'bg-lilac text-violet';
  return (
    <Card tape className="relative sm:col-span-2">
      <div className="flex items-start gap-4">
        <span className={cx('grid size-14 shrink-0 place-items-center rounded-pill', tone)}>
          {loading ? (
            <Spinner className="size-6" />
          ) : summary.state === 'live' ? (
            <CheckIcon className="size-7" />
          ) : summary.state === 'failing' ? (
            <AlertIcon className="size-7" />
          ) : summary.state === 'unknown' ? (
            <CloudOffIcon className="size-7" />
          ) : (
            <SparklesIcon className={cx('size-7', summary.state === 'publishing' && 'animate-pulse-dot')} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-muted">
            <Trans>Your website</Trans>
          </p>
          <h2 className="display-soft text-2xl leading-tight font-semibold sm:text-[1.75rem]">
            {loading ? <Skeleton className="mt-1 h-7 w-48" /> : <SiteHeadline summary={summary} />}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {summary.state === 'publishing' &&
            summary.waitingFor.includes('edits') &&
            summary.waitingFor.includes('captures') ? (
              <Trans>Your latest edits and new statuses are on their way.</Trans>
            ) : summary.state === 'publishing' && summary.waitingFor.includes('edits') ? (
              <Trans>Your latest edits are on their way to the site.</Trans>
            ) : summary.state === 'publishing' ? (
              <Trans>New statuses are on their way to the site.</Trans>
            ) : summary.state === 'failing' ? (
              <Trans>Your computer at home could not upload the last version. It keeps retrying.</Trans>
            ) : summary.state === 'never' && !loading ? (
              <Trans>As soon as your computer at home publishes, you will see it here.</Trans>
            ) : summary.state === 'unknown' && !loading ? (
              <Trans>The server did not answer. Your site is probably fine.</Trans>
            ) : null}{' '}
            {lastAt && (
              <span className="inline-block">
                <Trans>Last published {lastAt}.</Trans>
              </span>
            )}
            {knownAt && (
              <span className="inline-block">
                <Trans>Last known publish {knownAt}.</Trans>
              </span>
            )}
          </p>
        </div>
        <IconButton
          label={t`Check again`}
          icon={RefreshIcon}
          variant="ghost"
          className={cx('-me-2 -mt-1', fetching && '[&_svg]:animate-spin-soft')}
          aria-busy={fetching || undefined}
          onClick={onRefresh}
        />
      </div>
      {summary.targets.length > 1 && (
        <ul className="mt-4 flex flex-wrap gap-2">
          {summary.targets.map((tgt) => (
            <li key={tgt.target}>
              <Badge tone={tgt.ok ? 'success' : 'danger'} icon={tgt.ok ? CheckIcon : AlertIcon}>
                {tgt.target} · v{formatNumber(tgt.version, locale)}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function WhatsAppCard({ status }: { status: StatusResponse }) {
  const { i18n } = useLingui();
  const ago = useAgo();
  const wa = status.backend?.wa;
  const ok = wa?.state === 'open';
  const lastStatus = ago(wa?.lastStatusAt);
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-bold text-muted">
        <WifiIcon className="size-4" />
        WhatsApp
      </div>
      <p className="flex items-center gap-2 text-base leading-tight font-bold sm:text-lg">
        <span
          className={cx('size-2.5 shrink-0 rounded-pill', ok ? 'bg-success' : wa ? 'bg-danger' : 'bg-muted')}
          aria-hidden="true"
        />
        {wa ? i18n._(WA_STATE_LABEL[wa.state]) : <Trans>No news from your computer at home yet</Trans>}
      </p>
      <p className="mt-1 text-sm text-muted">
        {lastStatus ? <Trans>Last status {lastStatus}</Trans> : <Trans>No status captured yet</Trans>}
      </p>
      {wa && !wa.traveler.lidKnown && wa.traveler.pn !== null && (
        <p className="mt-2 text-xs text-muted">
          <Trans>Waiting for the first status to recognise the traveller.</Trans>
        </p>
      )}
    </Card>
  );
}

function BackendCard({ status, staleMinutes }: { status: StatusResponse; staleMinutes: number }) {
  const ago = useAgo();
  const now = useNow();
  const [explain, setExplain] = useState(false);
  const seen = status.lastSeenAt;
  const stale = !seen || now - Date.parse(seen) > staleMinutes * 60_000;
  const backend = status.backend;
  const failed = backend?.captures.failed ?? 0;
  const lost = backend?.captures.mediaLost ?? 0;
  const unsent = backend?.queue.failed ?? 0;
  const issues = failed + lost + unsent;
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2 text-sm font-bold text-muted">
        <RefreshIcon className="size-4 shrink-0" />
        <Trans>Computer at home</Trans>
      </div>
      <p className="flex items-center gap-2 text-base leading-tight font-bold sm:text-lg">
        <span className={cx('size-2.5 shrink-0 rounded-pill', stale ? 'bg-danger' : 'bg-success')} aria-hidden="true" />
        {stale ? <Trans>Not checking in</Trans> : <Trans>Running</Trans>}
      </p>
      <p className="mt-1 text-sm text-muted">
        {seen ? <Trans>Last heartbeat {ago(seen)}</Trans> : <Trans>Never checked in</Trans>}
      </p>
      {backend && (backend.queue.pending > 0 || issues > 0) && (
        <p className="mt-2 flex flex-wrap gap-1.5">
          {backend.queue.pending > 0 && (
            <Badge tone="lilac">
              <Plural value={backend.queue.pending} one="# waiting" other="# waiting" />
            </Badge>
          )}
          {issues > 0 && (
            // A count alone explains nothing: tap it for what went wrong.
            <button
              type="button"
              aria-expanded={explain}
              onClick={() => setExplain((v) => !v)}
              className="press inline-flex min-h-8 items-center gap-1 rounded-pill bg-danger/12 px-2.5 text-xs font-bold text-danger pointer-coarse:min-h-11"
            >
              <AlertIcon className="size-3.5" />
              <Plural value={issues} one="# problem" other="# problems" />
              <ChevronRightIcon className={cx('size-3.5 transition-transform', explain && 'rotate-90')} />
            </button>
          )}
        </p>
      )}
      {explain && issues > 0 && (
        <ul className="mt-2 space-y-1 rounded-tile bg-bg px-3 py-2 text-xs text-ink">
          {lost > 0 && (
            <li>
              <Plural
                value={lost}
                one="# status could not be downloaded from WhatsApp."
                other="# statuses could not be downloaded from WhatsApp."
              />
            </li>
          )}
          {failed > 0 && (
            <li>
              <Plural
                value={failed}
                one="# status could not be processed."
                other="# statuses could not be processed."
              />
            </li>
          )}
          {unsent > 0 && (
            <li>
              <Plural
                value={unsent}
                one="# update could not be sent to the server yet; it keeps trying."
                other="# updates could not be sent to the server yet; it keeps trying."
              />
            </li>
          )}
          <li className="text-muted">
            <Trans>Details are on the control page of your computer at home.</Trans>
          </li>
        </ul>
      )}
    </Card>
  );
}

function AlertsCard({ status }: { status: StatusResponse }) {
  const ago = useAgo();
  const active = status.alerts.filter((a) => a.resolvedAt === null);
  if (active.length === 0) return null;
  return (
    <Card className="sm:col-span-2 lg:col-span-3" aria-live="polite">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-danger">
        <AlertIcon className="size-4" />
        <Plural value={active.length} one="# alert" other="# alerts" />
      </h2>
      <ul className="space-y-2">
        {active.map((a) => (
          <li
            key={`${a.kind}-${a.since}`}
            className={cx(
              'rounded-tile px-3 py-2 text-sm',
              a.severity === 'critical' ? 'bg-danger/10 text-danger' : 'bg-blush text-ink',
            )}
          >
            <p className="font-bold">{a.message}</p>
            <p className="text-xs opacity-80">
              <Trans>since {ago(a.since)}</Trans>
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TodayCard() {
  const locale = useLocale();
  const settings = useQuery(settingsQuery());
  const days = useQuery(daysQuery());
  const tz = settings.data?.['timezone.current'] ?? deviceTimeZone();
  const today = localDateFor(new Date(), tz);
  const summary = days.data?.items.find((d) => d.localDate === today);
  const title = pickText(summary?.day?.title, locale, summary?.day?.origLocale)?.text;
  const place = summary?.day?.placeName;
  const count = summary ? summary.counts.captures + summary.counts.posts : 0;
  return (
    <Link
      to="/days/$date"
      params={{ date: today }}
      className="press group flex items-center gap-4 rounded-card bg-surface p-4 shadow-soft hover:shadow-lift sm:col-span-2 lg:col-span-1"
    >
      <span className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-tile bg-blush text-accent">
        {summary?.coverPreviewUrl ? (
          <img src={summary.coverPreviewUrl} alt="" className="size-full object-cover" />
        ) : (
          <BookIcon className="size-7" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-hand text-accent">
          <Trans>Today</Trans> · {formatLocalDate(today, locale)}
        </span>
        <span className="display-soft line-clamp-2 block text-xl leading-snug font-semibold" dir="auto">
          {title ?? <Trans>How was your day?</Trans>}
        </span>
        <span className="mt-0.5 flex items-center gap-1 text-sm text-muted">
          {place ? (
            <>
              <PinIcon className="size-3.5" />
              <bdi>{place}</bdi> {summary?.day?.countryCode ? countryFlag(summary.day.countryCode) : ''}
              {count > 0 && <> · </>}
            </>
          ) : (
            !title && <Trans>Add a title and the place.</Trans>
          )}
          {count > 0 && <Plural value={count} one="# moment" other="# moments" />}
        </span>
      </span>
      <ChevronRightIcon className="size-5 text-muted transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5" />
    </Link>
  );
}

function QuickTile({
  to,
  search,
  icon: IconCmp,
  label,
  tone,
  badge,
}: {
  to: '/compose' | '/inbox' | '/people';
  search?: { kind: 'note' | 'story' };
  icon: typeof FeatherIcon;
  label: ReactNode;
  tone: string;
  badge?: number;
}) {
  return (
    <Link
      to={to}
      {...(search ? { search } : {})}
      className="press group relative flex flex-col items-center gap-2 rounded-card bg-surface px-2 pt-4 pb-3 text-center shadow-soft hover:shadow-lift"
    >
      <span
        className={cx('grid size-12 place-items-center rounded-pill transition-transform group-hover:-rotate-6', tone)}
      >
        <IconCmp className="size-[1.35rem]" />
      </span>
      <span className="text-sm leading-tight font-bold">{label}</span>
      {badge ? (
        <span className="absolute end-2.5 top-2.5 grid h-5 min-w-5 place-items-center rounded-pill bg-accent px-1.5 text-[0.7rem] font-extrabold text-on-accent">
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

function QuickActions({ pendingDevices }: { pendingDevices: number }) {
  const seenAt = useStore(inboxSeenStore);
  const captures = useInfiniteQuery(capturesQuery());
  const fresh = (captures.data?.pages[0]?.items ?? []).filter((c) => isNew(c.occurredAt, seenAt)).length;
  const followers = useQuery(followersQuery());
  const people = followers.data?.items.filter((f) => f.state === 'active').length;
  return (
    <div className="grid grid-cols-4 gap-2.5 sm:col-span-2 sm:gap-3 lg:col-span-3">
      <QuickTile
        to="/compose"
        search={{ kind: 'note' }}
        icon={FeatherIcon}
        tone="bg-accent text-on-accent"
        label={<Trans>Note</Trans>}
      />
      <QuickTile
        to="/compose"
        search={{ kind: 'story' }}
        icon={PencilIcon}
        tone="bg-lilac text-violet"
        label={<Trans>Story</Trans>}
      />
      <QuickTile
        to="/inbox"
        icon={InboxIcon}
        tone="bg-blush text-accent-strong"
        label={<Trans>Inbox</Trans>}
        badge={fresh}
      />
      <QuickTile
        to="/people"
        icon={PeopleIcon}
        tone="bg-surface-2 text-violet"
        label={people === undefined ? <Trans>People</Trans> : <Plural value={people} one="# person" other="# people" />}
        badge={pendingDevices}
      />
    </div>
  );
}

/** "New device for Oma · iPhone · Safari · 5 min ago" [Allow] [Decline] (spec §7.5). */
function PendingDevicesCard({ count }: { count: number }) {
  const locale = useLocale();
  const now = useNow();
  const q = useQuery({ ...accessStatusQuery(), refetchInterval: ACCESS_POLL_MS });
  const action = useAccessAction();
  const cards: PendingDeviceCard[] = q.data?.pending ?? [];
  if (cards.length === 0 && !q.isPending) return null;
  const more = Math.max(0, (q.data?.pendingDevices ?? count) - cards.length);
  return (
    <section
      aria-labelledby="pending-h"
      className="min-w-0 rounded-card bg-blush p-4 shadow-soft sm:col-span-2 sm:p-5 lg:col-span-3"
      data-testid="pending-devices"
    >
      <h2 id="pending-h" className="mb-3 flex items-center gap-2 font-bold">
        <PhoneIcon className="size-5 text-accent" />
        <Plural
          value={q.data?.pendingDevices ?? count}
          one="A new device is waiting"
          other="# new devices are waiting"
        />
      </h2>
      {q.isPending && <Skeleton className="h-14" />}
      <ul className="space-y-2.5">
        {cards.map((c) => {
          const name = c.name;
          const label = c.label;
          const ago = formatRelative(c.createdAt, locale, now);
          return (
            <li key={c.did} className="rounded-tile bg-surface p-3">
              <p className="text-sm">
                <Trans>
                  New device for <bdi className="font-bold">{name}</bdi> · {label} · {ago}
                </Trans>
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  icon={CheckIcon}
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({
                      what: msg`Device allowed for ${name}`,
                      values: { name },
                      call: () => accessApi.approveDevice(c.did),
                    })
                  }
                >
                  <Trans>Allow</Trans>
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={CloseIcon}
                  disabled={action.isPending}
                  onClick={() =>
                    action.mutate({ what: msg`Device declined`, call: () => accessApi.declineDevice(c.did) })
                  }
                >
                  <Trans>Decline</Trans>
                </Button>
                <Link
                  to="/people/$fid"
                  params={{ fid: c.fid }}
                  className="inline-flex min-h-9 items-center px-2 text-sm font-bold text-accent hover:underline pointer-coarse:min-h-11"
                >
                  <Trans>Details</Trans>
                </Link>
              </div>
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <Link
          to="/people"
          className="mt-3 inline-flex min-h-9 items-center text-sm font-bold text-accent hover:underline pointer-coarse:min-h-11"
        >
          <Plural value={more} one="+ # more" other="+ # more" />
        </Link>
      )}
    </section>
  );
}

/** One-shot notices without names ("A person deleted their data · 20 Nov") with [OK]. */
function OwnerNoticesCard() {
  const locale = useLocale();
  const qc = useQueryClient();
  const q = useQuery(noticesQuery());
  const read = useAccessRequest<void>();
  const unread = (q.data?.items ?? []).filter((n) => n.readAt === null);
  if (unread.length === 0) return null;
  return (
    <section
      aria-labelledby="notices-h"
      className="min-w-0 space-y-1 rounded-card bg-lilac px-4 py-2 shadow-soft sm:col-span-2 lg:col-span-3"
      data-testid="owner-notices"
    >
      <h2 id="notices-h" className="sr-only">
        <Trans>Notices</Trans>
      </h2>
      {unread.map((n) => {
        const date = formatLocalDate(localDateFor(n.createdAt, deviceTimeZone()), locale, 'short');
        return (
          <div key={n.id} className="flex items-center gap-3 py-1.5 text-sm">
            <AlertIcon className="size-4 shrink-0 text-violet" />
            <p className="min-w-0 flex-1">
              {n.kind === 'follower_deleted' ? (
                <Trans>A person deleted their data · {date}</Trans>
              ) : n.kind === 'restore_reconciled' ? (
                <Trans>After a restore: please look at People · {date}</Trans>
              ) : (
                <Trans>The website storage does not match its set-up: see Safety · {date}</Trans>
              )}
            </p>
            <Button
              size="sm"
              variant="secondary"
              disabled={read.isPending}
              onClick={() =>
                read.mutate(() => accessApi.readNotices([n.id]), {
                  onSuccess: () => {
                    void qc.invalidateQueries({ queryKey: qk.access.notices });
                    void qc.invalidateQueries({ queryKey: qk.status });
                  },
                  onError: (err) => notifyAccessError(err),
                })
              }
            >
              <Trans>OK</Trans>
            </Button>
          </div>
        );
      })}
    </section>
  );
}

/** Departure hold (Q1): days waiting until she has moved on, with the one-tap release. */
function HoldCard({ settings }: { settings: Settings }) {
  const { t } = useLingui();
  const locale = useLocale();
  const now = useNow(60_000);
  const days = useQuery(daysQuery());
  const patch = useWrite('patchSettings');
  const notifyWrite = useNotifyWrite();
  // useNow only re-renders every minute; the decision itself uses the current time, so a
  // "moved on" just tapped (moved_on_at = now) releases at once.
  const held = heldPlaces(days.data?.items ?? [], settings, Math.max(now, Date.now()));
  if (held.length === 0) return null;
  return (
    <section
      aria-labelledby="hold-h"
      className="min-w-0 rounded-card bg-lilac p-4 shadow-soft sm:col-span-2 lg:col-span-3"
      data-testid="hold-card"
    >
      <h2 id="hold-h" className="sr-only">
        <Trans>Departure hold</Trans>
      </h2>
      <ul className="space-y-1.5">
        {held.map((h) => {
          const place = h.place ?? t`Without a place`;
          const n = h.days;
          const until = formatDateTime(h.until, deviceTimeZone(), locale);
          return (
            <li key={`${h.place ?? ''}-${h.until}`} className="flex items-start gap-2 text-sm">
              <PinIcon className="mt-0.5 size-4 shrink-0 text-violet" />
              <span>
                <Plural
                  value={n}
                  one={`${place}: # day waits until she has moved on (at the latest ${until})`}
                  other={`${place}: # days wait until she has moved on (at the latest ${until})`}
                />
              </span>
            </li>
          );
        })}
      </ul>
      <Button
        size="md"
        variant="secondary"
        icon={SendIcon}
        className="mt-3"
        onClick={() => {
          patch({ patch: { 'publish.moved_on_at': new Date().toISOString() } });
          notifyWrite('settings', msg`Marked as moved on`);
        }}
      >
        <Trans>She has moved on</Trans>
      </Button>
    </section>
  );
}

/** Autosaved drafts on this device (and posts the API rejected, put back as drafts). */
function DraftsCard() {
  const ago = useAgo();
  const drafts = listDrafts(useStore(draftStore));
  if (drafts.length === 0) return null;
  return (
    <Card as="section" aria-labelledby="drafts-h" className="p-4 sm:col-span-2 sm:p-5 lg:col-span-3">
      <h2 id="drafts-h" className="display-soft mb-2 px-1 text-lg font-semibold">
        <Plural value={drafts.length} one="# draft on this device" other="# drafts on this device" />
      </h2>
      <ul className="space-y-1">
        {drafts.slice(0, 5).map((d) => (
          <li key={d.id}>
            <Link
              to="/compose"
              search={draftSearch(d)}
              className="press flex items-center gap-3 rounded-tile p-1.5 hover:bg-blush/60"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-tile bg-lilac text-violet">
                {d.kind === 'note' ? <FeatherIcon className="size-5" /> : <BookIcon className="size-5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-hand text-[0.95rem]" dir="auto" data-user-text>
                  {draftPreview(d)}
                </span>
                <span className="block text-xs text-muted">
                  {d.editing ? <Trans>Edit, saved {ago(d.savedAt)}</Trans> : <Trans>Saved {ago(d.savedAt)}</Trans>}
                </span>
              </span>
              <ChevronRightIcon className="size-5 text-muted" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The latest captured statuses as a row of little polaroids. */
function RecentStrip() {
  const { i18n } = useLingui();
  const locale = useLocale();
  const q = useInfiniteQuery(capturesQuery());
  const items = (q.data?.pages[0]?.items ?? []).filter((c) => c.kind !== 'unsupported').slice(0, 10);
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="recent-h" className="sm:col-span-2 lg:col-span-3">
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 id="recent-h" className="display-soft text-lg font-semibold">
          <Trans>Recently captured</Trans>
        </h2>
        <Link
          to="/inbox"
          className="inline-flex items-center text-sm font-bold text-accent hover:underline pointer-coarse:min-h-11"
        >
          <Trans>All statuses</Trans>
        </Link>
      </div>
      <ul className="scrollbar-none -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pt-1 pb-3 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
        {items.map((c, i) => (
          <li key={c.sourceKey} className="snap-start">
            <Link
              to="/inbox/$sourceKey"
              params={{ sourceKey: c.sourceKey }}
              aria-label={`${c.caption || i18n._(KIND_LABEL[c.kind])} · ${formatTime(c.occurredAt, c.effectiveTz, locale)}`}
              className={cx(
                'polaroid press block w-28 hover:shadow-lift',
                i % 2 ? 'rotate-[1.5deg]' : 'rotate-[-1.5deg]',
              )}
            >
              <CaptureVisual
                capture={c}
                compact
                dimmed={c.effectiveVisibility === 'hidden'}
                className="aspect-square w-full"
                rounded="rounded-[0.45rem]"
              />
              <span className="block truncate px-0.5 py-1.5 text-center font-hand text-xs text-muted" dir="auto">
                {c.caption || formatTime(c.occurredAt, c.effectiveTz, locale)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function HomeScreen() {
  const { me } = useRouteContext({ from: '/authed' });
  const locale = useLocale();
  const { summary, status } = usePublishSummary();
  const settings = useQuery(settingsQuery());
  const name = me.displayName?.split(' ')[0] ?? me.email.split('@')[0] ?? '';
  const today = formatLocalDate(localDateFor(new Date(), deviceTimeZone()), locale, 'long');
  const access: AccessSummary | undefined = status.data?.access;
  const pendingDevices = access?.pendingDevices ?? 0;
  return (
    <>
      <ScreenHeader eyebrow={today} title={<Greeting name={name} />} />
      <EffectBadge className="mb-4" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {pendingDevices > 0 && <PendingDevicesCard count={pendingDevices} />}
        {access && access.unreadNotices > 0 && <OwnerNoticesCard />}
        {settings.data && <TimeZoneNudge current={settings.data['timezone.current']} />}
        <SiteCard
          summary={summary}
          loading={status.isPending && status.fetchStatus === 'fetching'}
          fetching={status.isFetching}
          onRefresh={() => void status.refetch()}
        />
        <TodayCard />
        {settings.data && <HoldCard settings={settings.data} />}
        <QuickActions pendingDevices={pendingDevices} />
        {access && <LockCard access={access} className="sm:col-span-2 lg:col-span-3" />}
        <DraftsCard />
        <InstallCard />
        <RecentStrip />
        {status.error && !status.data && <QueryError error={status.error} onRetry={() => void status.refetch()} />}
        {status.data && (
          <>
            <AlertsCard status={status.data} />
            <div className="grid grid-cols-2 gap-3 sm:col-span-2 sm:gap-4 lg:col-span-3">
              <WhatsAppCard status={status.data} />
              <BackendCard
                status={status.data}
                staleMinutes={settings.data?.['alerts.heartbeat_stale_minutes'] ?? 15}
              />
            </div>
          </>
        )}
        {status.isPending && (
          <>
            <Skeleton className="h-32 rounded-card" />
            <Skeleton className="h-32 rounded-card" />
          </>
        )}
      </div>
    </>
  );
}

/** Compact site status for the side navigation. */
export function SiteStatusMini() {
  const { summary } = usePublishSummary();
  const label =
    summary.state === 'live' ? (
      <Trans>Site is live</Trans>
    ) : summary.state === 'publishing' ? (
      <Trans>Publishing…</Trans>
    ) : summary.state === 'failing' ? (
      <Trans>Publishing fails</Trans>
    ) : summary.state === 'unknown' ? (
      <Trans>Status unknown</Trans>
    ) : (
      <Trans>Not published yet</Trans>
    );
  return (
    <Link
      to="/"
      className="press flex items-center gap-2.5 rounded-card bg-surface px-3 py-2.5 text-sm font-bold shadow-soft"
    >
      <span
        className={cx(
          'size-2.5 shrink-0 rounded-pill',
          summary.state === 'live'
            ? 'bg-success'
            : summary.state === 'failing'
              ? 'bg-danger'
              : summary.state === 'unknown'
                ? 'bg-muted'
                : 'animate-pulse-dot bg-violet',
        )}
        aria-hidden="true"
      />
      {label}
    </Link>
  );
}
