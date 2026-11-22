/**
 * The information screen's notice (D11, spec-wave5 §6.2.7): one locale of a PublicNotice, in this
 * order: title, intro, "What is stored" (collected), "Who sees what" (audience), "Why and for how
 * long" (purpose, retention), "Your rights" (rights + the fixed sentence about "Your data"),
 * "Responsible" (controller), "Version n · valid since …". Owner text is plain text: blank lines
 * split paragraphs and every paragraph is a text node (never HTML).
 */
import type { NoticeTexts, PublicNotice } from '@omw/contracts/access';
import { type LocaleCode, textDirection } from '@omw/contracts/i18n';
import { formatDate, type Ui } from './dom';
import { fmt, STRINGS } from './strings';

/** The notice's locale for a reader: the UI locale, the site default, de, en, then any. */
export function noticeLocale(notice: PublicNotice, preferred: readonly LocaleCode[]): LocaleCode | null {
  const available = Object.keys(notice.texts) as LocaleCode[];
  for (const code of [...preferred, 'de', 'en'] as const) if (notice.texts[code]) return code;
  return available[0] ?? null;
}

/** Paragraphs of a plain-text field (blank lines separate them). */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

const EMAIL_RE = /^[^\s@?#&/\\:<>"']+@[^\s@?#&/\\:<>"']+$/;

export function renderNotice(ui: Ui, notice: PublicNotice): HTMLElement {
  const { el } = ui;
  const locale = noticeLocale(notice, [ui.locale, ui.boot.defaultLocale]) ?? ui.locale;
  const texts = notice.texts[locale] as NoticeTexts;
  const s = STRINGS[locale];
  const body = (text: string) =>
    paragraphs(text).map((p) => el('p', { class: 'mt-2 text-pretty whitespace-pre-line' }, p));
  const heading = (text: string) => el('h3', { class: 'mt-5 font-bold text-ink' }, text);
  const { controller } = notice;
  const email = EMAIL_RE.test(controller.email)
    ? el(
        'a',
        {
          class: 'font-semibold text-violet underline underline-offset-4',
          attrs: { href: `mailto:${controller.email}` },
        },
        controller.email,
      )
    : controller.email;
  return el(
    'article',
    {
      class: 'mt-5 rounded-tile bg-surface-2 p-4 text-sm leading-relaxed text-ink sm:p-5',
      attrs: { lang: locale, dir: textDirection(locale), 'data-notice': String(notice.version) },
    },
    el('h2', { class: 'text-lg font-bold text-balance' }, texts.title),
    ...body(texts.intro),
    heading(s.headingCollected),
    ...body(texts.collected),
    heading(s.headingAudience),
    ...body(texts.audience),
    heading(s.headingPurpose),
    ...body(texts.purpose),
    ...body(texts.retention),
    heading(s.headingRights),
    ...body(texts.rights),
    el('p', { class: 'mt-2' }, s.rightsFixed),
    heading(s.headingController),
    el('p', { class: 'mt-2' }, controller.name),
    controller.address ? el('p', { class: 'whitespace-pre-line' }, controller.address) : null,
    el('p', null, email),
    el(
      'p',
      { class: 'mt-5 text-xs text-muted' },
      fmt(s.noticeVersion, { n: notice.version, date: formatDate(notice.publishedAt, locale) }),
    ),
  );
}
