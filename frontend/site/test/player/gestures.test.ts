import { describe, expect, it } from 'vitest';
import {
  classifySwipe,
  dragFeedback,
  GESTURE,
  keyAction,
  releaseVelocity,
  rubberBand,
  type SwipeInput,
  scrollsVertically,
  tapZone,
} from '../../src/player/gestures';

describe('tap zones', () => {
  it('LTR: first 30 % goes back, the rest forward', () => {
    expect(tapZone(0, 400, 1)).toBe('back');
    expect(tapZone(119, 400, 1)).toBe('back');
    expect(tapZone(120, 400, 1)).toBe('forward');
    expect(tapZone(399, 400, 1)).toBe('forward');
  });

  it('RTL: mirrored — the right 30 % goes back', () => {
    expect(tapZone(399, 400, -1)).toBe('back');
    expect(tapZone(281, 400, -1)).toBe('back');
    expect(tapZone(279, 400, -1)).toBe('forward');
    expect(tapZone(0, 400, -1)).toBe('forward');
  });

  it('is robust against odd input', () => {
    expect(tapZone(-50, 400, 1)).toBe('back');
    expect(tapZone(900, 400, 1)).toBe('forward');
    expect(tapZone(10, 0, 1)).toBe('forward');
  });
});

describe('swipes', () => {
  const base: SwipeInput = { dx: 0, dy: 0, dt: 300, fwd: 1, hasNextDay: true };

  it('ignores short, slow moves', () => {
    expect(classifySwipe({ ...base, dy: -30, dt: 400 })).toBeNull();
  });

  it('swipe up = next day (only if there is one)', () => {
    expect(classifySwipe({ ...base, dy: -120 })).toBe('nextDay');
    expect(classifySwipe({ ...base, dy: -120, hasNextDay: false })).toBeNull();
  });

  it('swipe down closes, wherever it starts and whether or not there is a previous day', () => {
    expect(classifySwipe({ ...base, dy: 140 })).toBe('close');
    expect(classifySwipe({ ...base, dy: 400, dt: 900 })).toBe('close');
    expect(classifySwipe({ ...base, dy: GESTURE.closeMinPx })).toBe('close');
    // Nothing about the previous day or the start position takes part any more.
    expect(classifySwipe({ ...base, dy: 140, hasNextDay: false })).toBe('close');
  });

  it('a short, slow pull down snaps back instead of closing', () => {
    expect(classifySwipe({ ...base, dy: GESTURE.closeMinPx - 1 })).toBeNull();
    expect(classifySwipe({ ...base, dy: GESTURE.swipeMinPx, dt: 600 })).toBeNull();
    expect(classifySwipe({ ...base, dy: 30, dt: 400 })).toBeNull();
  });

  it('accepts a fast flick, up (next day) and down (close)', () => {
    expect(classifySwipe({ ...base, dy: -30, dt: 40 })).toBe('nextDay');
    expect(classifySwipe({ ...base, dy: 60, dt: 40 })).toBe('close');
    expect(classifySwipe({ ...base, dy: GESTURE.closeFlickMinPx, dt: 40 })).toBe('close');
    // Too little travel is a tap with a wobble, however fast.
    expect(classifySwipe({ ...base, dy: GESTURE.slopPx * 2 - 1, dt: 5 })).toBeNull();
  });

  it('a quick little slip down (a tap that slides) snaps back: closing flicks need more travel', () => {
    expect(GESTURE.closeFlickMinPx).toBeGreaterThan(GESTURE.slopPx * 2);
    expect(classifySwipe({ ...base, dy: 22, dt: 10 })).toBeNull();
    expect(classifySwipe({ ...base, dy: 30, dt: 40 })).toBeNull();
    expect(classifySwipe({ ...base, dy: GESTURE.closeFlickMinPx - 1, dt: 20 })).toBeNull();
  });

  it('a flick is judged by the speed at release, not the average', () => {
    // Pulled slowly, then let go with a quick flick: closes.
    expect(classifySwipe({ ...base, dy: 70, dt: 900, vy: 1.2 })).toBe('close');
    // Fast at first, but the finger stopped before letting go: snaps back.
    expect(classifySwipe({ ...base, dy: 70, dt: 60, vy: 0 })).toBeNull();
    // Moving back up at release is no flick down.
    expect(classifySwipe({ ...base, dy: 70, dt: 60, vy: -1 })).toBeNull();
    // The same for items and days.
    expect(classifySwipe({ ...base, dx: -40, dt: 900, vx: -1 })).toBe('nextItem');
    expect(classifySwipe({ ...base, dx: -40, dt: 40, vx: 0 })).toBeNull();
    expect(classifySwipe({ ...base, dy: -40, dt: 40, vy: 0 })).toBeNull();
    // Long enough drags count without any flick.
    expect(classifySwipe({ ...base, dy: GESTURE.closeMinPx, vy: 0 })).toBe('close');
    expect(classifySwipe({ ...base, dx: GESTURE.swipeMinPx, vx: 0 })).toBe('prevItem');
  });

  it('releaseVelocity: the movement over the last flickWindowMs before the release', () => {
    expect(releaseVelocity([])).toEqual({ vx: 0, vy: 0 });
    expect(releaseVelocity([{ t: 0, x: 0, y: 0 }])).toEqual({ vx: 0, vy: 0 });
    // One quick step: the whole (short) gesture is the window.
    expect(
      releaseVelocity([
        { t: 0, x: 0, y: 0 },
        { t: 10, x: 0, y: 22 },
      ]),
    ).toEqual({ vx: 0, vy: 2.2 });
    // A slow pull, then a flick in the last 40 ms.
    const pull = [
      { t: 0, x: 0, y: 0 },
      { t: 400, x: 0, y: 20 },
      { t: 800, x: 0, y: 40 },
      { t: 820, x: 0, y: 60 },
      { t: 840, x: 0, y: 80 },
    ];
    expect(releaseVelocity(pull).vy).toBeCloseTo(1, 5); // from t = 800, the first within 840 - 80
    // Stopped before letting go.
    const stopped = [
      { t: 0, x: 0, y: 0 },
      { t: 30, x: 0, y: 70 },
      { t: 300, x: 0, y: 70 },
    ];
    expect(releaseVelocity(stopped).vy).toBe(0);
  });

  it('vertical moves that start in scrollable text scroll it: never close, never change the day', () => {
    expect(classifySwipe({ ...base, dy: 300, inScroller: true })).toBeNull();
    expect(classifySwipe({ ...base, dy: 30, dt: 40, inScroller: true })).toBeNull();
    expect(classifySwipe({ ...base, dy: -300, inScroller: true })).toBeNull();
    // Horizontal swipes still move between items there.
    expect(classifySwipe({ ...base, dx: -120, inScroller: true })).toBe('nextItem');
  });

  it('horizontal swipes move between items, mirrored in RTL', () => {
    expect(classifySwipe({ ...base, dx: -120 })).toBe('nextItem');
    expect(classifySwipe({ ...base, dx: 120 })).toBe('prevItem');
    expect(classifySwipe({ ...base, dx: 120, fwd: -1 })).toBe('nextItem');
    expect(classifySwipe({ ...base, dx: -120, fwd: -1 })).toBe('prevItem');
  });

  it('rejects diagonal moves', () => {
    expect(classifySwipe({ ...base, dx: 100, dy: 100 })).toBeNull();
  });

  it('a mostly vertical swipe still counts (axis ratio), a diagonal one does not', () => {
    expect(classifySwipe({ ...base, dx: 40, dy: 140 })).toBe('close');
    expect(classifySwipe({ ...base, dx: -40, dy: -140 })).toBe('nextDay');
    expect(classifySwipe({ ...base, dx: 120, dy: 110 })).toBeNull();
  });

  it('rubber band is linear for small moves and bounded', () => {
    expect(rubberBand(0, 300)).toBe(0);
    expect(rubberBand(10, 300)).toBeCloseTo(9.68, 1);
    expect(rubberBand(10_000, 300)).toBeLessThan(300);
    expect(rubberBand(-10_000, 300)).toBeGreaterThan(-300);
    expect(rubberBand(50, 0)).toBe(0);
  });
});

describe('drag feedback', () => {
  const h = 800;

  it('rests at 0', () => {
    expect(dragFeedback(0, h)).toEqual({ y: 0, scale: 1, lift: 0, radius: 0, backdrop: 1, rails: 1 });
    expect(dragFeedback(120, 0)).toEqual({ y: 0, scale: 1, lift: 0, radius: 0, backdrop: 1, rails: 1 });
    expect(dragFeedback(Number.NaN, h).y).toBe(0);
  });

  it('a pull down lifts the stage: it follows the finger, shrinks, rounds and fades the backdrop', () => {
    const quarter = dragFeedback(h * GESTURE.liftFullAt * 0.5, h);
    expect(quarter.y).toBe(h * GESTURE.liftFullAt * 0.5);
    expect(quarter.lift).toBeCloseTo(0.5);
    expect(quarter.scale).toBeCloseTo(1 - GESTURE.liftShrink / 2);
    expect(quarter.radius).toBeCloseTo(GESTURE.liftRadiusPx / 2);
    expect(quarter.backdrop).toBeCloseTo(0.5);
    // The side rails are gone by then: never half-faded on top of the page below.
    expect(quarter.rails).toBe(0);
    expect(dragFeedback(h * GESTURE.liftFullAt * 0.25, h).rails).toBeCloseTo(0.5);
    const full = dragFeedback(h * 2, h);
    expect(full.y).toBe(h * 2); // still under the finger
    expect(full.lift).toBe(1);
    expect(full.scale).toBeCloseTo(1 - GESTURE.liftShrink);
    expect(full.backdrop).toBe(0);
  });

  it('grows monotonically with the pull', () => {
    let last = dragFeedback(1, h);
    for (let dy = 20; dy <= h; dy += 20) {
      const f = dragFeedback(dy, h);
      expect(f.scale).toBeLessThanOrEqual(last.scale);
      expect(f.backdrop).toBeLessThanOrEqual(last.backdrop);
      expect(f.rails).toBeLessThanOrEqual(f.backdrop);
      expect(f.y).toBeGreaterThan(last.y);
      last = f;
    }
  });

  it('a pull up follows with resistance and lifts nothing', () => {
    const up = dragFeedback(-300, h);
    expect(up.y).toBeLessThan(0);
    expect(up.y).toBeGreaterThan(-h * GESTURE.pullUpLimit);
    expect(up).toMatchObject({ scale: 1, lift: 0, radius: 0, backdrop: 1, rails: 1 });
  });
});

describe('scrollable text', () => {
  it('only auto/scroll overflow with more content than room scrolls', () => {
    expect(scrollsVertically({ overflowY: 'auto', scrollHeight: 900, clientHeight: 400 })).toBe(true);
    expect(scrollsVertically({ overflowY: 'scroll', scrollHeight: 900, clientHeight: 400 })).toBe(true);
    expect(scrollsVertically({ overflowY: 'hidden', scrollHeight: 900, clientHeight: 400 })).toBe(false);
    expect(scrollsVertically({ overflowY: 'visible', scrollHeight: 900, clientHeight: 400 })).toBe(false);
    expect(scrollsVertically({ overflowY: 'auto', scrollHeight: 401, clientHeight: 400 })).toBe(false);
  });
});

describe('keys', () => {
  it('maps the documented keys (LTR)', () => {
    expect(keyAction({ key: ' ' }, 1)).toBe('toggle');
    expect(keyAction({ key: 'k' }, 1)).toBe('toggle');
    expect(keyAction({ key: 'K' }, 1)).toBe('toggle');
    expect(keyAction({ key: 'ArrowRight' }, 1)).toBe('forward');
    expect(keyAction({ key: 'ArrowLeft' }, 1)).toBe('back');
    expect(keyAction({ key: 'ArrowDown' }, 1)).toBe('nextDay');
    expect(keyAction({ key: 'ArrowUp' }, 1)).toBe('prevDay');
    expect(keyAction({ key: 'PageUp' }, 1)).toBe('prevDay');
    expect(keyAction({ key: 'PageDown' }, 1)).toBe('nextDay');
    expect(keyAction({ key: 'Escape' }, 1)).toBe('close');
    expect(keyAction({ key: 'm' }, 1)).toBe('mute');
    expect(keyAction({ key: 'x' }, 1)).toBeNull();
  });

  it('mirrors ←/→ in RTL; days and close are the same in both directions', () => {
    expect(keyAction({ key: 'ArrowRight' }, -1)).toBe('back');
    expect(keyAction({ key: 'ArrowLeft' }, -1)).toBe('forward');
    expect(keyAction({ key: 'PageUp' }, -1)).toBe('prevDay');
    expect(keyAction({ key: 'PageDown' }, -1)).toBe('nextDay');
    expect(keyAction({ key: 'Escape' }, -1)).toBe('close');
  });

  it('leaves Space to focused controls and ignores modified keys', () => {
    expect(keyAction({ key: ' ' }, 1, true)).toBeNull();
    expect(keyAction({ key: 'k' }, 1, true)).toBe('toggle');
    expect(keyAction({ key: 'ArrowRight', altKey: true }, 1)).toBeNull();
    expect(keyAction({ key: 'm', metaKey: true }, 1)).toBeNull();
  });

  it('ignores auto-repeat: holding Space/K/M does not flicker, held arrows do not flood', () => {
    for (const key of [' ', 'k', 'm', 'ArrowRight', 'ArrowLeft', 'ArrowDown', 'PageUp', 'Escape']) {
      expect(keyAction({ key, repeat: true }, 1)).toBeNull();
      expect(keyAction({ key, repeat: false }, 1)).not.toBeNull();
    }
  });
});
