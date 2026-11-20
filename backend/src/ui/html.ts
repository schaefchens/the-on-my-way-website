/**
 * Minimal, escape-by-default HTML templating for the control UI (server-rendered, no build step).
 *
 *   html`<p>${userText}</p>`      interpolations are escaped
 *   html`<div>${raw(svg)}</div>`  only for markup this server produced itself (QR SVG)
 *   arrays are joined; null/undefined/false render nothing.
 *
 * The CSP forbids inline scripts and inline style attributes, so templates use classes only.
 */
export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export const raw = (value: string): SafeHtml => new SafeHtml(value);

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? '');
  return new SafeHtml(out);
}

// ---------------------------------------------------------------------------------------------
// Formatting helpers

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/** "3 min ago" / "in 2 h" relative to `now`. */
export function relativeTime(iso: string | null | undefined, now: number): string {
  if (!iso) return '–';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '–';
  const diff = Math.round((now - t) / 1000);
  const abs = Math.abs(diff);
  let text: string;
  if (abs < 45) text = `${abs} s`;
  else if (abs < 45 * 60) text = `${Math.round(abs / 60)} min`;
  else if (abs < 36 * 3600) text = `${Math.round(abs / 3600)} h`;
  else text = `${Math.round(abs / 86400)} d`;
  return diff >= 0 ? `${text} ago` : `in ${text}`;
}

/** <time> element with an absolute title and a relative label. */
export function timeTag(iso: string | null | undefined, now: number): SafeHtml {
  if (!iso) return html`<span class="muted">–</span>`;
  return html`<time datetime="${iso}" title="${iso}">${relativeTime(iso, now)}</time>`;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'info';

/** A status pill; `title` keeps the raw machine value (e.g. "logged_out") at hand on hover. */
export function badge(text: string, tone: Tone, title?: string): SafeHtml {
  return title && title !== text
    ? html`<span class="badge badge-${tone}" title="${title}">${text}</span>`
    : html`<span class="badge badge-${tone}">${text}</span>`;
}

/** "14:05 UTC" (static/app.js shows it in the browser's local time). */
export function clockTag(iso: string | null | undefined): SafeHtml {
  if (!iso) return html`<span class="muted">–</span>`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return html`<span class="muted">–</span>`;
  return html`<time datetime="${d.toISOString()}" data-local-time>${d.toISOString().slice(11, 16)} UTC</time>`;
}

// ---------------------------------------------------------------------------------------------
// Layout

export type NavKey = 'overview' | 'link' | 'queue' | 'publish' | 'logs' | 'login';

const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: 'overview', href: '/', label: 'Overview' },
  { key: 'link', href: '/link', label: 'Link WhatsApp' },
  { key: 'queue', href: '/queue', label: 'Queue' },
  { key: 'publish', href: '/publish', label: 'Publish' },
  { key: 'logs', href: '/logs', label: 'Logs' },
];

export interface Flash {
  kind: 'ok' | 'error';
  text: string;
}

export interface LayoutOptions {
  title: string;
  active: NavKey;
  /** null on the login page. */
  csrf: string | null;
  body: SafeHtml;
  flash?: Flash | null;
  version: string;
  assets: { css: string; js: string };
}

export function csrfField(csrf: string | null): SafeHtml {
  return csrf ? html`<input type="hidden" name="_csrf" value="${csrf}">` : html``;
}

export function layout(o: LayoutOptions): string {
  const nav =
    o.active === 'login'
      ? html``
      : html`<nav class="nav" aria-label="Main">
          ${NAV.map(
            (n) =>
              html`<a href="${n.href}" class="${n.key === o.active ? 'active' : ''}" ${raw(
                n.key === o.active ? 'aria-current="page"' : '',
              )}>${n.label}</a>`,
          )}
          <form method="post" action="/logout" class="inline">${csrfField(o.csrf)}<button class="link" type="submit">Log out</button></form>
        </nav>`;
  const flash = o.flash
    ? html`<p class="flash flash-${o.flash.kind}" role="${o.flash.kind === 'error' ? 'alert' : 'status'}">${o.flash.text}</p>`
    : html``;
  return `<!doctype html>${html`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="same-origin">
${o.csrf ? html`<meta name="csrf-token" content="${o.csrf}">` : html``}
<title>${o.title} · On My Way control</title>
<link rel="stylesheet" href="${o.assets.css}">
<script type="module" src="${o.assets.js}"></script>
</head>
<body>
<header class="top">
  <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">✿</span> On My Way <span class="brand-sub">control</span></a>
  ${nav}
</header>
<main class="main" id="main">
${flash}
${o.body}
</main>
<footer class="foot">backend ${o.version}</footer>
</body>
</html>`}`;
}
