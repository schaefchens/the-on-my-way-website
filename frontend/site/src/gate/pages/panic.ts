/**
 * /_/panic/ (spec-wave5 §6.2.8): the optional panic link `#k=<key>` locks the site without a
 * login. The key leaves the address bar at once. The API always answers `{ok: true}`, so the page
 * cannot tell (and does not say) whether the key was valid.
 */
import { parseLinkFragment } from '../access-lite';
import { type GateContext, messageView, showInvalid } from '../context';

export async function panicPage(ctx: GateContext): Promise<void> {
  const { ui } = ctx;
  const env = ui.env;
  const key = parseLinkFragment(env.location.hash).k;
  env.replaceUrl('/_/panic/');
  if (!key) {
    showInvalid(ctx);
    return;
  }
  const lock = async () => {
    ui.show(() => ui.busy());
    try {
      await ctx.api.post('panic', { key });
    } catch (err) {
      ui.show(() => ui.failure(err, () => void lock()));
      return;
    }
    ui.show(() => messageView(ctx, ui.s.panicDone));
  };
  // One big button (§6.2.8): easy to hit in a hurry.
  const bigButton = () => {
    const button = ui.button(ui.s.panicButton, () => void lock(), 'danger', { 'data-action': 'lock' });
    button.classList.add('w-full', 'min-h-14', 'text-lg');
    return button;
  };
  ui.show(() => [
    ui.title(ui.s.panicTitle),
    ui.para(ui.s.panicText, 'mt-3 text-ink'),
    ui.el('div', { class: 'mt-6' }, bigButton()),
  ]);
}
