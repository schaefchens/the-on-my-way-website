/**
 * Cross-language D9 check: backend/wa-helper/testdata/golden/ is written by the Go helper's own
 * code (`go test -run TestGolden -update` in backend/wa-helper) and must parse with the zod
 * contracts. If this fails, the helper and wa.ts disagree.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InboxMeta, parseWaEventLine, RevokeRecord } from '../src/wa.js';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../backend/wa-helper/testdata/golden');
const read = (name: string) => readFileSync(join(dir, name), 'utf8');

describe('Go helper golden files (D9)', () => {
  const metas = readdirSync(dir).filter((f) => f.startsWith('meta-') && f.endsWith('.json'));

  it('covers every capture kind', () => {
    const kinds = new Set(metas.map((f) => InboxMeta.parse(JSON.parse(read(f))).kind));
    expect([...kinds].sort()).toEqual(['gif', 'photo', 'text', 'unsupported', 'video', 'voice']);
  });

  it.each(metas)('%s is a valid InboxMeta', (file) => {
    const result = InboxMeta.safeParse(JSON.parse(read(file)));
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues)).toBe(true);
  });

  it('revoke.json is a valid RevokeRecord', () => {
    expect(RevokeRecord.safeParse(JSON.parse(read('revoke.json'))).success).toBe(true);
  });

  it('every stdout line is a valid WaEvent', () => {
    const lines = read('events.jsonl').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      const parsed = parseWaEventLine(line);
      expect(parsed.ok, parsed.ok ? line : `${line}\n${parsed.error}`).toBe(true);
    }
  });
});
