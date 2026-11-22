import tailwindcss from '@tailwindcss/vite';
import { defaultClientConditions, defineConfig } from 'vite';

/**
 * Gate bundle (spec-wave5 §6.1): the static pages /_/{join,info,wait,ended,me,panic}/ of the
 * gate tree. The generator (backend/src/generator/site-build.ts readGateBuild) reads
 * dist/gate/.vite/manifest.json, entry "src/gate/main.ts" → file, css[], imported chunks, and
 * copies them to /_/assets/.
 * - base './' like the SPA: the generator writes the absolute /_/assets/ URLs.
 * - No source maps: the bundle is public and its sources' comments are not (the gate tree's
 *   leak test scans every file in it).
 * - One chunk; budget ≤ 25 kB gzip for JS + CSS together (test/gate/bundle.test.ts checks the
 *   built files when they exist).
 */
export default defineConfig({
  base: './',
  resolve: {
    conditions: ['@omw/source', ...defaultClientConditions],
  },
  plugins: [tailwindcss()],
  build: {
    outDir: 'dist/gate',
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    assetsDir: 'assets',
    modulePreload: false,
    rolldownOptions: {
      input: 'src/gate/main.ts',
      output: {
        entryFileNames: 'assets/gate-[hash].js',
        chunkFileNames: 'assets/gate-[hash].js',
        assetFileNames: 'assets/gate-[hash][extname]',
      },
      treeshake: {
        // Contract modules build zod schemas at module level; only the plain helpers are used.
        manualPureFunctions: ['z'],
      },
    },
  },
});
