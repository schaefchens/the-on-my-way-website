import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Builds the synthetic large data set once (it is git-ignored and deterministic). */
export default function globalSetup(): void {
  const site = fileURLToPath(new URL('..', import.meta.url));
  if (existsSync(`${site}/dev-data-large/data/manifest.json`)) return;
  execFileSync('pnpm', ['run', 'dev-data:large'], { cwd: site, stdio: 'inherit' });
}
