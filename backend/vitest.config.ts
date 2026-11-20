import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources ("@omw/source" export condition),
// so tests never depend on a prior `pnpm build`.
const conditions = ['@omw/source', 'node', 'import', 'module', 'default'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['@omw/source'] } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
  },
});
