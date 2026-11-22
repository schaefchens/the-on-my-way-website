/**
 * Item sheet of a captured status: the WhatsApp caption (read-only), the owner's description per
 * language, visibility, moving it to another day, the day cover, the owner's portrait (photos)
 * and its live status.
 */
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Visibility } from '@omw/contracts';
import type { Annotation, CaptureListItem, Settings } from '@omw/contracts/api';
import { LOCALES, type LocaleCode } from '@omw/contracts/i18n';
import { isValidLocalDate, localDateFor } from '@omw/contracts/time';
import { formatDateTime, formatLocalDate, formatTime } from '@omw/ui/locale';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cachedDayTz } from '../api/cache';
import { captureQuery, daysQuery, settingsQuery } from '../api/queries';
import { type AnnotationFields, writeBase } from '../api/types';
import { AppOriginNote, isAppCapture } from '../components/app-badge';
import { CaptureVisual } from '../components/capture';
import {
  CalendarIcon,
  EyeIcon,
  EyeOffIcon,
  HeartIcon,
  InfoIcon,
  MoveIcon,
  StarIcon,
  UndoIcon,
} from '../components/icons';
import { KIND_LABEL } from '../components/labels';
import { PortraitPreview, useSetPortrait } from '../components/portrait';
import { CapturePublishChip, VisibilityBadge } from '../components/status';
import {
  Badge,
  Button,
  cx,
  Field,
  LocaleTabs,
  QueryError,
  ScreenHeader,
  Section,
  Segmented,
  SelectInput,
  Skeleton,
  StickyActions,
  TextArea,
  TextInput,
} from '../components/ui';
import { UnsavedChangesGuard } from '../components/unsaved';
import { ADMIN_LOCALES } from '../i18n';
import { annotateVars, canBeCover, visibilityOutcome } from '../lib/captures';
import { useDraftedForm } from '../lib/drafted-form';
import { cleanText, dirtyPatch, filledLocales } from '../lib/forms';
import { useLocale, useNotifyWrite, usePendingEntities, useWrite } from '../lib/hooks';
import { notify } from '../lib/notices';
import { deviceTimeZone } from '../lib/places';
import { portraitProblem } from '../lib/profile';
import { publishable, useSetCover, useToggleVisibility } from './inbox';

const itemApi = getRouteApi('/authed/inbox/$sourceKey');

/** Locales the owner writes in (dev-only pseudo-locales excluded). */
export const CONTENT_LOCALES = LOCALES.filter((l) => !l.devOnly && ADMIN_LOCALES.includes(l.code));

type VisibilityChoice = 'auto' | Visibility;

/** Aspect ratio of a capture's preview (clamped, so very tall videos stay manageable). */
function visualAspect(c: CaptureListItem): string {
  if (c.kind === 'text') return '4 / 5';
  if (c.kind === 'voice' || c.kind === 'unsupported') return '4 / 3';
  const w = c.media?.w;
  const h = c.media?.h;
  if (!w || !h) return '4 / 5';
  return String(Math.min(1.6, Math.max(0.68, w / h)));
}

interface DescriptionValues extends Record<string, unknown> {
  description: Annotation['description'] | null;
  origLocale: LocaleCode | null;
}

interface DescriptionFormState {
  description: Partial<Record<LocaleCode, string>>;
  origLocale: LocaleCode | null;
}

const toDescriptionForm = (v: DescriptionValues): DescriptionFormState => ({
  description: { ...(v.description ?? {}) } as Partial<Record<LocaleCode, string>>,
  origLocale: v.origLocale,
});

function DescriptionForm({ capture: c, focus }: { capture: CaptureListItem; focus: boolean }) {
  const { t } = useLingui();
  const uiLocale = useLocale();
  const annotate = useWrite('annotate');
  const notifyWrite = useNotifyWrite();
  const pendingEntities = usePendingEntities();
  const entity = `capture:${c.sourceKey}`;
  const fields = useMemo<DescriptionValues>(
    () => ({ description: c.annotation?.description ?? null, origLocale: c.annotation?.origLocale ?? null }),
    [c.annotation?.description, c.annotation?.origLocale],
  );
  // Typed text survives leaving the screen (autosaved draft), and a save is based on the
  // version the edit began on (a description changed elsewhere meanwhile is merged, not lost).
  const drafted = useDraftedForm<DescriptionFormState, DescriptionValues>({
    entity,
    version: c.annotation?.updatedAt ?? null,
    base: writeBase(c.annotation?.updatedAt, c.changeSeq),
    ready: true,
    fields,
    toForm: toDescriptionForm,
    pending: pendingEntities.has(entity),
  });
  const { form, edit: setForm, restored, baseline, base, markSent, discard } = drafted;
  const [tab, setTab] = useState<LocaleCode>(
    form.origLocale ?? (CONTENT_LOCALES.some((l) => l.code === uiLocale) ? uiLocale : 'de'),
  );
  const edited: DescriptionValues = { description: cleanText(form.description), origLocale: form.origLocale };
  const { patch, original, dirty: changed } = dirtyPatch(baseline, edited);
  const dirty = drafted.touched && changed;
  const sectionRef = useRef<HTMLElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const reduceMotion = useReducedMotion();

  // Entry point "Describe" (inbox pencil): bring the field into view and put the cursor in it.
  useEffect(() => {
    if (!focus) return;
    sectionRef.current?.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    areaRef.current?.focus({ preventScroll: true });
  }, [focus, reduceMotion]);

  function save() {
    const fields = { ...patch } as AnnotationFields;
    // The first text sets the original language if none was chosen.
    if (fields.description && !edited.origLocale) {
      fields.origLocale = filledLocales(fields.description)[0] as LocaleCode;
    }
    const draft = markSent();
    if (Object.keys(fields).length === 0) return;
    annotate({
      sourceKey: c.sourceKey,
      patch: fields,
      original: original as AnnotationFields,
      base,
      ...(draft ? { draft } : {}),
    });
    notifyWrite(entity, msg`Description saved`);
  }

  const bar = dirty ? (
    <StickyActions
      note={
        restored ? (
          <span className="font-semibold text-ink">
            <Trans>Not saved yet</Trans>
          </span>
        ) : (
          <Trans>Unsaved description</Trans>
        )
      }
    >
      <Button variant="ghost" size="sm" onClick={discard}>
        <Trans>Discard</Trans>
      </Button>
      <Button size="sm" onClick={save}>
        <Trans>Save</Trans>
      </Button>
    </StickyActions>
  ) : null;
  // The bar belongs to the whole page (it must stay in reach while the photo is on screen),
  // so it is rendered at the end of <main>: sticky positioning works within its parent.
  const main = typeof document === 'undefined' ? null : document.getElementById('main');

  return (
    <Section
      id="description"
      ref={sectionRef}
      title={<Trans>Description</Trans>}
      description={<Trans>Your words next to the status, per language. The caption stays as it was posted.</Trans>}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <LocaleTabs
          label={t`Language`}
          locales={CONTENT_LOCALES}
          value={tab}
          onChange={setTab}
          filled={new Set(filledLocales(form.description))}
          original={form.origLocale}
          originalLabel={t`original`}
        />
      </div>
      <Field label={<Trans>Description ({tab})</Trans>}>
        {(ids) => (
          <TextArea
            {...ids}
            ref={areaRef}
            lang={tab}
            dir="auto"
            rows={4}
            maxLength={2000}
            value={form.description[tab] ?? ''}
            placeholder={t`What happened here?`}
            onChange={(e) => {
              const value = e.target.value;
              setForm((f) => ({ ...f, description: { ...f.description, [tab]: value } }));
            }}
          />
        )}
      </Field>
      <Field
        label={<Trans>Written in</Trans>}
        className="mt-4"
        hint={<Trans>The other language is shown as a translation.</Trans>}
      >
        {(ids) => (
          <SelectInput
            {...ids}
            value={form.origLocale ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, origLocale: (e.target.value || null) as LocaleCode | null }))}
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
      {bar && (main ? createPortal(bar, main) : bar)}
      <UnsavedChangesGuard dirty={dirty} onSave={save} onDiscard={discard} />
    </Section>
  );
}

function MoveForm({ capture: c }: { capture: CaptureListItem }) {
  const { t } = useLingui();
  const locale = useLocale();
  const qc = useQueryClient();
  const annotate = useWrite('annotate');
  const [date, setDate] = useState(c.effectiveLocalDate);
  useEffect(() => setDate(c.effectiveLocalDate), [c.effectiveLocalDate]);
  const override = c.annotation?.localDateOverride ?? null;
  const valid = isValidLocalDate(date);
  // Where the status lands without an override (its own day, re-dated by a day's time-zone fix).
  const dayTz = cachedDayTz(qc, c.localDate);
  const ownDay = dayTz ? localDateFor(c.occurredAt, dayTz) : c.localDate;

  function move(next: string | null) {
    const vars = annotateVars(c, { localDateOverride: next });
    annotate(vars);
    notify({
      tone: 'undo',
      message: next ? msg`Moved to another day` : msg`Back on its own day`,
      action: {
        label: msg`Undo`,
        run: () => annotate({ ...vars, patch: { localDateOverride: override }, original: { localDateOverride: next } }),
      },
    });
  }

  return (
    <Section
      icon={MoveIcon}
      title={<Trans>Day</Trans>}
      description={
        override ? (
          <Trans>Moved here by you. Captured on {formatLocalDate(c.localDate, locale, 'long')}.</Trans>
        ) : (
          <Trans>Shown on {formatLocalDate(c.effectiveLocalDate, locale, 'long')}.</Trans>
        )
      }
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field label={<Trans>Show on</Trans>} className="min-w-44 flex-1">
          {(ids) => <TextInput {...ids} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />}
        </Field>
        <Button
          variant="secondary"
          icon={CalendarIcon}
          disabled={!valid || date === c.effectiveLocalDate}
          onClick={() => move(date === ownDay ? null : date)}
        >
          <Trans>Move</Trans>
        </Button>
        {override && (
          <Button variant="ghost" icon={UndoIcon} onClick={() => move(null)} title={t`Back to the day it was captured`}>
            <Trans>Reset</Trans>
          </Button>
        )}
      </div>
    </Section>
  );
}

/**
 * "Use as portrait" for a photo (owner profile, site.avatar), with an undo offer. A photo can be
 * the portrait while it is hidden in the timeline: then a hint says so.
 */
function PortraitSection({ capture: c, settings }: { capture: CaptureListItem; settings: Settings | undefined }) {
  const setPortrait = useSetPortrait();
  const current = settings?.['site.avatar'] ?? null;
  const isPortrait = current?.sourceKey === c.sourceKey;
  // Deleted on WhatsApp, lost or still processing: not offered (the API would refuse it).
  if (portraitProblem(c) && !isPortrait) return null;
  return (
    <Section icon={HeartIcon} title={<Trans>Portrait</Trans>}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {isPortrait && <PortraitPreview setting={current} capture={c} size="sm" />}
          <p className="text-sm text-muted">
            {isPortrait ? (
              <Trans>This photo is your portrait on the site.</Trans>
            ) : (
              <Trans>Show this photo as your portrait on the site, as a small circle next to your name.</Trans>
            )}
          </p>
        </div>
        {/* A plain button whose label names the action (no aria-pressed: a toggle would keep
            one label, and "Remove as portrait, pressed" contradicts itself). */}
        <Button
          variant={isPortrait ? 'soft' : 'secondary'}
          icon={HeartIcon}
          data-testid="use-as-portrait"
          onClick={() => setPortrait(isPortrait ? null : { sourceKey: c.sourceKey })}
        >
          {isPortrait ? <Trans>Remove as portrait</Trans> : <Trans>Use as portrait</Trans>}
        </Button>
      </div>
      {isPortrait && c.effectiveVisibility !== 'public' && (
        <p
          data-testid="portrait-hidden-hint"
          className="mt-3 flex items-start gap-2 rounded-tile bg-lilac px-3 py-2 text-sm text-ink"
        >
          <EyeOffIcon className="size-4 translate-y-0.5 text-violet" />
          <Trans>Not shown in your timeline, but still your portrait on the site.</Trans>
        </p>
      )}
    </Section>
  );
}

export function ItemSheetScreen() {
  const { sourceKey } = itemApi.useParams();
  const { focus } = itemApi.useSearch();
  const { t, i18n } = useLingui();
  const locale = useLocale();
  const q = useQuery(captureQuery(sourceKey));
  const days = useQuery(daysQuery());
  const toggle = useToggleVisibility();
  const setCover = useSetCover();
  const settings = useQuery(settingsQuery());
  const c = q.data;
  const back = { to: '/inbox', label: t`Inbox` };

  if (!c) {
    return (
      <>
        <ScreenHeader back={back} title={<Trans>Status</Trans>} />
        <QueryError error={q.error} onRetry={() => void q.refetch()} />
        {q.isPending && <Skeleton className="h-96 rounded-card" />}
      </>
    );
  }

  const day = days.data?.items.find((d) => d.localDate === c.effectiveLocalDate);
  const isCover = day?.coverSourceKey === c.sourceKey;
  const pinnedCover = day?.day?.coverSourceKey === c.sourceKey;
  const choice: VisibilityChoice = c.annotation?.visibility ?? 'auto';
  const kind = i18n._(KIND_LABEL[c.kind]);
  // What "Automatic" means for this status right now (publish mode, delay, revoke).
  const auto = visibilityOutcome(c, null, settings.data, Date.now());
  const options: Array<{ value: VisibilityChoice; label: string }> = [
    { value: 'auto', label: t`Automatic` },
    // Explicit "public" skips a delay or the review: say so when that is what it does.
    { value: 'public', label: auto.kind === 'delayed' || auto.kind === 'review' ? t`Publish now` : t`Public` },
    { value: 'hidden', label: t`Hidden` },
    ...(choice === 'pending' ? [{ value: 'pending' as const, label: t`Waiting` }] : []),
  ];
  const autoText =
    auto.kind === 'delayed' && auto.publishAt ? (
      <Trans>Follows your publish setting: appears {formatDateTime(auto.publishAt, deviceTimeZone(), locale)}.</Trans>
    ) : auto.kind === 'review' ? (
      <Trans>Follows your publish setting: waits for your release.</Trans>
    ) : auto.kind === 'hidden' ? (
      <Trans>Follows your publish setting: hidden because you deleted it on WhatsApp.</Trans>
    ) : (
      <Trans>Follows your publish setting.</Trans>
    );

  return (
    <>
      <ScreenHeader
        back={back}
        eyebrow={`${kind} · ${formatLocalDate(c.effectiveLocalDate, locale)} · ${formatTime(c.occurredAt, c.effectiveTz, locale)}`}
        title={
          c.caption ? (
            <span dir="auto" data-user-text>
              {c.caption}
            </span>
          ) : (
            kind
          )
        }
        actions={publishable(c) && <CapturePublishChip capture={c} />}
      />
      <div className="grid items-start gap-5 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="space-y-4 md:sticky md:top-6">
          <figure
            className={cx(
              'polaroid mx-auto rotate-[-1.5deg] md:max-w-sm',
              // Came to describe it: a compact photo, so the field is in reach on a phone.
              focus === 'description' ? 'max-w-[11rem]' : 'max-w-[17rem]',
            )}
          >
            <CaptureVisual
              capture={c}
              dimmed={c.effectiveVisibility === 'hidden'}
              className="w-full"
              style={{ aspectRatio: visualAspect(c) }}
              rounded="rounded-[0.55rem]"
            />
            <figcaption className="px-2 py-3 text-center">
              {c.caption ? (
                <span className="font-hand text-lg" dir="auto" data-user-text>
                  {c.caption}
                </span>
              ) : (
                <span className="text-sm text-muted italic">
                  <Trans>No caption</Trans>
                </span>
              )}
            </figcaption>
          </figure>
          {isAppCapture(c) ? (
            <AppOriginNote capture={c} />
          ) : (
            <p className="flex items-start gap-2 px-2 text-xs text-muted">
              <InfoIcon className="size-4" />
              <Trans>The caption comes from WhatsApp and cannot be changed here.</Trans>
            </p>
          )}
          {c.revokedAt && !isAppCapture(c) && (
            <p className="rounded-tile bg-surface-2 px-3 py-2 text-sm">
              <Trans>You deleted this status on WhatsApp.</Trans>
            </p>
          )}
        </div>
        <div className="space-y-5">
          <Section
            icon={EyeIcon}
            title={<Trans>Visibility</Trans>}
            description={choice === 'auto' ? autoText : <Trans>Your choice overrides the publish setting.</Trans>}
            actions={<VisibilityBadge visibility={c.effectiveVisibility} />}
          >
            <Segmented<VisibilityChoice>
              label={t`Visibility`}
              value={choice}
              options={options}
              className="w-full"
              onChange={(next) => toggle(c, next === 'auto' ? null : next)}
            />
          </Section>
          <DescriptionForm key={c.sourceKey} capture={c} focus={focus === 'description'} />
          <MoveForm capture={c} />
          {canBeCover(c) && (
            <Section icon={StarIcon} title={<Trans>Cover</Trans>}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted">
                  {pinnedCover ? (
                    <Trans>This is the cover of {formatLocalDate(c.effectiveLocalDate, locale, 'long')}.</Trans>
                  ) : isCover ? (
                    <Trans>
                      It is the automatic cover of {formatLocalDate(c.effectiveLocalDate, locale, 'long')} right now.
                      Set it to keep it when other photos arrive.
                    </Trans>
                  ) : (
                    <Trans>Use it as the picture of {formatLocalDate(c.effectiveLocalDate, locale, 'long')}.</Trans>
                  )}
                </p>
                <Button
                  variant={pinnedCover ? 'soft' : 'secondary'}
                  icon={StarIcon}
                  aria-pressed={pinnedCover}
                  onClick={() => setCover(c, day)}
                >
                  {pinnedCover ? <Trans>Remove as cover</Trans> : <Trans>Set as cover</Trans>}
                </Button>
              </div>
            </Section>
          )}
          {c.kind === 'photo' && <PortraitSection capture={c} settings={settings.data} />}
          <p className="px-1 text-xs text-muted">
            <Link
              to="/days/$date"
              params={{ date: c.effectiveLocalDate }}
              className="font-bold text-accent hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
            >
              <Trans>Open the day</Trans>
            </Link>
            {c.mediaState === 'lost' && (
              <Badge tone="danger" className="ms-2">
                <Trans>Media lost</Trans>
              </Badge>
            )}
          </p>
        </div>
      </div>
    </>
  );
}
