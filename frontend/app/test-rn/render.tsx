/** Renders a component with the app's providers and a fake outbox (no native modules). */
import { jest } from '@jest/globals';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { DEFAULT_UPLOAD_SETTINGS } from '../modules/omw-native';
import { deriveStatus, type OutboxManifest, type StatusContext } from '../src/core/outbox-machine';
import { type OutboxApi, OutboxContext } from '../src/outbox/outbox';
import { type AppSettings, AppSettingsProvider, DEFAULT_APP_SETTINGS } from '../src/state/app-settings';
import { ThemeProvider } from '../src/theme';
import { WIFI } from './fixtures';

i18n.load({ en: {} });
i18n.activate('en');

export function fakeOutbox(entries: OutboxManifest[], patch: Partial<OutboxApi> = {}): OutboxApi {
  const statusContext: StatusContext = {
    settings: DEFAULT_UPLOAD_SETTINGS,
    network: WIFI,
    paired: true,
    archiveOnly: true,
    now: '2026-11-20T10:00:05.000Z',
  };
  const ctx = { ...statusContext, ...(patch.statusContext ?? {}) };
  return {
    ready: true,
    entries,
    get: (id) => entries.find((m) => m.entryId === id),
    statusOf: (m) => deriveStatus(m, ctx),
    statusContext: ctx,
    uploadSettings: ctx.settings,
    setUploadSettings: jest.fn(async () => {}),
    network: ctx.network,
    paired: ctx.paired,
    setPaired: jest.fn(),
    createDraft: jest.fn(async () => 'X'),
    edit: jest.fn(async () => {}),
    share: jest.fn(async () => {}),
    undo: jest.fn(async () => {}),
    retry: jest.fn(async () => {}),
    discard: jest.fn(async () => {}),
    uploadNow: jest.fn(async () => 1),
    refresh: jest.fn(async () => {}),
    lastShared: null,
    fileUri: (id, name) => `file:///doc/outbox/${id}/${name}`,
    ...patch,
  };
}

export async function renderWithApp(
  ui: ReactElement,
  options: { outbox?: OutboxApi; settings?: Partial<AppSettings> } = {},
) {
  const outbox = options.outbox ?? fakeOutbox([]);
  const result = await render(
    <GestureHandlerRootView style={{ flex: 1 }}>
      <I18nProvider i18n={i18n}>
        <AppSettingsProvider initial={{ ...DEFAULT_APP_SETTINGS, ...(options.settings ?? {}) }}>
          <ThemeProvider>
            <OutboxContext.Provider value={outbox}>{ui}</OutboxContext.Provider>
          </ThemeProvider>
        </AppSettingsProvider>
      </I18nProvider>
    </GestureHandlerRootView>,
  );
  return { outbox, ...result };
}
