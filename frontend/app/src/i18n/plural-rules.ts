/**
 * Intl.PluralRules for Hermes on Android: Hermes ships Intl.DateTimeFormat, NumberFormat and
 * Collator there, but not PluralRules, which Lingui needs for every plural message ("2 drafts").
 * Without it the first plural render throws "undefined cannot be used as a constructor".
 *
 * The app speaks English and German only (the pseudo-locale formats like English), and both share
 * the CLDR cardinal rule "one: i = 1 and v = 0, other: everything else". English ordinals are
 * included for completeness. Installed only when the engine has no PluralRules of its own.
 */

type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

interface Options {
  type?: 'cardinal' | 'ordinal';
}

/** Visible fraction digits of a number as Intl would format it by default ("1.0" has none in JS). */
function hasFraction(n: number): boolean {
  return !Number.isInteger(n);
}

export function cardinalCategory(n: number): PluralCategory {
  return Math.abs(n) === 1 && !hasFraction(n) ? 'one' : 'other';
}

export function englishOrdinalCategory(n: number): PluralCategory {
  if (hasFraction(n)) return 'other';
  const i = Math.abs(n);
  const m10 = i % 10;
  const m100 = i % 100;
  if (m10 === 1 && m100 !== 11) return 'one';
  if (m10 === 2 && m100 !== 12) return 'two';
  if (m10 === 3 && m100 !== 13) return 'few';
  return 'other';
}

function baseLanguage(locales: string | readonly string[] | undefined): string {
  const first = Array.isArray(locales) ? locales[0] : locales;
  return typeof first === 'string' && first.length > 0 ? (first.split(/[-_]/)[0] ?? 'en').toLowerCase() : 'en';
}

export class AppPluralRules {
  private readonly locale: string;
  private readonly type: 'cardinal' | 'ordinal';

  constructor(locales?: string | readonly string[], options: Options = {}) {
    const language = baseLanguage(locales);
    this.locale = language === 'de' ? 'de' : 'en';
    this.type = options.type === 'ordinal' ? 'ordinal' : 'cardinal';
  }

  select(value: number): PluralCategory {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'other';
    if (this.type === 'cardinal') return cardinalCategory(n);
    return this.locale === 'en' ? englishOrdinalCategory(n) : 'other';
  }

  resolvedOptions() {
    return {
      locale: this.locale,
      type: this.type,
      pluralCategories: (this.type === 'ordinal' && this.locale === 'en'
        ? ['few', 'one', 'two', 'other']
        : ['one', 'other']) as PluralCategory[],
      minimumIntegerDigits: 1,
      minimumFractionDigits: 0,
      maximumFractionDigits: 3,
    };
  }

  static supportedLocalesOf(locales: string | readonly string[]): string[] {
    const list = typeof locales === 'string' ? [locales] : [...locales];
    return list.filter((l) => ['en', 'de'].includes(baseLanguage(l)));
  }
}

/** Installs the fallback when the engine lacks Intl.PluralRules (Hermes on Android). */
export function installPluralRules(target: { Intl?: unknown } = globalThis as { Intl?: unknown }): boolean {
  const intl = (target.Intl ?? {}) as Record<string, unknown>;
  if (typeof intl.PluralRules === 'function') return false;
  Object.defineProperty(intl, 'PluralRules', { value: AppPluralRules, configurable: true, writable: true });
  if (!target.Intl) target.Intl = intl;
  return true;
}

installPluralRules();
