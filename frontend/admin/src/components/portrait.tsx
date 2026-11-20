/**
 * The owner's portrait (setting site.avatar) in the admin: a round preview from the private
 * capture preview, the picker sheet of photo captures, and the one write that sets or removes it
 * (with an undo offer). Used by Settings ("About you") and the item sheet ("Use as portrait").
 */
import { msg } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { CaptureListItem, Settings, SiteAvatarSetting } from '@omw/contracts/api';
import { formatLocalDate } from '@omw/ui/locale';
import { thumbhashToDataUrl } from '@omw/ui/thumbhash';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { API_BASE } from '../api/client';
import { qk } from '../api/keys';
import { capturesQuery } from '../api/queries';
import { useLocale, useWrite } from '../lib/hooks';
import { notify } from '../lib/notices';
import { clearProfileError, portraitProblem, sameSetting } from '../lib/profile';
import { CaptureVisual } from './capture';
import { CheckIcon, EyeOffIcon, HeartIcon, ImageIcon } from './icons';
import { Button, cx, Dialog, EmptyState, QueryError, Skeleton } from './ui';

/** The API's private preview of a capture (also when its list item is not loaded). */
export function capturePreviewPath(sourceKey: string): string {
  return `${API_BASE}/captures/${encodeURIComponent(sourceKey)}/preview`;
}

/** "50% 40%" for a focus point (physical image coordinates, like the site). */
export function objectPosition(focus: SiteAvatarSetting['focus']): string | undefined {
  if (!focus) return undefined;
  const pct = (v: number) => `${Math.round(Math.min(1, Math.max(0, v)) * 1000) / 10}%`;
  return `${pct(focus.x)} ${pct(focus.y)}`;
}

const SIZES = {
  sm: 'size-14',
  md: 'size-20',
  lg: 'size-24',
} as const;

/**
 * The portrait as the site shows it: a round crop at its focus point in a soft rose-to-violet
 * ring. The capture's colour and ThumbHash sit behind it while the preview loads (or offline).
 */
export function PortraitPreview({
  setting,
  capture,
  size = 'md',
  className,
}: {
  setting: SiteAvatarSetting | null | undefined;
  capture?: CaptureListItem | null | undefined;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const thumb = useMemo(() => {
    const hash = capture?.media?.thumbhash;
    return hash ? thumbhashToDataUrl(hash) : null;
  }, [capture?.media?.thumbhash]);
  const src = setting ? (capture?.previewUrl ?? capturePreviewPath(setting.sourceKey)) : null;
  return (
    <span
      data-testid="portrait-preview"
      className={cx(
        'grid shrink-0 place-items-center rounded-full p-[3px] shadow-soft',
        setting ? 'bg-linear-to-br from-rose-300 via-lilac-300 to-violet-300' : 'bg-line',
        SIZES[size],
        className,
      )}
    >
      <span className="block size-full overflow-hidden rounded-full bg-surface p-[3px]">
        {setting ? (
          <span
            className="relative block size-full overflow-hidden rounded-full bg-blush"
            style={{
              backgroundColor: capture?.media?.color ?? undefined,
              backgroundImage: thumb && !loaded ? `url(${thumb})` : undefined,
              backgroundSize: 'cover',
              backgroundPosition: objectPosition(setting.focus) ?? 'center',
            }}
          >
            {src && !failed && (
              <img
                src={src}
                alt=""
                decoding="async"
                onLoad={() => setLoaded(true)}
                onError={() => setFailed(true)}
                className={cx(
                  'absolute inset-0 size-full object-cover transition-opacity duration-300 ease-soft',
                  loaded ? 'opacity-100' : 'opacity-0',
                )}
                style={{ objectPosition: objectPosition(setting.focus) }}
              />
            )}
          </span>
        ) : (
          <span className="grid size-full place-items-center rounded-full bg-blush text-accent/70">
            <ImageIcon className="size-1/3" />
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * Sets (or with null removes) the portrait through the queued settings write, with an undo
 * offer that restores the previous choice.
 */
export function useSetPortrait(): (next: SiteAvatarSetting | null) => void {
  const qc = useQueryClient();
  const patch = useWrite('patchSettings');
  return (next) => {
    const before = qc.getQueryData<Settings>(qk.settings)?.['site.avatar'] ?? null;
    if (sameSetting(before, next)) return;
    clearProfileError('site.avatar');
    patch({ patch: { 'site.avatar': next } });
    notify({
      tone: 'undo',
      message: next ? msg`Now your portrait` : msg`Portrait removed`,
      action: {
        label: msg`Undo`,
        run: () => {
          clearProfileError('site.avatar');
          patch({ patch: { 'site.avatar': before } });
        },
      },
    });
  };
}

/** Photo statuses for the picker: newest first, a page at a time (the API filters by kind). */
function usePhotoCaptures(enabled: boolean) {
  return useInfiniteQuery({ ...capturesQuery({ kind: 'photo' }), enabled });
}

/**
 * The picker sheet: the owner's photo statuses (private previews, newest first, paged). Hidden
 * photos can be the portrait too (only a small copy is published); photos deleted on WhatsApp,
 * lost or still processing are not offered.
 */
export function PortraitPicker({
  open,
  current,
  onClose,
  onPick,
}: {
  open: boolean;
  current: string | null;
  onClose: () => void;
  onPick: (sourceKey: string) => void;
}) {
  const { t } = useLingui();
  const locale = useLocale();
  const q = usePhotoCaptures(open);
  const [selected, setSelected] = useState<string | null>(null);
  const all = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const photos = all.filter((c) => portraitProblem(c) === null);
  const notOffered = all.length - photos.length;
  const chosen = selected ?? current;
  return (
    <Dialog
      open={open}
      onClose={() => {
        setSelected(null);
        onClose();
      }}
      closeLabel={t`Close`}
      title={<Trans>Choose your portrait</Trans>}
      description={<Trans>Pick one of your photos. Only a small round copy of it appears on the site.</Trans>}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              setSelected(null);
              onClose();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            icon={CheckIcon}
            disabled={!selected || selected === current}
            onClick={() => {
              if (!selected) return;
              onPick(selected);
              setSelected(null);
            }}
          >
            <Trans>Use as portrait</Trans>
          </Button>
        </>
      }
    >
      <QueryError error={q.error && !q.data ? q.error : null} onRetry={() => void q.refetch()} />
      {q.isPending && (
        <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <Skeleton key={i} className="aspect-square rounded-tile" />
          ))}
        </div>
      )}
      {q.data && photos.length === 0 && !q.hasNextPage && (
        <EmptyState icon={ImageIcon} title={<Trans>No photos yet</Trans>}>
          <Trans>Your WhatsApp photo statuses show up here.</Trans>
        </EmptyState>
      )}
      {photos.length > 0 && (
        <fieldset>
          <legend className="sr-only">
            <Trans>Your photos</Trans>
          </legend>
          <ul className="grid grid-cols-3 gap-2.5 sm:grid-cols-4" data-testid="portrait-choices">
            {photos.map((c) => {
              const checked = chosen === c.sourceKey;
              const hidden = c.effectiveVisibility !== 'public';
              const date = formatLocalDate(c.effectiveLocalDate, locale);
              const label = c.caption ? `${c.caption} · ${date}` : date;
              return (
                <li key={c.sourceKey}>
                  <label
                    className={cx(
                      'press relative block cursor-pointer overflow-hidden rounded-tile ring-offset-2 ring-offset-surface',
                      'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
                      checked ? 'ring-3 ring-accent' : 'hover:ring-2 hover:ring-blush-strong',
                    )}
                  >
                    <input
                      type="radio"
                      name="portrait"
                      value={c.sourceKey}
                      checked={checked}
                      onChange={() => setSelected(c.sourceKey)}
                      aria-label={hidden ? t`${label} (not shown in the timeline)` : label}
                      className="sr-only"
                    />
                    <CaptureVisual capture={c} compact dimmed={hidden} className="aspect-square w-full" />
                    {hidden && (
                      <span className="absolute start-1.5 bottom-1.5 grid size-6 place-items-center rounded-pill bg-surface/90 text-muted shadow-soft">
                        <EyeOffIcon className="size-3.5" />
                      </span>
                    )}
                    {checked ? (
                      <span className="absolute end-1.5 top-1.5 grid size-6 place-items-center rounded-pill bg-accent text-on-accent shadow-soft">
                        <CheckIcon className="size-4" />
                      </span>
                    ) : (
                      // The portrait until now, while another photo is selected.
                      c.sourceKey === current && (
                        <span className="absolute end-1.5 top-1.5 grid size-6 place-items-center rounded-pill bg-surface/90 text-accent shadow-soft">
                          <HeartIcon className="size-3.5" />
                        </span>
                      )
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
      {q.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="ghost" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            <Trans>Show more photos</Trans>
          </Button>
        </div>
      )}
      {q.data && notOffered > 0 && (
        <p className="mt-3 text-xs text-muted">
          <Plural
            value={notOffered}
            one="# photo is not offered: deleted on WhatsApp, lost or still processing."
            other="# photos are not offered: deleted on WhatsApp, lost or still processing."
          />
        </p>
      )}
    </Dialog>
  );
}
