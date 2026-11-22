/**
 * A tiny DOM layer for the gate pages: an element builder that only ever creates text nodes
 * (never HTML from data: notice texts, names and labels come from the API), and the page shell
 * (language switch, one card, focus management, re-render on a language change).
 */
import type { GateBoot } from '@omw/contracts/access';
import { type LocaleCode, textDirection } from '@omw/contracts/i18n';
import type { PublicApiError } from './api';
import { type GateEnv, readStored, writeStored } from './env';
import { STRINGS, type Strings } from './strings';

export type Child = Node | string | number | null | undefined | false;
export type Attrs = Readonly<Record<string, string | boolean | null | undefined>>;
export interface Props {
  class?: string;
  attrs?: Attrs;
  onClick?: (event: MouseEvent) => void;
  onChange?: (event: Event) => void;
}

export type ElementBuilder = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
) => HTMLElementTagNameMap[K];

export function elementBuilder(doc: Document): ElementBuilder {
  return (tag, props, ...children) => {
    const node = doc.createElement(tag);
    if (props?.class) node.className = props.class;
    for (const [name, value] of Object.entries(props?.attrs ?? {})) {
      if (value === true) node.setAttribute(name, '');
      else if (typeof value === 'string') node.setAttribute(name, value);
    }
    if (props?.onClick) node.addEventListener('click', props.onClick as EventListener);
    if (props?.onChange) node.addEventListener('change', props.onChange);
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      node.append(typeof child === 'string' || typeof child === 'number' ? doc.createTextNode(String(child)) : child);
    }
    return node;
  };
}

const INTL_LOCALES: Readonly<Record<LocaleCode, string>> = { de: 'de-DE', en: 'en-GB', ar: 'ar' };
export const LANG_STORAGE_KEY = 'omw.gate.lang';
const LOCALE_LABELS: Readonly<Record<LocaleCode, string>> = { de: 'Deutsch', en: 'English', ar: 'Pseudo-RTL' };

/** Stored choice, else the first of the browser's languages the site offers, else the default. */
export function pickLocale(
  boot: Pick<GateBoot, 'locales' | 'defaultLocale'>,
  languages: readonly string[],
  stored: string | null,
): LocaleCode {
  const offered = (code: string): code is LocaleCode => (boot.locales as readonly string[]).includes(code);
  if (stored && offered(stored)) return stored;
  for (const tag of languages) {
    const primary = tag.toLowerCase().split('-')[0] ?? '';
    if (offered(primary)) return primary;
  }
  return boot.defaultLocale;
}

/** A long date (optionally with the time) that never breaks across lines ("22. November 2026"). */
export function formatDate(iso: string, locale: LocaleCode, withTime = false): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(
      INTL_LOCALES[locale],
      withTime ? { dateStyle: 'long', timeStyle: 'short' } : { dateStyle: 'long' },
    )
      .format(date)
      .replace(/\s/g, '\u00a0');
  } catch {
    return iso.slice(0, 10);
  }
}

export const BUTTON = {
  primary:
    'inline-flex min-h-11 items-center justify-center rounded-pill bg-accent px-6 py-2 font-bold text-on-accent shadow-soft hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50 motion-safe:transition-colors',
  secondary:
    'inline-flex min-h-11 items-center justify-center rounded-pill bg-blush px-6 py-2 font-bold text-ink hover:bg-blush-strong disabled:cursor-not-allowed disabled:opacity-50 motion-safe:transition-colors',
  danger:
    'inline-flex min-h-11 items-center justify-center rounded-pill bg-danger px-6 py-2 font-bold text-bg shadow-soft disabled:cursor-not-allowed disabled:opacity-40 motion-safe:transition-opacity',
  /** A destructive action that opens its own confirmation (not the final step). */
  dangerQuiet:
    'inline-flex min-h-11 items-center justify-center rounded-pill border-2 border-danger/40 px-6 py-2 font-bold text-danger hover:border-danger disabled:cursor-not-allowed disabled:opacity-50 motion-safe:transition-colors',
  link: 'inline-flex min-h-11 items-center font-semibold text-violet underline decoration-2 underline-offset-4 hover:text-ink',
} as const;

/** What a page draws: called again (with the new strings) when the language changes. */
export type View = () => Child[];

export interface Ui {
  readonly env: GateEnv;
  readonly boot: GateBoot;
  readonly el: ElementBuilder;
  readonly locale: LocaleCode;
  readonly s: Strings;
  /** Replaces the card's content and moves focus to its heading (or `data-autofocus`). */
  show(view: View): void;
  /** Draws the current view again (after a state change inside it). */
  refresh(): void;
  setLocale(locale: LocaleCode): void;
  date(iso: string, withTime?: boolean): string;
  /** Heading of a view (focus target, tabindex -1). */
  title(text: string): HTMLHeadingElement;
  para(text: string, cls?: string): HTMLParagraphElement;
  button(label: string, onClick: () => void, variant?: keyof typeof BUTTON, attrs?: Attrs): HTMLButtonElement;
  link(label: string, href: string, variant?: keyof typeof BUTTON): HTMLAnchorElement;
  /** "One moment …" with a calm pulse (no motion when reduced motion is preferred). */
  busy(text?: string): Child[];
  /** The message for a failed request, with a retry button. */
  failure(err: unknown, retry: () => void): Child[];
}

function isApiError(err: unknown): err is PublicApiError {
  return err instanceof Error && err.name === 'PublicApiError';
}

export function createUi(env: GateEnv, boot: GateBoot, root: HTMLElement): Ui {
  const doc = env.doc;
  const el = elementBuilder(doc);
  let locale = pickLocale(boot, env.languages, readStored(env, 'local', LANG_STORAGE_KEY));
  let current: View = () => [];
  const nav = el('nav', { class: 'flex gap-1 rounded-pill bg-surface/70 p-0.5 shadow-soft' });
  const card = el('section', { class: 'w-full rounded-card bg-surface p-6 shadow-soft sm:p-8' });

  const ui: Ui = {
    env,
    boot,
    el,
    get locale() {
      return locale;
    },
    get s() {
      return STRINGS[locale];
    },
    show(view) {
      current = view;
      draw(true);
    },
    refresh() {
      draw(false);
    },
    setLocale(next) {
      if (next === locale) return;
      locale = next;
      writeStored(env, 'local', LANG_STORAGE_KEY, next);
      applyDocument();
      draw(false);
    },
    date: (iso, withTime) => formatDate(iso, locale, withTime),
    // Focus moves here on every new view (screen readers announce it); no ring: it is no control.
    title: (text) =>
      el('h1', { class: 'text-2xl font-bold text-balance text-ink outline-none', attrs: { tabindex: '-1' } }, text),
    para: (text, cls = 'mt-3 text-muted') => el('p', { class: `${cls} text-pretty whitespace-pre-line` }, text),
    button: (label, onClick, variant = 'primary', attrs) =>
      el('button', { class: BUTTON[variant], attrs: { type: 'button', ...attrs }, onClick: () => onClick() }, label),
    link: (label, href, variant = 'link') => el('a', { class: BUTTON[variant], attrs: { href } }, label),
    busy: (text) => [
      el(
        'p',
        { class: 'flex items-center gap-3 text-muted', attrs: { role: 'status' } },
        el('span', {
          class: 'size-3 rounded-full bg-accent motion-safe:animate-pulse',
          attrs: { 'aria-hidden': 'true' },
        }),
        text ?? STRINGS[locale].loading,
      ),
    ],
    failure(err, retry) {
      const s = STRINGS[locale];
      const text =
        isApiError(err) && err.kind === 'rate_limited'
          ? s.rateLimited
          : isApiError(err) && err.kind === 'server'
            ? s.unavailable
            : s.offline;
      return [
        ui.title(s.privateTitle),
        el('p', { class: 'mt-3 text-ink', attrs: { role: 'alert' } }, text),
        el('div', { class: 'mt-6' }, ui.button(s.retry, retry)),
      ];
    },
  };

  // Built once, so a language change keeps the focus on the button that was pressed.
  const languageButtons = boot.locales.map((code) =>
    el(
      'button',
      {
        class:
          'min-h-9 rounded-pill px-3 text-xs font-extrabold tracking-wider text-muted hover:text-ink aria-pressed:bg-blush-strong aria-pressed:text-ink',
        attrs: { type: 'button', lang: code, 'aria-label': LOCALE_LABELS[code] },
        onClick: () => ui.setLocale(code),
      },
      code.toUpperCase(),
    ),
  );
  nav.append(...languageButtons);

  function applyDocument(): void {
    const html = doc.documentElement;
    html.lang = locale;
    html.dir = textDirection(locale);
    nav.setAttribute('aria-label', STRINGS[locale].language);
    boot.locales.forEach((code, i) => {
      languageButtons[i]?.setAttribute('aria-pressed', code === locale ? 'true' : 'false');
    });
  }

  function draw(moveFocus: boolean): void {
    card.replaceChildren(
      ...current()
        .filter((c): c is Node | string | number => c !== null && c !== undefined && c !== false)
        .map((c) => (typeof c === 'object' ? c : doc.createTextNode(String(c)))),
    );
    if (!moveFocus) return;
    const target = card.querySelector<HTMLElement>('[data-autofocus]') ?? card.querySelector<HTMLElement>('h1');
    target?.focus({ preventScroll: false });
  }

  applyDocument();
  const top = el(
    'div',
    { class: 'mb-4 flex items-center justify-between gap-3' },
    // The favicon's mark: a rose dot on a blush disc (generic, says nothing about the site).
    el(
      'span',
      { class: 'grid size-9 place-items-center rounded-full bg-blush shadow-soft', attrs: { 'aria-hidden': 'true' } },
      el('span', { class: 'size-3 rounded-full bg-accent' }),
    ),
    boot.locales.length > 1 ? nav : null,
  );
  root.replaceChildren(
    el('div', { class: 'mx-auto flex min-h-dvh w-full max-w-lg flex-col justify-center px-4 py-8' }, top, card),
  );
  return ui;
}
