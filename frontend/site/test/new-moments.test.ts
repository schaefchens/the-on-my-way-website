import { describe, expect, it } from 'vitest';
import { manifestNews } from '../src/data/hooks';

const manifest = (version: number, v: string) => ({ version, timeline: { v } });

describe('manifestNews ("new moments" baseline)', () => {
  it('adopts a newer first manifest quietly (older page stamp: not news)', () => {
    // A day page generated in release 3, the site is at release 7.
    expect(manifestNews({ version: 3, settled: false }, manifest(7, 'h7'), 'h3')).toEqual({ adopt: 'h7', fresh: null });
    // Same release: nothing to adopt.
    expect(manifestNews({ version: 7, settled: false }, manifest(7, 'h7'), 'h7')).toEqual({ adopt: null, fresh: null });
    // No boot version (fallback boot): still the baseline.
    expect(manifestNews({ version: null, settled: false }, manifest(7, 'h7'), null)).toEqual({
      adopt: 'h7',
      fresh: null,
    });
  });

  it('reports later, newer manifests as news until the visitor switches', () => {
    const settled = { version: 7, settled: true };
    expect(manifestNews(settled, manifest(7, 'h7'), 'h7')).toEqual({ adopt: null, fresh: null });
    expect(manifestNews(settled, manifest(8, 'h8'), 'h7')).toEqual({ adopt: null, fresh: 'h8' });
    // Accepted: the current timeline is the new one.
    expect(manifestNews(settled, manifest(8, 'h8'), 'h8')).toEqual({ adopt: null, fresh: null });
    // A version bump without a timeline change (e.g. only a day file) is not news either.
    expect(manifestNews(settled, manifest(9, 'h7'), 'h7')).toEqual({ adopt: null, fresh: null });
  });

  it('without a version baseline compares timeline hashes', () => {
    const settled = { version: null, settled: true };
    expect(manifestNews(settled, manifest(2, 'b'), 'a')).toEqual({ adopt: null, fresh: 'b' });
    expect(manifestNews(settled, manifest(2, 'a'), 'a')).toEqual({ adopt: null, fresh: null });
  });
});
