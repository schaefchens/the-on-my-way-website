/**
 * The gate bundle's copies of contract values (src/gate/access-lite.ts) must equal the contracts:
 * same regexes and constants, same parseLinkFragment answers on the shared vectors, a table of
 * edge cases and generated fragments.
 */
import { readFileSync } from 'node:fs';
import * as contracts from '@omw/contracts/access';
import { describe, expect, it } from 'vitest';
import * as lite from '../../src/gate/access-lite';

const vectors = JSON.parse(
  readFileSync(new URL('../../../../fixtures/vectors/access-paths.json', import.meta.url), 'utf8'),
) as {
  tokens: { accept: string[]; reject: string[] };
  gateSessions: { accept: string[]; reject: string[] };
  fragments: { hash: string; parsed: Record<string, unknown> }[];
};

describe('access-lite equals @omw/contracts/access', () => {
  it('has the same regexes and constants', () => {
    expect(lite.ACCESS_TOKEN_RE.source).toBe(contracts.ACCESS_TOKEN_RE.source);
    expect(lite.GATE_SESSION_RE.source).toBe(contracts.GATE_SESSION_RE.source);
    expect(lite.PUBLIC_API_BASE_RE.source).toBe(contracts.PUBLIC_API_BASE_RE.source);
    expect(lite.GATE_BOOT_ELEMENT_ID).toBe(contracts.GATE_BOOT_ELEMENT_ID);
    expect(lite.HANDOFF_PATH).toBe(contracts.HANDOFF_PATH);
    expect(lite.DELETE_ME_CONFIRMATION).toBe(contracts.DELETE_ME_CONFIRMATION);
    expect(lite.GATE_COOKIE_MAX_AGE.keyJs).toBe(contracts.GATE_COOKIE_MAX_AGE.keyJs);
    expect(lite.GATE_COOKIE_MAX_AGE.transfer).toBe(contracts.GATE_COOKIE_MAX_AGE.transfer);
  });

  it('accepts and rejects the shared token and session vectors', () => {
    for (const t of vectors.tokens.accept) expect(lite.ACCESS_TOKEN_RE.test(t), t).toBe(true);
    for (const t of vectors.tokens.reject) expect(lite.ACCESS_TOKEN_RE.test(t), t).toBe(false);
    for (const s of vectors.gateSessions.accept) expect(lite.GATE_SESSION_RE.test(s), s).toBe(true);
    for (const s of vectors.gateSessions.reject) expect(lite.GATE_SESSION_RE.test(s), s).toBe(false);
  });

  it('parses every vector fragment like the contracts', () => {
    expect(vectors.fragments.length).toBeGreaterThan(5);
    for (const { hash, parsed } of vectors.fragments) {
      expect(lite.parseLinkFragment(hash), hash).toEqual(contracts.parseLinkFragment(hash));
      expect(lite.parseLinkFragment(hash), hash).toEqual(parsed);
    }
  });

  it('parses edge cases and generated fragments like the contracts', () => {
    const t = 'tTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtTtT-_0';
    const parts = [
      `t=${t}`,
      `k=${t}`,
      `t=${t.slice(1)}`,
      'resume',
      'reconfirm',
      'view',
      'handoff-failed',
      'bogus',
      'return=%2Fabc%2Fde%2F',
      'return=%2F%2Fevil.example',
      'return=https%3A%2F%2Fevil',
      'return=%2Fa%5Cb',
      'return=%E0%A4%A',
      'return=/x/',
      '',
      '=',
      't=',
    ];
    const cases: string[] = ['', '#', '#&', '##resume'];
    for (const a of parts) for (const b of parts) cases.push(`#${a}&${b}`, `${a}&${b}`);
    for (const hash of cases) expect(lite.parseLinkFragment(hash), hash).toEqual(contracts.parseLinkFragment(hash));
  });
});
