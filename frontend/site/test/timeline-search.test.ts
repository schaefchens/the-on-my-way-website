import { describe, expect, it } from 'vitest';
import {
  homeSearch,
  isTypingTarget,
  sameHomeSearch,
  stepLevel,
  validateHomeSearch,
  zoomDirection,
  zoomKeyAction,
} from '../src/timeline/search';

describe('home search params (?z=&d=)', () => {
  it('keeps valid values and drops everything else', () => {
    expect(validateHomeSearch({ z: 'months', d: '2026-11-18' })).toEqual({ z: 'months', d: '2026-11-18' });
    expect(validateHomeSearch({ z: 'weeks', d: '2026-02-30' })).toEqual({});
    expect(validateHomeSearch({ z: 3, d: ['2026-11-18'], x: 'y' })).toEqual({});
  });

  it('omits the default level so "/de/" stays canonical', () => {
    expect(homeSearch('days', '2026-11-18')).toEqual({ d: '2026-11-18' });
    expect(homeSearch('trips', null)).toEqual({ z: 'trips' });
    expect(homeSearch('days', undefined)).toEqual({});
  });

  it('compares with the default filled in', () => {
    expect(sameHomeSearch({}, { z: 'days' })).toBe(true);
    expect(sameHomeSearch({ d: '2026-11-18' }, { z: 'days', d: '2026-11-18' })).toBe(true);
    expect(sameHomeSearch({ z: 'months' }, {})).toBe(false);
  });
});

describe('zoom steps', () => {
  it('in = more detail, out = overview, null at the ends', () => {
    expect(stepLevel('trips', 'in')).toBe('months');
    expect(stepLevel('months', 'in')).toBe('days');
    expect(stepLevel('days', 'in')).toBeNull();
    expect(stepLevel('days', 'out')).toBe('months');
    expect(stepLevel('trips', 'out')).toBeNull();
    expect(zoomDirection('trips', 'days')).toBe('in');
    expect(zoomDirection('days', 'trips')).toBe('out');
    expect(zoomDirection('months', 'months')).toBeNull();
  });

  it('maps keys +/- and 1-3, leaving modified keys to the browser', () => {
    expect(zoomKeyAction({ key: '+' })).toEqual({ type: 'step', direction: 'in' });
    expect(zoomKeyAction({ key: '=' })).toEqual({ type: 'step', direction: 'in' });
    expect(zoomKeyAction({ key: '-' })).toEqual({ type: 'step', direction: 'out' });
    expect(zoomKeyAction({ key: '1' })).toEqual({ type: 'set', level: 'trips' });
    expect(zoomKeyAction({ key: '3' })).toEqual({ type: 'set', level: 'days' });
    expect(zoomKeyAction({ key: '+', ctrlKey: true })).toBeNull();
    expect(zoomKeyAction({ key: '-', metaKey: true })).toBeNull();
    expect(zoomKeyAction({ key: 'a' })).toBeNull();
  });

  it('ignores keys typed into text fields', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isTypingTarget({ tagName: 'input', type: 'search' })).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
