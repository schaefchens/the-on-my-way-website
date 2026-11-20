/**
 * Smoke test of the whole SPA: real route tree, loaders, Lingui catalogs and screens, rendered
 * to HTML in Node from the dev data set (memory history instead of the browser).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryHistory } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/app';
import { fallbackBoot } from '../src/boot';
import { activateLocale } from '../src/i18n';
import { createSiteRouter } from '../src/router';
import { createSiteContext } from '../src/site';

const DIR = fileURLToPath(new URL('../dev-data', import.meta.url));
const HAVE_DATA = existsSync(join(DIR, 'data/manifest.json'));

async function render(path: string) {
  const boot = fallbackBoot(path);
  const site = createSiteContext(boot);
  const router = createSiteRouter(site, createMemoryHistory({ initialEntries: [path] }));
  await activateLocale(boot.locale ?? site.defaultLocale);
  await router.load();
  return { html: renderToString(<App site={site} router={router} />), router };
}

describe.skipIf(!HAVE_DATA)('app (rendered from dev-data)', () => {
  const original = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input).split('?')[0] ?? '';
      const file = join(DIR, path);
      if (!path.startsWith('/data/') || !existsSync(file)) return new Response('nope', { status: 404 });
      return new Response(readFileSync(file), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('renders the German timeline (days level, newest first)', async () => {
    const { html } = await render('/de/');
    expect(html).toContain('Momente von unterwegs');
    expect(html).toContain('November 2026');
    expect(html).toContain('Vietnam 2026');
    expect(html).toContain('Sài Gòn');
    expect(html).toContain('data-level="days"');
    expect(html).toContain('href="/de/day/2026-11-17/"');
    expect(html).toContain('Tag ansehen');
  });

  it('renders the overview levels from ?z=', async () => {
    const months = (await render('/de/?z=months')).html;
    expect(months).toContain('data-level="months"');
    expect(months).toContain('data-anchor="2026-11-15"');
    const trips = (await render('/en/?z=trips')).html;
    expect(trips).toContain('data-level="trips"');
    expect(trips).toContain('href="/en/trip/vietnam-2026/"');
    expect(trips).toContain('In between');
  });

  it('renders a day overlay above the timeline, in English', async () => {
    const { html } = await render('/en/day/2026-11-15/');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Lanterns in Hội An');
    // The timeline stays mounted (inert) underneath.
    expect(html).toContain('data-level="days"');
    expect(html).toMatch(/<div class="relative" inert="">/);
  });

  it('renders a story sheet and a trip page', async () => {
    expect((await render('/de/day/2026-11-15/story/p_s01lantern/')).html).toContain('Die Nacht der Laternen');
    expect((await render('/en/trip/vietnam-2026/')).html).toContain('From Hà Nội via Hội An to Sài Gòn.');
  });

  it('404s unknown days and locales', async () => {
    expect((await render('/de/day/2030-01-01/')).html).toContain('Hier ist nichts');
    // Unknown locale: 404 page in the default locale.
    expect((await render('/fr/')).html).toContain('Hier ist nichts');
  });
});
