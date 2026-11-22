/**
 * Settings (ux.md §3.14): the connection, the A4 upload rules (stored natively so the uploader
 * decides without JS; defaults: automatic, Wi-Fi only, no photos on mobile data, no roaming),
 * publishing (read-only), haptics, language, the app lock, background uploads, storage, about.
 */
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { type ReactNode, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isNativeAvailable, TokenVault } from '../../modules/omw-native';
import { formatBytes } from '../core/entry';
import { isPending } from '../core/outbox-machine';
import { settingsRelevance } from '../core/upload-rules';
import { type AppLocale, selectableLocales } from '../i18n';
import { outboxBytes } from '../outbox/fs-store';
import { useOutbox } from '../outbox/outbox';
import { applyLocale, type LockAfter, useAppSettings } from '../state/app-settings';
import { useLock } from '../state/lock';
import { type Theme, type as typeStyles, useTheme } from '../theme';
import { PillButton, RoundButton } from '../ui/button';
import { feedback } from '../ui/haptics';
import { Icon, type IconName } from '../ui/icons';
import { OemHintCard } from '../ui/oem-card';
import { Press } from '../ui/press';
import { intlLocale } from '../ui/status';

export default function Settings() {
  const theme = useTheme();
  const { t, i18n } = useLingui();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const outbox = useOutbox();
  const lock = useLock();
  const { settings: app, update } = useAppSettings();
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [bytes, setBytes] = useState<number | null>(null);
  const native = isNativeAvailable();
  const upload = outbox.uploadSettings;
  const network = outbox.network;
  const s = styles(theme);

  useEffect(() => {
    try {
      setBytes(outboxBytes());
    } catch {
      setBytes(null);
    }
  }, []);

  const set = (patch: Parameters<typeof outbox.setUploadSettings>[0], on: boolean) => {
    feedback.toggle(on);
    void outbox.setUploadSettings(patch).catch(() => feedback.reject());
  };

  const networkLine = !network.connected
    ? t`Offline`
    : [
        network.unmetered
          ? t`Wi-Fi`
          : network.transport === 'wifi'
            ? t`Wi-Fi with a data limit (counts as mobile data)`
            : t`Mobile data`,
        network.roaming ? (network.simOperatorName ? t`roaming on ${network.simOperatorName}` : t`roaming`) : null,
        network.validated ? null : t`no internet yet`,
      ]
        .filter(Boolean)
        .join(' · ');

  const languageNames: Record<AppLocale | 'system', string> = {
    system: t`Like the phone`,
    en: 'English',
    de: 'Deutsch',
    ar: t`Pseudo (RTL test)`,
  };
  const relevance = upload ? settingsRelevance(upload) : { photosOnMobileData: true, roaming: false };
  const pending = outbox.entries.filter(isPending).length;
  const kept = outbox.entries.filter((m) => m.phase !== 'draft').length;

  const disconnect = () => {
    const go = async () => {
      await TokenVault.clear();
      outbox.setPaired(false);
      update({ pairing: null, hints: null });
      feedback.confirm();
    };
    Alert.alert(
      t`Disconnect this phone?`,
      pending > 0
        ? plural(pending, {
            one: '# moment is not uploaded yet. It stays on this phone and goes once you connect again.',
            other: '# moments are not uploaded yet. They stay on this phone and go once you connect again.',
          })
        : t`You can connect it again with a new code from the admin.`,
      [
        { text: t`Cancel`, style: 'cancel' },
        { text: t`Disconnect`, style: 'destructive', onPress: () => void go() },
      ],
    );
  };

  const lockOptions: { value: LockAfter; label: string }[] = [
    { value: 0, label: t`Immediately` },
    { value: 60, label: t`After 1 min` },
    { value: 300, label: t`After 5 min` },
  ];

  return (
    <View style={[s.screen, { paddingTop: insets.top + 8 }]} testID="settings-screen">
      <View style={s.topBar}>
        <RoundButton icon="ChevronLeft" label={t`Back`} onPress={() => router.back()} testID="settings-back" />
        <Text style={s.title} accessibilityRole="header">
          <Trans>Settings</Trans>
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }} showsVerticalScrollIndicator={false}>
        <Section title={t`Your website`} icon="Globe" theme={theme}>
          {outbox.paired ? (
            <>
              <Text style={s.rowLabel} testID="connection-line">
                {app.pairing ? t`Connected as “${app.pairing.deviceName}”` : t`Connected`}
              </Text>
              {app.pairing ? (
                <Text style={s.rowHint}>
                  {t`Since ${new Intl.DateTimeFormat(intlLocale(i18n.locale), { day: 'numeric', month: 'long' }).format(new Date(app.pairing.pairedAt))}`}
                </Text>
              ) : null}
              <PillButton
                small
                variant="danger"
                label={t`Disconnect this phone`}
                onPress={disconnect}
                style={s.inlineAction}
                testID="disconnect"
              />
            </>
          ) : (
            <>
              <Text style={s.rowLabel}>
                <Trans>Not connected yet</Trans>
              </Text>
              <Text style={s.rowHint}>
                <Trans>Everything you capture waits safely on this phone until then.</Trans>
              </Text>
              <PillButton
                small
                label={t`Connect`}
                onPress={() => router.push('/pair')}
                style={s.inlineAction}
                testID="settings-connect"
              />
            </>
          )}
        </Section>

        <Section title={t`Uploads`} icon="Upload" theme={theme}>
          <Row
            theme={theme}
            label={t`Upload automatically`}
            hint={
              upload?.mode === 'manual'
                ? t`Off: moments wait on your phone until you tap “Upload now”.`
                : t`Starts by itself when the connection allows it.`
            }
            value={upload?.mode !== 'manual'}
            disabled={!upload || !native}
            onChange={(on) => set({ mode: on ? 'auto' : 'manual' }, on)}
            testID="setting-auto"
          />
          <Row
            theme={theme}
            label={t`Only on Wi-Fi`}
            hint={t`Never on mobile data. A phone hotspot counts as mobile data.`}
            value={upload?.wifiOnly ?? true}
            disabled={!upload || !native}
            onChange={(on) => set({ wifiOnly: on }, on)}
            testID="setting-wifi-only"
          />
          {relevance.photosOnMobileData ? (
            <Row
              theme={theme}
              label={t`Photos, text and voice also on mobile data`}
              hint={t`Videos still wait for Wi-Fi.`}
              value={upload?.photosOnMobileData ?? false}
              disabled={!upload || !native}
              onChange={(on) => set({ photosOnMobileData: on }, on)}
              testID="setting-photos-mobile"
              nested
            />
          ) : null}
          <Row
            theme={theme}
            label={t`Also while roaming`}
            hint={relevance.roaming ? t`On every SIM abroad.` : t`Only matters when mobile data is allowed.`}
            value={upload?.roaming ?? false}
            disabled={!upload || !native}
            onChange={(on) => set({ roaming: on }, on)}
            testID="setting-roaming"
          />
          {upload && upload.roamingAllowedSims.length > 0 ? (
            <View style={s.sims}>
              <Text style={s.rowHint}>
                <Trans>Allowed while roaming:</Trans>
              </Text>
              {upload.roamingAllowedSims.map((sim) => (
                <View key={sim} style={s.simRow}>
                  <Icon name="Signal" size={16} color={theme.colors.muted} />
                  <Text style={s.simText}>
                    {sim === network.simOperator && network.simOperatorName
                      ? `${network.simOperatorName} (${sim})`
                      : sim}
                  </Text>
                  <RoundButton
                    icon="Close"
                    size={36}
                    label={t`Remove ${sim}`}
                    onPress={() =>
                      set({ roamingAllowedSims: upload.roamingAllowedSims.filter((x) => x !== sim) }, false)
                    }
                  />
                </View>
              ))}
            </View>
          ) : null}
          <Text style={s.meta}>
            <Trans>Originals for your archive always wait for Wi-Fi.</Trans>
          </Text>
          <Text style={s.meta} testID="network-line">
            <Trans>Right now: {networkLine}</Trans>
          </Text>
        </Section>

        <Section title={t`Publishing`} icon="Sparkles" theme={theme}>
          <Text style={s.rowLabel}>
            {(app.hints?.archiveOnly ?? true)
              ? t`Archive mode: nothing is published yet`
              : (app.hints?.delayHours ?? 0) > 0
                ? t`Published with a delay of about ${Math.round(app.hints?.delayHours ?? 0)} h`
                : t`Published within about a minute`}
          </Text>
          <Text style={s.rowHint}>
            <Trans>This is set in the admin.</Trans>
          </Text>
        </Section>

        <Section title={t`Feel`} icon="Heart" theme={theme}>
          <Row
            theme={theme}
            label={t`Vibration feedback`}
            hint={t`Light taps for your own touches. The phone’s own setting still applies.`}
            value={app.haptics}
            onChange={(on) => {
              update({ haptics: on });
              if (on) feedback.toggle(true);
            }}
            testID="setting-haptics"
          />
          <Text style={s.rowLabel}>
            <Trans>Language</Trans>
          </Text>
          <View style={s.chips} accessibilityRole="radiogroup">
            {(['system', ...selectableLocales()] as const).map((locale) => {
              const on = app.locale === locale;
              return (
                <Press
                  key={locale}
                  style={[s.chip, on && s.chipOn]}
                  feedback="SEGMENT_TICK"
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  onPress={() => {
                    update({ locale });
                    setRestartNeeded(applyLocale(locale) || restartNeeded);
                  }}
                  testID={`locale-${locale}`}
                >
                  <Text style={[s.chipText, on && s.chipTextOn]}>{languageNames[locale]}</Text>
                </Press>
              );
            })}
          </View>
          {restartNeeded ? (
            <Text style={s.meta}>
              <Trans>Restart the app to switch the text direction.</Trans>
            </Text>
          ) : null}
        </Section>

        <Section title={t`Privacy`} icon="Lock" theme={theme}>
          <Row
            theme={theme}
            label={t`App lock`}
            hint={
              lock.availability === 'no_screen_lock'
                ? t`Set a screen lock on your phone first. Until then the app stays open.`
                : t`Fingerprint, face or PIN before sharing, the queue and Settings. Taking photos always works.`
            }
            value={app.lock.enabled}
            onChange={(on) => {
              feedback.toggle(on);
              update({ lock: { ...app.lock, enabled: on } });
            }}
            testID="setting-lock"
          />
          {app.lock.enabled ? (
            <View style={s.chips} accessibilityRole="radiogroup">
              {lockOptions.map((o) => {
                const on = app.lock.afterSeconds === o.value;
                return (
                  <Press
                    key={o.value}
                    style={[s.chip, on && s.chipOn]}
                    feedback="SEGMENT_TICK"
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    onPress={() => update({ lock: { ...app.lock, afterSeconds: o.value } })}
                    testID={`lock-after-${o.value}`}
                  >
                    <Text style={[s.chipText, on && s.chipTextOn]}>{o.label}</Text>
                  </Press>
                );
              })}
            </View>
          ) : null}
        </Section>

        <View style={s.section}>
          <View style={s.sectionHead}>
            <Icon name="Battery" size={16} color={theme.colors.muted} />
            <Text style={s.sectionTitle} accessibilityRole="header">
              <Trans>Background uploads</Trans>
            </Text>
          </View>
          <OemHintCard testID="settings-oem-card" />
        </View>

        <Section title={t`On this phone`} icon="Inbox" theme={theme}>
          <Text style={s.rowLabel}>
            {plural(kept, { one: '# moment', other: '# moments' })}
            {bytes !== null ? ` · ${formatBytes(bytes, intlLocale(i18n.locale))}` : ''}
          </Text>
          <Text style={s.rowHint}>
            <Trans>Kept here until the archive at home has them. Freeing up space comes later.</Trans>
          </Text>
        </Section>

        <Section title={t`About`} icon="Info" theme={theme}>
          <Text style={s.meta}>
            On My Way {Constants.expoConfig?.version} ({String(Constants.expoConfig?.extra?.versionName ?? 'dev')})
          </Text>
          {native ? null : (
            <Text style={s.meta}>
              <Trans>Native module missing: settings are read-only in this build.</Trans>
            </Text>
          )}
        </Section>
      </ScrollView>
    </View>
  );
}

function Section({
  title,
  icon,
  theme,
  children,
}: {
  title: string;
  icon: IconName;
  theme: Theme;
  children: ReactNode;
}) {
  const s = styles(theme);
  return (
    <View style={s.section}>
      <View style={s.sectionHead}>
        <Icon name={icon} size={16} color={theme.colors.muted} />
        <Text style={s.sectionTitle} accessibilityRole="header">
          {title}
        </Text>
      </View>
      <View style={s.card}>{children}</View>
    </View>
  );
}

function Row(props: {
  theme: Theme;
  label: string;
  hint: string;
  value: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
  testID: string;
  nested?: boolean;
}) {
  const { theme } = props;
  const s = styles(theme);
  const disabled = props.disabled === true;
  // The whole row is the switch (label, hint and the switch itself: one target of at least 48 dp);
  // the Switch only shows the state.
  return (
    <Pressable
      style={({ pressed }) => [s.row, props.nested && s.nested, pressed && !disabled && s.rowPressed]}
      onPress={() => props.onChange(!props.value)}
      disabled={disabled}
      accessibilityRole="switch"
      accessibilityLabel={props.label}
      accessibilityHint={props.hint}
      accessibilityState={{ checked: props.value, disabled }}
      testID={props.testID}
    >
      <View style={s.rowText}>
        <Text style={s.rowLabel}>{props.label}</Text>
        <Text style={s.rowHint}>{props.hint}</Text>
      </View>
      <View pointerEvents="none" importantForAccessibility="no-hide-descendants">
        <Switch
          value={props.value}
          disabled={disabled}
          trackColor={{ false: theme.colors.line, true: theme.colors.accent }}
          thumbColor={theme.name === 'dusk' ? theme.colors.ink : theme.colors.surface}
        />
      </View>
    </Pressable>
  );
}

const styles = (theme: Theme) => {
  const c = theme.colors;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bg, paddingHorizontal: theme.spacing.gutter },
    topBar: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52 },
    title: { ...typeStyles.title, color: c.ink, fontSize: 28 },
    section: { marginTop: 24 },
    sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
    sectionTitle: { ...typeStyles.label, color: c.muted, fontSize: 13, letterSpacing: 0.6 },
    card: {
      borderRadius: theme.radii.card,
      backgroundColor: c.surface,
      padding: 16,
      gap: 14,
      boxShadow: theme.shadows.soft,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 },
    rowPressed: { opacity: 0.7 },
    nested: { paddingStart: 14, borderStartWidth: 2, borderStartColor: c.line },
    rowText: { flex: 1 },
    rowLabel: { ...typeStyles.bodyBold, color: c.ink, fontSize: 16, lineHeight: 22 },
    rowHint: { ...typeStyles.body, color: c.muted, fontSize: 13, lineHeight: 18, marginTop: 2 },
    inlineAction: { alignSelf: 'flex-start' },
    meta: { ...typeStyles.body, color: c.muted, fontSize: 13, lineHeight: 18 },
    sims: { gap: 6 },
    simRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    simText: { ...typeStyles.bodyBold, color: c.ink, fontSize: 14, flex: 1 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: {
      paddingHorizontal: 14,
      minHeight: 40,
      justifyContent: 'center',
      borderRadius: theme.radii.pill,
      backgroundColor: c.blush,
    },
    chipOn: { backgroundColor: c.accent },
    chipText: { ...typeStyles.bodyBold, color: c.ink, fontSize: 14 },
    chipTextOn: { color: c.onAccent },
  });
};
