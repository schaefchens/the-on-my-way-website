/**
 * JSON Schema (draft 2020-12) export of the API bodies, used by scripts/export-schemas.ts and
 * by the drift test. Not re-exported from the package root (it is a build-time concern).
 */
import { z } from 'zod';
import { API_SCHEMAS, type ApiSchemaName } from './api.js';

export const SCHEMA_ID_PREFIX = 'https://omw.invalid/schemas/';

export type JsonSchema = Record<string, unknown>;

/** Recursively sorts object keys so the output is stable across zod versions/runs. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, sortKeys(v)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export function apiJsonSchema(name: ApiSchemaName): JsonSchema {
  const [schema, io] = API_SCHEMAS[name];
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'throw',
    reused: 'inline',
    cycles: 'throw',
    // zod only closes objects in "output" mode; close request bodies too, so PHP rejects
    // unknown (e.g. misspelled) fields. TS parsing stays lenient (unknown keys are stripped).
    override: (ctx) => {
      const def = ctx.zodSchema._zod.def as { type: string; catchall?: unknown };
      if (def.type === 'object' && !def.catchall && ctx.jsonSchema.additionalProperties === undefined) {
        ctx.jsonSchema.additionalProperties = false;
      }
    },
  }) as JsonSchema;
  const { $schema, ...rest } = json;
  return {
    $schema,
    $id: `${SCHEMA_ID_PREFIX}${name}.json`,
    title: name,
    ...(sortKeys(rest) as JsonSchema),
  };
}

export function buildApiJsonSchemas(): Record<ApiSchemaName, JsonSchema> {
  const out = {} as Record<ApiSchemaName, JsonSchema>;
  for (const name of Object.keys(API_SCHEMAS).sort() as ApiSchemaName[]) {
    out[name] = apiJsonSchema(name);
  }
  return out;
}
