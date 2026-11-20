/**
 * 409 conflict dialog: the newer server version against the owner's edit, field by field
 * (localized fields per language). Non-conflicting changes are merged silently; for each real
 * conflict the owner picks "mine" (default) or "newer version", then the merged write is sent
 * with the server's updatedAt (conflicts.ts resolveConflict).
 */
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { CaptureKind } from '@omw/contracts';
import type { CaptureListItem } from '@omw/contracts/api';
import { isLocaleCode, LOCALES } from '@omw/contracts/i18n';
import { countryName, formatLocalDate, formatTime } from '@omw/ui/locale';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { findCapture } from '../api/cache';
import { type Choice, type Conflict, conflictStore, type FieldDiff, resolveConflict } from '../api/conflicts';
import type { AnnotateVars, PatchDayVars, PutTripVars } from '../api/types';
import { useLocale } from '../lib/hooks';
import { useStore } from '../lib/store';
import { CaptureVisual } from './capture';
import { FIELD_LABEL, KIND_LABEL, VISIBILITY_LABEL } from './labels';
import { Badge, Button, cx, Dialog } from './ui';

function useValueText() {
  const { i18n, t } = useLingui();
  const locale = useLocale();
  return (field: string, value: unknown): string => {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return t`(empty)`;
    if (field === 'visibility' && typeof value === 'string' && value in VISIBILITY_LABEL) {
      return i18n._(VISIBILITY_LABEL[value as keyof typeof VISIBILITY_LABEL]);
    }
    if (field === 'countryCode' && typeof value === 'string') return countryName(value, locale);
    if (['localDateOverride', 'startDate', 'endDate'].includes(field) && typeof value === 'string') {
      return formatLocalDate(value, locale, 'long');
    }
    if (field === 'origLocale' && isLocaleCode(value)) return LOCALES.find((l) => l.code === value)?.label ?? value;
    if (field === 'occurredAt' && typeof value === 'string') return new Date(value).toLocaleString(locale);
    if (typeof value === 'object') {
      const o = value as { title?: unknown; body?: unknown };
      if ('body' in o) return [o.title, o.body].filter((x) => typeof x === 'string' && x).join(' — ');
      return JSON.stringify(value);
    }
    return String(value);
  };
}

/** "your photo" … per kind (the article/gender differs per kind in German). */
const YOUR_KIND: Record<CaptureKind, MessageDescriptor> = {
  photo: msg`your photo`,
  video: msg`your video`,
  gif: msg`your GIF`,
  voice: msg`your voice message`,
  text: msg`your text status`,
  unsupported: msg`your status`,
};

/** A status as the owner knows it: kind, caption and when (never its WhatsApp message id). */
function CaptureName({ capture }: { capture: CaptureListItem | undefined }) {
  const { i18n } = useLingui();
  const locale = useLocale();
  if (!capture) return <Trans>this status</Trans>;
  const your = i18n._(YOUR_KIND[capture.kind]);
  const when = `${formatLocalDate(capture.effectiveLocalDate, locale)}, ${formatTime(capture.occurredAt, capture.effectiveTz, locale)}`;
  const caption = capture.caption?.trim() || (capture.kind === 'text' ? capture.text?.body.trim() : '') || '';
  const short = caption.length > 40 ? `${caption.slice(0, 39)}…` : caption;
  return short ? (
    <Trans>
      {your} “<bdi>{short}</bdi>” from {when}
    </Trans>
  ) : (
    <Trans>
      {your} from {when}
    </Trans>
  );
}

/** Thumbnail caption: the WhatsApp caption, then kind and time. */
function CaptureLine({ capture }: { capture: CaptureListItem }) {
  const { i18n } = useLingui();
  const locale = useLocale();
  const when = `${formatLocalDate(capture.effectiveLocalDate, locale)}, ${formatTime(capture.occurredAt, capture.effectiveTz, locale)}`;
  return (
    <div className="min-w-0 text-sm">
      {capture.caption && (
        <p className="truncate font-hand text-base" dir="auto" data-user-text>
          {capture.caption}
        </p>
      )}
      <p className="text-muted">
        {i18n._(KIND_LABEL[capture.kind])} · {when}
      </p>
    </div>
  );
}

function EntityName({ conflict }: { conflict: Conflict }) {
  const locale = useLocale();
  const qc = useQueryClient();
  switch (conflict.name) {
    case 'annotate':
      return <CaptureName capture={findCapture(qc, (conflict.vars as AnnotateVars).sourceKey)} />;
    case 'patchDay': {
      const date = formatLocalDate((conflict.vars as PatchDayVars).date, locale, 'long');
      return <Trans>the day {date}</Trans>;
    }
    case 'updatePost':
      return <Trans>this post</Trans>;
    case 'putTrip': {
      const slug = (conflict.vars as PutTripVars).body.slug;
      return <Trans>the trip “{slug}”</Trans>;
    }
  }
}

function FieldChoice({ diff, choice, onChoose }: { diff: FieldDiff; choice: Choice; onChoose: (c: Choice) => void }) {
  const { i18n, t } = useLingui();
  const text = useValueText();
  const descriptor = FIELD_LABEL[diff.field];
  const label = descriptor ? i18n._(descriptor) : diff.field;
  const name = `conflict-${diff.id}`;
  const options: Array<{ value: Choice; title: string; value_: unknown }> = [
    { value: 'mine', title: t`Your change`, value_: diff.mine },
    { value: 'server', title: t`Newer version`, value_: diff.server },
  ];
  return (
    <fieldset className="rounded-card bg-bg p-3">
      <legend className="sr-only">{label}</legend>
      <p className="mb-2 flex items-center gap-2 px-1 text-sm font-bold" aria-hidden="true">
        {label}
        {diff.locale && <Badge tone="lilac">{diff.locale.toUpperCase()}</Badge>}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={cx(
              'press flex cursor-pointer flex-col gap-1 rounded-tile border-2 bg-surface p-3 text-sm',
              choice === o.value ? 'border-accent shadow-soft' : 'border-transparent hover:border-line',
            )}
          >
            <span className="flex items-center gap-2 font-bold">
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={choice === o.value}
                onChange={() => onChoose(o.value)}
                className="size-4 accent-[var(--omw-accent)]"
              />
              {o.title}
            </span>
            <span dir="auto" data-user-text className="line-clamp-4 text-muted break-words">
              {text(diff.field, o.value_)}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ConflictDialog() {
  const conflicts = useStore(conflictStore);
  const conflict = conflicts[0];
  // Keyed by the conflict: choices start fresh for every conflict.
  return conflict ? <ConflictSheet key={conflict.id} conflict={conflict} more={conflicts.length - 1} /> : null;
}

function ConflictSheet({ conflict, more }: { conflict: Conflict; more: number }) {
  const qc = useQueryClient();
  const { t } = useLingui();
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);

  const { plan } = conflict;
  const autoMerged = plan.fields.filter((f) => f.status === 'mine').length;
  const canRestore = plan.gone && conflict.name === 'putTrip';
  const capture = conflict.name === 'annotate' ? findCapture(qc, (conflict.vars as AnnotateVars).sourceKey) : undefined;

  async function resolve(keep: 'server' | 'merge') {
    setBusy(true);
    await resolveConflict(qc, conflict.id, keep === 'server' ? { keep: 'server' } : { keep: 'merge', choices });
  }

  return (
    <Dialog
      open
      dismissible={false}
      onClose={() => void resolve('server')}
      closeLabel={t`Close`}
      title={plan.gone ? <Trans>This was deleted elsewhere</Trans> : <Trans>Changed on another device</Trans>}
      description={
        plan.gone ? (
          <Trans>
            While you were editing, <EntityName conflict={conflict} /> was deleted (maybe on another device).
          </Trans>
        ) : (
          <Trans>
            While you were editing, <EntityName conflict={conflict} /> was changed elsewhere. Choose which version to
            keep.
          </Trans>
        )
      }
      footer={
        plan.gone ? (
          <>
            <Button variant="secondary" disabled={busy} onClick={() => void resolve('server')}>
              <Trans>Discard my change</Trans>
            </Button>
            {canRestore && (
              <Button busy={busy} onClick={() => void resolve('merge')}>
                <Trans>Restore with my change</Trans>
              </Button>
            )}
          </>
        ) : (
          <>
            <Button variant="secondary" disabled={busy} onClick={() => void resolve('server')}>
              <Trans>Keep newer version</Trans>
            </Button>
            <Button busy={busy} onClick={() => void resolve('merge')}>
              <Trans>Save my choice</Trans>
            </Button>
          </>
        )
      }
    >
      {capture && (
        <div className="mb-4 flex items-center gap-3 rounded-card bg-bg p-2">
          <CaptureVisual capture={capture} compact className="size-14 shrink-0" />
          <CaptureLine capture={capture} />
        </div>
      )}
      {!plan.gone && (
        <div className="space-y-3">
          {plan.conflicts.map((diff) => (
            <FieldChoice
              key={diff.id}
              diff={diff}
              choice={choices[diff.id] ?? 'mine'}
              onChoose={(c) => setChoices((prev) => ({ ...prev, [diff.id]: c }))}
            />
          ))}
          {autoMerged > 0 && (
            <p className="px-1 text-sm text-muted">
              <Plural
                value={autoMerged}
                one="# other change of yours does not collide and is kept."
                other="# other changes of yours do not collide and are kept."
              />
            </p>
          )}
          {more > 0 && (
            <p className="px-1 text-xs text-muted">
              <Plural value={more} one="# more conflict after this one." other="# more conflicts after this one." />
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
