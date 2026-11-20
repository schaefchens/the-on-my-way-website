/**
 * Trips: list with covers and date ranges; editor with title/description per language, slug
 * (fixed once created), a validated date range (end >= start, no overlap with other trips, as
 * the API enforces) and a cover chosen from the day covers inside the range.
 */
import { msg } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { AdminDaySummary, AdminTrip } from '@omw/contracts/api';
import { type LocaleCode, pickText } from '@omw/contracts/i18n';
import { overlappingTrips } from '@omw/contracts/policy';
import { isValidLocalDate, localDateFor } from '@omw/contracts/time';
import { formatLocalDate, formatLocalDateRange } from '@omw/ui/locale';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { API_BASE } from '../api/client';
import { sameValue } from '../api/conflicts';
import { daysQuery, settingsQuery, tripsQuery } from '../api/queries';
import { writeBase } from '../api/types';
import { ImageIcon, PlaneIcon, PlusIcon, SuitcaseIcon, TrashIcon } from '../components/icons';
import {
  Badge,
  Button,
  buttonClass,
  cx,
  Dialog,
  EmptyState,
  Field,
  ImageChoice,
  LocaleTabs,
  QueryError,
  ScreenHeader,
  Section,
  SelectInput,
  Skeleton,
  StickyActions,
  TextArea,
  TextInput,
} from '../components/ui';
import { cleanText, filledLocales, slugify } from '../lib/forms';
import { useLocale, useNotifyWrite, useServerForm, useWrite } from '../lib/hooks';
import { deviceTimeZone } from '../lib/places';
import { DaysTripsSwitch } from './days';
import { CONTENT_LOCALES } from './item';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function previewPath(sourceKey: string): string {
  return `${API_BASE}/captures/${encodeURIComponent(sourceKey)}/preview`;
}

function coverUrl(trip: Pick<AdminTrip, 'coverSourceKey'>, days: readonly AdminDaySummary[]): string | null {
  if (!trip.coverSourceKey) return null;
  return (
    days.find((d) => d.coverSourceKey === trip.coverSourceKey)?.coverPreviewUrl ?? previewPath(trip.coverSourceKey)
  );
}

function CoverImage({ src, className }: { src: string | null; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cx('relative overflow-hidden bg-linear-to-br from-blush to-lilac', className)}>
      {src && !failed ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      ) : (
        <span className="absolute inset-0 grid place-items-center text-accent/70">
          <PlaneIcon className="size-10" />
        </span>
      )}
    </div>
  );
}

export function TripsScreen() {
  const locale = useLocale();
  const q = useQuery(tripsQuery());
  const days = useQuery(daysQuery());
  const settings = useQuery(settingsQuery());
  const today = localDateFor(new Date(), settings.data?.['timezone.current'] ?? deviceTimeZone());
  const trips = [...(q.data?.items ?? [])].sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
  const dayList = days.data?.items ?? [];
  return (
    <>
      <ScreenHeader
        eyebrow={<Trans>chapter by chapter</Trans>}
        title={<Trans>Trips</Trans>}
        actions={
          <Link to="/trips/new" className={buttonClass('primary', 'md')}>
            <PlusIcon className="size-5" />
            <Trans>New trip</Trans>
          </Link>
        }
      />
      <DaysTripsSwitch current="trips" />
      <QueryError error={q.error && !q.data ? q.error : null} onRetry={() => void q.refetch()} />
      {q.isPending && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-64 rounded-card" />
          <Skeleton className="h-64 rounded-card" />
        </div>
      )}
      {q.data && trips.length === 0 && (
        <EmptyState
          icon={SuitcaseIcon}
          title={<Trans>No trips yet</Trans>}
          action={
            <Link to="/trips/new" className={buttonClass('primary')}>
              <Trans>Plan the first trip</Trans>
            </Link>
          }
        >
          <Trans>A trip bundles days into a chapter of the timeline, with its own page.</Trans>
        </EmptyState>
      )}
      <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {trips.map((trip, i) => {
          const daysIn = dayList.filter((d) => d.trip === trip.slug).length;
          const now = trip.startDate <= today && today <= trip.endDate;
          return (
            <li key={trip.slug}>
              <Link
                to="/trips/$slug"
                params={{ slug: trip.slug }}
                className={cx('press polaroid block hover:shadow-lift', i % 2 ? 'rotate-[0.8deg]' : 'rotate-[-0.8deg]')}
              >
                <CoverImage src={coverUrl(trip, dayList)} className="aspect-[4/3] rounded-[0.55rem]" />
                <div className="px-2 pt-3 pb-4">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="display-soft truncate text-xl font-semibold" dir="auto">
                      {pickText(trip.title, locale, trip.origLocale)?.text ?? trip.slug}
                    </h2>
                    {now && (
                      <Badge tone="rose">
                        <span className="size-1.5 animate-pulse-dot rounded-pill bg-accent" aria-hidden="true" />
                        <Trans>now</Trans>
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 font-hand text-muted">
                    {formatLocalDateRange(trip.startDate, trip.endDate, locale)}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    <Plural value={daysIn} one="# day with moments" other="# days with moments" />
                  </p>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Editor

interface TripForm {
  title: Partial<Record<LocaleCode, string>>;
  description: Partial<Record<LocaleCode, string>>;
  origLocale: LocaleCode | null;
  slug: string;
  slugTouched: boolean;
  startDate: string;
  endDate: string;
  coverSourceKey: string | null;
}

function toForm(trip: AdminTrip | undefined, today: string): TripForm {
  return {
    title: { ...(trip?.title ?? {}) },
    description: { ...(trip?.description ?? {}) },
    origLocale: trip?.origLocale ?? null,
    slug: trip?.slug ?? '',
    slugTouched: !!trip,
    startDate: trip?.startDate ?? today,
    endDate: trip?.endDate ?? today,
    coverSourceKey: trip?.coverSourceKey ?? null,
  };
}

const editApi = getRouteApi('/authed/trips/$slug');

export function TripNewScreen() {
  return <TripEditor slug={null} />;
}

export function TripEditScreen() {
  const { slug } = editApi.useParams();
  return <TripEditor key={slug} slug={slug} />;
}

function TripEditor({ slug }: { slug: string | null }) {
  const { t } = useLingui();
  const locale = useLocale();
  const navigate = useNavigate();
  // The editor asks the server again: a trip created elsewhere (or a moment ago) must not look
  // missing because a still-fresh cached list does not know it yet.
  const q = useQuery({ ...tripsQuery(), refetchOnMount: 'always' });
  const days = useQuery(daysQuery());
  const settings = useQuery(settingsQuery());
  const putTrip = useWrite('putTrip');
  const deleteTrip = useWrite('deleteTrip');
  const notifyWrite = useNotifyWrite();
  const today = localDateFor(new Date(), settings.data?.['timezone.current'] ?? deviceTimeZone());
  const existing = slug ? q.data?.items.find((tr) => tr.slug === slug) : undefined;
  const {
    form,
    edit: setForm,
    markSaved,
  } = useServerForm<TripForm>(existing?.updatedAt, !slug || !!existing, () => toForm(existing, today));
  const [tab, setTab] = useState<LocaleCode>(locale === 'en' ? 'en' : 'de');
  const [submitted, setSubmitted] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const others = (q.data?.items ?? []).filter((tr) => tr.slug !== slug);
  const title = cleanText(form.title);
  const datesValid = isValidLocalDate(form.startDate) && isValidLocalDate(form.endDate);
  const errors = {
    title: !title ? t`Give the trip a title.` : null,
    slug: !SLUG_RE.test(form.slug)
      ? t`Only lowercase letters, digits and dashes.`
      : !slug && others.some((tr) => tr.slug === form.slug)
        ? t`Another trip already uses this address.`
        : null,
    dates: !datesValid
      ? t`Choose a start and an end.`
      : form.endDate < form.startDate
        ? t`The end must not be before the start.`
        : null,
    overlap: null as string | null,
  };
  if (datesValid && !errors.dates) {
    const hits = overlappingTrips(
      { slug: form.slug || '~new', startDate: form.startDate, endDate: form.endDate },
      others,
    );
    if (hits.length) {
      const names = hits
        .map((h) => {
          const tr = others.find((o) => o.slug === h);
          return tr ? (pickText(tr.title, locale, tr.origLocale)?.text ?? h) : h;
        })
        .join(', ');
      errors.overlap = t`Overlaps with ${names}. Trips must not share days.`;
    }
  }
  const valid = !errors.title && !errors.slug && !errors.dates && !errors.overlap;
  // An existing trip without edits has nothing to save.
  const dirty =
    !existing ||
    !sameValue(
      {
        title: title,
        description: cleanText(form.description),
        origLocale: form.origLocale,
        startDate: form.startDate,
        endDate: form.endDate,
        coverSourceKey: form.coverSourceKey,
      },
      {
        title: existing.title,
        description: existing.description ?? null,
        origLocale: existing.origLocale ?? null,
        startDate: existing.startDate,
        endDate: existing.endDate,
        coverSourceKey: existing.coverSourceKey ?? null,
      },
    );
  const coverCandidates = useMemo(
    () =>
      (days.data?.items ?? []).filter(
        (d) => d.coverSourceKey && d.localDate >= form.startDate && d.localDate <= form.endDate,
      ),
    [days.data, form.startDate, form.endDate],
  );

  function save() {
    setSubmitted(true);
    if (!valid || !title) return;
    const description = cleanText(form.description);
    const origLocale =
      form.origLocale && title[form.origLocale] ? form.origLocale : ((filledLocales(title)[0] as LocaleCode) ?? null);
    const body = {
      slug: form.slug,
      title,
      ...(description ? { description } : {}),
      ...(origLocale ? { origLocale } : {}),
      startDate: form.startDate,
      endDate: form.endDate,
      coverSourceKey: form.coverSourceKey,
    };
    putTrip({
      body,
      base: existing ? writeBase(existing.updatedAt, existing.changeSeq) : null,
      original: existing
        ? {
            title: existing.title,
            ...(existing.description ? { description: existing.description } : {}),
            ...(existing.origLocale ? { origLocale: existing.origLocale } : {}),
            startDate: existing.startDate,
            endDate: existing.endDate,
            coverSourceKey: existing.coverSourceKey ?? null,
          }
        : {},
    });
    markSaved();
    notifyWrite(`trip:${body.slug}`, existing ? msg`Trip saved` : msg`Trip created`);
    void navigate({ to: '/trips' });
  }

  if (slug && !existing) {
    return (
      <>
        <ScreenHeader back={{ to: '/trips', label: t`Trips` }} title={<Trans>Trip</Trans>} />
        <QueryError error={q.error} onRetry={() => void q.refetch()} />
        {q.isPending || q.isFetching ? (
          <Skeleton className="h-96 rounded-card" />
        ) : (
          !q.error && <EmptyState icon={SuitcaseIcon} title={<Trans>This trip does not exist (any more).</Trans>} />
        )}
      </>
    );
  }

  const show = (e: string | null) => (submitted ? e : null);
  return (
    <>
      <ScreenHeader
        back={{ to: '/trips', label: t`Trips` }}
        eyebrow={
          existing ? formatLocalDateRange(existing.startDate, existing.endDate, locale) : <Trans>a new chapter</Trans>
        }
        title={
          existing ? (
            (pickText(existing.title, locale, existing.origLocale)?.text ?? existing.slug)
          ) : (
            <Trans>New trip</Trans>
          )
        }
      />
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <div className="space-y-5">
          <Section title={<Trans>Name & story</Trans>}>
            <LocaleTabs
              label={t`Language`}
              locales={CONTENT_LOCALES}
              value={tab}
              onChange={setTab}
              filled={new Set(filledLocales(form.title))}
              original={form.origLocale}
              originalLabel={t`original`}
            />
            <div className="mt-4 space-y-4">
              <Field label={<Trans>Title</Trans>} error={show(errors.title)}>
                {(ids) => (
                  <TextInput
                    {...ids}
                    lang={tab}
                    dir="auto"
                    maxLength={120}
                    className="display-soft text-lg font-semibold"
                    placeholder={t`e.g. Vietnam 2026`}
                    value={form.title[tab] ?? ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      setForm((f) => {
                        const next = { ...f, title: { ...f.title, [tab]: v } };
                        if (!f.slugTouched && !slug)
                          next.slug = slugify(cleanText(next.title)?.[f.origLocale ?? tab] ?? v);
                        return next;
                      });
                    }}
                  />
                )}
              </Field>
              <Field label={<Trans>Description</Trans>}>
                {(ids) => (
                  <TextArea
                    {...ids}
                    lang={tab}
                    dir="auto"
                    rows={3}
                    value={form.description[tab] ?? ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      setForm((f) => ({ ...f, description: { ...f.description, [tab]: v } }));
                    }}
                  />
                )}
              </Field>
              <Field label={<Trans>Written in</Trans>}>
                {(ids) => (
                  <SelectInput
                    {...ids}
                    value={form.origLocale ?? ''}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, origLocale: (e.target.value || null) as LocaleCode | null }))
                    }
                  >
                    <option value="">{t`Not set`}</option>
                    {CONTENT_LOCALES.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.label}
                      </option>
                    ))}
                  </SelectInput>
                )}
              </Field>
              <Field
                label={<Trans>Web address</Trans>}
                hint={
                  slug ? (
                    <Trans>The address cannot change after the trip was created.</Trans>
                  ) : (
                    <Trans>…/trip/{form.slug || 'my-trip'}/</Trans>
                  )
                }
                error={show(errors.slug)}
              >
                {(ids) => (
                  <TextInput
                    {...ids}
                    dir="ltr"
                    value={form.slug}
                    readOnly={!!slug}
                    className={slug ? 'bg-surface-2 text-muted' : undefined}
                    maxLength={64}
                    onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value.toLowerCase(), slugTouched: true }))}
                  />
                )}
              </Field>
            </div>
          </Section>
          <Section
            title={<Trans>Dates</Trans>}
            description={<Trans>Every day in this range belongs to the trip.</Trans>}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={<Trans>First day</Trans>}>
                {(ids) => (
                  <TextInput
                    {...ids}
                    type="date"
                    value={form.startDate}
                    aria-invalid={!!show(errors.dates) || !!errors.overlap || undefined}
                    onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                  />
                )}
              </Field>
              <Field label={<Trans>Last day</Trans>}>
                {(ids) => (
                  <TextInput
                    {...ids}
                    type="date"
                    value={form.endDate}
                    min={form.startDate}
                    aria-invalid={!!errors.dates || !!errors.overlap || undefined}
                    onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value }))}
                  />
                )}
              </Field>
            </div>
            {(errors.dates || errors.overlap) && (
              <p role="alert" className="mt-3 rounded-tile bg-danger/10 px-3 py-2 text-sm font-semibold text-danger">
                {errors.dates ?? errors.overlap}
              </p>
            )}
          </Section>
        </div>
        <div className="space-y-5">
          <Section
            icon={ImageIcon}
            title={<Trans>Cover</Trans>}
            description={<Trans>Chosen from the day covers of the trip.</Trans>}
          >
            {coverCandidates.length === 0 ? (
              <p className="text-sm text-muted">
                <Trans>No day in this range has a picture yet.</Trans>
              </p>
            ) : (
              <fieldset>
                <legend className="sr-only">{t`Cover`}</legend>
                <div className="grid grid-cols-3 gap-2">
                  <ImageChoice
                    name="trip-cover"
                    label={t`None`}
                    checked={form.coverSourceKey === null}
                    onChange={() => setForm((f) => ({ ...f, coverSourceKey: null }))}
                  >
                    <span
                      aria-hidden="true"
                      className={cx(
                        'grid aspect-square place-items-center rounded-tile border-2 border-dashed p-1 text-center text-xs font-bold',
                        form.coverSourceKey === null
                          ? 'border-accent bg-blush text-accent-strong'
                          : 'border-line text-muted',
                      )}
                    >
                      <Trans>None</Trans>
                    </span>
                  </ImageChoice>
                  {coverCandidates.map((d) => (
                    <ImageChoice
                      key={d.localDate}
                      name="trip-cover"
                      label={formatLocalDate(d.localDate, locale)}
                      checked={form.coverSourceKey === d.coverSourceKey}
                      onChange={() => setForm((f) => ({ ...f, coverSourceKey: d.coverSourceKey }))}
                    >
                      <CoverImage src={d.coverPreviewUrl} className="aspect-square" />
                    </ImageChoice>
                  ))}
                </div>
              </fieldset>
            )}
          </Section>
          {existing && (
            <Button variant="danger" icon={TrashIcon} className="w-full" onClick={() => setConfirmDelete(true)}>
              <Trans>Delete trip</Trans>
            </Button>
          )}
        </div>
      </div>
      <StickyActions note={submitted && !valid ? <Trans>Please check the marked fields.</Trans> : null}>
        <Link to="/trips" className={buttonClass('ghost', 'sm')}>
          <Trans>Cancel</Trans>
        </Link>
        <Button size="sm" onClick={save} disabled={(submitted && !valid) || !dirty}>
          {existing ? <Trans>Save trip</Trans> : <Trans>Create trip</Trans>}
        </Button>
      </StickyActions>
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        closeLabel={t`Close`}
        title={<Trans>Delete this trip?</Trans>}
        description={<Trans>The days and their moments stay. Only the trip chapter and its page disappear.</Trans>}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              <Trans>Keep</Trans>
            </Button>
            <Button
              className="bg-danger hover:bg-danger"
              icon={TrashIcon}
              onClick={() => {
                if (!slug) return;
                deleteTrip({ slug });
                notifyWrite(`trip:${slug}`, msg`Trip deleted`);
                void navigate({ to: '/trips' });
              }}
            >
              <Trans>Delete</Trans>
            </Button>
          </>
        }
      />
    </>
  );
}
