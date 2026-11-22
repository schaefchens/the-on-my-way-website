/** Pill and round buttons in the admin's style (press squish 0.965, ≥ 48 dp targets). */
import type { ReactNode } from 'react';
import { type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import type { HapticConstant } from '../../modules/omw-native';
import { type as typeStyles, useTheme } from '../theme';
import { Icon, type IconName } from './icons';
import { Press } from './press';

type Variant = 'primary' | 'soft' | 'ghost' | 'danger';

export function PillButton({
  label,
  onPress,
  variant = 'primary',
  icon,
  disabled,
  testID,
  style,
  feedback,
  accessibilityHint,
  small,
}: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  icon?: IconName;
  disabled?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  feedback?: HapticConstant;
  accessibilityHint?: string;
  small?: boolean;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const bg = { primary: c.accent, soft: c.blush, ghost: 'transparent', danger: c.blush }[variant];
  const fg = { primary: c.onAccent, soft: c.ink, ghost: c.accent, danger: c.danger }[variant];
  return (
    <Press
      onPress={onPress}
      disabled={disabled}
      feedback={feedback}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      accessibilityHint={accessibilityHint}
      testID={testID}
      style={[
        styles.pill,
        small && styles.pillSmall,
        { backgroundColor: bg, opacity: disabled ? 0.45 : 1 },
        variant === 'primary' && { boxShadow: theme.shadows.soft },
        style,
      ]}
    >
      {icon ? <Icon name={icon} size={small ? 16 : 20} color={fg} /> : null}
      <Text style={[typeStyles.label, styles.pillText, small && styles.pillTextSmall, { color: fg }]} numberOfLines={2}>
        {label}
      </Text>
    </Press>
  );
}

export function RoundButton({
  icon,
  label,
  onPress,
  testID,
  size = 48,
  tone = 'surface',
  children,
  feedback,
}: {
  icon?: IconName;
  label: string;
  onPress: () => void;
  testID?: string;
  size?: number;
  /** surface: on the themed background · glass: on the dark camera stage */
  tone?: 'surface' | 'glass';
  children?: ReactNode;
  feedback?: HapticConstant;
}) {
  const theme = useTheme();
  const glass = tone === 'glass';
  return (
    <Press
      onPress={onPress}
      feedback={feedback}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      hitSlop={size < 48 ? (48 - size) / 2 : undefined}
      style={[
        styles.round,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: glass ? 'rgba(18, 12, 23, 0.46)' : theme.colors.surface,
          boxShadow: glass ? undefined : theme.shadows.soft,
        },
      ]}
    >
      {children ??
        (icon ? (
          <Icon name={icon} size={Math.round(size * 0.46)} color={glass ? '#ffffff' : theme.colors.ink} />
        ) : null)}
    </Press>
  );
}

/** A soft card with an optional title (Today's notes and hints). */
export function Card({
  tone = 'surface',
  children,
  style,
  testID,
}: {
  tone?: 'surface' | 'lilac' | 'blush';
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const theme = useTheme();
  const c = theme.colors;
  const bg = { surface: c.surface, lilac: c.lilac, blush: c.blush }[tone];
  return (
    <View
      testID={testID}
      style={[
        styles.card,
        { backgroundColor: bg, borderRadius: theme.radii.card },
        tone === 'surface' && { boxShadow: theme.shadows.soft },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    minHeight: 52,
    paddingHorizontal: 22,
    borderRadius: 9999,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  pillSmall: { minHeight: 40, paddingHorizontal: 14 },
  pillText: { fontSize: 16, textAlign: 'center' },
  pillTextSmall: { fontSize: 14 },
  round: { alignItems: 'center', justifyContent: 'center' },
  card: { padding: 16, gap: 6 },
});
