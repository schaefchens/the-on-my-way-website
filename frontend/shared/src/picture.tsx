/**
 * <Picture> renders an ImageSet (static data contract) as
 *
 *   <picture>
 *     <source type="image/avif" srcset="… 320w, … 640w" sizes="…">
 *     <source type="image/webp" srcset="…" sizes="…">
 *     <img src="…webp" width height alt loading decoding style="background: color + thumbhash">
 *   </picture>
 *
 * Paths in ImageSet are relative to the site root (D3); they are resolved against the runtime
 * basePath from <MediaBaseProvider> (or the `basePath` prop). The dominant colour and the
 * ThumbHash placeholder sit behind the image until it has loaded.
 */
import type { ImageSet, ImageSource } from '@omw/contracts/site';
import {
  type CSSProperties,
  createContext,
  type ImgHTMLAttributes,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import { thumbhashToDataUrl } from './thumbhash';

// ---------------------------------------------------------------------------------------------
// URL helpers (pure, tested)

const BASE_PATH_RE = /^\/(?:[A-Za-z0-9._~-]+\/)*$/;

/** Joins the runtime basePath ("/" or "/travel/") and a site-relative path ("media/ab/…"). */
export function resolveSiteUrl(basePath: string, relPath: string): string {
  if (!BASE_PATH_RE.test(basePath)) throw new RangeError(`Invalid basePath: ${basePath}`);
  return basePath + relPath.replace(/^\/+/, '');
}

/** "…/a_w320.avif 320w, …/a_w640.avif 640w" (ascending by width). */
export function buildSrcSet(sources: readonly ImageSource[], basePath: string): string {
  return [...sources]
    .sort((a, b) => a.w - b.w)
    .map((s) => `${resolveSiteUrl(basePath, s.src)} ${s.w}w`)
    .join(', ');
}

/** The source used for <img src>: the smallest one at least `targetWidth` wide, else the largest. */
export function pickFallbackSource(sources: readonly ImageSource[], targetWidth = 640): ImageSource | undefined {
  const sorted = [...sources].sort((a, b) => a.w - b.w);
  return sorted.find((s) => s.w >= targetWidth) ?? sorted.at(-1);
}

// ---------------------------------------------------------------------------------------------
// basePath context

const MediaBaseContext = createContext('/');

export function MediaBaseProvider({ basePath, children }: { basePath: string; children: ReactNode }) {
  return <MediaBaseContext.Provider value={basePath}>{children}</MediaBaseContext.Provider>;
}

export function useMediaBase(): string {
  return useContext(MediaBaseContext);
}

// ---------------------------------------------------------------------------------------------
// Component

export interface PictureProps
  extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'sizes' | 'width' | 'height' | 'alt'> {
  image: ImageSet;
  /** Required: use the description, then the caption; "" for purely decorative images. */
  alt: string;
  /** `sizes` attribute, e.g. "(min-width: 48rem) 50vw, 100vw". Default "100vw". */
  sizes?: string;
  /** Overrides the basePath from <MediaBaseProvider>. */
  basePath?: string;
  /** Class of the <picture> element. */
  pictureClassName?: string;
  /** Show colour + ThumbHash behind the image until it loads. Default true. */
  placeholder?: boolean;
  /** Width the <img src> fallback should have at least (older browsers only). Default 640. */
  fallbackWidth?: number;
}

export function Picture({
  image,
  alt,
  sizes = '100vw',
  basePath,
  pictureClassName,
  placeholder = true,
  fallbackWidth = 640,
  loading = 'lazy',
  decoding = 'async',
  style,
  onLoad,
  ...imgProps
}: PictureProps) {
  const contextBase = useMediaBase();
  const base = basePath ?? contextBase;
  const [loaded, setLoaded] = useState(false);

  const avifSrcSet = useMemo(() => buildSrcSet(image.sources.avif, base), [image.sources.avif, base]);
  const webpSrcSet = useMemo(() => buildSrcSet(image.sources.webp, base), [image.sources.webp, base]);
  const fallback = pickFallbackSource(image.sources.webp, fallbackWidth);
  const thumb = useMemo(
    () => (placeholder ? thumbhashToDataUrl(image.thumbhash) : null),
    [placeholder, image.thumbhash],
  );

  const placeholderStyle: CSSProperties =
    placeholder && !loaded
      ? {
          backgroundColor: image.color,
          ...(thumb
            ? { backgroundImage: `url("${thumb}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
            : {}),
        }
      : {};

  const handleLoad = useCallback<NonNullable<ImgHTMLAttributes<HTMLImageElement>['onLoad']>>(
    (event) => {
      setLoaded(true);
      onLoad?.(event);
    },
    [onLoad],
  );

  return (
    <picture className={pictureClassName}>
      <source type="image/avif" srcSet={avifSrcSet} sizes={sizes} />
      <source type="image/webp" srcSet={webpSrcSet} sizes={sizes} />
      <img
        {...imgProps}
        src={fallback ? resolveSiteUrl(base, fallback.src) : undefined}
        width={image.w}
        height={image.h}
        alt={alt}
        loading={loading}
        decoding={decoding}
        onLoad={handleLoad}
        style={{ ...placeholderStyle, ...style }}
      />
    </picture>
  );
}
