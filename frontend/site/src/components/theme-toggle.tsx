/** Theme toggle: system → dawn → dusk (persisted per browser, see @omw/ui/theme). */
import { useLingui } from '@lingui/react/macro';
import { nextThemePreference, type ThemePreference, useThemePreference } from '@omw/ui/theme';
import { MoonIcon, SunIcon, SystemThemeIcon } from './icons';

export function ThemeToggle() {
  const { t } = useLingui();
  const [pref, setPref] = useThemePreference();
  const names: Record<ThemePreference, string> = {
    system: t`Theme: like the device`,
    dawn: t`Theme: dawn (light)`,
    dusk: t`Theme: dusk (dark)`,
  };
  const Icon = pref === 'dawn' ? SunIcon : pref === 'dusk' ? MoonIcon : SystemThemeIcon;
  return (
    <button
      type="button"
      onClick={() => setPref(nextThemePreference(pref))}
      aria-label={names[pref]}
      title={names[pref]}
      className="press grid size-10 place-items-center rounded-full text-muted hover:bg-blush hover:text-ink"
    >
      <Icon className="size-5" />
    </button>
  );
}
