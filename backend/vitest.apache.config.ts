import { defineConfig } from 'vitest/config';

/**
 * The Apache gate suite (spec-wave5 §8.2): `pnpm --filter @omw/backend test:apache`. It starts a
 * local httpd on 127.0.0.1 (and on macOS attaches a small case-sensitive disk image), so it is not
 * part of the default `pnpm test`; it skips itself when no Apache binary is found.
 */
const conditions = ['@omw/source', 'node', 'import', 'module', 'default'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['@omw/source'] } },
  test: {
    include: ['test/gate/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
