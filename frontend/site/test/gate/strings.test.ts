/**
 * Gate texts: complete in de and en with the same placeholders, du-form German, nothing that
 * says someone is away (spec-wave5 §5.5 word list: the bundle is public), pseudo-locale for RTL.
 */
import { describe, expect, it } from 'vitest';
import { formatDate } from '../../src/gate/dom';
import { de, en, fmt, pseudo, STRINGS } from '../../src/gate/strings';
import { AWAY_WORDS } from './words';

const placeholders = (s: string) => [...s.matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]).sort();

describe('gate strings', () => {
  it('have the same keys and placeholders in de and en', () => {
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(de[key]), key).toEqual(placeholders(en[key]));
      expect(de[key].trim(), key).not.toBe('');
    }
  });

  it('never say that someone travels or is away', () => {
    for (const table of [de, en]) {
      for (const [key, value] of Object.entries(table)) expect(AWAY_WORDS.test(value), `${key}: ${value}`).toBe(false);
    }
  });

  it('use du-form German (no formal "Sie/Ihr")', () => {
    for (const [key, value] of Object.entries(de)) {
      expect(/\b(?:Sie|Ihre?[nmrs]?|Ihnen)\b/.test(value), `${key}: ${value}`).toBe(false);
    }
  });

  it('carry the spec texts the flows depend on', () => {
    expect(de.invalidLink).toBe('Dieser Link ist nicht (mehr) gültig. Frag die Person, die ihn dir geschickt hat.');
    expect(de.mustWait).toBe('Dieses Gerät muss noch bestätigt werden, bevor du die Seite sehen kannst.');
    expect(de.deleteWarning).toBe(
      'Das kann nicht rückgängig gemacht werden. Du verlierst sofort den Zugang auf allen Geräten.',
    );
    expect(de.deleteCheck).toBe('Ich verstehe, dass alles endgültig gelöscht wird');
    expect(de.rightsFixed).toBe('Unter „Deine Daten“ kannst du alles einsehen, exportieren und löschen.');
  });

  it('fill placeholders as plain text and keep unknown ones', () => {
    expect(fmt(de.linkFor, { name: '<b>Oma</b>' })).toBe('Dieser Link ist für <b>Oma</b>.');
    expect(fmt('{a} {b}', { a: 1 })).toBe('1 {b}');
  });

  it('pseudo-localize for the RTL dev locale (placeholders kept)', () => {
    expect(pseudo('Hi {name}')).toBe('‫Hí {name}‬');
    expect(STRINGS.ar.linkFor).toContain('{name}');
    expect(STRINGS.ar.linkFor.startsWith('‫')).toBe(true);
  });
});

describe('formatDate', () => {
  it('never breaks a date across lines; with the time it tells two confirmations of one day apart', () => {
    const iso = '2026-11-21T18:23:00.000Z';
    const date = formatDate(iso, 'de');
    expect(date).not.toMatch(/ /);
    expect(date.replace(/\u00a0/g, ' ')).toMatch(/^\d{1,2}\. November 2026$/);
    expect(formatDate(iso, 'en', true)).not.toMatch(/ /);
    expect(formatDate(iso, 'de', true)).not.toBe(formatDate('2026-11-21T19:23:00.000Z', 'de', true));
    expect(formatDate('nonsense', 'de')).toBe('');
  });
});
