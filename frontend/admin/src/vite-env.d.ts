/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/vanillajs" />

declare module '*.po' {
  import type { Messages } from '@lingui/core';
  export const messages: Messages;
}

interface ImportMetaEnv {
  /** "1" = fake a logged-in owner without the PHP API (UI work only). */
  readonly VITE_AUTH_STUB?: string;
}
