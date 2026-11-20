/**
 * Motion for the admin: LazyMotion with the full feature set (drag for swipe actions, layout
 * for the moving pills) loaded in its own chunk, and reducedMotion "user" everywhere (@omw/ui).
 * `m.*` components render immediately and animate once the features arrived.
 */
import { MOTION_CONFIG } from '@omw/ui/motion';
import { LazyMotion, MotionConfig } from 'motion/react';
import type { ReactNode } from 'react';

const loadFeatures = () => import('./motion-features').then((mod) => mod.default);

export function MotionRoot({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={loadFeatures} strict>
      <MotionConfig {...MOTION_CONFIG}>{children}</MotionConfig>
    </LazyMotion>
  );
}
