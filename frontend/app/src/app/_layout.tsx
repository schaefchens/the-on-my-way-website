import { I18nProvider } from '@lingui/react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useReducedMotion } from 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { z } from 'zod';
import { i18n } from '../i18n';
import { OutboxProvider } from '../outbox/outbox';
import { AppSettingsProvider } from '../state/app-settings';
import { LockProvider } from '../state/lock';
import { ThemeProvider, useTheme } from '../theme';
import { ToastProvider } from '../ui/toast';

// Hermes compiles `new Function` at runtime: zod's JIT buys nothing there (app-plan §4).
z.config({ jitless: true });

/** Camera, editor, text and voice always sit on a dark stage (ux.md §5.1). */
const STAGE_SCREENS = ['camera', 'compose', 'text', 'voice'] as const;

function ThemedStack() {
  const theme = useTheme();
  // With reduced motion (system animations off, e.g. e-ink tablets) screens switch without any
  // transition: a native fade that never runs must not leave a new screen invisible.
  const reduced = useReducedMotion();
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(theme.colors.bg);
  }, [theme.colors.bg]);
  return (
    <>
      <StatusBar style={theme.name === 'dusk' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.bg },
          animation: reduced ? 'none' : 'fade_from_bottom',
        }}
      >
        {STAGE_SCREENS.map((name) => (
          <Stack.Screen
            key={name}
            name={name}
            options={{
              // The camera's own circular reveal (or a crossfade) does the motion.
              animation: reduced || name === 'camera' ? 'none' : 'fade',
              contentStyle: { backgroundColor: '#120c17' },
              statusBarStyle: 'light',
            }}
          />
        ))}
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <I18nProvider i18n={i18n}>
          <AppSettingsProvider>
            <ThemeProvider>
              <LockProvider>
                <OutboxProvider>
                  <ToastProvider>
                    <ThemedStack />
                  </ToastProvider>
                </OutboxProvider>
              </LockProvider>
            </ThemeProvider>
          </AppSettingsProvider>
        </I18nProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
