import { ZOOM_GESTURE } from '@omw/ui/motion';
import { describe, expect, it } from 'vitest';
import {
  commitDirection,
  distance,
  midpoint,
  originWithin,
  pinchScale,
  previewScale,
  wheelScaleFactor,
} from '../src/timeline/pinch-math';

describe('pinch math', () => {
  it('previews 1:1 inside the range and never leaves [0.85, 1.2]', () => {
    expect(previewScale(1)).toBe(1);
    expect(previewScale(1.1)).toBe(1.1);
    expect(previewScale(0.9)).toBe(0.9);
    for (const s of [0.1, 0.5, 0.84, 1.21, 2, 10]) {
      const p = previewScale(s);
      expect(p).toBeGreaterThanOrEqual(ZOOM_GESTURE.minScale);
      expect(p).toBeLessThanOrEqual(ZOOM_GESTURE.maxScale);
    }
    expect(previewScale(Number.NaN)).toBe(1);
    expect(previewScale(-1)).toBe(1);
  });

  it('rubber-bands monotonically past the limits', () => {
    expect(previewScale(1.3)).toBeLessThanOrEqual(previewScale(1.6));
    expect(previewScale(0.7)).toBeGreaterThanOrEqual(previewScale(0.5));
  });

  it('commits one level at |ln s| > 0.18 (raw scale, not the clamped preview)', () => {
    expect(commitDirection(1.19)).toBeNull();
    expect(commitDirection(Math.exp(0.181))).toBe('in');
    expect(commitDirection(0.85)).toBeNull(); // |ln 0.85| = 0.1625
    expect(commitDirection(Math.exp(-0.181))).toBe('out');
    expect(commitDirection(0)).toBeNull();
  });

  it('measures two-finger gestures', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(midpoint({ x: 0, y: 10 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 15 });
    expect(pinchScale(100, 130)).toBeCloseTo(1.3);
    expect(pinchScale(0, 130)).toBe(1);
  });

  it('turns ctrl+wheel into a scale: negative delta zooms in, one mouse notch commits', () => {
    expect(wheelScaleFactor(-10)).toBeGreaterThan(1);
    expect(wheelScaleFactor(10)).toBeLessThan(1);
    expect(commitDirection(wheelScaleFactor(-100))).toBe('in');
    expect(commitDirection(wheelScaleFactor(100))).toBe('out');
    // Small trackpad deltas accumulate before committing.
    expect(commitDirection(wheelScaleFactor(-4))).toBeNull();
    expect(wheelScaleFactor(-3, 1)).toBeCloseTo(wheelScaleFactor(-48, 0));
    expect(wheelScaleFactor(-1000)).toBeCloseTo(wheelScaleFactor(-50));
  });

  it('expresses a viewport point as a transform-origin of a box', () => {
    expect(originWithin({ x: 120.4, y: 300.6 }, { left: 20, top: -1000 })).toBe('100px 1301px');
  });
});
