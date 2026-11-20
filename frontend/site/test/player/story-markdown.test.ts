import { describe, expect, it } from 'vitest';
import { renderStoryMarkdown } from '../../src/player/story-sheet';

describe('story markdown', () => {
  it('escapes raw HTML (html: false)', () => {
    const html = renderStoryMarkdown('Hi <script>alert(1)</script> <img src=x onerror=alert(1)>', 'en');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('drops unsafe link schemes and opens links safely in a new tab', () => {
    const html = renderStoryMarkdown('[x](javascript:alert(1)) [ok](https://example.org)', 'en');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://example.org" target="_blank" rel="noopener noreferrer nofollow"');
  });

  it('linkifies bare URLs', () => {
    expect(renderStoryMarkdown('see https://example.org/a', 'de')).toContain('<a href="https://example.org/a"');
  });

  it('uses typographic quotes per language', () => {
    expect(renderStoryMarkdown('"Hallo" -- sagt sie...', 'de')).toContain('„Hallo“ – sagt sie…');
    expect(renderStoryMarkdown('"Hello"', 'en')).toContain('“Hello”');
  });

  it('renders headings, lists and emphasis', () => {
    const html = renderStoryMarkdown('# Top\n\n## Title\n\n### Sub\n\n- **one**\n- *two*', 'de');
    // Demoted below the sheet's <h1> title.
    expect(html).toContain('<h2>Top</h2>');
    expect(html).toContain('<h3>Title</h3>');
    expect(html).toContain('<h4>Sub</h4>');
    expect(html).toContain('<li><strong>one</strong></li>');
    expect(html).toContain('<em>two</em>');
  });

  it('renders no images (CSP: same-site images only; like the pre-rendered page)', () => {
    const html = renderStoryMarkdown('![x](https://evil.example/p.gif) and ![local](media/ab/x.webp)', 'en');
    expect(html).not.toContain('<img');
    // The image syntax degrades to "!" plus a plain link, exactly as the generator renders it.
    expect(html).toContain(
      '!<a href="https://evil.example/p.gif" target="_blank" rel="noopener noreferrer nofollow">x</a>',
    );
  });

  it('keeps only http(s), mailto and relative links (generator parity)', () => {
    const html = renderStoryMarkdown('[a](ftp://x.example) [b](mailto:a@b.example) [c](../day/) [d](tel:123)', 'en');
    expect(html).not.toContain('href="ftp:');
    expect(html).not.toContain('href="tel:');
    expect(html).toContain('href="mailto:a@b.example"');
    expect(html).toContain('href="../day/"');
  });
});
