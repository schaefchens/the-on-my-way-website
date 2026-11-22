/**
 * Settings → Privacy notice (spec-wave5 §7.7, D11, Q7): the text people read before they join,
 * kept as one editable draft and published as immutable versions. Controller (name, e-mail,
 * address), the seven sections per site language (always German and English), a live preview
 * with the gate page's rules (plain text, a blank line starts a new paragraph), "Save draft"
 * (online only) and "Publish as version N+1" (only a saved draft without problems; everyone
 * confirms the new text on their next visit). Nothing here is stored on the device.
 */
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { NoticeTexts, PrivacyNoticeDraft, PrivacyState, PublicNotice } from '@omw/contracts/access';
import { LOCALES, type LocaleCode } from '@omw/contracts/i18n';
import { formatDateTime } from '@omw/ui/locale';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { accessApi, accessErrorMessage, useAccessRequest } from '../api/access';
import { ApiRequestError } from '../api/client';
import { qk } from '../api/keys';
import { privacyQuery, settingsQuery } from '../api/queries';
import { ConfirmSheet } from '../components/confirm-sheet';
import { AlertIcon, BookIcon, CheckIcon, ChevronRightIcon, InfoIcon, SendIcon } from '../components/icons';
import {
  Button,
  Field,
  LocaleTabs,
  QueryError,
  ScreenHeader,
  Section,
  Skeleton,
  TextArea,
  TextInput,
} from '../components/ui';
import { UnsavedChangesGuard } from '../components/unsaved';
import { useConnectivity, useLocale, useServerForm } from '../lib/hooks';
import { notify } from '../lib/notices';
import { deviceTimeZone } from '../lib/places';

type TextKey = keyof NoticeTexts;
const TEXT_KEYS: readonly TextKey[] = ['title', 'intro', 'collected', 'audience', 'purpose', 'retention', 'rights'];
const TEXT_MAX: Record<TextKey, number> = {
  title: 120,
  intro: 4000,
  collected: 4000,
  audience: 4000,
  purpose: 4000,
  retention: 4000,
  rights: 4000,
};

interface NoticeForm {
  name: string;
  email: string;
  address: string;
  texts: Partial<Record<LocaleCode, Record<TextKey, string>>>;
}

/** Notice languages: always German and English (D11), plus every other site language. */
export function noticeLocales(siteLocales: readonly LocaleCode[]): LocaleCode[] {
  const out: LocaleCode[] = ['de', 'en'];
  for (const l of siteLocales) if (!out.includes(l)) out.push(l);
  return out;
}

function emptyTexts(): Record<TextKey, string> {
  return { title: '', intro: '', collected: '', audience: '', purpose: '', retention: '', rights: '' };
}

export function formFromDraft(draft: PrivacyNoticeDraft, locales: readonly LocaleCode[]): NoticeForm {
  const texts: NoticeForm['texts'] = {};
  for (const l of locales) texts[l] = { ...emptyTexts(), ...(draft.texts[l] ?? {}) };
  return {
    name: draft.controller.name,
    email: draft.controller.email,
    address: draft.controller.address ?? '',
    texts,
  };
}

export function draftFromForm(form: NoticeForm): PrivacyNoticeDraft {
  const texts: PrivacyNoticeDraft['texts'] = {};
  for (const [l, t] of Object.entries(form.texts) as Array<[LocaleCode, Record<TextKey, string> | undefined]>) {
    if (t) texts[l] = { ...t };
  }
  const address = form.address.trim();
  return {
    controller: { name: form.name.trim(), email: form.email.trim(), ...(address ? { address } : {}) },
    texts,
  };
}

/**
 * True when publishing the saved draft would only repeat the current version: the controller and
 * every complete language are the same text (trimmed, as the API publishes them). Publishing that
 * would make everyone confirm an unchanged text again. Errs towards "changed": a draft that differs
 * only in ways the API normalises away (an incomplete extra language) still counts as changed.
 */
export function draftMatchesCurrent(draft: PrivacyNoticeDraft, current: PublicNotice | null): boolean {
  if (!current) return false;
  const c = draft.controller;
  const address = (c.address ?? '').trim();
  if (c.name.trim() !== current.controller.name || c.email.trim() !== current.controller.email) return false;
  if (address !== (current.controller.address ?? '')) return false;
  const draftLocales = (Object.keys(draft.texts) as LocaleCode[]).filter((l) =>
    TEXT_KEYS.some((k) => (draft.texts[l]?.[k] ?? '').trim() !== ''),
  );
  const currentLocales = Object.keys(current.texts) as LocaleCode[];
  if (draftLocales.length !== currentLocales.length) return false;
  return currentLocales.every((l) => {
    const d = draft.texts[l];
    const p = current.texts[l];
    return !!d && !!p && TEXT_KEYS.every((k) => (d[k] ?? '').trim() === (p[k] ?? ''));
  });
}

/** Paragraphs as the gate page splits them: a blank line starts a new one (text only, never HTML). */
export function noticeParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Headings of the info screen (§6.2.7) in the notice's language (the preview only). */
const PREVIEW_HEADINGS: Record<
  'de' | 'en',
  Record<'collected' | 'audience' | 'purpose' | 'rights' | 'controller', string> & {
    rightsNote: string;
    version: (n: number, date: string) => string;
    forName: string;
  }
> = {
  de: {
    collected: 'Was gespeichert wird',
    audience: 'Wer was sieht',
    purpose: 'Wozu und wie lange',
    rights: 'Deine Rechte',
    rightsNote: 'Unter „Deine Daten“ kannst du alles einsehen, exportieren und löschen.',
    controller: 'Verantwortlich',
    version: (n, date) => `Version ${n} · gültig seit ${date}`,
    forName: 'Dieser Link ist für Oma.',
  },
  en: {
    collected: 'What is stored',
    audience: 'Who sees what',
    purpose: 'Why and for how long',
    rights: 'Your rights',
    rightsNote: 'Under “Your data” you can view, export and delete everything.',
    controller: 'Responsible',
    version: (n, date) => `Version ${n} · valid since ${date}`,
    forName: 'This link is for Grandma.',
  },
};

function Paragraphs({ text }: { text: string }) {
  const paras = noticeParagraphs(text);
  if (paras.length === 0) return <p className="text-muted/70">…</p>;
  return (
    <>
      {paras.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs have no identity
        <p key={i}>{p}</p>
      ))}
    </>
  );
}

/** What a person sees on the info screen, from the form as typed (or a published version). */
function NoticePreview({
  locale,
  texts,
  controller,
  version,
  publishedAt,
}: {
  locale: LocaleCode;
  texts: Partial<Record<TextKey, string>>;
  controller: { name: string; email: string; address?: string | undefined };
  version: number;
  publishedAt: string | null;
}) {
  const uiLocale = useLocale();
  const h = PREVIEW_HEADINGS[locale === 'de' ? 'de' : 'en'];
  const date = publishedAt ? formatDateTime(publishedAt, deviceTimeZone(), uiLocale) : '…';
  const sectionH = 'mt-5 font-display text-lg font-semibold';
  return (
    <article lang={locale} dir="auto" className="space-y-2 rounded-card bg-bg p-5 text-sm leading-relaxed paper-grain">
      <p className="font-hand text-base text-accent">{h.forName}</p>
      <h3 className="display-soft text-2xl font-semibold">{texts.title || '…'}</h3>
      <Paragraphs text={texts.intro ?? ''} />
      <h4 className={sectionH}>{h.collected}</h4>
      <Paragraphs text={texts.collected ?? ''} />
      <h4 className={sectionH}>{h.audience}</h4>
      <Paragraphs text={texts.audience ?? ''} />
      <h4 className={sectionH}>{h.purpose}</h4>
      <Paragraphs text={texts.purpose ?? ''} />
      <Paragraphs text={texts.retention ?? ''} />
      <h4 className={sectionH}>{h.rights}</h4>
      <Paragraphs text={texts.rights ?? ''} />
      <p>{h.rightsNote}</p>
      <h4 className={sectionH}>{h.controller}</h4>
      <p>
        {controller.name || '…'}
        {controller.address ? (
          <>
            <br />
            {controller.address}
          </>
        ) : null}
        <br />
        {controller.email ? (
          <a className="font-semibold text-accent underline" href={`mailto:${controller.email}`}>
            {controller.email}
          </a>
        ) : (
          '…'
        )}
      </p>
      <p className="pt-3 text-xs text-muted">{h.version(version, date)}</p>
    </article>
  );
}

const FIELD_LABEL: Record<TextKey, ReturnType<typeof msg>> = {
  title: msg`Title`,
  intro: msg`Introduction`,
  collected: msg`What is stored`,
  audience: msg`Who sees what`,
  purpose: msg`Why`,
  retention: msg`How long`,
  rights: msg`Rights`,
};

/** "texts.en.title …" → "English: Title" when the API names a path; else the API's text. */
export function problemLabel(
  problem: string,
  describe: (key: TextKey, locale: string) => string,
  controllerLabel: (f: 'name' | 'email') => string,
): string {
  const text = /texts[./]([a-z]{2}(?:-[A-Za-z]+)?)[./](title|intro|collected|audience|purpose|retention|rights)\b/.exec(
    problem,
  );
  if (text?.[1] && text[2]) return describe(text[2] as TextKey, text[1]);
  const ctl = /controller[./](name|email)\b/.exec(problem);
  if (ctl?.[1]) return controllerLabel(ctl[1] as 'name' | 'email');
  return problem;
}

function VersionHistory({ state }: { state: PrivacyState }) {
  const locale = useLocale();
  const [open, setOpen] = useState<number | null>(null);
  const [tab, setTab] = useState<LocaleCode>('de');
  const current = state.current;
  if (state.versions.length === 0) {
    return (
      <p className="text-sm text-muted">
        <Trans>No version published yet. Nobody can join until you publish the first one.</Trans>
      </p>
    );
  }
  const versions = [...state.versions].sort((a, b) => b.version - a.version);
  return (
    <ul className="space-y-2">
      {versions.map((v) => {
        const viewable = current?.version === v.version;
        const isOpen = open === v.version && viewable;
        const date = formatDateTime(v.publishedAt, deviceTimeZone(), locale);
        const prefix = v.sha256.slice(0, 8);
        const version = v.version;
        return (
          <li key={v.version} className="rounded-tile bg-bg">
            <button
              type="button"
              aria-expanded={viewable ? isOpen : undefined}
              disabled={!viewable}
              onClick={() => setOpen(isOpen ? null : v.version)}
              className="press flex min-h-11 w-full items-center gap-3 px-3.5 py-2 text-start disabled:cursor-default"
            >
              <span className="font-bold">
                <Trans>Version {version}</Trans>
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-muted">
                {date} · <code dir="ltr">{prefix}</code>
              </span>
              {viewable && (
                <ChevronRightIcon
                  className={isOpen ? 'size-4 rotate-90 transition-transform' : 'size-4 transition-transform'}
                  flip
                />
              )}
            </button>
            {isOpen && current && <PublishedView notice={current} tab={tab} onTab={setTab} />}
          </li>
        );
      })}
    </ul>
  );
}

function PublishedView({
  notice,
  tab,
  onTab,
}: {
  notice: PublicNotice;
  tab: LocaleCode;
  onTab: (l: LocaleCode) => void;
}) {
  const { t } = useLingui();
  const locales = (Object.keys(notice.texts) as LocaleCode[]).map((code) => ({
    code,
    label: LOCALES.find((l) => l.code === code)?.label ?? code,
  }));
  const shown = notice.texts[tab] ? tab : (locales[0]?.code ?? 'de');
  return (
    <div className="space-y-3 px-3.5 pb-3.5">
      <LocaleTabs label={t`Language`} locales={locales} value={shown} onChange={onTab} />
      <NoticePreview
        locale={shown}
        texts={notice.texts[shown] ?? {}}
        controller={notice.controller}
        version={notice.version}
        publishedAt={notice.publishedAt}
      />
    </div>
  );
}

export function PrivacyScreen() {
  const { t, i18n } = useLingui();
  const qc = useQueryClient();
  const { online } = useConnectivity();
  const settings = useQuery(settingsQuery());
  const q = useQuery(privacyQuery());
  const state = q.data;
  const locales = noticeLocales(settings.data?.['site.locales'] ?? ['de', 'en']);
  const form = useServerForm<NoticeForm>(state ? `${state.draftSha256}|${locales.join(',')}` : null, !!state, () =>
    state
      ? formFromDraft(state.draft, locales)
      : formFromDraft({ controller: { name: '', email: '' }, texts: {} }, locales),
  );
  const [tab, setTab] = useState<LocaleCode>('de');
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useAccessRequest<PrivacyState>();
  const publish = useAccessRequest<PrivacyState>();
  const f = form.form;
  const texts = f.texts[tab] ?? emptyTexts();
  const tabs = locales.map((code) => ({ code, label: LOCALES.find((l) => l.code === code)?.label ?? code }));
  const filled = new Set(locales.filter((l) => TEXT_KEYS.every((k) => (f.texts[l]?.[k] ?? '').trim() !== '')));
  const nextVersion = (state?.versions.reduce((m, v) => Math.max(m, v.version), 0) ?? 0) + 1;
  const dirty = form.touched;
  const problems = state?.problems ?? [];
  const currentVersion = state?.current?.version ?? 0;
  const unchanged = !!state && draftMatchesCurrent(state.draft, state.current);
  const canPublish = !!state && !dirty && problems.length === 0 && online && !unchanged;

  function setText(key: TextKey, value: string) {
    form.edit((prev) => ({
      ...prev,
      texts: { ...prev.texts, [tab]: { ...(prev.texts[tab] ?? emptyTexts()), [key]: value } },
    }));
  }

  function onFailure(err: unknown) {
    if (err instanceof ApiRequestError && err.status === 0) setError(i18n._(msg`Not sent – no connection`));
    else setError(i18n._(accessErrorMessage(err).message));
  }

  function saveDraft() {
    setError(null);
    const draft = draftFromForm(f);
    save.mutate(() => accessApi.savePrivacyDraft(draft), {
      onSuccess: (next) => {
        qc.setQueryData(qk.access.privacy, next);
        form.markSaved();
        notify({ tone: 'success', message: msg`Draft saved` });
      },
      onError: onFailure,
    });
  }

  function doPublish() {
    if (!state) return;
    setError(null);
    const sha = state.draftSha256;
    publish.mutate(() => accessApi.publishPrivacy(sha), {
      onSuccess: (next) => {
        setConfirmPublish(false);
        qc.setQueryData(qk.access.privacy, next);
        void qc.invalidateQueries({ queryKey: qk.status });
        void qc.invalidateQueries({ queryKey: qk.access.status });
        notify({ tone: 'success', message: msg`Version published` });
      },
      onError: (err) => {
        setConfirmPublish(false);
        onFailure(err);
        if (err instanceof ApiRequestError && (err.code === 'conflict' || err.code === 'notice_incomplete')) {
          void qc.invalidateQueries({ queryKey: qk.access.privacy });
        }
      },
    });
  }

  const localeName = (code: string) => LOCALES.find((l) => l.code === code)?.label ?? code;

  return (
    <>
      <ScreenHeader
        back={{ to: '/settings', label: t`Settings` }}
        eyebrow={<Trans>what people read before they join</Trans>}
        title={<Trans>Privacy notice</Trans>}
      />
      <QueryError error={q.error && !q.data ? q.error : null} onRetry={() => void q.refetch()} />
      {q.isPending && <Skeleton className="h-64 rounded-card" />}
      {state && (
        <div className="grid items-start gap-5 xl:grid-cols-2">
          <div className="space-y-5">
            <div
              className="flex items-start gap-3 rounded-card bg-lilac p-4 shadow-soft"
              data-testid="privacy-template-banner"
            >
              <InfoIcon className="mt-0.5 size-5 shrink-0 text-violet" />
              <p className="text-sm font-bold">
                <Trans>Template – not legal advice. Please check and adapt it.</Trans>
              </p>
            </div>
            <Section
              icon={BookIcon}
              title={<Trans>Responsible</Trans>}
              description={<Trans>Shown at the end of the notice.</Trans>}
            >
              <div className="space-y-4">
                <Field label={<Trans>Name</Trans>}>
                  {(ids) => (
                    <TextInput
                      {...ids}
                      data-testid="privacy-name"
                      maxLength={120}
                      value={f.name}
                      onChange={(e) => form.edit((p) => ({ ...p, name: e.target.value }))}
                    />
                  )}
                </Field>
                <Field label={<Trans>E-mail</Trans>}>
                  {(ids) => (
                    <TextInput
                      {...ids}
                      data-testid="privacy-email"
                      type="email"
                      inputMode="email"
                      dir="ltr"
                      maxLength={254}
                      value={f.email}
                      onChange={(e) => form.edit((p) => ({ ...p, email: e.target.value }))}
                    />
                  )}
                </Field>
                <Field label={<Trans>Address</Trans>} hint={<Trans>Optional.</Trans>}>
                  {(ids) => (
                    <TextArea
                      {...ids}
                      rows={2}
                      maxLength={300}
                      value={f.address}
                      onChange={(e) => form.edit((p) => ({ ...p, address: e.target.value }))}
                    />
                  )}
                </Field>
              </div>
            </Section>
            <Section
              icon={BookIcon}
              title={<Trans>Texts</Trans>}
              description={<Trans>Plain text. A blank line starts a new paragraph.</Trans>}
            >
              <LocaleTabs
                label={t`Language of the notice`}
                locales={tabs}
                value={tab}
                onChange={setTab}
                filled={filled}
              />
              <div className="mt-4 space-y-4">
                {TEXT_KEYS.map((key) => (
                  <Field key={`${tab}-${key}`} label={i18n._(FIELD_LABEL[key])}>
                    {(ids) =>
                      key === 'title' ? (
                        <TextInput
                          {...ids}
                          data-testid={`privacy-${key}`}
                          lang={tab}
                          dir="auto"
                          maxLength={TEXT_MAX[key]}
                          value={texts[key]}
                          onChange={(e) => setText(key, e.target.value)}
                        />
                      ) : (
                        <TextArea
                          {...ids}
                          data-testid={`privacy-${key}`}
                          lang={tab}
                          dir="auto"
                          rows={key === 'collected' ? 7 : 4}
                          maxLength={TEXT_MAX[key]}
                          value={texts[key]}
                          onChange={(e) => setText(key, e.target.value)}
                        />
                      )
                    }
                  </Field>
                ))}
              </div>
            </Section>
          </div>
          <div className="space-y-5">
            <Section icon={SendIcon} title={<Trans>Save and publish</Trans>}>
              <div aria-live="polite" className="mb-4 text-sm">
                {error ? (
                  <p role="alert" className="flex items-start gap-1.5 font-semibold text-danger">
                    <AlertIcon className="mt-0.5 size-4 shrink-0" />
                    {error}
                  </p>
                ) : dirty ? (
                  <p className="font-semibold text-violet">
                    <Trans>Not saved yet. Save the draft first, then publish it.</Trans>
                  </p>
                ) : problems.length > 0 ? (
                  <div data-testid="privacy-problems">
                    <p className="font-semibold">
                      <Trans>Not complete yet:</Trans>
                    </p>
                    <ul className="mt-1 list-disc space-y-0.5 ps-5 text-muted">
                      {problems.slice(0, 8).map((p) => (
                        <li key={p}>
                          {problemLabel(
                            p,
                            (key, l) => `${localeName(l)}: ${i18n._(FIELD_LABEL[key])}`,
                            (field) => (field === 'name' ? t`Responsible: name` : t`Responsible: e-mail`),
                          )}
                        </li>
                      ))}
                      {problems.length > 8 && <li>…</li>}
                    </ul>
                  </div>
                ) : unchanged ? (
                  <p className="text-muted" data-testid="privacy-unchanged">
                    <Trans>Same as version {currentVersion}. Change the text to publish a new version.</Trans>
                  </p>
                ) : !online ? (
                  <p className="text-muted">
                    <Trans>Offline: saving needs a connection.</Trans>
                  </p>
                ) : (
                  <p className="inline-flex items-center gap-1 font-semibold text-success-strong">
                    <CheckIcon className="size-4" />
                    <Trans>Ready to publish</Trans>
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" busy={save.isPending} disabled={!dirty || !online} onClick={saveDraft}>
                  <Trans>Save draft</Trans>
                </Button>
                <Button icon={SendIcon} disabled={!canPublish} onClick={() => setConfirmPublish(true)}>
                  <Trans>Publish as version {nextVersion}</Trans>
                </Button>
              </div>
            </Section>
            <Section
              icon={InfoIcon}
              title={<Trans>Preview</Trans>}
              description={<Trans>As people see it on the info screen.</Trans>}
            >
              <NoticePreview
                locale={tab}
                texts={texts}
                controller={{ name: f.name, email: f.email, address: f.address }}
                version={nextVersion}
                publishedAt={null}
              />
            </Section>
            <Section icon={SendIcon} title={<Trans>Versions</Trans>}>
              <VersionHistory state={state} />
            </Section>
          </div>
        </div>
      )}
      <ConfirmSheet
        open={confirmPublish}
        title={<Trans>Publish version {nextVersion}?</Trans>}
        description={<Trans>Everyone sees the new text on their next visit and confirms it.</Trans>}
        confirmLabel={<Trans>Publish</Trans>}
        confirmIcon={SendIcon}
        busy={publish.isPending}
        onClose={() => setConfirmPublish(false)}
        onConfirm={doPublish}
      />
      <UnsavedChangesGuard dirty={dirty} canSave={online} onSave={saveDraft} onDiscard={() => form.reset()} />
    </>
  );
}
