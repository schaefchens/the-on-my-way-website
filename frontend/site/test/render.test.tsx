import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fallbackBoot } from '../src/boot';
import { activateLocale } from '../src/i18n';
import { NotFoundScreen } from '../src/routes/not-found';
import { createSiteContext, SiteProvider } from '../src/site';

describe('Lingui macros + catalogs', () => {
  it('renders translated messages for de, en and the RTL pseudo-locale', async () => {
    const render = () =>
      renderToStaticMarkup(
        <SiteProvider value={createSiteContext(fallbackBoot('/de/'))}>
          <I18nProvider i18n={i18n}>
            <NotFoundScreen />
          </I18nProvider>
        </SiteProvider>,
      );
    await activateLocale('de');
    expect(render()).toContain('Hier ist nichts');
    await activateLocale('en');
    expect(render()).toContain('Nothing here');
    await activateLocale('ar');
    const pseudo = render();
    expect(pseudo).not.toContain('Nothing here');
    expect(pseudo).toMatch(/[\u202e\u202b\u200f]/); // RTL marks from pseudo-localization
  });
});
