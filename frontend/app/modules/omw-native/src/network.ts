import { NO_SUBSCRIPTION, nativeModule } from './native';
import type { NetworkState, Subscription } from './types';

interface Native {
  getState(): Promise<NetworkState>;
  addListener(eventName: 'onNetworkChange', listener: (state: NetworkState) => void): Subscription;
}

const native = () => nativeModule<Native>('OmwNetwork');

export const OFFLINE: Readonly<NetworkState> = Object.freeze({
  connected: false,
  validated: false,
  unmetered: false,
  roaming: false,
  transport: 'none',
  simOperator: null,
  simOperatorName: null,
});

/** The network facts of A4, for UI hints. The native uploader decides on its own. */
export const Network = {
  async getState(): Promise<NetworkState> {
    return (await native()?.getState()) ?? { ...OFFLINE };
  },
  addListener(listener: (state: NetworkState) => void): Subscription {
    return native()?.addListener('onNetworkChange', listener) ?? NO_SUBSCRIPTION;
  },
};
