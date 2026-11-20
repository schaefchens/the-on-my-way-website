import { describe, expect, it } from 'vitest';
import { classifySwipe, GESTURE, keyAction, rubberBand, type SwipeInput, tapZone } from '../../src/player/gestures';

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
  const base: SwipeInput = { dx: 0, dy: 0, dt: 300, startY: 400, fwd: 1, hasPrevDay: true, hasNextDay: true };

  it('ignores short, slow moves', () => {
    expect(classifySwipe({ ...base, dy: -30, dt: 400 })).toBeNull();
  });

  it('swipe up = next day (only if there is one)', () => {
    expect(classifySwipe({ ...base, dy: -120 })).toBe('nextDay');
    expect(classifySwipe({ ...base, dy: -120, hasNextDay: false })).toBeNull();
  });

  it('swipe down = previous day; closes on the first day or from the top bar', () => {
    expect(classifySwipe({ ...base, dy: 140 })).toBe('prevDay');
    expect(classifySwipe({ ...base, dy: 140, hasPrevDay: false })).toBe('close');
    expect(classifySwipe({ ...base, dy: 140, startY: GESTURE.closeZonePx - 10 })).toBe('close');
  });

  it('accepts a fast flick', () => {
    expect(classifySwipe({ ...base, dy: -30, dt: 40 })).toBe('nextDay');
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

  it('rubber band is linear for small moves and bounded', () => {
    expect(rubberBand(0, 300)).toBe(0);
    expect(rubberBand(10, 300)).toBeCloseTo(9.68, 1);
    expect(rubberBand(10_000, 300)).toBeLessThan(300);
    expect(rubberBand(-10_000, 300)).toBeGreaterThan(-300);
    expect(rubberBand(50, 0)).toBe(0);
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
    expect(keyAction({ key: 'PageUp' }, 1)).toBe('prevDay');
    expect(keyAction({ key: 'Escape' }, 1)).toBe('close');
    expect(keyAction({ key: 'm' }, 1)).toBe('mute');
    expect(keyAction({ key: 'x' }, 1)).toBeNull();
  });

  it('mirrors ←/→ in RTL', () => {
    expect(keyAction({ key: 'ArrowRight' }, -1)).toBe('back');
    expect(keyAction({ key: 'ArrowLeft' }, -1)).toBe('forward');
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
