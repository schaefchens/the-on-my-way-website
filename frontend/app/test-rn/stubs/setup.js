// Jest setup for the app's component tests (runs before each test file).
// zod's JIT uses `new Function`; the app runs jitless on Hermes, so the tests do too.
require('zod').z.config({ jitless: true });
require('react-native-gesture-handler/jestSetup');

jest.mock('react-native-reanimated', () => require('./reanimated'));
jest.mock('react-native-worklets', () => ({ scheduleOnRN: (fn, ...args) => fn(...args) }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('expo-file-system', () => {
  class FakeFile {
    constructor(...parts) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
      this.exists = false;
      this.size = 0;
    }
    textSync() {
      return '{}';
    }
    write() {}
    async move() {}
    async copy() {}
    async digest() {
      return '0'.repeat(64);
    }
    delete() {}
  }
  class FakeDirectory extends FakeFile {
    create() {}
    list() {
      return [];
    }
  }
  return {
    File: FakeFile,
    Directory: FakeDirectory,
    Paths: { document: { uri: 'file:///doc' }, availableDiskSpace: 1e12 },
  };
});
jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  getEnrolledLevelAsync: async () => 0,
  authenticateAsync: async () => ({ success: true }),
}));
jest.mock('expo-sqlite', () => {
  const db = {
    execAsync: async () => {},
    getAllAsync: async () => [],
    runAsync: async () => ({ changes: 0, lastInsertRowId: 0 }),
    withExclusiveTransactionAsync: async (task) => task(db),
  };
  return { openDatabaseAsync: async () => db };
});
jest.mock('expo-crypto', () => ({
  getRandomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256),
}));
jest.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: () => ({}) },
  SaveFormat: { JPEG: 'jpeg' },
}));
jest.mock('expo-audio', () => ({}));
