import { motionValue } from 'motion/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { dayProgress, MAX_PROGRESS_SEGMENTS, ProgressBars } from '../../src/player/chrome';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `e_${String(i).padStart(12, '0')}`);

describe('progress bars', () => {
  it('computes the share of the day watched', () => {
    expect(dayProgress(0, 4, 0, false)).toBe(0);
    expect(dayProgress(1, 4, 0.5, false)).toBeCloseTo(0.375);
    expect(dayProgress(3, 4, 1, false)).toBe(1);
    expect(dayProgress(2, 4, 0.3, true)).toBe(1);
    expect(dayProgress(0, 0, 0.5, false)).toBe(0);
    expect(dayProgress(1, 4, Number.NaN, false)).toBe(0.25);
    expect(dayProgress(1, 4, 7, false)).toBe(0.5);
  });

  it('draws one segment per moment up to the limit', () => {
    const html = renderToStaticMarkup(
      <ProgressBars ids={ids(MAX_PROGRESS_SEGMENTS)} index={2} ended={false} progress={motionValue(0)} />,
    );
    expect(html).toContain('data-mode="segments"');
    expect(html.match(/h-\[3px\]/g)).toHaveLength(MAX_PROGRESS_SEGMENTS);
  });

  it('switches to one continuous bar for days with many moments (no overflow off-screen)', () => {
    const html = renderToStaticMarkup(
      <ProgressBars ids={ids(74)} index={37} ended={false} progress={motionValue(0)} />,
    );
    expect(html).toContain('data-mode="continuous"');
    expect(html.match(/h-\[3px\]/g)).toHaveLength(1);
    expect(html).toContain(`scaleX(${37 / 74})`);
  });
});
