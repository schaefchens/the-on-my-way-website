/**
 * HTML built by construction-safe templates.
 *
 *   html`<p class="caption">${userText}</p>`          // userText is escaped
 *   html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`
 *
 * Every interpolated value is escaped (& < > " ') unless it is an `Html` value, which only this
 * module can create: through the `html` tag itself (its literal parts are trusted source code),
 * through `trustedHtml()` for the few vetted producers (markdown-it with html:false, see
 * markdown.ts), and through the serialisers below (JSON for <script type="application/json">,
 * validated CSS). Attribute values are always double-quoted in the templates, so escaping `"`
 * and `&` is sufficient there; URLs additionally go through `safeHref()`.
 */

const BRAND: unique symbol = Symbol('omw.html');

export class Html {
  readonly [BRAND] = true;
  readonly value: string;
  /** @internal use html`` / trustedHtml() */
  constructor(value: string, token: typeof BRAND) {
    if (token !== BRAND) throw new TypeError('Html values are created by html`` or trustedHtml()');
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export type HtmlValue = Html | string | number | boolean | null | undefined | readonly HtmlValue[];

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML/XML element content and double- or single-quoted attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

export function isHtml(value: unknown): value is Html {
  return value instanceof Html;
}

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false || value === true) return '';
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`Cannot render ${value} into HTML`);
    return String(value);
  }
  return escapeHtml(String(value));
}

/** Tagged template: literal parts are trusted, interpolations are escaped (Html passes through). */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): Html {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? '');
  return new Html(out, BRAND);
}

/** Wraps markup produced by a vetted producer (see file header). Never pass user text here. */
export function trustedHtml(markup: string): Html {
  return new Html(markup, BRAND);
}

export function joinHtml(items: readonly HtmlValue[], separator: HtmlValue = ''): Html {
  const sep = render(separator);
  return new Html(items.map(render).join(sep), BRAND);
}

/**
 * Serialises JSON for an inline <script type="application/json"> (no "</script>", no "<!--",
 * no U+2028/9): same rules as escapeJsonForHtml in frontend/site/vite/dev-data-plugin.ts.
 */
export function jsonForScript(value: unknown): Html {
  const json = JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return new Html(json, BRAND);
}

/**
 * Inline script/style bodies we generate ourselves. Refuses anything that could end the element
 * early, so a bug can never turn into markup injection.
 */
export function inlineCode(code: string): Html {
  if (/<\/(?:script|style)/i.test(code) || code.includes('<!--')) {
    throw new Error('Inline code must not contain closing tags or comment openers');
  }
  return new Html(code, BRAND);
}

/**
 * URL for href/src attributes: absolute http(s) URLs and root-relative paths only (our own URLs
 * are built from validated parts; this is a second line of defence against javascript: & co).
 */
export function safeHref(url: string): string {
  if (/^https?:\/\/[^\s"'<>]+$/i.test(url) || /^\/(?!\/)[^\s"'<>]*$/.test(url)) return url;
  throw new RangeError(`Refusing unsafe URL in markup: ${url}`);
}
