/**
 * Toasts with an optional action ("Shared · Undo"). They stay 8 s, or Android's recommended
 * accessibility timeout when that is longer (TalkBack users), and are announced politely.
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type as typeStyles, useTheme } from '../theme';
import { Icon, type IconName } from './icons';
import { Press } from './press';

interface ToastInput {
  message: string;
  icon?: IconName;
  action?: { label: string; onPress: () => void; testID?: string };
  /** Default 8000 ms (ux.md §3.10). */
  durationMs?: number;
}

interface Ctx {
  show(toast: ToastInput): void;
  hide(): void;
}

const ToastContext = createContext<Ctx>({ show: () => {}, hide: () => {} });

export function useToast(): Ctx {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<(ToastInput & { id: number }) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setToast(null);
  }, []);

  const show = useCallback((input: ToastInput) => {
    if (timer.current) clearTimeout(timer.current);
    seq.current += 1;
    const id = seq.current;
    setToast({ ...input, id });
    AccessibilityInfo.announceForAccessibility(
      input.action ? `${input.message}. ${input.action.label}` : input.message,
    );
    const base = input.durationMs ?? 8000;
    void AccessibilityInfo.getRecommendedTimeoutMillis(base)
      .catch(() => base)
      .then((ms) => {
        if (seq.current !== id) return;
        timer.current = setTimeout(() => setToast((t) => (t?.id === id ? null : t)), Math.max(base, ms));
      });
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const value = useMemo(() => ({ show, hide }), [show, hide]);
  const c = theme.colors;

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast ? (
        <Animated.View
          key={toast.id}
          entering={FadeIn.duration(200).reduceMotion(ReduceMotion.System)}
          exiting={FadeOut.duration(160).reduceMotion(ReduceMotion.System)}
          style={[styles.wrap, { bottom: insets.bottom + 132 }]}
          pointerEvents="box-none"
          accessibilityLiveRegion="polite"
        >
          <View style={[styles.toast, { backgroundColor: theme.name === 'dusk' ? c.surface2 : c.ink }]} testID="toast">
            {toast.icon ? (
              <Icon name={toast.icon} size={18} color={theme.name === 'dusk' ? c.success : '#bfe9d2'} />
            ) : null}
            <Text style={[typeStyles.bodyBold, styles.text, { color: theme.name === 'dusk' ? c.ink : c.bg }]}>
              {toast.message}
            </Text>
            {toast.action ? (
              <Press
                onPress={() => {
                  hide();
                  toast.action?.onPress();
                }}
                style={styles.action}
                accessibilityRole="button"
                testID={toast.action.testID ?? 'toast-action'}
              >
                <Text
                  style={[typeStyles.label, styles.actionText, { color: theme.name === 'dusk' ? c.accent : '#f8c1d2' }]}
                >
                  {toast.action.label}
                </Text>
              </Press>
            ) : null}
          </View>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 52,
    paddingLeft: 18,
    paddingRight: 8,
    borderRadius: 9999,
    maxWidth: 480,
    boxShadow: '0 8px 28px -8px rgba(27, 19, 34, 0.45)',
  },
  text: { fontSize: 15, flexShrink: 1, paddingVertical: 12 },
  action: { minHeight: 44, paddingHorizontal: 14, justifyContent: 'center', borderRadius: 9999 },
  actionText: { fontSize: 15 },
});
