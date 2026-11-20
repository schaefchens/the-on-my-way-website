/**
 * Playwright config of the integration e2e against REAL generator output (backend capture ->
 * pipeline -> generator -> publisher), served by the generator's own static server
 * (backend/src/generator/serve.ts), i.e. what a plain static host serves.
 *
 *   OMW_GENERATED_DIR=$PWD/.cache/e2e/site PLAYWRIGHT_BROWSERS_PATH=$PWD/.cache/ms-playwright \
 *     pnpm exec playwright test -c frontend/site/playwright.generated.config.ts       (repo root)
 *
 * - OMW_GENERATED_DIR: the published folder to serve (a local publish target or OUT_DIR). When
 *   unset, a server must already listen on OMW_GENERATED_URL.
 * - OMW_GENERATED_URL: default http://127.0.0.1:4173 (D12 static preview port).
 * The site must contain owner content (a trip and a story) and the pseudo-locale "ar"
 * (`backend owner-import fixtures/generated/owner.json --locales=de,en,ar`); see
 * backend/README.md "Local end-to-end run (fixtures, no phone, no API)".
 */
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const siteDir = import.meta.dirname;
const repoRoot = resolve(siteDir, '../..');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(repoRoot, '.cache/ms-playwright');

const baseURL = (process.env.OMW_GENERATED_URL ?? 'http://127.0.0.1:4173').replace(/\/+$/, '');
const dir = process.env.OMW_GENERATED_DIR;
const port = new URL(baseURL).port || '80';

export default defineConfig({
  testDir: './e2e',
  testMatch: /generated\.spec\.ts$/,
  outputDir: resolve(repoRoot, '.cache/playwright/generated-results'),
  fullyParallel: true,
  workers: 3,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], browserName: 'chromium' } },
  ],
  ...(dir
    ? {
        webServer: {
          command: `node --conditions=@omw/source --import tsx backend/src/generator/cli.ts serve --dir "${resolve(dir)}" --port ${port} --host 127.0.0.1`,
          cwd: repoRoot,
          env: { TSX_DISABLE_CACHE: '1' },
          url: `${baseURL}/data/manifest.json`,
          reuseExistingServer: true,
          timeout: 30_000,
        },
      }
    : {}),
});
