import { lingui } from '@lingui/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Same transforms as the app (React + Lingui macros), sources of workspace packages via
// the "@omw/source" condition, Node environment (components are tested with react-dom/server).
const conditions = ['@omw/source', 'node', 'import', 'module', 'default'];

export default defineConfig({
  plugins: [react(), lingui({ macroTransform: true })],
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: ['@omw/source'] } },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
