/**
 * One person (spec-wave5 §7.4): name (editable), private note, invitation date and the confirmed
 * privacy notice; devices with their state and actions (allow / decline a waiting device, remove
 * an active one); a new personal link, the data export, ending access and deleting everything
 * (D2, D8, D12). Every store-changing action shows its effect (components/effect-badge.tsx).
 */
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AdminDevice, AdminFollower, PersonalLink } from '@omw/contracts/access';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import {
  accessApi,
  applyActionResult,
  downloadJson,
  exportFileName,
  notifyAccessError,
  useAccessAction,
  useAccessRequest,
} from '../api/access';
import { ApiRequestError } from '../api/client';
import { qk } from '../api/keys';
import { followerQuery } from '../api/queries';
import { ConfirmSheet } from '../components/confirm-sheet';
import { EffectBadge } from '../components/effect-badge';
import {
  AlertIcon,
  CheckIcon,
  CloseIcon,
  CompassIcon,
  DevicesIcon,
  KeyIcon,
  LaptopIcon,
  LinkIcon,
  LockIcon,
  PencilIcon,
  PhoneIcon,
  SendIcon,
  TabletIcon,
  TrashIcon,
} from '../components/icons';
import {
  Badge,
  type BadgeTone,
  Button,
  buttonClass,
  Card,
  EmptyState,
  Field,
  QueryError,
  ScreenHeader,
  Section,
  Skeleton,
  TextArea,
  TextInput,
} from '../components/ui';
import { useLocale, useNow } from '../lib/hooks';
import { notify } from '../lib/notices';
import {
  countDevices,
  type DeviceChip,
  type DeviceKind,
  deviceChip,
  deviceKind,
  formatDay,
  formatDaysAgo,
  sortDevices,
} from '../lib/people';
import { deviceTimeZone } from '../lib/places';
import { cleanFollowerName, PersonalLinkSheet } from './people';

const CHIP_TONE: Record<DeviceChip, BadgeTone> = {
  pending: 'rose',
  active: 'success',
  removed: 'neutral',
  declined: 'neutral',
  signed_out: 'neutral',
};

function Chip({ chip }: { chip: DeviceChip }) {
  return (
    <Badge tone={CHIP_TONE[chip]}>
      {chip === 'pending' ? (
        <Trans>Waiting</Trans>
      ) : chip === 'active' ? (
        <Trans>Active</Trans>
      ) : chip === 'removed' ? (
        <Trans>Removed</Trans>
      ) : chip === 'declined' ? (
        <Trans>Declined</Trans>
      ) : (
        <Trans>Signed out</Trans>
      )}
    </Badge>
  );
}

function useLocalDate() {
  const locale = useLocale();
  return (iso: string) => formatDay(iso, locale, deviceTimeZone());
}

/** Name and note, edited in place (PATCH /admin/followers/{fid}). */
function PersonHeader({ follower }: { follower: AdminFollower }) {
  const { t, i18n } = useLingui();
  const qc = useQueryClient();
  const date = useLocalDate();
  const request = useAccessRequest<AdminFollower>();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(follower.name);
  const [note, setNote] = useState(follower.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const clean = cleanFollowerName(name);
  const tooLong = clean.length > 60 || note.trim().length > 200;
  const invitedOn = date(follower.createdAt);
  const consent = follower.consent;
  const consentOn = consent ? date(consent.confirmedAt) : null;
  const consentVersion = consent?.version ?? 0;
  function save() {
    if (!clean || tooLong) return;
    const patch = {
      ...(clean !== follower.name ? { name: clean } : {}),
      ...(note.trim() !== (follower.note ?? '') ? { note: note.trim() || null } : {}),
    };
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    request.mutate(() => accessApi.patchFollower(follower.id, patch), {
      onSuccess: (f) => {
        applyActionResult(qc, { follower: f });
        notify({ tone: 'success', message: msg`Saved` });
        setEditing(false);
        setError(null);
      },
      onError: (err) => {
        if (err instanceof ApiRequestError && err.status === 0) setError(i18n._(msg`Not sent – no connection`));
        else notifyAccessError(err);
      },
    });
  }
  if (editing) {
    return (
      <Card className="mb-5 space-y-4">
        <Field label={<Trans>Name</Trans>} error={clean.length > 60 ? t`At most 60 characters` : error}>
          {(ids) => (
            <TextInput
              {...ids}
              data-testid="person-name"
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field
          label={<Trans>Private note</Trans>}
          hint={<Trans>Only for you.</Trans>}
          error={note.trim().length > 200 ? t`At most 200 characters` : null}
        >
          {(ids) => (
            <TextArea {...ids} rows={2} maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setName(follower.name);
              setNote(follower.note ?? '');
              setEditing(false);
              setError(null);
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button icon={CheckIcon} busy={request.isPending} disabled={!clean || tooLong} onClick={save}>
            <Trans>Save</Trans>
          </Button>
        </div>
      </Card>
    );
  }
  return (
    <div className="mb-5 space-y-1.5 px-1 text-sm text-muted">
      {follower.note && (
        <p className="font-hand text-base text-ink" dir="auto" data-user-text>
          {follower.note}
        </p>
      )}
      <p>
        <Trans>Invited on {invitedOn}</Trans>
      </p>
      <p>
        {consent ? (
          <Trans>
            Privacy notice v{consentVersion} confirmed on {consentOn}
          </Trans>
        ) : (
          <Trans>Has not confirmed a privacy notice yet</Trans>
        )}
      </p>
      <Button
        size="sm"
        variant="ghost"
        icon={PencilIcon}
        className="-ms-3"
        onClick={() => {
          setName(follower.name);
          setNote(follower.note ?? '');
          setEditing(true);
        }}
      >
        <Trans>Edit name and note</Trans>
      </Button>
    </div>
  );
}

const DEVICE_ICONS: Readonly<Record<DeviceKind, typeof PhoneIcon>> = {
  phone: PhoneIcon,
  tablet: TabletIcon,
  computer: LaptopIcon,
  other: DevicesIcon,
};

function DeviceRow({ follower, device }: { follower: AdminFollower; device: AdminDevice }) {
  const { i18n } = useLingui();
  const locale = useLocale();
  const now = useNow(60_000);
  const date = useLocalDate();
  const action = useAccessAction();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [limit, setLimit] = useState<string | null>(null);
  const chip = deviceChip(device);
  const name = follower.name;
  const label = device.label || i18n._(msg`Unknown device`);
  const DeviceKindIcon = DEVICE_ICONS[deviceKind(device.label)];
  const since = date(device.createdAt);
  const seen = device.lastSeenAt ? formatDaysAgo(device.lastSeenAt, locale, now, deviceTimeZone()) : null;
  function approve() {
    setLimit(null);
    action.mutate(
      {
        what: msg`Device allowed for ${name}`,
        values: { name },
        call: () => accessApi.approveDevice(device.id),
        handles: (err) => err instanceof ApiRequestError && err.code === 'device_limit',
      },
      {
        onError: (err) => {
          if (err instanceof ApiRequestError && err.code === 'device_limit') {
            const n = countDevices(follower, 'active');
            setLimit(i18n._(msg`${name} already has ${n} devices. Remove one first.`));
          }
        },
      },
    );
  }
  return (
    <li className="rounded-tile bg-bg p-3.5" data-testid={`device-${device.id}`}>
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-pill bg-surface text-violet">
          <DeviceKindIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-bold">{label}</span>
            <Chip chip={chip} />
            {device.first && (
              <span className="text-xs text-muted">
                <Trans>first device</Trans>
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            <Trans>since {since}</Trans>
            {seen && (
              <>
                {' · '}
                <Trans>last seen {seen}</Trans>
              </>
            )}
          </p>
        </div>
      </div>
      {chip === 'pending' && (
        <div className="mt-3 space-y-3">
          <p className="rounded-tile bg-blush px-3 py-2 text-sm">
            <Trans>Only allow devices you can match to this person. If in doubt, ask them quickly.</Trans>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="md" icon={CheckIcon} busy={action.isPending} onClick={approve}>
              <Trans>Allow</Trans>
            </Button>
            <Button
              size="md"
              variant="secondary"
              icon={CloseIcon}
              disabled={action.isPending}
              onClick={() =>
                action.mutate({
                  what: msg`Device declined`,
                  call: () => accessApi.declineDevice(device.id),
                })
              }
            >
              <Trans>Decline</Trans>
            </Button>
          </div>
          {limit && (
            <p role="alert" className="flex items-start gap-2 text-sm font-semibold text-danger">
              <AlertIcon className="mt-0.5 size-4 shrink-0" />
              {limit}
            </p>
          )}
        </div>
      )}
      {chip === 'active' && follower.state === 'active' && (
        <div className="mt-3">
          <Button size="sm" variant="danger" icon={TrashIcon} onClick={() => setConfirmRemove(true)}>
            <Trans>Remove</Trans>
          </Button>
        </div>
      )}
      <ConfirmSheet
        open={confirmRemove}
        danger
        title={<Trans>Remove this device?</Trans>}
        description={
          <Trans>
            “{label}” sees only the neutral page from now on. To use it again, {name} opens the link again and you allow
            the device.
          </Trans>
        }
        confirmLabel={<Trans>Remove device</Trans>}
        confirmIcon={TrashIcon}
        busy={action.isPending}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() =>
          action.mutate(
            { what: msg`Device removed`, call: () => accessApi.revokeDevice(device.id) },
            { onSettled: () => setConfirmRemove(false) },
          )
        }
      />
    </li>
  );
}

function ActionRow({
  icon: IconCmp,
  title,
  description,
  children,
}: {
  icon: typeof LinkIcon;
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-tile bg-bg p-3.5 sm:flex-row sm:items-center">
      <span className="hidden size-10 shrink-0 place-items-center rounded-pill bg-surface text-accent sm:grid">
        <IconCmp className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-bold">{title}</p>
        <p className="text-sm text-muted">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </li>
  );
}

function PersonActions({ follower }: { follower: AdminFollower }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const action = useAccessAction();
  const linkRequest = useAccessRequest<{ link: PersonalLink }>();
  const exportRequest = useAccessRequest<unknown>();
  const [confirmLink, setConfirmLink] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [link, setLink] = useState<PersonalLink | null>(null);
  const name = follower.name;
  const active = follower.state === 'active';
  return (
    <Section icon={KeyIcon} title={<Trans>Access</Trans>}>
      <ul className="space-y-2.5">
        {active && (
          <ActionRow
            icon={LinkIcon}
            title={<Trans>New personal link</Trans>}
            description={<Trans>For a lost link. Connected devices stay connected.</Trans>}
          >
            <Button size="sm" variant="secondary" icon={LinkIcon} onClick={() => setConfirmLink(true)}>
              <Trans>Create new link</Trans>
            </Button>
          </ActionRow>
        )}
        <ActionRow
          icon={SendIcon}
          title={<Trans>Export data</Trans>}
          description={<Trans>Everything stored about {name}, as a file.</Trans>}
        >
          <Button
            size="sm"
            variant="secondary"
            icon={SendIcon}
            busy={exportRequest.isPending}
            onClick={() =>
              exportRequest.mutate(() => accessApi.exportFollower(follower.id), {
                onSuccess: (data) => downloadJson(data, exportFileName(name)),
                onError: (err) => notifyAccessError(err),
              })
            }
          >
            <Trans>Export data</Trans>
          </Button>
        </ActionRow>
        {active && (
          <ActionRow
            icon={LockIcon}
            title={<Trans>End access</Trans>}
            description={<Trans>All devices of {name} see only the neutral page.</Trans>}
          >
            <Button size="sm" variant="danger" icon={LockIcon} onClick={() => setConfirmEnd(true)}>
              <Trans>End access</Trans>
            </Button>
          </ActionRow>
        )}
        <ActionRow
          icon={TrashIcon}
          title={<Trans>Delete all data of this person</Trans>}
          description={<Trans>For a request that reaches you some other way. Cannot be undone.</Trans>}
        >
          <Button size="sm" variant="danger" icon={TrashIcon} onClick={() => setConfirmDelete(true)}>
            <Trans>Delete…</Trans>
          </Button>
        </ActionRow>
      </ul>

      <ConfirmSheet
        open={confirmLink}
        title={<Trans>Create a new link?</Trans>}
        description={<Trans>The old link stops working then.</Trans>}
        confirmLabel={<Trans>Create new link</Trans>}
        confirmIcon={LinkIcon}
        busy={linkRequest.isPending}
        onClose={() => setConfirmLink(false)}
        onConfirm={() =>
          linkRequest.mutate(() => accessApi.rotateLink(follower.id), {
            onSuccess: (res) => {
              setConfirmLink(false);
              setLink(res.link);
              applyActionResult(qc, {});
            },
            onError: (err) => {
              setConfirmLink(false);
              notifyAccessError(err);
            },
          })
        }
      />
      <ConfirmSheet
        open={confirmEnd}
        danger
        title={<Trans>End access for {name}?</Trans>}
        description={
          <Trans>
            {name} sees only the neutral page from now on. What {name} has already seen stays with them. Stored data is
            kept.
          </Trans>
        }
        confirmLabel={<Trans>End access</Trans>}
        confirmIcon={LockIcon}
        busy={action.isPending}
        onClose={() => setConfirmEnd(false)}
        onConfirm={() =>
          action.mutate(
            {
              what: msg`Access ended for ${name}`,
              values: { name },
              call: () => accessApi.revokeFollower(follower.id),
            },
            { onSettled: () => setConfirmEnd(false) },
          )
        }
      >
        <p className="rounded-tile bg-lilac px-3 py-2.5 text-sm">
          <Trans>Also remove {name} from your WhatsApp status audience.</Trans>
        </p>
      </ConfirmSheet>
      <ConfirmSheet
        open={confirmDelete}
        danger
        title={<Trans>Delete all data of {name}?</Trans>}
        description={
          <Trans>
            The name, all devices and confirmations are deleted for good, and every device loses access at once. Only an
            anonymous entry without a name remains.
          </Trans>
        }
        check={<Trans>I understand that everything is deleted for good</Trans>}
        confirmLabel={<Trans>Delete for good</Trans>}
        confirmIcon={TrashIcon}
        busy={action.isPending}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() =>
          action.mutate(
            { what: msg`All data of a person deleted`, call: () => accessApi.deleteFollower(follower.id) },
            {
              onSuccess: () => {
                setConfirmDelete(false);
                qc.removeQueries({ queryKey: qk.access.follower(follower.id) });
                void navigate({ to: '/people' });
              },
              onError: () => setConfirmDelete(false),
            },
          )
        }
      />
      <PersonalLinkSheet name={name} link={link} onClose={() => setLink(null)} />
    </Section>
  );
}

export function PersonScreen() {
  const { t } = useLingui();
  const { fid } = useParams({ from: '/authed/people/$fid' });
  const q = useQuery(followerQuery(fid));
  const date = useLocalDate();
  const f = q.data;
  const gone = q.error instanceof ApiRequestError && q.error.status === 404;
  const back = { to: '/people', label: t`People` };
  if (gone) {
    return (
      <>
        <ScreenHeader back={back} title={<Trans>Not here any more</Trans>} />
        <EmptyState
          icon={CompassIcon}
          title={<Trans>This person no longer exists</Trans>}
          action={
            <Link to="/people" className={buttonClass('secondary')}>
              <Trans>All people</Trans>
            </Link>
          }
        />
      </>
    );
  }
  const endedOn = f?.revokedAt ? date(f.revokedAt) : null;
  const name = f?.name ?? '';
  return (
    <>
      <ScreenHeader
        back={back}
        eyebrow={f?.state === 'revoked' ? <Trans>access ended</Trans> : <Trans>personally invited</Trans>}
        title={f ? <bdi>{f.name}</bdi> : <Skeleton className="h-10 w-40" />}
        subtitle={f?.state === 'revoked' && endedOn ? <Trans>Access ended on {endedOn}.</Trans> : undefined}
      />
      <EffectBadge className="mb-4" />
      <QueryError error={q.error && !q.data ? q.error : null} onRetry={() => void q.refetch()} />
      {q.isPending && <Skeleton className="h-48 rounded-card" />}
      {f && (
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <div className="space-y-5">
            <PersonHeader key={`${f.id}-${f.name}-${f.note ?? ''}`} follower={f} />
            <Section icon={PhoneIcon} title={<Trans>Devices</Trans>}>
              {f.devices.length === 0 ? (
                <p className="text-sm text-muted">
                  <Trans>No device yet. As soon as {name} opens the link, the device appears here.</Trans>
                </p>
              ) : (
                <ul className="space-y-2.5">
                  {sortDevices(f.devices).map((d) => (
                    <DeviceRow key={d.id} follower={f} device={d} />
                  ))}
                </ul>
              )}
            </Section>
          </div>
          <PersonActions follower={f} />
        </div>
      )}
    </>
  );
}
