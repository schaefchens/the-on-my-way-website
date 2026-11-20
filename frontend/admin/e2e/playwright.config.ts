/**
 * E2E tests of the admin PWA against the typed mock API (e2e/mock), never the real PHP API.
 * The webServer builds the production admin into .cache/admin-e2e/dist (api/public/admin is not
 * touched) and serves it with the mock on one origin, like the PHP host: /admin/ + /api/v1.
 * Port 51751 (B8 range 51750-51759). Specs share the mock's state, so they run serially and
 * reset it first.
 *
 *   PLAYWRIGHT_BROWSERS_PATH=$PWD/.cache/ms-playwright pnpm --filter @omw/admin e2e
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.OMW_ADMIN_E2E_PORT ?? 51751);
// One build per port: two runs on different ports never overwrite each other's build.
const DIST = `../../.cache/admin-e2e/dist-${PORT}`;

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: '../../../.cache/playwright/admin-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 390, height: 844 },
    locale: 'de-DE',
    timezoneId: 'Asia/Ho_Chi_Minh',
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec vite build --outDir ${DIST} --emptyOutDir --logLevel warn && TSX_DISABLE_CACHE=1 node --conditions=@omw/source --import tsx e2e/mock/server.ts --port ${PORT} --dist ${DIST} --publish-after 1500`,
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
