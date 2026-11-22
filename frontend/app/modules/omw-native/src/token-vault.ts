import { NativeUnavailableError, nativeModule } from './native';

interface Native {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

const native = () => nativeModule<Native>('OmwTokenVault');

/**
 * The app token from pairing (scope "capture"), Keystore-encrypted, excluded from backups and
 * readable by the native uploader. Never log it, never put it in other storage.
 */
export const TokenVault = {
  /** null when not paired (or when the key was lost, e.g. after a device restore). */
  async get(): Promise<string | null> {
    const n = native();
    return n ? n.get() : null;
  },
  async set(token: string): Promise<void> {
    if (!/^omw_[A-Za-z0-9_-]{43}$/.test(token)) throw new RangeError('Not an app token');
    const n = native();
    if (!n) throw new NativeUnavailableError('TokenVault.set');
    await n.set(token);
  },
  async clear(): Promise<void> {
    await native()?.clear();
  },
};
