/** Site-wide constants shared with the backend generator (documented in frontend/README.md). */
import type { LocaleCode } from '@omw/contracts/i18n';

/** Element React mounts into; the generator pre-renders the first screen inside it. */
export const ROOT_ELEMENT_ID = 'omw-root';
/** <script id="omw-boot" type="application/json"> with the page's Boot JSON (D3). */
export const BOOT_ELEMENT_ID = 'omw-boot';

/** Used when neither the Boot JSON nor the URL names a locale (dev only). */
export const FALLBACK_LOCALE: LocaleCode = 'de';

/** Poll the manifest for "new moments" (plan C, "Data"). */
export const MANIFEST_POLL_MS = 5 * 60_000;

export const DATA_PATHS = {
  manifest: 'data/manifest.json',
  timeline: 'data/timeline.json',
  dayDir: 'data/days/',
  tripDir: 'data/trips/',
} as const;
