import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, isRedirect } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/app';
import { authGuard } from '../src/auth';
import { activateLocale } from '../src/i18n';
import { createAdminRouter } from '../src/router';

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

function serve(routes: Record<string, () => Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const handler = routes[String(input)];
    return handler ? handler() : new Response('{"error":{"code":"not_found","message":"nope"}}', { status: 404 });
  }) as typeof fetch;
}

async function render(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAdminRouter(queryClient, createMemoryHistory({ initialEntries: [path] }));
  await activateLocale('de');
  await router.load();
  return { html: renderToString(<App router={router} queryClient={queryClient} />), router };
}

describe('admin router', () => {
  it('sends anonymous visitors to the login screen, remembering the target', async () => {
    serve({
      '/api/v1/admin/me': () => new Response('{"error":{"code":"unauthenticated","message":"x"}}', { status: 401 }),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const thrown = await authGuard({ context: { queryClient }, location: { href: '/inbox' } }).catch((e: unknown) => e);
    expect(isRedirect(thrown)).toBe(true);
    expect((thrown as { options: unknown }).options).toMatchObject({ to: '/login', search: { redirect: '/inbox' } });
    // (Without a DOM the router runs in server mode and only records redirects, so render /login directly.)
    const { html } = await render('/admin/login?redirect=%2Finbox');
    expect(html).toContain('Anmelden');
    expect(html).toContain('E-Mail');
  });

  it('renders the authenticated layout and screen', async () => {
    serve({
      '/api/v1/admin/me': () => Response.json({ email: 'owner@example.org', displayName: 'Reisende', csrfToken: 'c1' }),
    });
    const { html } = await render('/admin/compose?kind=story');
    expect(html).toContain('Reisende');
    expect(html).toContain('Neue Geschichte');
    expect(html).toContain('href="/admin/inbox"');
  });
});
