/**
 * Playwright config of the journey-player e2e tests (B6). Runs against a production build of
 * the site served by e2e/player-server.ts (generator-like pages with Boot JSON, dev data set),
 * so the lazy player chunk, the story chunk and the real routing are exercised.
 *
 *   pnpm exec playwright test -c frontend/site/playwright.player.config.ts      (from the repo root)
 *
 * Needs the dev data set (pnpm --filter @omw/site dev-data) and the Chromium headless shell in
 * .cache/ms-playwright. Port 51741 (override with OMW_PLAYER_E2E_PORT).
 */
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const siteDir = import.meta.dirname;
const repoRoot = resolve(siteDir, '../..');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(repoRoot, '.cache/ms-playwright');

const port = Number(process.env.OMW_PLAYER_E2E_PORT ?? 51741);
const dist = resolve(repoRoot, '.cache/player-e2e/dist');

export default defineConfig({
  testDir: './e2e',
  testMatch: /player.*\.spec\.ts$/,
  outputDir: resolve(repoRoot, '.cache/player-e2e/results'),
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], browserName: 'chromium', hasTouch: false } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: `pnpm exec vite build --outDir ${dist} --emptyOutDir --logLevel warn && node --conditions=@omw/source --import tsx e2e/player-server.ts`,
    cwd: siteDir,
    url: `http://127.0.0.1:${port}/de/`,
    // The server serves a build made for this run: never reuse a stray one (OMW_E2E_REUSE_SERVER=1
    // opts in, e.g. for a server you started yourself on OMW_PLAYER_E2E_PORT).
    reuseExistingServer: process.env.OMW_E2E_REUSE_SERVER === '1',
    timeout: 120_000,
    env: {
      OMW_PLAYER_E2E_PORT: String(port),
      OMW_PLAYER_E2E_DIST: dist,
      TSX_DISABLE_CACHE: '1',
    },
  },
});
