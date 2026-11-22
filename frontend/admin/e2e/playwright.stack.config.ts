/**
 * End-to-end owner flow across the WHOLE local stack (no mocks): the built admin PWA served by
 * the real PHP API (php -S, fresh SQLite database), the Node backend in fixture mode syncing with
 * that API, and the generated site published to a local folder served on a static port.
 * The spec starts and stops every process itself (e2e/stack/stack.ts); state lives in
 * .cache/e2e-stack and is recreated on every run.
 *
 *   pnpm --filter @omw/admin build                                    # once: api/public/admin
 *   pnpm --filter @omw/site build                                     # once: the site the generator ships
 *   PLAYWRIGHT_BROWSERS_PATH=$PWD/.cache/ms-playwright pnpm --filter @omw/admin e2e:stack
 *
 * Ports (must be free): 8080 API, 8787 backend control UI, 4173 static site
 * (override with OMW_STACK_API_PORT / OMW_STACK_CONTROL_PORT / OMW_STACK_SITE_PORT; the state
 * directory with OMW_STACK_ROOT, default .cache/e2e-stack).
 *
 * access-flow.stack.ts (wave 5, the access gate) runs two more stacks one after the other, with
 * the API's store writer `direct` and then `none` (the backend writes the store): API 8081,
 * control UI 8788 and a local Apache serving the generated gate + content trees on 4174
 * (OMW_GATE_API_PORT / OMW_GATE_CONTROL_PORT / OMW_GATE_SITE_PORT; roots .cache/e2e-stack-gate
 * and .cache/e2e-stack-gate-mac). Skipped without an Apache binary (macOS: /usr/sbin/httpd).
 */
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const repoRoot = resolve(import.meta.dirname, '../../..');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(repoRoot, '.cache/ms-playwright');

export default defineConfig({
  testDir: './stack',
  testMatch: /\.stack\.ts$/,
  outputDir: resolve(repoRoot, '.cache/playwright/stack-results'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 390, height: 844 },
    locale: 'de-DE',
    timezoneId: 'Asia/Ho_Chi_Minh',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
