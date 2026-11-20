import { describe, expect, it } from 'vitest';
import { canTakeFocus, restoreTarget } from '../../src/player/restore-focus';

/** Minimal stand-ins for DOM elements (the site's Vitest runs in Node). */
const body = { tag: 'body' } as unknown as Element;
const doc = { body };
Object.assign(body, { ownerDocument: doc, isConnected: true, focus() {}, closest: () => null });

function el(opts: { connected?: boolean; inert?: boolean } = {}): HTMLElement {
  return {
    ownerDocument: doc,
    isConnected: opts.connected ?? true,
    focus() {},
    closest: (selector: string) => (selector === '[inert]' && opts.inert ? ({} as Element) : null),
  } as unknown as HTMLElement;
}

describe('restore focus', () => {
  it('only live, non-inert elements other than <body> can take focus', () => {
    expect(canTakeFocus(el())).toBe(true);
    expect(canTakeFocus(el({ connected: false }))).toBe(false);
    expect(canTakeFocus(el({ inert: true }))).toBe(false);
    expect(canTakeFocus(body)).toBe(false);
    expect(canTakeFocus(null)).toBe(false);
  });

  it('restores to the first usable candidate when focus fell back to <body>', () => {
    const opener = el();
    const preferred = el();
    expect(restoreTarget(body, [null, opener])).toBe(opener);
    expect(restoreTarget(body, [preferred, opener])).toBe(preferred);
    // The opener was unmounted (virtualized timeline) or is still inert: use the fallback.
    const fallback = el();
    expect(restoreTarget(body, [undefined, el({ connected: false }), fallback])).toBe(fallback);
    expect(restoreTarget(body, [el({ inert: true }), null])).toBeNull();
    expect(restoreTarget(null, [opener])).toBe(opener);
  });

  it('leaves focus alone when something already holds it', () => {
    expect(restoreTarget(el(), [el()])).toBeNull();
    // …unless that element is gone or inert.
    const opener = el();
    expect(restoreTarget(el({ connected: false }), [opener])).toBe(opener);
    expect(restoreTarget(el({ inert: true }), [opener])).toBe(opener);
  });
});
