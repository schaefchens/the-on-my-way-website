import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources ("@omw/source" export condition).
const conditions = ['@omw/source', 'node', 'import', 'module', 'default'];

export default defineConfig({
  plugins: [react()],
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['@omw/source'] } },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
