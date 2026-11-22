/**
 * Playwright config of the gate pages' e2e (spec-wave5 §8.5): the production gate bundle, built
 * into .cache/gate-e2e/dist (./dist is never touched), served by request routing inside the
 * tests (e2e/gate-mock.ts: mock site host with the gate rules, mock public API). No server, no
 * port, no network.
 *
 *   pnpm exec playwright test -c frontend/site/playwright.gate.config.ts      (from the repo root)
 *
 * Needs the Chromium headless shell in .cache/ms-playwright.
 */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const siteDir = import.meta.dirname;
const repoRoot = resolve(siteDir, '../..');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(repoRoot, '.cache/ms-playwright');
const dist = resolve(repoRoot, '.cache/gate-e2e/dist');
process.env.OMW_GATE_E2E_DIST = dist;

// Build once per run (the config is evaluated by the runner and by every worker).
if (!process.env.OMW_GATE_E2E_BUILT) {
  execFileSync(
    'pnpm',
    ['exec', 'vite', 'build', '-c', 'vite.gate.config.ts', '--outDir', dist, '--emptyOutDir', '--logLevel', 'warn'],
    {
      cwd: siteDir,
      stdio: 'inherit',
    },
  );
  process.env.OMW_GATE_E2E_BUILT = '1';
}

export default defineConfig({
  testDir: './e2e',
  testMatch: /gate\.spec\.ts$/,
  outputDir: resolve(repoRoot, '.cache/gate-e2e/results'),
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    acceptDownloads: true,
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
  ],
});
