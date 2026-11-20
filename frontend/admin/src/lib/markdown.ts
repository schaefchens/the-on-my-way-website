/**
 * Story preview: markdown-it with raw HTML disabled (same rule as the public site, plan C).
 * Images are disabled as in the generator (backend/src/generator/markdown.ts): the site's CSP
 * allows same-site images only, so `![x](https://…)` would be blocked there; the preview shows
 * what the site shows (the source text), and the admin never loads third-party images either.
 * Loaded lazily by the composer so it stays out of the initial bundle.
 */
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: false }).disable(['image']);

// Links in previews open in a new tab and never leak the admin URL.
const defaultLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(source: string): string {
  return md.render(source);
}
