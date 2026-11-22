/**
 * Signature transition 3 (app-plan §5.2): the "Archived ✓" / "Live ✓" check draws its stroke,
 * short arm then long arm (300 ms, ease-soft). Two rounded bars grow from their start point
 * (scaleX with a left transform origin), so only transforms animate. Reduced motion: drawn at once.
 */
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { EASE_SOFT } from './motion';

const SHORT = { x: 0.2, y: 0.53, len: 0.3, deg: 42 };
const LONG = { x: 0.41, y: 0.73, len: 0.57, deg: -48 };

export function CheckStroke({
  size = 20,
  color,
  animate = true,
  delayMs = 0,
  testID,
}: {
  size?: number;
  color: string;
  animate?: boolean;
  delayMs?: number;
  testID?: string;
}) {
  const reduced = useReducedMotion();
  const instant = !animate || reduced;
  const p = useSharedValue(instant ? 1 : 0);

  useEffect(() => {
    if (instant) {
      p.value = 1;
      return;
    }
    p.value = 0;
    p.value = withDelay(delayMs, withTiming(1, { duration: 300, easing: EASE_SOFT }));
  }, [instant, delayMs, p]);

  const thick = Math.max(2, size * 0.13);
  const short = useAnimatedStyle(() => ({
    transform: [{ rotate: `${SHORT.deg}deg` }, { scaleX: interpolate(p.value, [0, 0.35], [0, 1], 'clamp') }],
  }));
  const long = useAnimatedStyle(() => ({
    transform: [{ rotate: `${LONG.deg}deg` }, { scaleX: interpolate(p.value, [0.3, 1], [0, 1], 'clamp') }],
  }));
  const arm = (a: typeof SHORT) => ({
    position: 'absolute' as const,
    left: a.x * size - thick / 2,
    top: a.y * size - thick / 2,
    width: a.len * size + thick,
    height: thick,
    borderRadius: thick / 2,
    backgroundColor: color,
    transformOrigin: `${thick / 2}px ${thick / 2}px`,
  });

  return (
    <View
      style={{ width: size, height: size }}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      testID={testID}
    >
      <Animated.View style={[arm(SHORT), short]} />
      <Animated.View style={[arm(LONG), long]} />
    </View>
  );
}
