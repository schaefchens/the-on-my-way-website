/**
 * Story sheet (plan C): long-form owner stories as a sheet above the (paused) player.
 * markdown-it with raw HTML disabled, linkify and typographer (locale quotes); language picked
 * with the contracts' pickText rules, "Original: …" label and a toggle between translation and
 * original. No share buttons on purpose.
 *
 * Default export: loaded lazily by routes/story.tsx as its own chunk (markdown-it lives here).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import type { LocaleCode } from '@omw/contracts/i18n';
import type { DayDetail } from '@omw/contracts/site';
import { countryFlag, formatLocalDate, languageName } from '@omw/ui/locale';
import { SPRINGS } from '@omw/ui/motion';
import markdownit, { type MarkdownIt, type RendererRule } from 'markdown-it';
import { m } from 'motion/react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from './focus-trap';
import { BookIcon, CloseIcon } from './icons';
import { readingMinutes } from './items';
import { pickStory, type StoryEntry, storyAlternative } from './story-content';
import './story-sheet.css';

const QUOTES: Record<LocaleCode, string> = {
  de: '„“‚‘',
  en: '“”‘’',
  ar: '«»‹›',
};

const renderers = new Map<LocaleCode, MarkdownIt>();

/**
 * One configured markdown-it per content language (quotes differ). Same rules as the
 * pre-rendered story page (backend/src/generator/markdown.ts): raw HTML off, images off (the
 * page CSP allows images from the site only; `![x](url)` renders as "!" plus a link), and only
 * http(s), mailto and relative links. Links open in a new tab.
 */
export function markdownFor(locale: LocaleCode): MarkdownIt {
  const cached = renderers.get(locale);
  if (cached) return cached;
  const md = markdownit({ html: false, linkify: true, typographer: true, breaks: false, quotes: QUOTES[locale] });
  md.disable(['image']);
  const defaultValidate = md.validateLink.bind(md);
  md.validateLink = (url: string) => {
    if (!defaultValidate(url)) return false;
    const trimmed = url.trim().toLowerCase();
    if (/^[a-z][a-z0-9+.-]*:/.test(trimmed)) return /^(?:https?|mailto):/.test(trimmed);
    return true;
  };
  const renderToken: RendererRule = (tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options);
  const linkOpen = md.renderer.rules.link_open ?? renderToken;
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token) {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer nofollow');
    }
    return linkOpen(tokens, idx, options, env, self);
  };
  // The sheet's title is the <h1>: story headings start one level below it (# -> h2, ## -> h3).
  const demote = (tokens: Parameters<RendererRule>[0], idx: number) => {
    const token = tokens[idx];
    if (!token) return;
    const level = Number(token.tag.slice(1));
    if (Number.isInteger(level)) token.tag = `h${Math.min(6, Math.max(2, level + 1))}`;
  };
  md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
    demote(tokens, idx);
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.heading_close = (tokens, idx, options, _env, self) => {
    demote(tokens, idx);
    return self.renderToken(tokens, idx, options);
  };
  renderers.set(locale, md);
  return md;
}

/** Story markdown -> HTML (raw HTML in the source is escaped, unsafe link schemes dropped). */
export function renderStoryMarkdown(body: string, locale: LocaleCode): string {
  return markdownFor(locale).render(body);
}

export interface StorySheetProps {
  story: StoryEntry;
  locale: LocaleCode;
  day: DayDetail | undefined;
  onClose: () => void;
}

export default function StorySheet({ story, locale, day, onClose }: StorySheetProps) {
  const { t } = useLingui();
  const headingId = useId();
  const sheetRef = useRef<HTMLElement>(null);
  const picked = pickStory(story, locale);
  const [shown, setShown] = useState<LocaleCode | null>(picked?.locale ?? null);
  const shownLocale = shown && story.story[shown] ? shown : (picked?.locale ?? null);
  const content = shownLocale ? story.story[shownLocale] : undefined;
  const alternative = shownLocale ? storyAlternative(story, shownLocale, locale) : null;
  const html = useMemo(
    () => (content && shownLocale ? renderStoryMarkdown(content.body, shownLocale) : ''),
    [content, shownLocale],
  );
  const minutes = content ? readingMinutes(content.body) : 1;
  const isOriginal = shownLocale === story.orig;
  const shownLanguage = shownLocale ? languageName(shownLocale, locale) : '';
  const origLanguage = languageName(story.orig, locale);
  const alternativeLanguage = alternative ? languageName(alternative, locale) : '';

  useFocusTrap(sheetRef, { active: true, restoreFocus: false });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Pull the handle down to close.
  const handleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handle = handleRef.current;
    const sheet = sheetRef.current;
    if (!handle || !sheet) return;
    let startY: number | null = null;
    const onDown = (e: PointerEvent) => {
      // Buttons in the bar (close) keep their click: capturing would retarget it to the bar.
      if (e.target instanceof Element && e.target.closest('button, a')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      startY = e.clientY;
      handle.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (startY === null) return;
      const dy = Math.max(0, e.clientY - startY);
      sheet.style.transform = dy ? `translate3d(0, ${dy}px, 0)` : '';
    };
    const onUp = (e: PointerEvent) => {
      if (startY === null) return;
      const dy = e.clientY - startY;
      startY = null;
      sheet.style.transition = 'transform 280ms cubic-bezier(0.22, 1, 0.36, 1)';
      sheet.style.transform = '';
      setTimeout(() => {
        sheet.style.transition = '';
      }, 300);
      if (dy > 90) onClose();
    };
    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    return () => {
      handle.removeEventListener('pointerdown', onDown);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
  }, [onClose]);

  const dateLabel = day ? formatLocalDate(day.date, locale, 'long') : '';

  return (
    <div className="fixed inset-0 z-50" data-testid="story-sheet-root">
      <m.div
        aria-hidden="true"
        className="absolute inset-0 bg-plum-950/55 backdrop-blur-[2px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.25 }}
        onClick={onClose}
      />
      <m.article
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        data-testid="story-sheet"
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        transition={SPRINGS.soft}
        className="absolute inset-x-0 top-[max(2.5rem,env(safe-area-inset-top))] bottom-0 mx-auto flex max-w-3xl flex-col overflow-hidden rounded-t-sheet bg-surface text-ink shadow-float outline-none sm:top-8 sm:bottom-8 sm:rounded-sheet"
      >
        <div
          ref={handleRef}
          className="relative z-10 flex shrink-0 touch-none items-center justify-between gap-3 bg-surface/90 px-4 pt-2 pb-2 backdrop-blur"
        >
          <span
            aria-hidden="true"
            className="absolute top-2 left-1/2 h-1.5 w-12 -translate-x-1/2 rounded-pill bg-line"
          />
          <span className="mt-3 inline-flex items-center gap-2 text-xs font-bold tracking-[0.14em] text-accent uppercase">
            <BookIcon size={16} />
            <Trans>Story</Trans>
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t`Close story`}
            data-testid="story-close"
            className="mt-2 grid size-10 place-items-center rounded-pill bg-blush text-ink transition-transform duration-150 ease-snappy hover:bg-blush-strong active:scale-90"
          >
            <CloseIcon size={20} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto max-w-[38rem] px-6 pt-4 pb-16 sm:px-10">
            <header className="mb-10">
              <p className="text-sm font-semibold text-muted">
                {dateLabel}
                {day?.place && (
                  <>
                    {' · '}
                    <bdi>{day.place}</bdi>
                  </>
                )}
                {day?.country && ` ${countryFlag(day.country)}`}
              </p>
              <h1
                id={headingId}
                lang={shownLocale ?? undefined}
                dir="auto"
                data-user-text
                className="mt-3 font-display text-[clamp(2.1rem,7vw,3.1rem)] leading-[1.05] font-semibold text-balance [font-variation-settings:'SOFT'_100]"
              >
                {content?.title}
              </h1>
              <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="inline-block size-1.5 rounded-pill bg-accent" />
                  <Trans>{minutes} min read</Trans>
                </span>
                {shownLocale && isOriginal && shownLocale !== locale && (
                  <span className="rounded-pill bg-lilac px-2.5 py-0.5 text-xs font-semibold text-violet">
                    <Trans>Original: {shownLanguage}</Trans>
                  </span>
                )}
                {shownLocale === locale && !isOriginal && (
                  <span className="rounded-pill bg-lilac px-2.5 py-0.5 text-xs font-semibold text-violet">
                    <Trans>Translated from {origLanguage}</Trans>
                  </span>
                )}
                {alternative && (
                  <button
                    type="button"
                    onClick={() => setShown(alternative)}
                    data-testid="story-language-toggle"
                    className="rounded-pill px-2.5 py-0.5 text-xs font-semibold text-accent underline decoration-1 underline-offset-4 hover:bg-blush"
                  >
                    {alternative === story.orig ? (
                      <Trans>Show original</Trans>
                    ) : (
                      <Trans>Show in {alternativeLanguage}</Trans>
                    )}
                  </button>
                )}
              </div>
            </header>
            <div
              className="omw-prose"
              lang={shownLocale ?? undefined}
              dir="auto"
              data-user-text
              // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown-it with html:false escapes raw HTML and validates link schemes.
              dangerouslySetInnerHTML={{ __html: html }}
            />
            <footer className="mt-14 flex justify-center">
              <button
                type="button"
                onClick={onClose}
                className="rounded-pill bg-accent px-6 py-3 font-semibold text-on-accent shadow-lift transition-[transform,background-color] duration-150 ease-snappy hover:bg-accent-strong active:scale-95"
              >
                <Trans>Back to the day</Trans>
              </button>
            </footer>
          </div>
        </div>
      </m.article>
    </div>
  );
}
