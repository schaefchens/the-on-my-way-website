import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Framework-free tests (Node): the token snapshot, the omw-native JS facade, the i18n catalogs and
 * the API client. `expo` and `expo-constants` are replaced by stubs, so the native-module wrappers
 * run their no-native fallbacks.
 * Component tests (jest-expo + RNTL) come with the screens.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^expo$/, replacement: fileURLToPath(new URL('./test/stubs/expo.ts', import.meta.url)) },
      {
        find: /^expo-constants$/,
        replacement: fileURLToPath(new URL('./test/stubs/expo-constants.ts', import.meta.url)),
      },
      // Contracts from source (value imports too, e.g. the text-status parity test).
      {
        find: /^@omw\/contracts$/,
        replacement: fileURLToPath(new URL('../../packages/contracts/src/index.ts', import.meta.url)),
      },
      {
        find: /^@omw\/contracts\/(.*)$/,
        replacement: fileURLToPath(new URL('../../packages/contracts/src/$1.ts', import.meta.url)),
      },
    ],
    conditions: ['@omw/source'],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
