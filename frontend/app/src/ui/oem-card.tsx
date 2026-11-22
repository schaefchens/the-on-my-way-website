/**
 * The battery hint card (app-plan §5.1 "Uploads after a force-stop", §7 OEM limits): phone makers
 * stop background work in their own ways; the card names the right settings path for her phone's
 * brand and opens the app's system settings. Shown once on Today, always available in Settings.
 * Which path really works on her phone is an open check (her phone is not available here).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import { type as typeStyles, useTheme } from '../theme';
import { Card, PillButton } from './button';
import { Icon } from './icons';

export type OemFamily = 'samsung' | 'xiaomi' | 'huawei' | 'oppo' | 'other';

/** The phone family from Build.BRAND / MANUFACTURER (pure; unit-tested). */
export function oemFamily(brand: string | undefined, manufacturer?: string): OemFamily {
  const b = `${brand ?? ''} ${manufacturer ?? ''}`.toLowerCase();
  if (b.includes('samsung')) return 'samsung';
  if (/xiaomi|redmi|poco/.test(b)) return 'xiaomi';
  if (/huawei|honor/.test(b)) return 'huawei';
  if (/oneplus|oppo|realme|vivo/.test(b)) return 'oppo';
  return 'other';
}

export function deviceFamily(): OemFamily {
  const c = Platform.constants as { Brand?: string; Manufacturer?: string };
  return oemFamily(c.Brand, c.Manufacturer);
}

export function OemHintCard({ onDone, testID }: { onDone?: () => void; testID?: string }) {
  const theme = useTheme();
  const { t } = useLingui();
  const family = deviceFamily();
  const path = {
    samsung: t`Settings › Apps › On My Way › Battery › Unrestricted`,
    xiaomi: t`Settings › Apps › On My Way › Battery saver › No restrictions, and switch on Autostart`,
    huawei: t`Settings › Battery › App launch › On My Way › Manage manually (all three on)`,
    oppo: t`Settings › Apps › On My Way › Battery usage › Allow background activity`,
    other: t`Settings › Apps › On My Way › App battery usage › Unrestricted`,
  }[family];
  const c = theme.colors;
  return (
    <Card tone="blush" testID={testID ?? 'oem-card'}>
      <View style={styles.head}>
        <Icon name="Battery" size={20} color={c.accent} />
        <Text style={[typeStyles.label, styles.title, { color: c.ink }]}>
          <Trans>Let uploads run in the background</Trans>
        </Text>
      </View>
      <Text style={[typeStyles.body, styles.body, { color: c.ink }]}>
        <Trans>
          Some phones stop apps to save battery. So your moments keep travelling home while the phone sleeps:
        </Trans>
      </Text>
      <Text style={[typeStyles.bodyBold, styles.body, { color: c.ink }]}>{path}</Text>
      <View style={styles.actions}>
        <PillButton small label={t`Open settings`} onPress={() => void Linking.openSettings()} testID="oem-open" />
        {onDone ? <PillButton small variant="ghost" label={t`Done`} onPress={onDone} testID="oem-done" /> : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 15, flexShrink: 1 },
  body: { fontSize: 14, lineHeight: 20 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
});
