/**
 * jest-expo + React Native Testing Library: the outbox state machine, the A4 settings rules, the
 * text-status serialization and the screens' components (test-rn/). Framework-free checks that
 * need Node only stay in Vitest (test/).
 *
 * - @omw/contracts is consumed from source (as Metro does with the "@omw/source" condition), and
 *   its NodeNext "./x.js" specifiers resolve to the .ts files.
 * - .po catalogs are stubbed: Lingui's dev-mode macros carry the English source text.
 */
const path = require('node:path');

const contracts = path.resolve(__dirname, '../../packages/contracts/src');
const preset = require('jest-expo/android/jest-preset.js');
const babelJs = preset.transform['\\.[jt]sx?$'];

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo/android',
  roots: ['<rootDir>/test-rn'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
  moduleNameMapper: {
    '^@omw/contracts$': `${contracts}/index.ts`,
    '^@omw/contracts/(.*)$': `${contracts}/$1.ts`,
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '\\.po$': '<rootDir>/test-rn/stubs/po.js',
  },
  setupFiles: ['<rootDir>/test-rn/stubs/setup.js'],
  // Lingui 6 ships ESM only (.mjs): transform it like the app code (pnpm paths keep a second
  // node_modules segment, so the package name must be allowed after the last one).
  transform: { ...preset.transform, '\\.mjs$': babelJs },
  moduleFileExtensions: [...preset.moduleFileExtensions, 'mjs'],
  transformIgnorePatterns: [
    '/node_modules/(?!(\\.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@lingui|@messageformat|standard-navigation|react-native-svg|react-native-reanimated|react-native-worklets|react-native-gesture-handler|react-native-safe-area-context|react-native-screens))',
  ],
  cacheDirectory: path.resolve(__dirname, '../../.cache/jest'),
};
