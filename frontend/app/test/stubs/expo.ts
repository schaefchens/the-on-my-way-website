/**
 * Stand-in for `expo` in Vitest (Node has no native modules). Tests register fakes with
 * setFakeNativeModule(); anything unregistered behaves like a missing native module. The registry
 * lives on globalThis so it survives vi.resetModules().
 */
const KEY = Symbol.for('omw.test.fakeNativeModules');
const g = globalThis as typeof globalThis & { [KEY]?: Map<string, unknown> };
const fakes = (): Map<string, unknown> => {
  g[KEY] ??= new Map();
  return g[KEY];
};

export function setFakeNativeModule(name: string, module: unknown): void {
  fakes().set(name, module);
}

export function clearFakeNativeModules(): void {
  fakes().clear();
}

export function requireOptionalNativeModule<T>(name: string): T | null {
  return (fakes().get(name) as T | undefined) ?? null;
}
