/**
 * Access to the Kotlin modules. requireOptionalNativeModule returns null outside a native build
 * (unit tests, web), so every API has a defined fallback instead of crashing at import time.
 */
import { requireOptionalNativeModule } from 'expo';
import type { Subscription } from './types';

export type NativeModuleName = 'OmwTokenVault' | 'OmwMediaExport' | 'OmwUploader' | 'OmwHaptics' | 'OmwNetwork';

export interface WithListeners {
  addListener(eventName: string, listener: (payload: never) => void): Subscription;
}

const cache = new Map<NativeModuleName, unknown>();

export function nativeModule<T>(name: NativeModuleName): T | null {
  if (!cache.has(name)) cache.set(name, requireOptionalNativeModule<T>(name));
  return (cache.get(name) as T | null | undefined) ?? null;
}

/** True when the Kotlin side is linked (a dev or release build, not tests or web). */
export function isNativeAvailable(): boolean {
  return nativeModule('OmwNetwork') !== null;
}

export const NO_SUBSCRIPTION: Subscription = Object.freeze({ remove() {} });

export class NativeUnavailableError extends Error {
  readonly code = 'ERR_NATIVE_UNAVAILABLE';
  constructor(what: string) {
    super(`${what} needs the native omw-native module (a dev or release build)`);
    this.name = 'NativeUnavailableError';
  }
}
