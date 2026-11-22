/** "Connect a phone" and the App badge (traveler app, app-plan §3.7): requests and rendering. */
import { I18nProvider } from '@lingui/react';
import { captureOrigin } from '@omw/contracts/app';
import { AppPhoneListResponse } from '@omw/contracts/app-inbox';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { appKeys, appPhonesApi } from '../src/api/app-phones';
import { setCsrfToken } from '../src/api/client';
import { AppBadge, isAppCapture } from '../src/components/app-badge';
import { CaptureVisual } from '../src/components/capture';
import { CapturePublishChip } from '../src/components/status';
import { activateLocale, i18n } from '../src/i18n';
import { ConnectPhoneSection } from '../src/screens/settings-phones';
import { capture } from './helpers';

const APP_KEY = 'app:01JD3ZQ8X4V7N2K5M9P0R6S8TW';
const original = globalThis.fetch;

function withProviders(node: ReactNode, queryClient = new QueryClient()) {
  return renderToString(
    <I18nProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
    </I18nProvider>,
  );
}

beforeAll(async () => {
  await activateLocale('de');
});
afterEach(() => {
  globalThis.fetch = original;
  setCsrfToken(null);
});

describe('app phones API', () => {
  it('creates codes, lists and disconnects phones on the app routes', async () => {
    const calls: { url: string; method: string; body: string | null; csrf: string | null }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: (init?.body as string) ?? null,
        csrf: headers.get('X-CSRF-Token'),
      });
      if (String(input).endsWith('/app-pairings')) {
        return Response.json(
          {
            link: 'omw://pair#01JD3ZQ8X4V7N2K5M9P0R6S8TW',
            typedCode: 'ABCD-EFGH',
            expiresAt: '2026-11-20T11:00:00.000Z',
          },
          { status: 201 },
        );
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    setCsrfToken('c1');
    const code = await appPhonesApi.createPairing(1440);
    expect(code.typedCode).toBe('ABCD-EFGH');
    await appPhonesApi.disconnect(3);
    expect(calls).toEqual([
      { url: '/api/v1/admin/app-pairings', method: 'POST', body: '{"ttlMinutes":1440}', csrf: 'c1' },
      { url: '/api/v1/admin/app-phones/3', method: 'DELETE', body: null, csrf: 'c1' },
    ]);
    expect(appKeys.phones[0]).toBe('admin');
  });
});

describe('App badge', () => {
  it('marks captures from the app, never WhatsApp ones', () => {
    expect(isAppCapture({ sourceKey: APP_KEY })).toBe(true);
    expect(isAppCapture({ sourceKey: 'wa:3EB0' })).toBe(false);
    // The zod-free restatement agrees with the contract's captureOrigin() on the API's keys.
    for (const key of [APP_KEY, 'wa:3EB0C431D2A7F8E1', 'fixture:abc', 'appx:1', 'wa:app']) {
      expect(isAppCapture({ sourceKey: key }), key).toBe(captureOrigin(key) === 'app');
    }
    expect(withProviders(<AppBadge capture={{ sourceKey: APP_KEY }} />)).toContain('data-testid="app-badge"');
    expect(withProviders(<AppBadge capture={{ sourceKey: 'wa:3EB0' }} />)).toBe('');
  });

  it('shows on photos and text statuses from the app', () => {
    const photo = withProviders(<CaptureVisual capture={capture({ sourceKey: APP_KEY })} />);
    expect(photo).toContain('data-testid="app-badge"');
    const text = withProviders(
      <CaptureVisual
        capture={capture({
          sourceKey: APP_KEY,
          kind: 'text',
          text: { body: 'Hallo', bg: '#7e57c2ff', fg: '#ffffffff', font: 'SYSTEM' },
        })}
      />,
    );
    expect(text).toContain('data-testid="app-badge"');
    expect(withProviders(<CaptureVisual capture={capture()} />)).not.toContain('app-badge');
  });
});

describe('Archive-only chip (Q8 a)', () => {
  const phones = (archiveOnly: boolean) =>
    AppPhoneListResponse.parse({
      items: [],
      openPairing: null,
      inbox: { usedBytes: 0, maxBytes: 1024 * 1024 * 1024 },
      archiveOnly,
    });
  const live = capture({ sourceKey: APP_KEY, effectiveVisibility: 'public' });

  it('says "Archive only" instead of a publish state for app captures while publishing is off', () => {
    const qc = new QueryClient();
    qc.setQueryData(appKeys.phones, phones(true));
    expect(withProviders(<CapturePublishChip capture={live} />, qc)).toContain('Nur Archiv');
    // Not known yet: never claim more than the archive.
    expect(withProviders(<CapturePublishChip capture={live} />)).toContain('Nur Archiv');
  });

  it('leaves WhatsApp captures and switched-on app publishing alone', () => {
    const qc = new QueryClient();
    qc.setQueryData(appKeys.phones, phones(false));
    expect(withProviders(<CapturePublishChip capture={live} />, qc)).not.toContain('Nur Archiv');
    const wa = new QueryClient();
    wa.setQueryData(appKeys.phones, phones(true));
    expect(
      withProviders(<CapturePublishChip capture={capture({ effectiveVisibility: 'public' })} />, wa),
    ).not.toContain('Nur Archiv');
  });
});

describe('Connect a phone', () => {
  it('lists connected phones, the inbox and the archive-only mode in German', () => {
    const qc = new QueryClient();
    qc.setQueryData(
      appKeys.phones,
      AppPhoneListResponse.parse({
        items: [
          {
            id: 1,
            name: 'Pixel 8a',
            platform: 'android',
            appVersion: '2026.11.20-1a2b3c4',
            createdAt: '2026-11-19T10:00:00.000Z',
            lastUsedAt: '2026-11-20T09:00:00.000Z',
            expiresAt: '2027-05-19T10:00:00.000Z',
            revokedAt: null,
            entries: { total: 12, inInbox: 2 },
          },
        ],
        openPairing: null,
        inbox: { usedBytes: 50 * 1024 * 1024, maxBytes: 1024 * 1024 * 1024 },
        archiveOnly: true,
      }),
    );
    const html = withProviders(<ConnectPhoneSection />, qc);
    expect(html).toContain('Handy verbinden');
    expect(html).toContain('Pixel 8a');
    expect(html).toContain('Nur Archiv');
    expect(html).toContain('12 Momente, 2 unterwegs');
    expect(html).toContain('50 von 1.024 MB');
    expect(html).toContain('Pixel 8a trennen');
  });
});
