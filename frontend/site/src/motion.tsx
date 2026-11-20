/**
 * Lazy boundary for Motion (keeps Motion's core out of the initial bundle, plan C budget).
 * Everything rendered inside <MotionBoundary> may use `m.*` components; the provider chunk is
 * preloaded on idle and by the overlay routes' loaders, so it is normally ready before use.
 */
import { lazy, type ReactNode, Suspense } from 'react';

let promise: Promise<typeof import('./motion-providers')> | null = null;
let features: Promise<unknown> | null = null;

/**
 * Starts loading Motion (idempotent): the providers chunk AND the animation features that
 * <LazyMotion> loads on top. Overlays animate in from opacity 0, so without the features they
 * would stay invisible until those arrive (L3-01: a deep-linked day waited ~1.5 s for them on a
 * slow connection). Never rejects: a failed load retries next time.
 */
export function preloadMotion(): Promise<void> {
  promise ??= import('./motion-providers').catch((err: unknown) => {
    promise = null;
    throw err;
  });
  features ??= import('./motion-features').catch((err: unknown) => {
    features = null;
    throw err;
  });
  return Promise.all([promise, features]).then(
    () => undefined,
    () => undefined,
  );
}

const Providers = lazy(() => {
  promise ??= import('./motion-providers');
  return promise;
});

export function MotionBoundary({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <Providers>{children}</Providers>
    </Suspense>
  );
}
