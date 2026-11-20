/**
 * Inbox: captured statuses, newest first, grouped by (effective) day, with private previews.
 * Swipe a card back to hide it, forward to show it (or use the buttons); set it as the day's
 * cover; open it to describe it or move it to another day. Every change offers an undo.
 */
import { msg } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { Visibility } from '@omw/contracts';
import type { AdminDaySummary, CaptureListItem } from '@omw/contracts/api';
import { pickText } from '@omw/contracts/i18n';
import { localDateFor } from '@omw/contracts/time';
import { formatDateTime, formatLocalDate, formatTime, forwardSign } from '@omw/ui/locale';
import { SPRINGS } from '@omw/ui/motion';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useMotionValue, useTransform } from 'motion/react';
import * as m from 'motion/react-m';
import { useEffect, useMemo, useRef } from 'react';
import { capturesQuery, daysQuery, settingsQuery } from '../api/queries';
import { writeBase } from '../api/types';
import { CaptureVisual } from '../components/capture';
import { ChevronRightIcon, EyeIcon, EyeOffIcon, InboxIcon, PencilIcon, StarIcon } from '../components/icons';
import { KIND_LABEL } from '../components/labels';
import { CapturePublishChip, VisibilityBadge } from '../components/status';
import {
  Badge,
  Button,
  cx,
  EmptyState,
  IconButton,
  QueryError,
  ScreenHeader,
  Segmented,
  Skeleton,
} from '../components/ui';
import {
  annotateVars,
  canBeCover,
  groupBy,
  toggledVisibility,
  visibilityNotice,
  visibilityOutcome,
} from '../lib/captures';
import { useLocale, useWrite } from '../lib/hooks';
import { notify } from '../lib/notices';
import { deviceTimeZone } from '../lib/places';
import { inboxSeenStore, isNew, markSeen } from '../lib/seen';
import { useStore } from '../lib/store';

export type InboxFilter = 'all' | Visibility;
const inboxApi = getRouteApi('/authed/inbox');

/** "14:30" today, else a short date and time (device clock: what the owner's phone shows). */
function usePublishTime() {
  const locale = useLocale();
  return (iso: string) => {
    const tz = deviceTimeZone();
    return localDateFor(iso, tz) === localDateFor(new Date(), tz)
      ? formatTime(iso, tz, locale)
      : formatDateTime(iso, tz, locale);
  };
}

/**
 * Visibility change with undo (shared with the item sheet). Without `next` it is the one-tap
 * toggle of the card and the swipe (lib/captures.ts toggledVisibility): un-hiding returns to
 * the publish setting instead of publishing at once. `next` null clears the override.
 */
export function useToggleVisibility() {
  const annotate = useWrite('annotate');
  const settings = useQuery(settingsQuery());
  const time = usePublishTime();
  return (c: CaptureListItem, next?: Visibility | null) => {
    const now = Date.now();
    const target = next === undefined ? toggledVisibility(c, settings.data, now) : next;
    const vars = annotateVars(c, { visibility: target });
    annotate(vars);
    notify({
      tone: 'undo',
      message: visibilityNotice(visibilityOutcome(c, target, settings.data, now), time),
      action: {
        label: msg`Undo`,
        run: () =>
          annotate({
            ...vars,
            patch: { visibility: vars.original.visibility ?? null },
            original: { visibility: target },
          }),
      },
    });
  };
}

/** Sets (or clears) the explicit cover of the capture's day, with undo. */
export function useSetCover() {
  const patchDay = useWrite('patchDay');
  return (c: CaptureListItem, day: AdminDaySummary | undefined) => {
    const before = day?.day?.coverSourceKey ?? null;
    const next = before === c.sourceKey ? null : c.sourceKey;
    const vars = {
      date: c.effectiveLocalDate,
      patch: { coverSourceKey: next },
      original: { coverSourceKey: before },
      base: writeBase(day?.day?.updatedAt, day?.changeSeq),
    };
    patchDay(vars);
    notify({
      tone: 'undo',
      message: next ? msg`Set as the day's cover` : msg`Cover removed`,
      action: {
        label: msg`Undo`,
        run: () => patchDay({ ...vars, patch: { coverSourceKey: before }, original: { coverSourceKey: next } }),
      },
    });
  };
}

const SWIPE = 88;

/** The generator never publishes unsupported kinds or captures whose media is lost. */
export function publishable(c: CaptureListItem): boolean {
  return c.kind !== 'unsupported' && c.mediaState !== 'lost';
}

function CaptureCard({
  capture: c,
  day,
  fresh,
}: {
  capture: CaptureListItem;
  day: AdminDaySummary | undefined;
  fresh: boolean;
}) {
  const { t, i18n } = useLingui();
  const locale = useLocale();
  const toggle = useToggleVisibility();
  const setCover = useSetCover();
  const x = useMotionValue(0);
  const fwd = forwardSign(locale);
  const hideOpacity = useTransform(x, (v) => Math.min(1, Math.max(0, (-v * fwd) / SWIPE)));
  const showOpacity = useTransform(x, (v) => Math.min(1, Math.max(0, (v * fwd) / SWIPE)));
  const hidden = c.effectiveVisibility === 'hidden';
  // The day's effective cover (badge) may be automatic; the star toggles the explicit choice.
  const isCover = day?.coverSourceKey === c.sourceKey;
  const pinnedCover = day?.day?.coverSourceKey === c.sourceKey;
  const description = pickText(c.annotation?.description, locale, c.annotation?.origLocale);
  const time = formatTime(c.occurredAt, c.effectiveTz, locale);
  const kind = i18n._(KIND_LABEL[c.kind]);

  return (
    <li className="relative min-w-0">
      {/* Swipe backdrop: hide on one side, show on the other (mirrors in RTL). */}
      <div aria-hidden="true" className="absolute inset-0 flex items-center justify-between rounded-card px-6">
        <m.span style={{ opacity: showOpacity }} className="flex items-center gap-2 font-bold text-success">
          <EyeIcon className="size-6" />
          <Trans>Show</Trans>
        </m.span>
        <m.span style={{ opacity: hideOpacity }} className="flex items-center gap-2 font-bold text-muted">
          <Trans>Hide</Trans>
          <EyeOffIcon className="size-6" />
        </m.span>
      </div>
      <m.article
        aria-label={`${kind}, ${time}`}
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.55}
        dragSnapToOrigin
        dragTransition={{ bounceStiffness: 500, bounceDamping: 32 }}
        style={{ x, touchAction: 'pan-y' }}
        onDragEnd={(_, info) => {
          const forward = info.offset.x * fwd;
          if (forward < -SWIPE && c.effectiveVisibility !== 'hidden') toggle(c, 'hidden');
          // Forward = the one-tap toggle: a hidden status returns to the publish setting, a
          // waiting one is published now.
          else if (forward > SWIPE && c.effectiveVisibility !== 'public') toggle(c);
        }}
        whileDrag={{ scale: 1.01 }}
        transition={SPRINGS.soft}
        className="relative flex gap-3.5 rounded-card bg-surface p-3 shadow-soft md:flex-col md:gap-4 md:p-3.5"
      >
        <Link
          to="/inbox/$sourceKey"
          params={{ sourceKey: c.sourceKey }}
          draggable={false}
          aria-label={t`Open ${kind} from ${time}`}
          // Phones: a compact square polaroid, so three or more statuses fit on a screen.
          className="polaroid press block w-[31%] shrink-0 rotate-[-1.2deg] self-start md:w-full md:rotate-0"
        >
          <CaptureVisual
            capture={c}
            dimmed={hidden}
            className="aspect-square w-full md:aspect-[4/3]"
            rounded="rounded-[0.55rem]"
          />
          <span
            className="block truncate px-1 py-1.5 text-center font-hand text-[0.8rem] text-muted md:py-2 md:text-sm"
            dir="auto"
            data-user-text
          >
            {c.caption || ' '}
          </span>
        </Link>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="font-bold tabular-nums">{time}</span>
            <span className="text-muted">· {kind}</span>
            {fresh && (
              <Badge tone="rose" className="ms-auto md:ms-0">
                <span className="size-1.5 rounded-pill bg-accent" aria-hidden="true" />
                <Trans>new</Trans>
              </Badge>
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <VisibilityBadge visibility={c.effectiveVisibility} />
            {publishable(c) && <CapturePublishChip capture={c} />}
            {isCover && (
              <Badge tone="lilac" icon={StarIcon}>
                {pinnedCover ? <Trans>Cover</Trans> : <Trans>Cover (automatic)</Trans>}
              </Badge>
            )}
            {c.revokedAt && (
              <Badge tone="neutral">
                <Trans>Deleted on WhatsApp</Trans>
              </Badge>
            )}
            {c.annotation?.localDateOverride && (
              <Badge tone="neutral">
                <Trans>moved</Trans>
              </Badge>
            )}
          </div>
          <p
            className={cx(
              'mt-1.5 line-clamp-2 text-sm md:mt-2 md:line-clamp-3',
              description ? 'text-ink' : 'text-muted italic',
            )}
            dir="auto"
            data-user-text
          >
            {description?.text ?? <Trans>No description yet</Trans>}
          </p>
          <div className="mt-auto flex items-center gap-1 pt-2 md:pt-3">
            <Button
              variant={hidden ? 'soft' : 'secondary'}
              size="sm"
              icon={hidden ? EyeIcon : EyeOffIcon}
              onClick={() => toggle(c)}
              aria-pressed={hidden}
            >
              {hidden ? (
                <Trans>Show</Trans>
              ) : c.effectiveVisibility === 'pending' ? (
                <Trans>Publish now</Trans>
              ) : (
                <Trans>Hide</Trans>
              )}
            </Button>
            {canBeCover(c) && (
              <IconButton
                size="sm"
                label={pinnedCover ? t`Remove as the day's cover` : t`Set as the day's cover`}
                icon={StarIcon}
                aria-pressed={pinnedCover}
                className={pinnedCover ? 'bg-lilac text-violet [&_svg]:fill-current' : ''}
                onClick={() => setCover(c, day)}
              />
            )}
            <Link
              to="/inbox/$sourceKey"
              params={{ sourceKey: c.sourceKey }}
              search={{ focus: 'description' }}
              aria-label={t`Describe`}
              title={t`Describe`}
              className="press ms-auto grid size-11 shrink-0 place-items-center rounded-pill text-muted hover:bg-blush hover:text-ink"
            >
              <PencilIcon className="size-5" />
            </Link>
          </div>
        </div>
      </m.article>
    </li>
  );
}

export function InboxScreen() {
  const { t } = useLingui();
  const locale = useLocale();
  const { show = 'all' } = inboxApi.useSearch();
  const navigate = inboxApi.useNavigate();
  const filter = show === 'all' ? {} : { visibility: show };
  const q = useInfiniteQuery(capturesQuery(filter));
  const days = useQuery(daysQuery());
  const seenAt = useStore(inboxSeenStore);
  // Captures that are "new" stay marked during this visit; leaving the inbox marks them seen.
  const seenOnEnter = useRef(seenAt);
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const newest = items[0]?.occurredAt;
  useEffect(() => () => markSeen(newest), [newest]);

  const dayByDate = useMemo(() => new Map((days.data?.items ?? []).map((d) => [d.localDate, d])), [days.data]);
  const groups = useMemo(() => groupBy(items, (c) => c.effectiveLocalDate), [items]);

  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = q;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <>
      <ScreenHeader
        eyebrow={<Trans>straight from WhatsApp</Trans>}
        title={<Trans>Inbox</Trans>}
        subtitle={<Trans>Swipe a status away to hide it, or back to show it. Tap to describe it.</Trans>}
      />
      <Segmented<InboxFilter>
        label={t`Show`}
        value={show}
        onChange={(next) => void navigate({ search: next === 'all' ? {} : { show: next }, replace: true })}
        size="sm"
        className="mb-6 w-full sm:w-auto"
        options={[
          { value: 'all', label: t`All` },
          { value: 'public', label: t`Public` },
          { value: 'pending', label: t`Waiting` },
          { value: 'hidden', label: t`Hidden` },
        ]}
      />
      <QueryError error={q.error && !q.data ? q.error : null} onRetry={() => void q.refetch()} />
      {q.isPending && (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 rounded-card" />
          ))}
        </div>
      )}
      {q.data && items.length === 0 && (
        <EmptyState
          icon={InboxIcon}
          title={show === 'all' ? <Trans>No statuses yet</Trans> : <Trans>Nothing here</Trans>}
        >
          {show === 'all' ? (
            <Trans>As soon as you post a WhatsApp status, it shows up here.</Trans>
          ) : (
            <Trans>No status matches this filter.</Trans>
          )}
        </EmptyState>
      )}
      <div className="space-y-8">
        {groups.map((g) => {
          const day = dayByDate.get(g.key);
          const title = pickText(day?.day?.title, locale, day?.day?.origLocale)?.text;
          return (
            <section key={g.key} aria-labelledby={`d-${g.key}`}>
              <div className="sticky top-0 z-10 -mx-4 mb-3 flex items-end justify-between gap-3 bg-bg/95 px-4 pt-3 pb-2.5 shadow-[0_10px_16px_-14px_var(--omw-shadow-far)] backdrop-blur-md sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10">
                <div className="min-w-0">
                  <h2 id={`d-${g.key}`} className="font-hand text-lg leading-tight text-accent">
                    {formatLocalDate(g.key, locale, 'day-header')}
                  </h2>
                  <p className="display-soft truncate text-lg font-semibold" dir="auto">
                    {title ?? (
                      <span className="text-muted">
                        <Plural value={g.items.length} one="# status" other="# statuses" />
                      </span>
                    )}
                  </p>
                </div>
                <Link
                  to="/days/$date"
                  params={{ date: g.key }}
                  className="press inline-flex min-h-9 shrink-0 items-center gap-1 rounded-pill px-3 text-sm font-bold text-muted hover:bg-blush hover:text-ink pointer-coarse:min-h-11"
                >
                  <Trans>Day</Trans>
                  <ChevronRightIcon className="size-4" />
                </Link>
              </div>
              <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {g.items.map((c) => (
                  <CaptureCard
                    key={c.sourceKey}
                    capture={c}
                    day={day}
                    fresh={isNew(c.occurredAt, seenOnEnter.current)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <div ref={sentinel} />
      {hasNextPage && (
        <div className="mt-8 flex justify-center">
          <Button variant="secondary" busy={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            <Trans>Load older statuses</Trans>
          </Button>
        </div>
      )}
    </>
  );
}
