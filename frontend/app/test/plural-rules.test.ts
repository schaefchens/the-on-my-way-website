import { describe, expect, it } from 'vitest';
import { AppPluralRules, cardinalCategory, englishOrdinalCategory, installPluralRules } from '../src/i18n/plural-rules';

describe('Intl.PluralRules fallback (Hermes on Android has none)', () => {
  it('uses the shared en/de cardinal rule: only an integer 1 is "one"', () => {
    expect([0, 1, 2, 5, 21, 1.5, -1].map(cardinalCategory)).toEqual([
      'other',
      'one',
      'other',
      'other',
      'other',
      'other',
      'one',
    ]);
  });

  it('agrees with the engine’s own rules for English and German', () => {
    for (const locale of ['en', 'de']) {
      const engine = new Intl.PluralRules(locale);
      const ours = new AppPluralRules(locale);
      for (const n of [0, 1, 2, 3, 11, 21, 100, 0.5, 1.25])
        expect(ours.select(n), `${locale} ${n}`).toBe(engine.select(n));
    }
    const engineOrd = new Intl.PluralRules('en', { type: 'ordinal' });
    for (const n of [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111]) {
      expect(englishOrdinalCategory(n), `ordinal ${n}`).toBe(engineOrd.select(n));
    }
  });

  it('treats the pseudo-locale and regional tags like their language', () => {
    expect(new AppPluralRules('ar').resolvedOptions().locale).toBe('en');
    expect(new AppPluralRules(['de-AT']).resolvedOptions().locale).toBe('de');
    expect(new AppPluralRules('de', { type: 'ordinal' }).select(1)).toBe('other');
  });

  it('installs itself only when the engine has no PluralRules', () => {
    const withRules = { Intl: { PluralRules: Intl.PluralRules } };
    expect(installPluralRules(withRules)).toBe(false);
    expect(withRules.Intl.PluralRules).toBe(Intl.PluralRules);
    const hermes: { Intl?: unknown } = { Intl: {} };
    expect(installPluralRules(hermes)).toBe(true);
    const Rules = (hermes.Intl as { PluralRules: typeof AppPluralRules }).PluralRules;
    expect(new Rules('de').select(2)).toBe('other');
  });
});
