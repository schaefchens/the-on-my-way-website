/**
 * fixtures/vectors/app-*.json: the cross-runtime contract of the app protocol (PHP mirrors it).
 * Expectations are hand-written in scripts/app-vectors-data.ts; this test checks that the TS
 * implementation agrees with them and that the committed files are current.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildAppVectors, UNKNOWN_KEY_NOTE } from '../scripts/app-vectors-data.js';
import {
  type AppEntry,
  AppEntryCreate,
  appCanonicalJson,
  appEntryHash,
  appEntryProblems,
  appPairingCodeFromLink,
  type ChunkOutcome,
  correctAppOccurredAt,
  formatAppTypedPairingCode,
  formatUploadChecksum,
  nextChunkBytes,
  normalizeAppPairingCode,
  parseUploadChecksum,
} from '../src/app.js';
import { buildAppJsonSchemas } from '../src/json-schema.js';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/vectors');
const load = <T>(name: string): T => JSON.parse(readFileSync(resolve(dir, name), 'utf8')) as T;

type EntryCase = {
  name: string;
  body: unknown;
  valid: boolean;
  stage?: 'schema' | 'rules';
  paths?: string[];
  note?: string;
};

describe('app vectors', () => {
  it('committed files match scripts/app-vectors-data.ts', () => {
    for (const [file, content] of Object.entries(buildAppVectors(appCanonicalJson))) {
      expect(readFileSync(resolve(dir, file), 'utf8'), `${file} drifted (pnpm vectors:app)`).toBe(
        `${JSON.stringify(content, null, 2)}\n`,
      );
    }
  });

  it('app-entries.json: accepted and rejected AppEntryCreate bodies', () => {
    const { cases } = load<{ cases: EntryCase[] }>('app-entries.json');
    expect(cases.length).toBeGreaterThan(40);
    const entrySchema = buildAppJsonSchemas().AppEntryCreate as {
      properties: { entry: { additionalProperties?: unknown } };
    };
    for (const c of cases) {
      const parsed = AppEntryCreate.safeParse(c.body);
      if (c.valid) {
        expect(parsed.success, `${c.name}: ${parsed.error?.message}`).toBe(true);
        continue;
      }
      if (c.stage === 'rules') {
        expect(parsed.success, c.name).toBe(false);
        const paths = (parsed.error?.issues ?? []).map((i) => i.path.slice(1).join('.')).sort();
        expect(paths, c.name).toEqual([...(c.paths ?? [])].sort());
        // The field schemas alone accept it: only the cross-field rules reject it.
        const fields = AppEntryCreate.shape.entry.safeParse((c.body as { entry: unknown }).entry);
        expect(fields.success, c.name).toBe(false);
      } else if (c.note === UNKNOWN_KEY_NOTE) {
        expect(parsed.success, c.name).toBe(true);
        expect(entrySchema.properties.entry.additionalProperties, c.name).toBe(false);
      } else {
        expect(parsed.success, c.name).toBe(false);
        const rules = parsed.error?.issues.every((i) => i.code === 'custom' && i.path[1] !== 'tz');
        expect(rules, `${c.name} must fail on a field rule, not a cross-field one`).toBe(false);
      }
    }
  });

  it('app-time.json: correctAppOccurredAt', () => {
    const { cases } = load<{
      cases: { name: string; input: Parameters<typeof correctAppOccurredAt>[0]; expected: unknown }[];
    }>('app-time.json');
    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const c of cases) expect(correctAppOccurredAt(c.input), c.name).toEqual(c.expected);
  });

  it('app-canonical.json: canonical JSON and the entry hash', async () => {
    const { cases } = load<{ cases: { name: string; value: unknown; canonical: string; sha256Hex: string }[] }>(
      'app-canonical.json',
    );
    for (const c of cases) {
      expect(appCanonicalJson(c.value), c.name).toBe(c.canonical);
      if (c.name.startsWith('entry hash:')) {
        expect(await appEntryHash(c.value as AppEntry), c.name).toBe(c.sha256Hex);
      }
    }
  });

  it('app-pairing.json: codes and links', () => {
    const v = load<{
      normalize: { input: string; expected: string | null }[];
      link: { url: string; expected: string | null }[];
      format: { code: string; expected: string }[];
    }>('app-pairing.json');
    for (const c of v.normalize) expect(normalizeAppPairingCode(c.input), JSON.stringify(c.input)).toBe(c.expected);
    for (const c of v.link) expect(appPairingCodeFromLink(c.url), c.url).toBe(c.expected);
    for (const c of v.format) expect(formatAppTypedPairingCode(c.code)).toBe(c.expected);
  });

  it('app-chunks.json: adaptive chunk size and Upload-Checksum', () => {
    const v = load<{
      next: {
        name: string;
        current: number;
        outcome: ChunkOutcome;
        bounds?: { minBytes: number; maxBytes: number };
        expected: number;
      }[];
      checksum: { hex: string; header: string }[];
      badHeaders: string[];
    }>('app-chunks.json');
    for (const c of v.next) expect(nextChunkBytes(c.current, c.outcome, c.bounds), c.name).toBe(c.expected);
    for (const c of v.checksum) {
      expect(formatUploadChecksum(c.hex)).toBe(c.header);
      expect(parseUploadChecksum(c.header)).toBe(c.hex);
    }
    for (const h of v.badHeaders) expect(parseUploadChecksum(h), h).toBeNull();
  });

  it('every rules-stage case is explained by appEntryProblems alone', () => {
    const { cases } = load<{ cases: EntryCase[] }>('app-entries.json');
    for (const c of cases.filter((x) => x.stage === 'rules')) {
      const entry = (c.body as { entry: Parameters<typeof appEntryProblems>[0] }).entry;
      const paths = appEntryProblems(entry)
        .map((p) => p.path.join('.'))
        .sort();
      expect(paths, c.name).toEqual([...(c.paths ?? [])].sort());
    }
  });
});
