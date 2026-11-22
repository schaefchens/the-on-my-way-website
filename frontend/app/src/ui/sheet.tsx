/**
 * Bottom sheet (ux.md §4.2 #13): rises with the soft spring, follows a downward drag on its handle
 * and closes with the release velocity; the scrim fades in 200 ms. Every gesture has a visible
 * alternative: the scrim and system back close it too, and TalkBack gets a "Close" button.
 * Reduced motion: a 120 ms fade, no movement.
 */
import { useLingui } from '@lingui/react/macro';
import { type ReactNode, useEffect, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { type as typeStyles, useTheme } from '../theme';
import { Icon } from './icons';
import { REDUCED_FADE, SPRINGS } from './motion';
import { Press } from './press';

export function Sheet({
  open,
  onClose,
  title,
  children,
  testID,
  dark = false,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  testID?: string;
  /** Camera and editor sheets sit on the dark stage. */
  dark?: boolean;
}) {
  const theme = useTheme();
  const { t } = useLingui();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const y = useSharedValue(height);
  const shown = useSharedValue(0);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    if (open) {
      shown.value = withTiming(1, reduced ? REDUCED_FADE : { duration: 200 });
      y.value = reduced ? 0 : withSpring(0, SPRINGS.soft);
    } else {
      const done = (finished?: boolean) => {
        'worklet';
        if (finished) scheduleOnRN(setMounted, false);
      };
      if (reduced) {
        shown.value = withTiming(0, REDUCED_FADE, done);
      } else {
        shown.value = withTiming(0, { duration: 200 });
        y.value = withTiming(height, { duration: 220 }, done);
      }
    }
  }, [open, mounted, reduced, height, shown, y]);

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [open, onClose]);

  const pan = usePanGesture({
    activeOffsetY: [-12, 12],
    onUpdate: (e) => {
      'worklet';
      y.value = Math.max(0, e.translationY);
    },
    onDeactivate: (e) => {
      'worklet';
      if (e.translationY > 120 || e.velocityY > 900) {
        scheduleOnRN(onClose);
      } else {
        y.value = withSpring(0, { ...SPRINGS.soft, velocity: e.velocityY });
      }
    },
  });

  const scrimStyle = useAnimatedStyle(() => ({ opacity: shown.value }));
  const sheetStyle = useAnimatedStyle(() => ({
    opacity: reduced ? shown.value : 1,
    transform: [{ translateY: y.value }],
  }));

  if (!mounted) return null;
  const c = theme.colors;
  const surface = dark ? '#1f1627' : c.surface;
  const ink = dark ? '#f7ecf2' : c.ink;

  return (
    <View style={StyleSheet.absoluteFill} testID={testID}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t`Close`}
          importantForAccessibility="no"
        />
      </Animated.View>
      <Animated.View
        accessibilityViewIsModal
        style={[
          styles.sheet,
          { backgroundColor: surface, paddingBottom: insets.bottom + 16, maxHeight: height - insets.top - 24 },
          sheetStyle,
        ]}
      >
        <GestureDetector gesture={pan}>
          <View style={styles.handleArea}>
            <View style={[styles.handle, { backgroundColor: dark ? '#4a3a55' : c.line }]} />
            <View style={styles.header}>
              {title ? (
                <Text style={[typeStyles.title, styles.title, { color: ink }]} accessibilityRole="header">
                  {title}
                </Text>
              ) : (
                <View />
              )}
              <Press
                onPress={onClose}
                style={[styles.close, { backgroundColor: dark ? '#30243b' : c.blush }]}
                accessibilityRole="button"
                accessibilityLabel={t`Close`}
                testID={testID ? `${testID}-close` : undefined}
              >
                <Icon name="Close" size={18} color={ink} />
              </Press>
            </View>
          </View>
        </GestureDetector>
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: 'rgba(27, 19, 34, 0.42)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    paddingHorizontal: 20,
  },
  handleArea: { paddingTop: 10, paddingBottom: 6 },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, gap: 12 },
  title: { fontSize: 24, lineHeight: 30, flexShrink: 1 },
  close: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
});
