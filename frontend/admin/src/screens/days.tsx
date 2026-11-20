/**
 * Days: every day with content, newest first and grouped by month, with gentle badges for a
 * missing title or place. The day editor holds title/summary per language, place and country,
 * optional coordinates, the cover and the time-zone fix (contracts: Day.tz, policy Placement).
 */
import { msg } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { AdminDayDetail, AdminDaySummary, Day } from '@omw/contracts/api';
import { type LocaleCode, pickText } from '@omw/contracts/i18n';
import { addDays } from '@omw/contracts/time';
import { countryFlag, formatLocalDate, formatTime } from '@omw/ui/locale';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useId, useMemo, useState } from 'react';
import { dayQuery, daysQuery, settingsQuery, tripsQuery } from '../api/queries';
import { writeBase } from '../api/types';
import { CaptureVisual } from '../components/capture';
import {
  BookIcon,
  CalendarIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  FeatherIcon,
  GlobeIcon,
  ImageIcon,
  InfoIcon,
  PencilIcon,
  PinIcon,
  SuitcaseIcon,
} from '../components/icons';
import { KIND_LABEL } from '../components/labels';
import { ItemPublishChip, VisibilityBadge } from '../components/status';
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  IconButton,
  ImageChoice,
  LocaleTabs,
  QueryError,
  ScreenHeader,
  Section,
  Segmented,
  SelectInput,
  Skeleton,
  StickyActions,
  Switch,
  TextArea,
  TextInput,
} from '../components/ui';
import { UnsavedChangesGuard } from '../components/unsaved';
import { canBeCover, groupBy } from '../lib/captures';
import { useDraftedForm } from '../lib/drafted-form';
import { cleanText, dirtyPatch, filledLocales, parseCoordinate } from '../lib/forms';
import { useLocale, useNotifyWrite, usePendingEntities, useWrite } from '../lib/hooks';
import { countryOptions, deviceTimeZone, zoneChoices, zoneLabel } from '../lib/places';
import { CONTENT_LOCALES } from './item';

/** "Days · Trips" switch shown on both screens (Trips share the Days tab on phones). */
export function DaysTripsSwitch({ current }: { current: 'days' | 'trips' }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  return (
    <Segmented<'days' | 'trips'>
      label={t`Days or trips`}
      value={current}
      size="sm"
      className="mb-6"
      onChange={(next) => void navigate({ to: next === 'days' ? '/days' : '/trips' })}
      options={[
        { value: 'days', label: t`Days`, icon: CalendarIcon },
        { value: 'trips', label: t`Trips`, icon: SuitcaseIcon },
      ]}
    />
  );
}

function DayRow({ summary, tripTitle }: { summary: AdminDaySummary; tripTitle: string | null }) {
  const locale = useLocale();
  const day = summary.day;
  const title = pickText(day?.title, locale, day?.origLocale)?.text;
  const moments = summary.counts.captures + summary.counts.posts;
  return (
    <li>
      <Link
        to="/days/$date"
        params={{ date: summary.localDate }}
        className="press group flex items-center gap-4 rounded-card bg-surface p-3 pe-4 shadow-soft hover:shadow-lift"
      >
        <span className="relative size-18 shrink-0 overflow-hidden rounded-tile bg-blush">
          {summary.coverPreviewUrl ? (
            <img src={summary.coverPreviewUrl} alt="" loading="lazy" className="size-full object-cover" />
          ) : (
            <span className="grid size-full place-items-center text-accent">
              <ImageIcon className="size-6" />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-hand text-[0.95rem] text-accent">
            {formatLocalDate(summary.localDate, locale)}
          </span>
          <span
            className={cx('display-soft block truncate text-lg leading-snug font-semibold', !title && 'text-muted')}
            dir="auto"
          >
            {title ?? <Trans>Untitled day</Trans>}
          </span>
          {tripTitle && (
            <span className="mt-1 flex min-w-0">
              <Badge tone="neutral" icon={SuitcaseIcon} className="max-w-full">
                <bdi className="truncate">{tripTitle}</bdi>
              </Badge>
            </span>
          )}
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {day?.placeName && (
              <span className="inline-flex items-center gap-1 font-semibold">
                <PinIcon className="size-3.5" />
                <bdi>{day.placeName}</bdi>
                {day.countryCode && <span aria-hidden="true">{countryFlag(day.countryCode)}</span>}
              </span>
            )}
            <span>
              <Plural value={moments} one="# moment" other="# moments" />
            </span>
            {!day?.placeName && (
              <Badge tone="lilac">
                <Trans>no place</Trans>
              </Badge>
            )}
            {summary.counts.hidden > 0 && (
              <Badge tone="neutral">
                <Plural value={summary.counts.hidden} one="# hidden" other="# hidden" />
              </Badge>
            )}
            {summary.counts.pending > 0 && (
              <Badge tone="lilac">
                <Plural value={summary.counts.pending} one="# waiting" other="# waiting" />
              </Badge>
            )}
          </span>
        </span>
        <ChevronRightIcon className="size-5 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5" />
      </Link>
    </li>
  );
}

export function DaysScreen() {
  const locale = useLocale();
  const q = useQuery(daysQuery());
  const trips = useQuery(tripsQuery());
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const tripTitles = useMemo(
    () =>
      new Map(
        (trips.data?.items ?? []).map((tr) => [tr.slug, pickText(tr.title, locale, tr.origLocale)?.text ?? tr.slug]),
      ),
    [trips.data, locale],
  );
  const items = useMemo(() => {
    const list = [...(q.data?.items ?? [])].reverse();
    return onlyIncomplete ? list.filter((d) => !d.day?.title || !d.day?.placeName) : list;
  }, [q.data, onlyIncomplete]);
  const months = useMemo(() => groupBy(items, (d) => d.localDate.slice(0, 7)), [items]);
  const incomplete = (q.data?.items ?? []).filter((d) => !d.day?.title || !d.day?.placeName).length;

  return (
    <>
      <ScreenHeader eyebrow={<Trans>page by page</Trans>} title={<Trans>Days</Trans>} />
      <DaysTripsSwitch current="days" />
      {incomplete > 0 && (
        <Card className="mb-6 py-4">
          <Switch
            checked={onlyIncomplete}
            onChange={setOnlyIncomplete}
            label={<Trans>Only days that need love</Trans>}
            description={
              <Plural
                value={incomplete}
                one="# day has no title or place yet."
                other="# days have no title or place yet."
              />
            }
          />
        </Card>
      )}
      <QueryError error={q.error && !q.data ? q.error : null} onRetry={() => void q.refetch()} />
      {q.isPending && (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-card" />
          ))}
        </div>
      )}
      {q.data && items.length === 0 && (
        <EmptyState icon={BookIcon} title={<Trans>No days yet</Trans>}>
          <Trans>Days appear as soon as there is a status or a note.</Trans>
        </EmptyState>
      )}
      <div className="space-y-8">
        {months.map((month) => (
          <section key={month.key} aria-labelledby={`m-${month.key}`}>
            <h2
              id={`m-${month.key}`}
              className="display-soft mb-3 px-1 text-sm font-bold tracking-wide text-muted uppercase"
            >
              {formatLocalDate(`${month.key}-01`, locale, 'month')}
            </h2>
            <ul className="grid gap-3 lg:grid-cols-2">
              {month.items.map((d) => (
                <DayRow key={d.localDate} summary={d} tripTitle={d.trip ? (tripTitles.get(d.trip) ?? d.trip) : null} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Day editor

interface DayForm {
  title: Partial<Record<LocaleCode, string>>;
  summary: Partial<Record<LocaleCode, string>>;
  origLocale: LocaleCode | null;
  placeName: string;
  countryCode: string;
  lat: string;
  lng: string;
  coverSourceKey: string | null;
  tz: string | null;
}

/** The editable fields of a day as the API sees them (for dirty patches). */
function dayFields(day: Day | null) {
  return {
    title: day?.title ?? null,
    summary: day?.summary ?? null,
    origLocale: day?.origLocale ?? null,
    placeName: day?.placeName ?? null,
    countryCode: day?.countryCode ?? null,
    lat: day?.lat ?? null,
    lng: day?.lng ?? null,
    coverSourceKey: day?.coverSourceKey ?? null,
    tz: day?.tz ?? null,
  };
}

type DayValues = ReturnType<typeof dayFields>;

function toForm(v: DayValues): DayForm {
  return {
    title: { ...(v.title ?? {}) },
    summary: { ...(v.summary ?? {}) },
    origLocale: v.origLocale,
    placeName: v.placeName ?? '',
    countryCode: v.countryCode ?? '',
    lat: v.lat !== null ? String(v.lat) : '',
    lng: v.lng !== null ? String(v.lng) : '',
    coverSourceKey: v.coverSourceKey,
    tz: v.tz,
  };
}

const dayApi = getRouteApi('/authed/days/$date');

function CoverPicker({
  detail,
  value,
  onChange,
}: {
  detail: AdminDayDetail;
  value: string | null;
  onChange: (key: string | null) => void;
}) {
  const { t } = useLingui();
  const locale = useLocale();
  const candidates = detail.captures.filter(canBeCover);
  const name = useId();
  if (candidates.length === 0) {
    return (
      <p className="text-sm text-muted">
        <Trans>There is no photo or video on this day yet.</Trans>
      </p>
    );
  }
  return (
    <fieldset>
      <legend className="sr-only">{t`Cover`}</legend>
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        <ImageChoice name={name} label={t`Automatic`} checked={value === null} onChange={() => onChange(null)}>
          <span
            className={cx(
              'grid aspect-square place-items-center rounded-tile border-2 border-dashed p-1 text-center text-[0.7rem] leading-tight font-bold break-words hyphens-auto',
              value === null ? 'border-accent bg-blush text-accent-strong' : 'border-line text-muted',
            )}
            aria-hidden="true"
          >
            <Trans>Automatic</Trans>
          </span>
        </ImageChoice>
        {candidates.map((c) => (
          <ImageChoice
            key={c.sourceKey}
            name={name}
            label={`${formatTime(c.occurredAt, c.effectiveTz, locale)}${c.caption ? ` · ${c.caption}` : ''}`}
            checked={value === c.sourceKey}
            onChange={() => onChange(c.sourceKey)}
          >
            <CaptureVisual capture={c} compact className="aspect-square w-full" />
          </ImageChoice>
        ))}
      </div>
    </fieldset>
  );
}

function TimeZoneFix({
  detail,
  value,
  onChange,
  current,
}: {
  detail: AdminDayDetail;
  value: string | null;
  onChange: (tz: string | null) => void;
  /** timezone.current (the zone new statuses are sorted in by). */
  current: string | undefined;
}) {
  const { t } = useLingui();
  const locale = useLocale();
  const zones = zoneChoices(locale);
  const device = deviceTimeZone();
  const captured = [...new Set([...detail.captures.map((c) => c.tz), ...detail.posts.map((p) => p.tz)])];
  const capturedLabels = captured.map((z) => zoneLabel(z, locale)).join(', ');
  // The device zone would change nothing: it is the fix already, or every item is in it anyway.
  const deviceChangesNothing = value === device || (value === null && captured.every((z) => z === device));
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        {captured.length > 0 ? (
          <Trans>
            The items of this day were sorted in by the time zone set when they were captured ({capturedLabels}). If
            that was wrong (a flight, a forgotten setting), choose the right zone: they are re-dated and may move to the
            day before or after.
          </Trans>
        ) : (
          <Trans>If items of this day were sorted in with the wrong time zone, choose the right one here.</Trans>
        )}
      </p>
      <p className="flex items-start gap-2 rounded-tile bg-bg px-3 py-2.5 text-xs text-muted">
        <InfoIcon className="mt-px size-4 shrink-0 text-violet" />
        <span>
          <Trans>
            This only re-sorts this one day. Where you are now (for new statuses) is set in{' '}
            <Link to="/settings" className="font-bold text-accent underline-offset-2 hover:underline">
              Settings
            </Link>
            {current ? <> ({zoneLabel(current, locale)})</> : null}.
          </Trans>
        </span>
      </p>
      <Field label={<Trans>Time zone of this day</Trans>}>
        {(ids) => (
          <SelectInput {...ids} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
            <option value="">{t`No correction`}</option>
            {zones.map((z) => (
              <option key={z.tz} value={z.tz}>
                {z.label} ({z.offset})
              </option>
            ))}
          </SelectInput>
        )}
      </Field>
      {(!deviceChangesNothing || value) && (
        <div className="flex flex-wrap gap-2">
          {!deviceChangesNothing && (
            <Button variant="soft" size="sm" icon={ClockIcon} onClick={() => onChange(device)}>
              <Trans>Re-sort this day in this device's zone ({zoneLabel(device, locale)})</Trans>
            </Button>
          )}
          {value && (
            <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
              <Trans>Remove correction</Trans>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function DayItems({ detail }: { detail: AdminDayDetail }) {
  const { i18n } = useLingui();
  const locale = useLocale();
  const entries = [
    ...detail.captures.map((c) => ({ at: c.occurredAt, kind: 'capture' as const, c })),
    ...detail.posts.map((p) => ({ at: p.occurredAt, kind: 'post' as const, p })),
  ].sort((a, b) => (a.at < b.at ? -1 : 1));
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted">
        <Trans>Nothing on this day yet.</Trans>
      </p>
    );
  }
  return (
    <ol className="relative space-y-2 before:absolute before:inset-y-3 before:start-[1.6rem] before:border-s-2 before:border-dashed before:border-line">
      {entries.map((e) =>
        e.kind === 'capture' ? (
          <li key={e.c.sourceKey} className="relative">
            <Link
              to="/inbox/$sourceKey"
              params={{ sourceKey: e.c.sourceKey }}
              className="press flex items-center gap-3 rounded-tile p-1.5 hover:bg-blush/60"
            >
              <CaptureVisual
                capture={e.c}
                compact
                dimmed={e.c.effectiveVisibility === 'hidden'}
                className="size-12 shrink-0"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">
                  <span className="tabular-nums">{formatTime(e.c.occurredAt, e.c.effectiveTz, locale)}</span> ·{' '}
                  {i18n._(KIND_LABEL[e.c.kind])}
                </span>
                {e.c.caption && (
                  <span className="block truncate font-hand text-sm text-muted" dir="auto" data-user-text>
                    {e.c.caption}
                  </span>
                )}
              </span>
              <VisibilityBadge visibility={e.c.effectiveVisibility} />
            </Link>
          </li>
        ) : (
          <li key={e.p.publicId} className="relative">
            <Link
              to="/compose"
              search={{ kind: e.p.kind, post: e.p.publicId }}
              className="press flex items-center gap-3 rounded-tile p-1.5 hover:bg-blush/60"
            >
              <span className="grid size-12 shrink-0 place-items-center rounded-tile bg-lilac text-violet">
                {e.p.kind === 'note' ? <FeatherIcon className="size-5" /> : <BookIcon className="size-5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">
                  <span className="tabular-nums">{formatTime(e.p.occurredAt, e.p.tz, locale)}</span> ·{' '}
                  {i18n._(KIND_LABEL[e.p.kind])}
                </span>
                <span className="block truncate font-hand text-sm text-muted" dir="auto" data-user-text>
                  {postPreview(e.p, locale)}
                </span>
              </span>
              <VisibilityBadge visibility={e.p.visibility} />
              <ItemPublishChip
                item={{ visibility: e.p.visibility, changeSeq: e.p.changeSeq }}
                entity={`post:${e.p.publicId}`}
              />
            </Link>
          </li>
        ),
      )}
    </ol>
  );
}

function postPreview(p: AdminDayDetail['posts'][number], locale: LocaleCode): string {
  const content = p.content as Partial<Record<LocaleCode, { title?: string; body: string }>>;
  const c = content[locale] ?? content[p.origLocale] ?? Object.values(content)[0];
  return c ? (c.title ?? c.body).slice(0, 140) : '';
}

export function DayEditorScreen() {
  const { date } = dayApi.useParams();
  return <DayEditor key={date} date={date} />;
}

function DayEditor({ date }: { date: string }) {
  const { t } = useLingui();
  const locale = useLocale();
  const navigate = useNavigate();
  const q = useQuery(dayQuery(date));
  const settings = useQuery(settingsQuery());
  const trips = useQuery(tripsQuery());
  const patchDay = useWrite('patchDay');
  const notifyWrite = useNotifyWrite();
  const pendingEntities = usePendingEntities();
  const server = q.data?.day ?? null;
  const entity = `day:${date}`;
  const fields = useMemo(() => dayFields(server), [server]);
  // Edits survive leaving the screen (autosaved draft) and are based on the version they began on.
  const drafted = useDraftedForm<DayForm, DayValues>({
    entity,
    version: server?.updatedAt,
    base: writeBase(server?.updatedAt, q.data?.changeSeq),
    ready: !!q.data,
    fields,
    toForm,
    pending: pendingEntities.has(entity),
  });
  const { form, edit: setForm, restored, baseline, base, markSent, discard } = drafted;
  const [tab, setTab] = useState<LocaleCode>(locale === 'en' ? 'en' : 'de');

  const lat = parseCoordinate(form.lat, 90);
  const lng = parseCoordinate(form.lng, 180);
  const coordsError = lat === undefined || lng === undefined || (lat === null) !== (lng === null);
  const edited = {
    title: cleanText(form.title),
    summary: cleanText(form.summary),
    origLocale: form.origLocale,
    placeName: form.placeName.trim() || null,
    countryCode: form.countryCode || null,
    lat: lat ?? null,
    lng: lng ?? null,
    coverSourceKey: form.coverSourceKey,
    tz: form.tz,
  };
  const diff = dirtyPatch(baseline, edited);
  const { patch, original } = diff;
  const dirty = drafted.touched && (diff.dirty || coordsError);

  function save() {
    if (coordsError) return;
    const fields = { ...patch };
    if ((fields.title || fields.summary) && !edited.origLocale) {
      fields.origLocale = (filledLocales(edited.title)[0] ?? filledLocales(edited.summary)[0] ?? locale) as LocaleCode;
    }
    const draft = markSent();
    if (Object.keys(fields).length === 0) return;
    patchDay({ date, patch: fields, original, base, ...(draft ? { draft } : {}) });
    notifyWrite(entity, msg`Day saved`);
  }

  const title = pickText(server?.title, locale, server?.origLocale)?.text;
  const countries = countryOptions(locale);
  const trip = trips.data?.items.find((tr) => tr.slug === q.data?.trip);
  // Automatic cover (contracts AdminDaySummary): the first public photo/video of the day.
  const coverKey =
    form.coverSourceKey ??
    q.data?.captures.find((c) => canBeCover(c) && c.effectiveVisibility === 'public')?.sourceKey ??
    null;
  const cover = q.data?.captures.find((c) => c.sourceKey === coverKey);
  const nav = (d: string) => void navigate({ to: '/days/$date', params: { date: d } });
  const coverFigure = cover ? (
    <figure className="polaroid washi-tape mx-auto mt-3 w-full max-w-[16rem] rotate-[1.5deg] lg:max-w-xs">
      <CaptureVisual capture={cover} className="aspect-[4/3] w-full" rounded="rounded-[0.55rem]" />
      <figcaption className="px-2 py-2.5 text-center font-hand text-muted" dir="auto">
        {form.placeName || title || formatLocalDate(date, locale)}
        {form.countryCode && <span aria-hidden="true"> {countryFlag(form.countryCode)}</span>}
      </figcaption>
    </figure>
  ) : null;

  return (
    <>
      <ScreenHeader
        back={{ to: '/days', label: t`Days` }}
        eyebrow={formatLocalDate(date, locale, 'long')}
        title={title ?? <span className="text-muted">{t`Untitled day`}</span>}
        actions={
          <div className="flex gap-1">
            <IconButton
              label={t`Previous day`}
              icon={ChevronLeftIcon}
              variant="secondary"
              size="sm"
              onClick={() => nav(addDays(date, -1))}
            />
            <IconButton
              label={t`Next day`}
              icon={ChevronRightIcon}
              variant="secondary"
              size="sm"
              onClick={() => nav(addDays(date, 1))}
            />
          </div>
        }
      />
      <QueryError error={q.error && !q.data ? q.error : null} onRetry={() => void q.refetch()} />
      {q.isPending && <Skeleton className="h-96 rounded-card" />}
      {q.data && (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <div className="space-y-5">
            {coverFigure && <div className="mb-2 lg:hidden">{coverFigure}</div>}
            <Section icon={PencilIcon} title={<Trans>Title & summary</Trans>}>
              <LocaleTabs
                label={t`Language`}
                locales={CONTENT_LOCALES}
                value={tab}
                onChange={setTab}
                filled={new Set([...filledLocales(form.title), ...filledLocales(form.summary)])}
                original={form.origLocale}
                originalLabel={t`original`}
              />
              <div className="mt-4 space-y-4">
                <Field label={<Trans>Title</Trans>}>
                  {(ids) => (
                    <TextInput
                      {...ids}
                      lang={tab}
                      dir="auto"
                      maxLength={200}
                      className="display-soft text-lg font-semibold"
                      placeholder={t`e.g. Lanterns in Hội An`}
                      value={form.title[tab] ?? ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        setForm((f) => ({ ...f, title: { ...f.title, [tab]: v } }));
                      }}
                    />
                  )}
                </Field>
                <Field label={<Trans>Summary</Trans>} hint={<Trans>A sentence or two for the day page.</Trans>}>
                  {(ids) => (
                    <TextArea
                      {...ids}
                      lang={tab}
                      dir="auto"
                      rows={3}
                      maxLength={2000}
                      value={form.summary[tab] ?? ''}
                      onChange={(e) => {
                        const v = e.target.value;
                        setForm((f) => ({ ...f, summary: { ...f.summary, [tab]: v } }));
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
              </div>
            </Section>
            <Section icon={PinIcon} title={<Trans>Place</Trans>}>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={<Trans>Place</Trans>}>
                  {(ids) => (
                    <TextInput
                      {...ids}
                      dir="auto"
                      name="placeName"
                      maxLength={200}
                      placeholder={t`e.g. Hội An`}
                      value={form.placeName}
                      onChange={(e) => setForm((f) => ({ ...f, placeName: e.target.value }))}
                    />
                  )}
                </Field>
                <Field
                  label={<Trans>Country</Trans>}
                  labelAside={form.countryCode ? <span aria-hidden="true">{countryFlag(form.countryCode)}</span> : null}
                >
                  {(ids) => (
                    <SelectInput
                      {...ids}
                      value={form.countryCode}
                      onChange={(e) => setForm((f) => ({ ...f, countryCode: e.target.value }))}
                    >
                      <option value="">{t`No country`}</option>
                      {countries.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.name}
                        </option>
                      ))}
                    </SelectInput>
                  )}
                </Field>
              </div>
              <details className="group mt-4">
                <summary className="press inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-pill px-2 text-sm font-bold text-muted hover:text-ink pointer-coarse:min-h-11">
                  <GlobeIcon className="size-4" />
                  <Trans>Coordinates (optional)</Trans>
                </summary>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  <Field label={<Trans>Latitude</Trans>} error={lat === undefined ? t`Between -90 and 90` : undefined}>
                    {(ids) => (
                      <TextInput
                        {...ids}
                        inputMode="decimal"
                        placeholder="15.8801"
                        value={form.lat}
                        onChange={(e) => setForm((f) => ({ ...f, lat: e.target.value }))}
                      />
                    )}
                  </Field>
                  <Field
                    label={<Trans>Longitude</Trans>}
                    error={lng === undefined ? t`Between -180 and 180` : undefined}
                  >
                    {(ids) => (
                      <TextInput
                        {...ids}
                        inputMode="decimal"
                        placeholder="108.3380"
                        value={form.lng}
                        onChange={(e) => setForm((f) => ({ ...f, lng: e.target.value }))}
                      />
                    )}
                  </Field>
                </div>
                {lat !== undefined && lng !== undefined && (lat === null) !== (lng === null) && (
                  <p className="mt-2 text-xs font-semibold text-danger">
                    <Trans>Fill in both coordinates or none.</Trans>
                  </p>
                )}
              </details>
            </Section>
            <Section icon={ClockIcon} title={<Trans>Time zone</Trans>}>
              <TimeZoneFix
                detail={q.data}
                value={form.tz}
                current={settings.data?.['timezone.current']}
                onChange={(tz) => setForm((f) => ({ ...f, tz }))}
              />
            </Section>
          </div>
          <div className="space-y-5 lg:sticky lg:top-6">
            {coverFigure && <div className="hidden lg:block">{coverFigure}</div>}
            <Section
              icon={ImageIcon}
              title={<Trans>Cover</Trans>}
              description={<Trans>Automatic uses the first public photo of the day.</Trans>}
            >
              <CoverPicker
                detail={q.data}
                value={form.coverSourceKey}
                onChange={(coverSourceKey) => setForm((f) => ({ ...f, coverSourceKey }))}
              />
            </Section>
            <Section
              icon={BookIcon}
              title={<Trans>On this day</Trans>}
              actions={
                trip ? (
                  <Badge tone="neutral" icon={SuitcaseIcon}>
                    {pickText(trip.title, locale, trip.origLocale)?.text ?? trip.slug}
                  </Badge>
                ) : null
              }
            >
              <DayItems detail={q.data} />
              <div className="mt-4">
                <Link
                  to="/compose"
                  search={{ kind: 'note', date }}
                  className="press inline-flex min-h-9 items-center gap-1.5 rounded-pill px-3 text-sm font-bold text-accent hover:bg-blush pointer-coarse:min-h-11"
                >
                  <FeatherIcon className="size-4" />
                  <Trans>Add a note to this day</Trans>
                </Link>
              </div>
            </Section>
          </div>
        </div>
      )}
      {/* A direct child of the page: it sticks above the tab bar while the form is long. */}
      {q.data && dirty && (
        <StickyActions
          note={
            coordsError ? (
              <Trans>Check the coordinates.</Trans>
            ) : restored ? (
              <span className="font-semibold text-ink">
                <Trans>Not saved yet</Trans>
              </span>
            ) : (
              <Trans>Unsaved changes</Trans>
            )
          }
        >
          <Button variant="ghost" size="sm" onClick={discard}>
            <Trans>Discard</Trans>
          </Button>
          <Button size="sm" name="save-day" disabled={coordsError} onClick={save}>
            <Trans>Save day</Trans>
          </Button>
        </StickyActions>
      )}
      <UnsavedChangesGuard dirty={dirty} canSave={!coordsError} onSave={save} onDiscard={discard} />
    </>
  );
}
