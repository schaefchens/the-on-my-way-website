/**
 * JSON Schema (draft 2020-12) export of the API bodies, used by scripts/export-schemas.ts and
 * by the drift test. Not re-exported from the package root (it is a build-time concern).
 */
import { z } from 'zod';
import { API_SCHEMAS, type ApiSchemaName } from './api.js';
import { APP_SCHEMAS, type AppSchemaName } from './app.js';
import { APP_INBOX_SCHEMAS, type AppInboxSchemaName } from './app-inbox.js';

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
  return toJsonSchema(name, schema, io);
}

function toJsonSchema(name: string, schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
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

/** The traveler app's schemas (./app APP_SCHEMAS + ./app-inbox APP_INBOX_SCHEMAS), written next to the API's. */
export function buildAppJsonSchemas(): Record<AppSchemaName | AppInboxSchemaName, JsonSchema> {
  const registry: Record<string, readonly [z.ZodType, 'input' | 'output']> = { ...APP_SCHEMAS, ...APP_INBOX_SCHEMAS };
  const out = {} as Record<AppSchemaName | AppInboxSchemaName, JsonSchema>;
  for (const name of Object.keys(registry).sort() as (AppSchemaName | AppInboxSchemaName)[]) {
    const [schema, io] = registry[name] as readonly [z.ZodType, 'input' | 'output'];
    out[name] = toJsonSchema(name, schema, io);
  }
  return out;
}

/** Everything `pnpm schemas` writes to api/schemas (API + app; names must not collide). */
export function buildAllJsonSchemas(): Record<string, JsonSchema> {
  const api: Record<string, JsonSchema> = buildApiJsonSchemas();
  const app: Record<string, JsonSchema> = buildAppJsonSchemas();
  for (const name of Object.keys(app)) {
    if (name in api) throw new Error(`Schema name ${name} is used by both API_SCHEMAS and APP_SCHEMAS`);
  }
  return { ...api, ...app };
}

export function buildApiJsonSchemas(): Record<ApiSchemaName, JsonSchema> {
  const out = {} as Record<ApiSchemaName, JsonSchema>;
  for (const name of Object.keys(API_SCHEMAS).sort() as ApiSchemaName[]) {
    out[name] = apiJsonSchema(name);
  }
  return out;
}
