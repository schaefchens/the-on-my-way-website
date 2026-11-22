/**
 * People (spec-wave5 §7.3, D1/D2/D6/D12): everyone who has a personal link. Active people first
 * ("Oma · 2 devices · seen today", "1 waiting"), then "Access ended", then the anonymous
 * tombstones of deleted people. [+ Invite a person] creates the person and shows the link once.
 * Banners: no privacy notice published yet, the website storage not set up, the card after a
 * restore. Nothing here is persisted on the device (queries.ts, meta.persist = false).
 */
import { msg } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { AdminFollower, FollowerTombstone, PersonalLink } from '@omw/contracts/access';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import {
  accessApi,
  accessErrorMessage,
  applyActionResult,
  notifyAccessError,
  useAccessAction,
  useAccessRequest,
} from '../api/access';
import { ApiRequestError } from '../api/client';
import { qk } from '../api/keys';
import { accessStatusQuery, followersQuery, noticesQuery } from '../api/queries';
import { EffectBadge } from '../components/effect-badge';
import { AlertIcon, ChevronRightIcon, InfoIcon, PeopleIcon, PlusIcon, ShieldIcon } from '../components/icons';
import { LinkSheet, personalLinkMessage } from '../components/link-sheet';
import {
  Badge,
  Button,
  buttonClass,
  cx,
  Dialog,
  EmptyState,
  Field,
  QueryError,
  ScreenHeader,
  Skeleton,
  TextArea,
  TextInput,
} from '../components/ui';
import { useLocale, useNow } from '../lib/hooks';
import { countDevices, formatDay, formatDaysAgo, restoreSummary } from '../lib/people';
import { deviceTimeZone } from '../lib/places';
import { cleanAuthor } from '../lib/profile';

const NAME_MAX = 60;
const NOTE_MAX = 200;

/** Name rules of the contract (AuthorName: one trimmed line, 1–60 code points). */
export function cleanFollowerName(raw: string): string {
  return cleanAuthor(raw);
}

/** UTF-16 length, as the contract's zod max() counts (stricter than code points). */
function nameLength(name: string): number {
  return name.length;
}

/** The link sheet for a personal link (new person or a new link): shown once, then forgotten. */
export function PersonalLinkSheet({
  name,
  link,
  onClose,
}: {
  name: string;
  link: PersonalLink | null;
  onClose: () => void;
}) {
  return (
    <LinkSheet
      open={link !== null}
      title={<Trans>Personal link for {name}</Trans>}
      description={<Trans>Send it to {name} yourself, e.g. in WhatsApp.</Trans>}
      url={link?.url ?? null}
      shareText={(locale) => personalLinkMessage(name, link?.url ?? '', locale)}
      note={
        <Trans>The link is shown only now. If it gets lost, create a new one; connected devices stay connected.</Trans>
      }
      onClose={onClose}
    />
  );
}

function InviteSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useLingui();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ name: string; link: PersonalLink } | null>(null);
  const request = useAccessRequest<Awaited<ReturnType<typeof accessApi.createFollower>>>();
  const clean = cleanFollowerName(name);
  const shown = clean || '…';
  const tooLong = nameLength(clean) > NAME_MAX;
  const noteTooLong = nameLength(note) > NOTE_MAX;
  function reset() {
    setName('');
    setNote('');
    setError(null);
  }
  function submit() {
    if (!clean || tooLong || noteTooLong || request.isPending) return;
    setError(null);
    const body = { name: clean, ...(note.trim() ? { note: note.trim() } : {}) };
    request.mutate(() => accessApi.createFollower(body), {
      onSuccess: (res) => {
        applyActionResult(qc, {});
        reset();
        onClose();
        setCreated({ name: res.follower.name, link: res.link });
      },
      onError: (err) => {
        if (err instanceof ApiRequestError && err.status === 0) setError(i18n._(msg`Not sent – no connection`));
        else setError(i18n._(accessErrorMessage(err).message));
      },
    });
  }
  return (
    <>
      <Dialog
        open={open}
        onClose={() => {
          reset();
          onClose();
        }}
        closeLabel={t`Close`}
        title={<Trans>Invite a person</Trans>}
        description={<Trans>You get a personal link for this person. Only they can join with it.</Trans>}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                reset();
                onClose();
              }}
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button
              type="submit"
              form="invite-form"
              icon={PlusIcon}
              busy={request.isPending}
              disabled={!clean || tooLong || noteTooLong}
            >
              <Trans>Create link</Trans>
            </Button>
          </>
        }
      >
        <form
          id="invite-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field
            label={<Trans>Name</Trans>}
            hint={<Trans>As they will see it: “This link is for {shown}.”</Trans>}
            error={tooLong ? t`At most ${NAME_MAX} characters` : null}
          >
            {(ids) => (
              <TextInput
                {...ids}
                data-testid="invite-name"
                autoComplete="off"
                maxLength={NAME_MAX * 2}
                placeholder={t`e.g. Grandma`}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field
            label={<Trans>Private note</Trans>}
            hint={<Trans>Only for you, optional.</Trans>}
            error={noteTooLong ? t`At most ${NOTE_MAX} characters` : null}
          >
            {(ids) => (
              <TextArea
                {...ids}
                data-testid="invite-note"
                rows={2}
                maxLength={NOTE_MAX * 2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            )}
          </Field>
          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-tile bg-danger/10 px-3 py-2.5 text-sm text-danger"
            >
              <AlertIcon className="mt-0.5 size-4 shrink-0" />
              {error}
            </p>
          )}
        </form>
      </Dialog>
      <PersonalLinkSheet name={created?.name ?? ''} link={created?.link ?? null} onClose={() => setCreated(null)} />
    </>
  );
}

function PersonRow({ follower }: { follower: AdminFollower }) {
  const locale = useLocale();
  const now = useNow(60_000);
  const active = countDevices(follower, 'active');
  const waiting = countDevices(follower, 'pending');
  const seen = follower.lastSeenAt ? formatDaysAgo(follower.lastSeenAt, locale, now, deviceTimeZone()) : null;
  const ended = follower.state === 'revoked';
  const endedOn = follower.revokedAt ? formatDay(follower.revokedAt, locale, deviceTimeZone()) : null;
  return (
    <li>
      <Link
        to="/people/$fid"
        params={{ fid: follower.id }}
        className="press flex items-center gap-3 rounded-card bg-surface p-3.5 shadow-soft hover:shadow-lift"
      >
        <span
          className={cx(
            'grid size-11 shrink-0 place-items-center rounded-pill font-display text-lg font-bold',
            ended ? 'bg-surface-2 text-muted' : 'bg-lilac text-violet',
          )}
          aria-hidden="true"
        >
          {[...follower.name][0]?.toUpperCase() ?? '?'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-bold" dir="auto">
            {follower.name}
          </span>
          <span className="block text-sm text-muted">
            {ended ? (
              endedOn ? (
                <Trans>Access ended {endedOn}</Trans>
              ) : (
                <Trans>Access ended</Trans>
              )
            ) : (
              <>
                <Plural value={active} _0="no device yet" one="# device" other="# devices" />
                {seen && (
                  <>
                    {' · '}
                    <Trans>seen {seen}</Trans>
                  </>
                )}
              </>
            )}
          </span>
        </span>
        {waiting > 0 && !ended && (
          <Badge tone="rose">
            <Plural value={waiting} one="# waiting" other="# waiting" />
          </Badge>
        )}
        <ChevronRightIcon className="size-5 text-muted" flip />
      </Link>
    </li>
  );
}

function TombstoneRow({ tombstone }: { tombstone: FollowerTombstone }) {
  const locale = useLocale();
  const date = formatDay(tombstone.deletedAt, locale, deviceTimeZone());
  return (
    <li className="flex items-center gap-3 rounded-card bg-surface-2/60 px-3.5 py-3 text-sm text-muted">
      <span className="grid size-9 shrink-0 place-items-center rounded-pill bg-surface text-muted" aria-hidden="true">
        –
      </span>
      <span className="min-w-0 flex-1">
        <Trans>Person · deleted on {date}</Trans>
        {' · '}
        {tombstone.deletedBy === 'follower' ? (
          <Trans>by themselves</Trans>
        ) : tombstone.deletedBy === 'owner' ? (
          <Trans>by you</Trans>
        ) : (
          <Trans>during a restore</Trans>
        )}
      </span>
    </li>
  );
}

/** Banners and the after-a-restore card above the list. */
function AccessBanners({ followers, tombstones }: { followers: AdminFollower[]; tombstones: FollowerTombstone[] }) {
  const status = useQuery(accessStatusQuery());
  const notices = useQuery({ ...noticesQuery(), enabled: (status.data?.unreadNotices ?? 0) > 0 });
  const action = useAccessAction();
  const read = useAccessRequest<void>();
  const qc = useQueryClient();
  const s = status.data;
  if (!s) return null;
  const restoreNotices = (notices.data?.items ?? []).filter((n) => n.kind === 'restore_reconciled' && !n.readAt);
  const summary = restoreNotices.length > 0 ? restoreSummary(s.lastReconcile, followers, tombstones) : null;
  const names = summary?.names.join(', ') ?? '';
  return (
    <div className="mb-5 space-y-3">
      {s.noticeVersion === null && (
        <div
          className="flex items-start gap-3 rounded-card bg-blush p-4 shadow-soft"
          data-testid="banner-notice-missing"
        >
          <InfoIcon className="mt-0.5 size-5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <p className="font-bold">
              <Trans>Before anyone can join, publish the privacy notice.</Trans>
            </p>
            <Link to="/settings/privacy" className={buttonClass('secondary', 'sm', 'mt-2')}>
              <Trans>Open the privacy notice</Trans>
            </Link>
          </div>
        </div>
      )}
      {s.storeId === null && (
        <div className="flex items-start gap-3 rounded-card bg-lilac p-4 shadow-soft" data-testid="banner-store-init">
          <ShieldIcon className="mt-0.5 size-5 shrink-0 text-violet" />
          <div className="min-w-0 flex-1">
            <p className="font-bold">
              <Trans>Set up the website storage</Trans>
            </p>
            <p className="mt-0.5 text-sm text-muted">
              <Trans>Once, before the first person joins: the website then knows which devices may enter.</Trans>
            </p>
            <Button
              size="sm"
              className="mt-2"
              busy={action.isPending}
              onClick={() => action.mutate({ what: msg`Website storage set up`, call: () => accessApi.storeInit() })}
            >
              <Trans>Set up</Trans>
            </Button>
          </div>
        </div>
      )}
      {s.restoring && (
        <div className="flex items-start gap-3 rounded-card bg-lilac p-4 shadow-soft" data-testid="banner-restoring">
          <InfoIcon className="mt-0.5 size-5 shrink-0 text-violet" />
          <p className="font-bold">
            <Trans>After a restore: checking access…</Trans>
          </p>
        </div>
      )}
      {summary && (
        <div className="rounded-card bg-lilac p-4 shadow-soft" data-testid="restore-card">
          <p className="font-bold">
            <Trans>After a restore</Trans>
          </p>
          {(summary.devices > 0 || summary.people > 0) && (
            <p className="mt-1 text-sm">
              {summary.devices > 0 && (
                <Plural
                  value={summary.devices}
                  one={`# device has to join again with a new link (${names}).`}
                  other={`# devices have to join again with a new link (${names}).`}
                />
              )}{' '}
              {summary.people > 0 && (
                <Plural
                  value={summary.people}
                  one="# person is missing from the backup and has to be invited again."
                  other="# people are missing from the backup and have to be invited again."
                />
              )}
            </p>
          )}
          {summary.needLink.length > 0 && (
            <div className="mt-2 text-sm" data-testid="restore-need-link">
              <p>
                <Trans>
                  For safety, every personal link was reset: a link you replaced after the backup must not work again.
                  Connected devices stay connected. For a new device, create a new link:
                </Trans>
              </p>
              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {summary.needLink.map((p) => (
                  <li key={p.id}>
                    <Link
                      to="/people/$fid"
                      params={{ fid: p.id }}
                      className="font-bold text-accent underline-offset-2 hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
                    >
                      <bdi>{p.name}</bdi>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="mt-2 text-sm text-muted">
            <Trans>If you had a panic link, create it again under Safety.</Trans>
          </p>
          <Button
            size="sm"
            variant="secondary"
            className="mt-3"
            busy={read.isPending}
            onClick={() =>
              read.mutate(() => accessApi.readNotices(restoreNotices.map((n) => n.id)), {
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
      )}
    </div>
  );
}

export function PeopleScreen() {
  const { t } = useLingui();
  const [inviting, setInviting] = useState(false);
  const q = useQuery(followersQuery());
  const items = q.data?.items ?? [];
  const tombstones = q.data?.tombstones ?? [];
  const active = items.filter((f) => f.state === 'active');
  const ended = items.filter((f) => f.state === 'revoked');
  return (
    <>
      <ScreenHeader
        eyebrow={<Trans>who sees your journey</Trans>}
        title={<Trans>People</Trans>}
        back={{ to: '/settings', label: t`Settings` }}
      />
      <Button
        icon={PlusIcon}
        className="mb-5 w-full sm:w-auto"
        onClick={() => setInviting(true)}
        data-testid="invite-open"
      >
        <Trans>Invite a person</Trans>
      </Button>
      <EffectBadge className="mb-4" />
      <AccessBanners followers={items} tombstones={tombstones} />
      <QueryError error={q.error && !q.data ? q.error : null} onRetry={() => void q.refetch()} />
      {q.isPending && (
        <div className="space-y-3">
          <Skeleton className="h-16 rounded-card" />
          <Skeleton className="h-16 rounded-card" />
        </div>
      )}
      {q.data && items.length === 0 && tombstones.length === 0 && (
        <EmptyState
          icon={PeopleIcon}
          title={<Trans>Nobody yet</Trans>}
          action={
            <Button icon={PlusIcon} onClick={() => setInviting(true)}>
              <Trans>Invite a person</Trans>
            </Button>
          }
        >
          <Trans>Invite the people who may follow your journey. Each of them gets their own link.</Trans>
        </EmptyState>
      )}
      {active.length > 0 && (
        <section aria-labelledby="people-active" className="mb-6">
          <h2 id="people-active" className="sr-only">
            <Trans>Invited</Trans>
          </h2>
          <ul className="space-y-2.5">
            {active.map((f) => (
              <PersonRow key={f.id} follower={f} />
            ))}
          </ul>
        </section>
      )}
      {ended.length > 0 && (
        <section aria-labelledby="people-ended" className="mb-6">
          <h2 id="people-ended" className="display-soft mb-2 px-1 text-lg font-semibold">
            <Trans>Access ended</Trans>
          </h2>
          <ul className="space-y-2.5">
            {ended.map((f) => (
              <PersonRow key={f.id} follower={f} />
            ))}
          </ul>
        </section>
      )}
      {tombstones.length > 0 && (
        <section aria-labelledby="people-deleted" className="mb-6">
          <h2 id="people-deleted" className="display-soft mb-2 px-1 text-lg font-semibold">
            <Trans>Deleted</Trans>
          </h2>
          <ul className="space-y-2">
            {tombstones.map((tb) => (
              <TombstoneRow key={tb.id} tombstone={tb} />
            ))}
          </ul>
        </section>
      )}
      <InviteSheet open={inviting} onClose={() => setInviting(false)} />
    </>
  );
}
