import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dayPart } from '../src/ui/greeting';

function entries(locale: string): Map<string, string> {
  const po = readFileSync(new URL(`../src/locales/${locale}/messages.po`, import.meta.url), 'utf8');
  const out = new Map<string, string>();
  for (const m of po.matchAll(/^msgid "(.*)"\nmsgstr "(.*)"$/gm)) if (m[1]) out.set(m[1], m[2] ?? '');
  return out;
}

describe('catalogs', () => {
  it('translates every message into German', () => {
    const en = entries('en');
    const de = entries('de');
    expect(en.size).toBeGreaterThan(20);
    expect([...de.keys()].sort()).toEqual([...en.keys()].sort());
    for (const [id, str] of de) expect(str, id).not.toBe('');
  });

  it('keeps placeholders intact', () => {
    for (const [id, str] of entries('de')) {
      const want = [...id.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
      const got = [...str.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();
      expect(got, id).toEqual(want);
    }
  });

  it('uses du, never Sie', () => {
    for (const [id, str] of entries('de')) expect(str, id).not.toMatch(/\b(Sie|Ihnen|Ihr|Ihre)\b/);
  });

  it('has the pseudo-locale catalog for RTL checks', () => {
    expect(entries('ar').size).toBe(entries('en').size);
  });
});

describe('greeting bands (same as the admin)', () => {
  it.each([
    [0, 'night'],
    [4, 'night'],
    [5, 'morning'],
    [10, 'morning'],
    [11, 'day'],
    [16, 'day'],
    [17, 'evening'],
    [21, 'evening'],
    [22, 'night'],
  ] as const)('%i h -> %s', (hour, part) => {
    expect(dayPart(hour)).toBe(part);
  });
});
