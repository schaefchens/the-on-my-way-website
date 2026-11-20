import type { ImageSet } from '@omw/contracts/site';
import { resolveSitePath } from '@omw/contracts/site';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildSrcSet, MediaBaseProvider, Picture, pickFallbackSource, resolveSiteUrl } from '../src/picture';

// 1x1 px thumbhash of a pinkish image (generated with thumbhash.rgbaToThumbHash).
const THUMB = 'HBkSHYSIeHiPiHh8eJd4eTN0EEQG';

const image: ImageSet = {
  w: 1080,
  h: 1350,
  color: '#c08a6e',
  thumbhash: THUMB,
  sources: {
    avif: [
      { w: 640, src: 'media/ab/ab12cd34ef56ab78_w640.avif' },
      { w: 320, src: 'media/ab/ab12cd34ef56ab78_w320.avif' },
      { w: 1080, src: 'media/ab/ab12cd34ef56ab78_w1080.avif' },
    ],
    webp: [
      { w: 320, src: 'media/ab/ab12cd34ef56ab78_w320.webp' },
      { w: 640, src: 'media/ab/ab12cd34ef56ab78_w640.webp' },
      { w: 1080, src: 'media/ab/ab12cd34ef56ab78_w1080.webp' },
    ],
  },
};

describe('resolveSiteUrl', () => {
  it('joins basePath and site-relative paths like the contracts helper', () => {
    for (const base of ['/', '/travel/', '/a/b-c/']) {
      for (const rel of ['media/ab/x_w320.avif', '/media/ab/x_w320.avif']) {
        expect(resolveSiteUrl(base, rel)).toBe(resolveSitePath(base, rel));
      }
    }
    expect(resolveSiteUrl('/travel/', 'media/x.webp')).toBe('/travel/media/x.webp');
  });

  it('rejects malformed base paths', () => {
    expect(() => resolveSiteUrl('travel/', 'x')).toThrow(RangeError);
    expect(() => resolveSiteUrl('/travel', 'x')).toThrow(RangeError);
  });
});

describe('buildSrcSet', () => {
  it('sorts by width and prefixes the basePath', () => {
    expect(buildSrcSet(image.sources.avif, '/travel/')).toBe(
      '/travel/media/ab/ab12cd34ef56ab78_w320.avif 320w, ' +
        '/travel/media/ab/ab12cd34ef56ab78_w640.avif 640w, ' +
        '/travel/media/ab/ab12cd34ef56ab78_w1080.avif 1080w',
    );
  });

  it('picks the smallest source at least the target width, else the largest', () => {
    expect(pickFallbackSource(image.sources.webp)?.w).toBe(640);
    expect(pickFallbackSource(image.sources.webp, 700)?.w).toBe(1080);
    expect(pickFallbackSource(image.sources.webp, 4000)?.w).toBe(1080);
    expect(pickFallbackSource([])).toBeUndefined();
  });
});

describe('<Picture>', () => {
  it('renders AVIF before WebP with srcset, sizes, intrinsic size and placeholder', () => {
    const html = renderToStaticMarkup(
      <MediaBaseProvider basePath="/travel/">
        <Picture image={image} alt="Gelbe Häuser" sizes="(min-width: 48rem) 50vw, 100vw" className="rounded-tile" />
      </MediaBaseProvider>,
    );
    const avifAt = html.indexOf('type="image/avif"');
    const webpAt = html.indexOf('type="image/webp"');
    expect(avifAt).toBeGreaterThan(-1);
    expect(webpAt).toBeGreaterThan(avifAt);
    expect(html).toContain(
      'srcSet="/travel/media/ab/ab12cd34ef56ab78_w320.avif 320w, /travel/media/ab/ab12cd34ef56ab78_w640.avif 640w, /travel/media/ab/ab12cd34ef56ab78_w1080.avif 1080w"',
    );
    expect(html).toContain('sizes="(min-width: 48rem) 50vw, 100vw"');
    expect(html).toContain('src="/travel/media/ab/ab12cd34ef56ab78_w640.webp"');
    expect(html).toContain('width="1080"');
    expect(html).toContain('height="1350"');
    expect(html).toContain('alt="Gelbe Häuser"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('decoding="async"');
    expect(html).toContain('class="rounded-tile"');
    expect(html).toContain('background-color:#c08a6e');
    expect(html).toMatch(/background-image:url\(&quot;data:image\/png;base64,[A-Za-z0-9+/=]+&quot;\)/);
  });

  it('lets the basePath prop override the provider and can skip the placeholder', () => {
    const html = renderToStaticMarkup(<Picture image={image} alt="" basePath="/x/" placeholder={false} />);
    expect(html).toContain('src="/x/media/ab/ab12cd34ef56ab78_w640.webp"');
    expect(html).not.toContain('background-color');
  });
});
