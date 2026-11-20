import { lingui } from '@lingui/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';
import { omwDevData } from './vite/dev-data-plugin.ts';

/**
 * Public site SPA (plan C, D3).
 * - base './': built asset URLs are relative, so one build works under any basePath; the
 *   generator writes absolute, basePath-prefixed tags from dist/.vite/manifest.json.
 * - "@omw/source" resolves workspace packages to their TypeScript sources (no build needed).
 * - Lingui macros are compiled by the plugin's native transform (macroTransform), no Babel.
 * - Dev: /data and /media are served from OMW_DEV_DATA_DIR (default ./dev-data), see
 *   vite/dev-data-plugin.ts and scripts/make-dev-data.ts.
 */
export default defineConfig({
  base: './',
  resolve: {
    conditions: ['@omw/source', ...defaultClientConditions],
  },
  plugins: [react(), lingui({ macroTransform: true }), tailwindcss(), omwDevData()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  // 4173 is reserved for the static preview of backend/data/out (D12).
  preview: { host: '127.0.0.1', port: 4175, strictPort: true },
  build: {
    manifest: true,
    sourcemap: true,
    assetsDir: 'assets',
    // The real budget is gzip-based (plan C: initial JS <= 150 kB gz); this only flags outliers.
    chunkSizeWarningLimit: 450,
    rolldownOptions: {
      treeshake: {
        // @omw/contracts modules mix plain helpers (LOCALES, pickText, …) with zod schemas built
        // at module level. Marking zod's builder calls pure lets unused schemas (and zod) drop
        // out of the production bundle; the dev-only validation imports them dynamically.
        manualPureFunctions: ['z'],
      },
    },
  },
});
