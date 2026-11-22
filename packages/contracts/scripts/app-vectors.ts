/**
 * Writes (or with --check, verifies) fixtures/vectors/app-*.json from scripts/app-vectors-data.ts.
 *
 *   pnpm --filter @omw/contracts vectors:app
 *   pnpm --filter @omw/contracts vectors:app:check
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appCanonicalJson } from '../src/app.js';
import { buildAppVectors } from './app-vectors-data.js';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/vectors');
const check = process.argv.includes('--check');
const problems: string[] = [];

for (const [file, content] of Object.entries(buildAppVectors(appCanonicalJson))) {
  const text = `${JSON.stringify(content, null, 2)}\n`;
  const path = resolve(dir, file);
  if (check) {
    let current: string | null = null;
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      current = null;
    }
    if (current !== text) problems.push(`${file} is ${current === null ? 'missing' : 'outdated'}`);
  } else {
    writeFileSync(path, text);
    console.log(`wrote fixtures/vectors/${file}`);
  }
}
if (problems.length > 0) {
  console.error(`App vectors drifted (run \`pnpm --filter @omw/contracts vectors:app\`):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
if (check) console.log('fixtures/vectors/app-*.json are up to date.');
