/**
 * Media helpers of the player: image sizes per mode, warming the next items (plan C: "Preload
 * the next two items (decode()) and the WhatsApp fonts"), and URLs for Media Session artwork.
 */
import type { LocaleCode } from '@omw/contracts/i18n';
import { pickText } from '@omw/contracts/i18n';
import type { Entry, ImageSet } from '@omw/contracts/site';
import { preloadWaFont } from '@omw/ui/fonts';
import { buildSrcSet, pickFallbackSource, resolveSiteUrl } from '@omw/ui/picture';

/**
 * `sizes` for the player's images. The stage is at most ~36rem wide (a 9:16 frame on large
 * screens, the full viewport on phones), so DPR 2–3 phones pick the 1080w/1600w variants.
 * Data saver asks for a ~320 CSS px slot, so the 640w variant is enough.
 */
export function playerImageSizes(dataSaver: boolean): string {
  return dataSaver ? '320px' : '(min-width: 40rem) 36rem, 100vw';
}

/** How many upcoming items are warmed (plan C: the next two). */
export const PRELOAD_AHEAD = 2;

const warmed = new Set<string>();

/**
 * Starts downloading and decoding an ImageSet with the same <picture> selection the slide will
 * use, so the browser's cache serves the slide instantly. Resolves when decoded (or failed).
 */
export function preloadImageSet(image: ImageSet, basePath: string, sizes: string): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve();
  const key = `${basePath}|${sizes}|${image.sources.webp[0]?.src ?? ''}`;
  if (warmed.has(key)) return Promise.resolve();
  warmed.add(key);
  const picture = document.createElement('picture');
  for (const [type, sources] of [
    ['image/avif', image.sources.avif],
    ['image/webp', image.sources.webp],
  ] as const) {
    const source = document.createElement('source');
    source.type = type;
    source.sizes = sizes;
    source.srcset = buildSrcSet(sources, basePath);
    picture.append(source);
  }
  const img = document.createElement('img');
  img.decoding = 'async';
  img.sizes = sizes;
  const fallback = pickFallbackSource(image.sources.webp, 1080);
  if (fallback) img.src = resolveSiteUrl(basePath, fallback.src);
  picture.append(img);
  return img.decode().catch(() => {
    warmed.delete(key);
  });
}

/** Loads the faces an item needs (WhatsApp font, handwriting, display) before it shows. */
export function preloadFonts(entry: Entry, locale: LocaleCode): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return Promise.resolve();
  switch (entry.kind) {
    case 'text':
      return preloadWaFont(entry.text.font, entry.text.body);
    case 'note': {
      const text = pickText(entry.note, locale, entry.orig)?.text ?? 'Aa';
      return loadFace('500 1em "Playpen Sans Variable"', text);
    }
    case 'story':
      return loadFace('600 1em "Fraunces Variable"', 'Aa');
    default:
      return Promise.resolve();
  }
}

async function loadFace(font: string, sample: string): Promise<void> {
  try {
    await document.fonts.load(font, sample);
  } catch {
    // Best effort: the fallback stack renders.
  }
}

/**
 * Warms an upcoming entry: images are decoded, fonts loaded. Videos are handled by the video
 * pool (preload="metadata" on the spare element), voice notes stream on demand.
 */
export function warmEntry(entry: Entry, opts: { basePath: string; sizes: string; locale: LocaleCode }): void {
  switch (entry.kind) {
    case 'photo':
      void preloadImageSet(entry.image, opts.basePath, opts.sizes);
      break;
    case 'video':
    case 'gif':
      void preloadImageSet(entry.video.poster, opts.basePath, opts.sizes);
      break;
    default:
      void preloadFonts(entry, opts.locale);
  }
}

/** Absolute artwork URLs for the Media Session (WebP, the most widely supported variant). */
export function artworkFor(image: ImageSet | null, basePath: string): { src: string; sizes: string; type: string }[] {
  if (!image || typeof location === 'undefined') return [];
  return image.sources.webp.map((s) => {
    const h = Math.round((s.w * image.h) / image.w);
    return {
      src: new URL(resolveSiteUrl(basePath, s.src), location.href).href,
      sizes: `${s.w}x${h}`,
      type: 'image/webp',
    };
  });
}

/** "1:05" for seconds. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
