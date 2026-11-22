/** TalkBack and chip names of the text-status colours and fonts (de/en). */
import { useLingui } from '@lingui/react/macro';
import type { FontName } from '@omw/contracts/wa';

export function useColorNames(): Record<string, string> {
  const { t } = useLingui();
  return {
    plum: t`Plum`,
    rose: t`Rose`,
    'deep-rose': t`Deep rose`,
    berry: t`Berry`,
    mauve: t`Mauve`,
    violet: t`Violet`,
    'lavender-dusk': t`Lavender dusk`,
    ocean: t`Ocean`,
    lagoon: t`Lagoon`,
    forest: t`Forest`,
    terracotta: t`Terracotta`,
    night: t`Night`,
  };
}

export function useFontNames(): Record<FontName, string> {
  const { t } = useLingui();
  return {
    SYSTEM: t`Phone font`,
    SYSTEM_TEXT: t`Serif`,
    FB_SCRIPT: t`Script`,
    SYSTEM_BOLD: t`Bold`,
    MORNINGBREEZE_REGULAR: t`Rounded`,
    CALISTOGA_REGULAR: t`Calistoga`,
    EXO2_EXTRABOLD: t`Exo`,
    COURIERPRIME_BOLD: t`Typewriter`,
  };
}
