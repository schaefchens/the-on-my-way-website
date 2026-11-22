/**
 * Mounts a gate page: reads nothing but the boot data and the browser (GateEnv), builds the shell
 * and runs the page named by GateBoot.page.
 */
import type { GateBoot, GatePage } from '@omw/contracts/access';
import { createPublicApi } from './api';
import type { GateContext } from './context';
import { GateCookies } from './cookies';
import { createUi } from './dom';
import type { GateEnv } from './env';
import { endedPage } from './pages/ended';
import { infoPage } from './pages/info';
import { joinPage } from './pages/join';
import { mePage } from './pages/me';
import { panicPage } from './pages/panic';
import { waitPage } from './pages/wait';

export const ROOT_ID = 'omw-gate-root';

const PAGES: Readonly<Record<GatePage, (ctx: GateContext) => Promise<void>>> = {
  join: joinPage,
  info: infoPage,
  wait: waitPage,
  ended: endedPage,
  me: mePage,
  panic: panicPage,
};

/** The dawn/dusk choice the visitor made in the SPA (same origin, same storage). */
function applyTheme(env: GateEnv): void {
  try {
    const pref = env.storage('local')?.getItem('omw-theme');
    if (pref === 'dawn') env.doc.documentElement.dataset.theme = 'dawn';
    else if (pref === 'dusk') env.doc.documentElement.dataset.theme = 'night';
  } catch {
    // follow the OS
  }
}

export function createGateContext(env: GateEnv, boot: GateBoot, root: HTMLElement): GateContext {
  const ui = createUi(env, boot, root);
  const api = createPublicApi({ api: boot.api, cookieMode: boot.cookieMode, fetch: env.fetch, schedule: env.schedule });
  const cookies = new GateCookies(
    env.doc,
    { key: boot.cookies.key, transfer: boot.cookies.transfer, handoff: boot.cookies.handoff },
    { secure: boot.cookies.secure, domain: boot.cookieDomain },
  );
  return { ui, api, cookies };
}

/** Runs the page; resolves when its first flow step is done (tests await it). */
export async function mountGate(env: GateEnv, boot: GateBoot | null): Promise<GateContext | null> {
  const root = env.doc.getElementById(ROOT_ID) ?? env.doc.body;
  applyTheme(env);
  if (!boot) {
    // No usable boot data (a broken deploy): say so in both languages, contact nobody.
    const p = env.doc.createElement('p');
    p.className = 'p-8 text-center text-muted';
    p.textContent = 'Gerade nicht verfügbar. · Not available right now.';
    root.replaceChildren(p);
    return null;
  }
  const ctx = createGateContext(env, boot, root);
  await PAGES[boot.page](ctx);
  return ctx;
}
