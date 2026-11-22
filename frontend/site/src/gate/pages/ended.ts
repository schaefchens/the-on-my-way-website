/**
 * /_/ended/ (spec-wave5 §6.2.3): no access on this device. The link "Your data" appears only when
 * the device still has full D12 rights (it ended together with the person's access, §3.3), which
 * `me/data` answers with `ok`. `#deleted`: the person just deleted their data (no request).
 */
import { type GateContext, messageView } from '../context';

export async function endedPage(ctx: GateContext): Promise<void> {
  const { ui, cookies } = ctx;
  const env = ui.env;
  if (env.location.hash === '#deleted') {
    ui.show(() => messageView(ctx, ui.s.deletedText));
    return;
  }
  let dataLink = false;
  const view = () => messageView(ctx, ui.s.endedText, dataLink ? ui.link(ui.s.yourData, '/_/me/') : null);
  ui.show(view);
  const k = cookies.readKey();
  if (!k) return;
  try {
    const res = await ctx.api.post('me/data', { k });
    if (res.status === 'ok') {
      dataLink = true;
      ui.refresh();
    }
  } catch {
    // The link is a convenience; without an answer the page stays as it is.
  }
}
