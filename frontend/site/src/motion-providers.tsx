/**
 * Motion providers (LazyMotion + MotionConfig with reducedMotion "user"). Only the overlay routes
 * (journey player, story sheet, trip page) use `m.*` components, so these providers wrap the
 * overlay <Outlet /> and live in their own chunk together with Motion's core; the animation
 * features themselves load lazily on top (motion-features.ts). See motion.tsx.
 */
import { MOTION_CONFIG } from '@omw/ui/motion';
import { LazyMotion, MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';

const loadMotionFeatures = () => import('./motion-features').then((m) => m.default);

export default function MotionProviders({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <MotionConfig {...MOTION_CONFIG}>{children}</MotionConfig>
    </LazyMotion>
  );
}
