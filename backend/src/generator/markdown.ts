/**
 * Story markdown for the pre-rendered story page (plan C: markdown-it with raw HTML disabled).
 *
 * - html: false — raw HTML in the source is shown as text, never as markup.
 * - Links: markdown-it's validateLink drops javascript:, vbscript:, file: and non-image data:
 *   URLs; on top of that only http(s), mailto and relative links are kept, and every link gets
 *   rel="nofollow noopener noreferrer".
 * - Images are disabled: the page CSP allows images from the site only, and stories reference
 *   photos through captures, not URLs.
 * The output of render() is the only markup the generator wraps with trustedHtml().
 */
import MarkdownIt from 'markdown-it';
import { type Html, trustedHtml } from './html.js';

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
md.disable(['image']);

const defaultValidate = md.validateLink.bind(md);
md.validateLink = (url: string) => {
  if (!defaultValidate(url)) return false;
  const trimmed = url.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:/.test(trimmed)) return /^(?:https?|mailto):/.test(trimmed);
  return true;
};

md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const token = tokens[idx];
  if (token) token.attrSet('rel', 'nofollow noopener noreferrer');
  return self.renderToken(tokens, idx, options);
};

export function renderMarkdown(source: string): Html {
  return trustedHtml(md.render(source));
}
