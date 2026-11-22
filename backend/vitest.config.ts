import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources ("@omw/source" export condition),
// so tests never depend on a prior `pnpm build`.
const conditions = ['@omw/source', 'node', 'import', 'module', 'default'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['@omw/source'] } },
  test: {
    include: ['test/**/*.test.ts'],
    // The Apache gate suite runs on its own (vitest.apache.config.ts, `pnpm test:apache`).
    exclude: ['test/gate/**', '**/node_modules/**'],
    environment: 'node',
    pool: 'forks',
    // Generator and publisher tests build whole sites; with every workspace's suite running at once
    // (`pnpm test`) a 5 s default timed out under load.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
