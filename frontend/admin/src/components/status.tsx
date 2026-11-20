/** Per-item status chips: "Live ✓ / publishing… / saving…" and visibility. */
import { Trans, useLingui } from '@lingui/react/macro';
import type { Visibility } from '@omw/contracts';
import type { CaptureListItem, PublishStateInput } from '@omw/contracts/api';
import { useQuery } from '@tanstack/react-query';
import { settingsQuery, statusQuery } from '../api/queries';
import { usePendingWrites } from '../lib/hooks';
import { capturePublishInput, type ItemState, itemState } from '../lib/publish';
import { CheckIcon, ClockIcon, CloudOffIcon, EyeOffIcon } from './icons';
import { VISIBILITY_LABEL } from './labels';
import { Badge, Spinner } from './ui';

export function useItemState(item: PublishStateInput, entity: string): ItemState {
  const status = useQuery(statusQuery());
  const pending = usePendingWrites().filter((p) => p.entity === entity);
  const saving = pending.length === 0 ? false : pending.some((p) => p.paused) ? 'queued' : true;
  return itemState(item, status.data, saving);
}

export function PublishChip({ state }: { state: ItemState }) {
  switch (state) {
    case 'live':
      return (
        <Badge tone="success" icon={CheckIcon}>
          <Trans>Live</Trans>
        </Badge>
      );
    case 'publishing':
      return (
        <Badge tone="lilac">
          <span className="size-1.5 animate-pulse-dot rounded-pill bg-violet" aria-hidden="true" />
          <Trans>Publishing…</Trans>
        </Badge>
      );
    case 'queued':
      return (
        <Badge tone="lilac" icon={CloudOffIcon}>
          <Trans>Waiting for network</Trans>
        </Badge>
      );
    case 'saving':
      return (
        <Badge tone="rose">
          <Spinner className="size-3" />
          <Trans>Saving…</Trans>
        </Badge>
      );
    case 'not_public':
      return null;
  }
}

/** Publish chip for an item, derived from the status poll and our queued writes. */
export function ItemPublishChip({ item, entity }: { item: PublishStateInput; entity: string }) {
  return <PublishChip state={useItemState(item, entity)} />;
}

/** Publish chip of a captured status (knows when delayed publishing makes it public). */
export function CapturePublishChip({ capture }: { capture: CaptureListItem }) {
  const settings = useQuery(settingsQuery());
  return <ItemPublishChip item={capturePublishInput(capture, settings.data)} entity={`capture:${capture.sourceKey}`} />;
}

export function VisibilityBadge({ visibility, auto = false }: { visibility: Visibility; auto?: boolean }) {
  const { i18n, t } = useLingui();
  if (visibility === 'public') return null;
  return (
    <Badge tone={visibility === 'hidden' ? 'neutral' : 'lilac'} icon={visibility === 'hidden' ? EyeOffIcon : ClockIcon}>
      {i18n._(VISIBILITY_LABEL[visibility])}
      {auto && <span className="sr-only">{t`(by the publish setting)`}</span>}
    </Badge>
  );
}
