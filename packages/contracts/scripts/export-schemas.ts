/**
 * Writes JSON Schema (draft 2020-12) files for every API body to api/schemas/<Name>.json.
 *
 *   pnpm --filter @omw/contracts schemas          # write
 *   pnpm --filter @omw/contracts schemas:check    # exit 1 if the files drifted
 *
 * Each file carries `$id: https://omw.invalid/schemas/<Name>.json`, so opis/json-schema can map
 * the prefix to the directory (`$resolver->registerPrefix('https://omw.invalid/schemas/', dir)`).
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAllJsonSchemas, SCHEMA_ID_PREFIX } from '../src/json-schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../../../api/schemas');
const check = process.argv.includes('--check');

/** Only files written by this script are ever reported obsolete or deleted. */
function isGenerated(file: string): boolean {
  try {
    return readFileSync(join(outDir, file), 'utf8').includes(`"$id": "${SCHEMA_ID_PREFIX}`);
  } catch {
    return false;
  }
}

const files = new Map<string, string>();
const schemas = buildAllJsonSchemas();
for (const [name, schema] of Object.entries(schemas)) {
  files.set(`${name}.json`, `${JSON.stringify(schema, null, 2)}\n`);
}
files.set(
  'index.json',
  `${JSON.stringify(
    {
      contractVersion: 1,
      idPrefix: SCHEMA_ID_PREFIX,
      generatedBy: 'pnpm --filter @omw/contracts schemas',
      schemas: Object.keys(schemas).sort(),
    },
    null,
    2,
  )}\n`,
);

if (check) {
  const problems: string[] = [];
  let existing: string[] = [];
  try {
    existing = readdirSync(outDir).filter((f) => f.endsWith('.json'));
  } catch {
    problems.push(`${outDir} does not exist`);
  }
  for (const [file, content] of files) {
    let current: string | null = null;
    try {
      current = readFileSync(join(outDir, file), 'utf8');
    } catch {
      current = null;
    }
    if (current !== content) problems.push(`${file} is ${current === null ? 'missing' : 'outdated'}`);
  }
  for (const file of existing) if (!files.has(file) && isGenerated(file)) problems.push(`${file} is obsolete`);
  if (problems.length > 0) {
    console.error(`JSON Schema export drifted (run \`pnpm schemas\`):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`api/schemas is up to date (${files.size} files).`);
} else {
  mkdirSync(outDir, { recursive: true });
  for (const file of readdirSync(outDir)) {
    if (file.endsWith('.json') && !files.has(file) && isGenerated(file)) rmSync(join(outDir, file));
  }
  for (const [file, content] of files) writeFileSync(join(outDir, file), content);
  console.log(`Wrote ${files.size} files to ${outDir}`);
}
