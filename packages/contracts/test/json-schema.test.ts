import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_SCHEMAS, type ApiSchemaName } from '../src/api.js';
import { buildApiJsonSchemas, SCHEMA_ID_PREFIX } from '../src/json-schema.js';

const schemasDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../api/schemas');

describe('JSON Schema export', () => {
  const schemas = buildApiJsonSchemas();

  it('exports every API schema as draft 2020-12 with an $id', () => {
    expect(Object.keys(schemas).sort()).toEqual(Object.keys(API_SCHEMAS).sort());
    for (const [name, schema] of Object.entries(schemas)) {
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema.$id).toBe(`${SCHEMA_ID_PREFIX}${name}.json`);
    }
  });

  it('closes request and response objects (additionalProperties: false)', () => {
    const variants = schemas.PostCreate.oneOf as { additionalProperties?: unknown }[];
    expect(variants).toHaveLength(2);
    for (const v of variants) expect(v.additionalProperties).toBe(false);
    expect(schemas.CaptureMirror.additionalProperties).toBe(false);
    expect(schemas.Settings.additionalProperties).toBe(false);
  });

  it('carries rules PHP must enforce: op/data variants, URL scheme, story titles, unique locales', () => {
    const items = schemas.ChangeItem.oneOf as {
      oneOf: { required: string[]; properties: Record<string, unknown> }[];
    }[];
    expect(items).toHaveLength(5);
    for (const entity of items) {
      const [upsert, del] = entity.oneOf;
      expect(upsert?.required).toContain('data');
      expect(del?.properties).not.toHaveProperty('data');
    }
    const patch = schemas.SettingsPatch.properties as Record<string, { anyOf?: { pattern?: string }[] }>;
    const ntfy = new RegExp(patch['alerts.ntfy_url']?.anyOf?.[0]?.pattern ?? '^$');
    expect(ntfy.test('https://ntfy.sh/omw')).toBe(true);
    expect(ntfy.test('ftp://ntfy.sh/omw')).toBe(false);
    expect(ntfy.test('file:///etc/passwd')).toBe(false);
    expect(JSON.stringify(schemas.Settings)).toContain('"uniqueItems":true');
    expect(JSON.stringify(schemas.PostCreate)).toContain('"minProperties":1');
  });

  it('matches the committed files in api/schemas (run `pnpm schemas` after changing contracts)', () => {
    for (const name of Object.keys(schemas) as ApiSchemaName[]) {
      const committed = readFileSync(resolve(schemasDir, `${name}.json`), 'utf8');
      expect(committed, `${name}.json drifted`).toBe(`${JSON.stringify(schemas[name], null, 2)}\n`);
    }
  });
});
