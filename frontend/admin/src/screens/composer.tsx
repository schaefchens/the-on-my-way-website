/**
 * Composer: a note (<= 280 characters, handwritten card) or a story (title + markdown with a
 * preview), one tab per language, the original language, time and visibility. Drafts autosave on
 * this device; publishing uses the draft's client-chosen publicId, so a double tap or an offline
 * replay can never create two posts. Existing posts are edited here too (?post=p_…).
 */
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AdminPost } from '@omw/contracts/api';
import { LOCALES, type LocaleCode } from '@omw/contracts/i18n';
import { localDateFor } from '@omw/contracts/time';
import { formatLocalDate, formatTime } from '@omw/ui/locale';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { postQuery, settingsQuery } from '../api/queries';
import { resolveBase } from '../api/writes';
import { CharRing } from '../components/char-ring';
import {
  BookIcon,
  ClockIcon,
  EyeIcon,
  EyeOffIcon,
  FeatherIcon,
  InfoIcon,
  SendIcon,
  TrashIcon,
} from '../components/icons';
import { PublishChip, useItemState } from '../components/status';
import {
  Button,
  cx,
  Dialog,
  Field,
  LocaleTabs,
  QueryError,
  ScreenHeader,
  Segmented,
  SelectInput,
  Skeleton,
  StickyActions,
  TextInput,
} from '../components/ui';
import {
  buildCreate,
  buildUpdate,
  type ComposeProblem,
  charCount,
  composeContent,
  draftFromPost,
  NOTE_MAX,
  newDraft,
} from '../lib/compose';
import { type Draft, type DraftKind, draftStore, removeDraft, saveDraft } from '../lib/drafts';
import { useLocale, useNotifyWrite, useWrite } from '../lib/hooks';
import { deviceTimeZone, utcToZonedInput, zonedTimeToUtc, zoneLabel } from '../lib/places';
import { useStore } from '../lib/store';
import { CONTENT_LOCALES } from './item';

const composeApi = getRouteApi('/authed/compose');

/** Contract limit of a post body (NoteLocaleContent / StoryLocaleContent). */
const BODY_MAX = 100_000;

function MarkdownPreview({ source }: { source: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void import('../lib/markdown').then(({ renderMarkdown }) => {
      if (alive) setHtml(renderMarkdown(source));
    });
    return () => {
      alive = false;
    };
  }, [source]);
  if (html === null) return <Skeleton className="h-40" />;
  if (!source.trim()) {
    return (
      <p className="text-muted italic">
        <Trans>Nothing to preview yet.</Trans>
      </p>
    );
  }
  // markdown-it runs with html: false, so the output contains no raw HTML from the source.
  // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by markdown-it (html: false)
  return <div className="prose-journal" dir="auto" dangerouslySetInnerHTML={{ __html: html }} />;
}

function useDraft(
  kind: DraftKind,
  postId: string | undefined,
  date: string | undefined,
  draftId: string | undefined,
): {
  draft: Draft | null;
  post: AdminPost | undefined;
  loading: boolean;
  error: Error | null;
} {
  const uiLocale = useLocale();
  const drafts = useStore(draftStore);
  const settings = useQuery(settingsQuery());
  // Editing starts from the freshest server version (fewer conflicts; a stale draft is noticed).
  const postQ = useQuery({ ...postQuery(postId ?? 'p_none'), enabled: !!postId, refetchOnMount: 'always' });
  const id = postId ? `edit:${postId}` : (draftId ?? `new:${kind}${date ? `:${date}` : ''}`);
  const existing = drafts[id];
  const tz = settings.data?.['timezone.current'] ?? deviceTimeZone();

  // A fresh draft exists only in memory until the first keystroke stores it (autosave).
  const fresh = useMemo(() => {
    if (postId) return null;
    const today = localDateFor(new Date(), tz);
    const occurredAt = date && date !== today ? zonedTimeToUtc(`${date}T12:00`, tz) : null;
    const origLocale = CONTENT_LOCALES.some((l) => l.code === uiLocale) ? uiLocale : 'de';
    return newDraft(kind, { id, origLocale, occurredAt, tz: occurredAt ? tz : null });
  }, [postId, id, kind, date, tz, uiLocale]);
  const fromPost = useMemo(() => (postQ.data ? draftFromPost(postQ.data, id) : null), [postQ.data, id]);

  return {
    draft: existing ?? fromPost ?? fresh,
    post: postQ.data,
    loading: !!postId && postQ.isPending,
    error: postQ.error,
  };
}

export function ComposerScreen() {
  const { kind, post: postId, date, draft: draftId } = composeApi.useSearch();
  const { t } = useLingui();
  const locale = useLocale();
  const navigate = useNavigate();
  const notifyWrite = useNotifyWrite();
  const { draft, post, loading, error } = useDraft(kind, postId, date, draftId);
  const createPost = useWrite('createPost');
  const updatePost = useWrite('updatePost');
  const deletePost = useWrite('deletePost');
  const [tab, setTab] = useState<LocaleCode>(locale === 'en' ? 'en' : 'de');
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  const [showProblems, setShowProblems] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pendingSave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [local, setLocal] = useState<Draft | null>(draft);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const liveState = useItemState(
    { visibility: post?.visibility ?? 'hidden', changeSeq: post?.changeSeq ?? 0 },
    `post:${postId ?? ''}`,
  );

  // Adopt the stored draft once it exists (first render, or after creating it).
  useEffect(() => {
    if (draft && (!local || local.id !== draft.id)) {
      setLocal(draft);
      setTab(draft.content[draft.origLocale] || !draft.editing ? draft.origLocale : tab);
    }
  }, [draft, local, tab]);

  // Autosave (debounced) while typing.
  function update(next: Draft) {
    setLocal(next);
    if (pendingSave.current) clearTimeout(pendingSave.current);
    pendingSave.current = setTimeout(() => {
      const stamped = { ...next, savedAt: new Date().toISOString() };
      saveDraft(stamped);
      setSavedAt(stamped.savedAt);
    }, 400);
  }
  useEffect(
    () => () => {
      if (pendingSave.current) clearTimeout(pendingSave.current);
    },
    [],
  );

  const result = useMemo(() => (local ? composeContent(local) : null), [local]);

  if (!local || !result) {
    return (
      <>
        <ScreenHeader title={postId ? <Trans>Edit</Trans> : <Trans>Write</Trans>} />
        <QueryError error={error} />
        {(loading || !error) && <Skeleton className="h-72 rounded-card" />}
      </>
    );
  }

  const d = local;
  const tz = d.tz ?? post?.tz ?? deviceTimeZone();
  const current = d.content[tab] ?? { title: '', body: '' };
  const setField = (field: 'title' | 'body', value: string) =>
    update({ ...d, content: { ...d.content, [tab]: { ...current, [field]: value } } });
  const filled = new Set(result.filled);
  const used = charCount(current.body.trim());
  const editing = d.editing && !!post;
  const updateBody = editing && post ? buildUpdate(d, post) : null;
  const canPublish = result.problems.length === 0 && (!editing || (updateBody?.dirty ?? false));
  // The post changed on the server after this draft was started (not by our own queued writes).
  const changedElsewhere =
    editing &&
    !!post &&
    post.changeSeq > 0 &&
    !!d.base &&
    resolveBase(`post:${post.publicId}`, d.base) !== post.updatedAt;

  function problemText(p: ComposeProblem): string {
    switch (p.code) {
      case 'empty':
        return d.kind === 'note' ? t`Write a few words first.` : t`Give your story a title and some text.`;
      case 'too_long': {
        const lang = p.locale.toUpperCase();
        const over = p.length - NOTE_MAX;
        return t`The ${lang} note is ${over} characters too long.`;
      }
      case 'title_missing': {
        const lang = p.locale.toUpperCase();
        return t`The ${lang} story needs a title.`;
      }
    }
  }

  function publish() {
    if (result && result.problems.length > 0) {
      setShowProblems(true);
      return;
    }
    if (editing && post) {
      const body = buildUpdate(d, post);
      if (!body?.dirty) return;
      updatePost({
        publicId: post.publicId,
        kind: post.kind,
        patch: body.patch,
        original: body.original,
        base: d.base,
        draftId: d.id,
      });
      notifyWrite(`post:${post.publicId}`, msg`Changes saved`);
    } else {
      const body = buildCreate(d);
      if (!body) return;
      createPost({ body, draftId: d.id });
      notifyWrite(
        `post:${body.publicId}`,
        d.visibility === 'public' ? msg`Published. It will be on the site in a moment.` : msg`Saved as hidden.`,
      );
    }
    if (pendingSave.current) clearTimeout(pendingSave.current);
    removeDraft(d.id);
    const target = d.occurredAt ? localDateFor(d.occurredAt, tz) : null;
    void navigate(target ? { to: '/days/$date', params: { date: target } } : { to: '/' });
  }

  const header = editing ? (
    d.kind === 'note' ? (
      <Trans>Edit note</Trans>
    ) : (
      <Trans>Edit story</Trans>
    )
  ) : d.kind === 'note' ? (
    <Trans>New note</Trans>
  ) : (
    <Trans>New story</Trans>
  );
  const publishLabel = editing ? (
    <Trans>Save changes</Trans>
  ) : d.visibility === 'public' ? (
    <Trans>Publish</Trans>
  ) : (
    <Trans>Save hidden</Trans>
  );
  const whenLabel = d.occurredAt
    ? `${formatLocalDate(localDateFor(d.occurredAt, tz), locale)} · ${formatTime(d.occurredAt, tz, locale)}`
    : t`now`;

  return (
    <>
      <ScreenHeader
        eyebrow={editing ? <Trans>a page of your journal</Trans> : <Trans>a page for your journal</Trans>}
        title={header}
        actions={editing ? <PublishChip state={liveState} /> : undefined}
        back={editing && post ? { to: '/days/$date', label: t`Day`, params: { date: post.localDate } } : undefined}
      />
      {!editing && (
        <Segmented<DraftKind>
          label={t`Kind`}
          value={d.kind}
          className="mb-5"
          onChange={(next) =>
            void navigate({ to: '/compose', search: { kind: next, ...(date ? { date } : {}) }, replace: true })
          }
          options={[
            { value: 'note', label: t`Note`, icon: FeatherIcon },
            { value: 'story', label: t`Story`, icon: BookIcon },
          ]}
        />
      )}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,0.6fr)]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <LocaleTabs
              label={t`Language`}
              locales={CONTENT_LOCALES}
              value={tab}
              onChange={setTab}
              filled={filled}
              original={result.origLocale ?? d.origLocale}
              originalLabel={t`original`}
            />
            {d.kind === 'story' && (
              <Segmented<'write' | 'preview'>
                label={t`Editor mode`}
                size="sm"
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'write', label: t`Write` },
                  { value: 'preview', label: t`Preview` },
                ]}
              />
            )}
          </div>
          {d.kind === 'note' ? (
            <div className="washi-tape mt-5 rotate-[-0.6deg] rounded-card bg-surface p-5 shadow-lift ring-ring/0 transition-shadow duration-200 focus-within:ring-3 focus-within:ring-ring/35 sm:p-7">
              <label htmlFor="note-body" className="sr-only">
                {t`Note (${tab})`}
              </label>
              <textarea
                id="note-body"
                lang={tab}
                dir="auto"
                rows={6}
                maxLength={BODY_MAX}
                value={current.body}
                placeholder={t`What is on your mind right now?`}
                onChange={(e) => setField('body', e.target.value)}
                className="block w-full resize-none bg-transparent font-hand text-[1.35rem] leading-relaxed text-ink placeholder:text-muted/60 focus:outline-none"
                aria-describedby="note-count"
                // "Write" is a deliberate intent: the keyboard comes up right away for a new note.
                // biome-ignore lint/a11y/noAutofocus: the composer opens for typing; the page has one field
                autoFocus={!d.editing}
              />
              <div
                id="note-count"
                className="mt-3 flex items-center justify-end border-t-2 border-dashed border-line pt-3"
              >
                <CharRing used={used} max={NOTE_MAX} />
              </div>
            </div>
          ) : (
            <div className="rounded-card bg-surface p-5 shadow-soft sm:p-7">
              <label htmlFor="story-title" className="sr-only">
                {t`Title (${tab})`}
              </label>
              <textarea
                id="story-title"
                lang={tab}
                dir="auto"
                rows={1}
                maxLength={200}
                value={current.title}
                placeholder={t`Title of your story`}
                onChange={(e) => setField('title', e.target.value.replace(/\n/g, ' '))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.preventDefault();
                }}
                // biome-ignore lint/a11y/noAutofocus: a new story starts with its title
                autoFocus={!d.editing}
                className="display-soft block w-full resize-none bg-transparent text-[1.8rem] leading-tight font-semibold [field-sizing:content] placeholder:text-muted/50 focus:outline-none"
              />
              <hr className="my-4 border-t-2 border-dashed border-line" />
              {mode === 'write' ? (
                <>
                  <label htmlFor="story-body" className="sr-only">
                    {t`Story text in Markdown (${tab})`}
                  </label>
                  <textarea
                    id="story-body"
                    lang={tab}
                    dir="auto"
                    rows={14}
                    maxLength={BODY_MAX}
                    value={current.body}
                    placeholder={t`Tell the story… (Markdown: **bold**, _italic_, ## heading, - list)`}
                    onChange={(e) => setField('body', e.target.value)}
                    className="block min-h-72 w-full resize-y bg-transparent leading-relaxed placeholder:text-muted/60 focus:outline-none"
                  />
                </>
              ) : (
                <MarkdownPreview source={current.body} />
              )}
            </div>
          )}
          {changedElsewhere && (
            <p role="status" className="flex items-start gap-2 rounded-tile bg-lilac px-4 py-3 text-sm">
              <InfoIcon className="mt-0.5 size-4 shrink-0 text-violet" />
              <span>
                <Trans>
                  This post was changed on another device after you started this draft. Saving keeps both: where you
                  both changed the same text, you choose.
                </Trans>
              </span>
            </p>
          )}
          {showProblems && result.problems.length > 0 && (
            <ul
              role="alert"
              className="space-y-1 rounded-tile bg-danger/10 px-4 py-3 text-sm font-semibold text-danger"
            >
              {result.problems.map((p) => (
                <li key={`${p.code}-${'locale' in p ? p.locale : ''}`}>{problemText(p)}</li>
              ))}
            </ul>
          )}
        </div>
        <aside className="space-y-4 rounded-card bg-surface/70 p-5 shadow-soft ring-1 ring-line/60">
          <Field
            label={<Trans>Original language</Trans>}
            hint={<Trans>Other languages are shown as translations.</Trans>}
          >
            {(ids) => (
              <SelectInput
                {...ids}
                value={d.origLocale}
                onChange={(e) => update({ ...d, origLocale: e.target.value as LocaleCode })}
              >
                {CONTENT_LOCALES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {LOCALES.find((x) => x.code === l.code)?.label ?? l.code}
                  </option>
                ))}
              </SelectInput>
            )}
          </Field>
          <Field
            label={<Trans>When</Trans>}
            hint={<Trans>Time in {zoneLabel(tz, locale)}. Leave empty for now.</Trans>}
          >
            {(ids) => (
              <div className="flex gap-2">
                <TextInput
                  {...ids}
                  type="datetime-local"
                  value={d.occurredAt ? utcToZonedInput(d.occurredAt, tz) : ''}
                  onChange={(e) => {
                    const iso = e.target.value ? zonedTimeToUtc(e.target.value, tz) : null;
                    update({ ...d, occurredAt: iso, tz: iso ? tz : d.editing ? d.tz : null });
                  }}
                />
              </div>
            )}
          </Field>
          <p className="-mt-2 flex items-center gap-1.5 text-xs text-muted">
            <ClockIcon className="size-3.5" />
            {whenLabel}
          </p>
          <div className="space-y-2">
            <p className="text-sm font-bold">
              <Trans>Visibility</Trans>
            </p>
            <Segmented<'public' | 'hidden'>
              label={t`Visibility`}
              size="sm"
              className="w-full"
              value={d.visibility === 'public' ? 'public' : 'hidden'}
              onChange={(v) => update({ ...d, visibility: v })}
              options={[
                { value: 'public', label: t`Public`, icon: EyeIcon },
                { value: 'hidden', label: t`Hidden`, icon: EyeOffIcon },
              ]}
            />
          </div>
          <p className="text-xs text-muted" aria-live="polite">
            {savedAt ? (
              <Trans>Draft saved on this device at {formatTime(savedAt, deviceTimeZone(), locale)}</Trans>
            ) : (
              <Trans>Drafts are saved on this device while you write.</Trans>
            )}
          </p>
          <div className="hidden lg:block">
            <Button
              size="lg"
              icon={SendIcon}
              className="w-full"
              onClick={publish}
              disabled={editing && !canPublish && result.problems.length === 0}
            >
              {publishLabel}
            </Button>
          </div>
          {editing && post ? (
            <Button variant="danger" icon={TrashIcon} className="w-full" onClick={() => setConfirmDelete(true)}>
              <Trans>Delete</Trans>
            </Button>
          ) : (
            draftHasContent(d) && (
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => {
                  removeDraft(d.id);
                  setLocal(null);
                }}
              >
                <Trans>Discard draft</Trans>
              </Button>
            )
          )}
          {!editing && (
            <p className="text-center text-xs text-muted">
              <Link
                to="/days"
                className="font-bold text-accent hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
              >
                <Trans>Edit an existing post from its day</Trans>
              </Link>
            </p>
          )}
        </aside>
      </div>
      {/* A direct child of the page, so it sticks above the tab bar over the whole form. */}
      <StickyActions
        className="lg:hidden"
        note={
          <span className="line-clamp-2 text-xs">
            {savedAt ? <Trans>Draft saved</Trans> : <Trans>Drafts stay on this device.</Trans>}
          </span>
        }
      >
        <Button icon={SendIcon} onClick={publish} disabled={editing && !canPublish && result.problems.length === 0}>
          {publishLabel}
        </Button>
      </StickyActions>
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        closeLabel={t`Close`}
        title={d.kind === 'note' ? <Trans>Delete this note?</Trans> : <Trans>Delete this story?</Trans>}
        description={<Trans>It disappears from the site with the next publish. This cannot be undone.</Trans>}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              <Trans>Keep</Trans>
            </Button>
            <Button
              className={cx('bg-danger hover:bg-danger')}
              icon={TrashIcon}
              onClick={() => {
                if (!post) return;
                deletePost({ publicId: post.publicId });
                removeDraft(d.id);
                notifyWrite(`post:${post.publicId}`, msg`Deleted`);
                setConfirmDelete(false);
                void navigate({ to: '/days/$date', params: { date: post.localDate } });
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

function draftHasContent(d: Draft): boolean {
  return Object.values(d.content).some((c) => c && (c.body.trim() || c.title.trim()));
}
