import { lingui } from '@lingui/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Admin PWA (plan C "Admin PWA"), served by the PHP API under /admin/ (same origin as
 * /api/v1/admin, so first-party cookies and no CORS).
 * - build -> api/public/admin (git-ignored; deployed together with the PHP app)
 * - dev on 127.0.0.1:5174/admin/, /api proxied to the PHP dev server (php -S 127.0.0.1:8080)
 * - service worker: src/sw.ts via injectManifest; the admin API is never cached
 */
const API_DEV = process.env.OMW_API_DEV_URL ?? 'http://127.0.0.1:8080';

export default defineConfig({
  base: '/admin/',
  resolve: {
    conditions: ['@omw/source', ...defaultClientConditions],
  },
  plugins: [
    react(),
    lingui({ macroTransform: true }),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      base: '/admin/',
      scope: '/admin/',
      registerType: 'prompt',
      injectRegister: false, // registered in src/pwa.ts (production only)
      manifest: {
        id: '/admin/',
        name: 'On My Way · Admin',
        // The label under the home-screen icon.
        short_name: 'On My Way',
        description: 'Notizen, Geschichten und Moderation für die On-My-Way-Reisezeitleiste',
        lang: 'de',
        start_url: '/admin/',
        scope: '/admin/',
        display: 'standalone',
        orientation: 'portrait',
        // Same cream as the light <meta name="theme-color"> (index.html): splash screen, task
        // switcher and the in-app status bar agree. (A manifest has one colour; dark mode
        // follows the meta tag.)
        theme_color: '#fff8f6',
        background_color: '#fff8f6',
        categories: ['travel', 'lifestyle'],
        // The manifest has no per-language strings: the shortcuts name both languages of the app.
        shortcuts: [
          { name: 'Notiz · Note', short_name: 'Notiz · Note', url: '/admin/compose?kind=note' },
          { name: 'Eingang · Inbox', short_name: 'Eingang · Inbox', url: '/admin/inbox' },
          { name: 'Zeitzone · Time zone', short_name: 'Zeitzone', url: '/admin/settings' },
        ],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      injectManifest: {
        // App shell only; fonts are cached at runtime (sw.ts) to keep the install small.
        globPatterns: ['**/*.{js,css,html}'], // + manifest icons and the webmanifest (added by the plugin)
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: { '/api': { target: API_DEV, changeOrigin: false } },
  },
  preview: {
    host: '127.0.0.1',
    port: 4176,
    strictPort: true,
    proxy: { '/api': { target: API_DEV, changeOrigin: false } },
  },
  build: {
    outDir: '../../api/public/admin',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 450,
    rolldownOptions: {
      // See frontend/site/vite.config.ts: drop unused zod schemas from @omw/contracts modules.
      treeshake: { manualPureFunctions: ['z'] },
    },
  },
});
