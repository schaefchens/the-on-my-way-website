import type { ReactNode } from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { type HapticConstant, haptic } from '../../modules/omw-native';

type Props = Omit<PressableProps, 'style' | 'children'> & {
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
  /** Android feedback constant for this touch; ordinary buttons get only the visual press. */
  feedback?: HapticConstant;
};

/** A Pressable with the gentle press squish of the site (0.965) and optional haptics. */
export function Press({ style, children, feedback, onPress, ...rest }: Props) {
  return (
    <Pressable
      {...rest}
      onPress={(e) => {
        if (feedback) void haptic(feedback);
        onPress?.(e);
      }}
      style={({ pressed }) => [style, pressed && { transform: [{ scale: 0.965 }], opacity: 0.92 }]}
    >
      {children}
    </Pressable>
  );
}
