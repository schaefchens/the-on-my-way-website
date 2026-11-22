/**
 * The app's own settings (the upload rules live natively, see Uploader.getSettings): haptics,
 * language, app lock, the one-time cards, and what pairing and /app/hints told us. Stored as one
 * JSON file in the app's documents (atomic rename), excluded from backups like the whole app.
 */
import { File, Paths } from 'expo-file-system';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { setHapticsEnabled } from '../../modules/omw-native';
import { type AppLocale, activateLocale, systemLocale } from '../i18n';

export type LockAfter = 0 | 60 | 300;

export interface AppSettings {
  haptics: boolean;
  /** 'system' follows the phone (de or en). */
  locale: 'system' | AppLocale;
  lock: { enabled: boolean; afterSeconds: LockAfter };
  /** The OEM "allow background uploads" card was answered. */
  oemHintDone: boolean;
  /** The capture coach mark was shown. */
  coachSeen: boolean;
  /** Facts about the pairing (never the token: that lives in the TokenVault only). */
  pairing: { deviceName: string; pairedAt: string; tokenName: string } | null;
  /** Last /app/hints (null = never heard): archive-only is assumed until the API says otherwise. */
  hints: { archiveOnly: boolean; delayHours: number; backendLastSeenAt: string | null; at: string } | null;
  /** This install's id for pairing (core/install-id), made at the first pairing; kept on Disconnect. */
  installId: string | null;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  haptics: true,
  locale: 'system',
  lock: { enabled: true, afterSeconds: 300 },
  oemHintDone: false,
  coachSeen: false,
  pairing: null,
  hints: null,
  installId: null,
};

function settingsFile(): File {
  return new File(Paths.document, 'app-settings.json');
}

export function loadAppSettings(): AppSettings {
  try {
    const file = settingsFile();
    if (!file.exists) return DEFAULT_APP_SETTINGS;
    const raw = JSON.parse(file.textSync()) as Partial<AppSettings>;
    return {
      ...DEFAULT_APP_SETTINGS,
      ...raw,
      lock: { ...DEFAULT_APP_SETTINGS.lock, ...(raw.lock ?? {}) },
    };
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

async function saveAppSettings(s: AppSettings): Promise<void> {
  const next = new File(Paths.document, 'app-settings.next.json');
  await next.write(JSON.stringify(s));
  await next.move(settingsFile(), { overwrite: true });
}

export function applyLocale(locale: AppSettings['locale']): boolean {
  return activateLocale(locale === 'system' ? systemLocale() : locale);
}

interface Ctx {
  settings: AppSettings;
  update(patch: Partial<AppSettings> | ((prev: AppSettings) => Partial<AppSettings>)): void;
}

const AppSettingsContext = createContext<Ctx>({ settings: DEFAULT_APP_SETTINGS, update: () => {} });

export function AppSettingsProvider({ children, initial }: { children: ReactNode; initial?: AppSettings }) {
  const [settings, setSettings] = useState<AppSettings>(() => {
    const loaded = initial ?? loadAppSettings();
    applyLocale(loaded.locale);
    return loaded;
  });

  useEffect(() => {
    setHapticsEnabled(settings.haptics);
  }, [settings.haptics]);

  const update = useCallback<Ctx['update']>((patch) => {
    setSettings((prev) => {
      const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) };
      void saveAppSettings(next).catch(() => {
        // Settings are conveniences: a failed write keeps the in-memory value for this session.
      });
      return next;
    });
  }, []);

  const value = useMemo(() => ({ settings, update }), [settings, update]);
  return <AppSettingsContext.Provider value={value}>{children}</AppSettingsContext.Provider>;
}

export function useAppSettings(): Ctx {
  return useContext(AppSettingsContext);
}
