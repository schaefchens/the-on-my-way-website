/**
 * The publish sheet (ux.md §3.10): when the moment should appear (As usual / Hold back / Only for
 * me), the day ("Put it on that day?"), and the per-entry upload override (A4). In archive-only
 * mode (Q8 a) it says plainly that nothing goes public yet: the choice is kept for later.
 * "Now" comes with v0.6 (fresh fingerprint), so it is not offered here.
 */
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { AppVisibilityChoice } from '@omw/contracts/app';
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { DEFAULT_UPLOAD_SETTINGS, type UploadMode } from '../../modules/omw-native';
import { effectiveMode } from '../core/upload-rules';
import { useOutbox } from '../outbox/outbox';
import { useAppSettings } from '../state/app-settings';
import { type Theme, type as typeStyles, useTheme } from '../theme';
import { PillButton } from './button';
import { feedback } from './haptics';
import { Icon } from './icons';
import { Press } from './press';
import { Sheet } from './sheet';

export interface PublishChoice {
  visibility: AppVisibilityChoice | null;
  mode: UploadMode | null;
  /** Days she said yes to ("Put it on that day?"). */
  acceptedDays: string[];
}

export const AS_USUAL: PublishChoice = { visibility: null, mode: null, acceptedDays: [] };

/** The short publish line above the send button ("Today · To your archive"). */
export function usePublishLine(choice: PublishChoice, dayLabel?: string | null) {
  const { t } = useLingui();
  const { settings } = useAppSettings();
  const outbox = useOutbox();
  const archiveOnly = settings.hints?.archiveOnly ?? true;
  const when =
    choice.visibility === 'pending'
      ? t`Held back`
      : choice.visibility === 'hidden'
        ? t`Only for me`
        : archiveOnly
          ? t`To your archive`
          : (settings.hints?.delayHours ?? 0) > 0
            ? t`Appears in about ${Math.round(settings.hints?.delayHours ?? 0)} h`
            : t`On the site in about a minute`;
  const mode = effectiveMode(outbox.uploadSettings ?? DEFAULT_UPLOAD_SETTINGS, choice.mode);
  const upload = mode === 'manual' ? t`waits for “Upload now”` : null;
  return [dayLabel ?? t`Today`, when, upload].filter(Boolean).join(' · ');
}

export function PublishSheet({
  open,
  onClose,
  count,
  choice,
  onChange,
  onShare,
  daySuggestions,
}: {
  open: boolean;
  onClose: () => void;
  count: number;
  choice: PublishChoice;
  onChange: (choice: PublishChoice) => void;
  onShare: () => void;
  /** "This photo is from Tue 17 Nov" chips: one per day. */
  daySuggestions: { day: string; label: string; count: number }[];
}) {
  const theme = useTheme();
  const { t } = useLingui();
  const { settings } = useAppSettings();
  const outbox = useOutbox();
  const s = styles(theme);
  const archiveOnly = settings.hints?.archiveOnly ?? true;
  const delay = Math.round(settings.hints?.delayHours ?? 0);
  const uploadSettings = outbox.uploadSettings;
  const mode = uploadSettings ? effectiveMode(uploadSettings, choice.mode) : 'auto';
  const onWifiOnly = uploadSettings?.wifiOnly && !outbox.network.unmetered;

  const asUsual = archiveOnly
    ? t`As usual, once publishing starts`
    : delay > 0
      ? t`As usual: appears in about ${delay} h`
      : t`As usual: on the site in about a minute`;

  const options: {
    value: AppVisibilityChoice | null;
    title: string;
    hint: string;
    icon: 'Globe' | 'Pause' | 'EyeOff';
  }[] = [
    { value: null, title: asUsual, hint: t`The website’s delay and rules apply.`, icon: 'Globe' },
    { value: 'pending', title: t`Hold back`, hint: t`I’ll release it later.`, icon: 'Pause' },
    { value: 'hidden', title: t`Only for me`, hint: t`Kept in the archive, never shown.`, icon: 'EyeOff' },
  ];

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={plural(count, { one: 'Share # moment', other: 'Share # moments' })}
      testID="publish-sheet"
    >
      <ScrollView contentContainerStyle={s.content}>
        {archiveOnly ? (
          <View style={s.note} testID="publish-archive-note">
            <Icon name="Lock" size={18} color={theme.colors.violet} />
            <Text style={s.noteText}>
              <Trans>
                Archive mode: nothing goes public yet. Your moments go safely to the archive at home, and this choice
                counts once publishing starts.
              </Trans>
            </Text>
          </View>
        ) : null}

        {daySuggestions.map((d) => {
          const on = choice.acceptedDays.includes(d.day);
          return (
            <View key={d.day} style={s.row}>
              <Icon name="Calendar" size={20} color={theme.colors.accent} />
              <View style={s.rowText}>
                <Text style={s.rowTitle}>
                  {d.count === 1 ? t`This photo is from ${d.label}` : t`${d.count} photos are from ${d.label}`}
                </Text>
                <Text style={s.rowHint}>
                  <Trans>Put it on that day?</Trans>
                </Text>
              </View>
              <Switch
                value={on}
                onValueChange={(v) => {
                  feedback.toggle(v);
                  onChange({
                    ...choice,
                    acceptedDays: v ? [...choice.acceptedDays, d.day] : choice.acceptedDays.filter((x) => x !== d.day),
                  });
                }}
                accessibilityLabel={t`Put it on ${d.label}`}
                trackColor={{ false: theme.colors.line, true: theme.colors.accent }}
                thumbColor={theme.name === 'dusk' ? theme.colors.ink : theme.colors.surface}
                testID={`day-${d.day}`}
              />
            </View>
          );
        })}

        <Text style={s.section} accessibilityRole="header">
          <Trans>When should it appear?</Trans>
        </Text>
        <View accessibilityRole="radiogroup">
          {options.map((o) => {
            const selected = choice.visibility === o.value;
            return (
              <Press
                key={o.value ?? 'usual'}
                onPress={() => {
                  if (!selected) feedback.step();
                  onChange({ ...choice, visibility: o.value });
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                style={[s.option, selected && s.optionOn]}
                testID={`publish-option-${o.value ?? 'usual'}`}
              >
                <View style={[s.radio, selected && s.radioOn]}>{selected ? <View style={s.radioDot} /> : null}</View>
                <View style={s.rowText}>
                  <Text style={s.rowTitle}>{o.title}</Text>
                  <Text style={s.rowHint}>{o.hint}</Text>
                </View>
                <Icon name={o.icon} size={20} color={selected ? theme.colors.accent : theme.colors.muted} />
              </Press>
            );
          })}
        </View>

        <View style={[s.row, s.uploadRow]}>
          <Icon name="Upload" size={20} color={theme.colors.muted} />
          <View style={s.rowText}>
            <Text style={s.rowTitle}>
              {mode === 'auto'
                ? onWifiOnly
                  ? t`Upload: automatically, on Wi-Fi`
                  : t`Upload: automatically`
                : t`Upload: when I tap “Upload now”`}
            </Text>
            <Text style={s.rowHint}>
              {plural(count, { one: 'Only for this moment.', other: 'Only for these # moments.' })}
            </Text>
          </View>
          <Switch
            value={mode === 'auto'}
            onValueChange={(v) => {
              feedback.toggle(v);
              onChange({ ...choice, mode: v ? 'auto' : 'manual' });
            }}
            accessibilityLabel={t`Upload automatically`}
            trackColor={{ false: theme.colors.line, true: theme.colors.accent }}
            thumbColor={theme.name === 'dusk' ? theme.colors.ink : theme.colors.surface}
            testID="publish-upload-auto"
          />
        </View>

        <PillButton label={t`Share`} icon="Send" onPress={onShare} testID="publish-share" style={s.share} />
      </ScrollView>
    </Sheet>
  );
}

const styles = (theme: Theme) => {
  const c = theme.colors;
  return StyleSheet.create({
    content: { paddingTop: 12, paddingBottom: 8, gap: 10 },
    note: { flexDirection: 'row', gap: 10, backgroundColor: c.lilac, borderRadius: 20, padding: 14 },
    noteText: { ...typeStyles.body, color: c.ink, fontSize: 14, lineHeight: 20, flex: 1 },
    section: { ...typeStyles.label, color: c.muted, fontSize: 13, letterSpacing: 0.4, marginTop: 6 },
    option: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderRadius: 18,
      marginBottom: 6,
      backgroundColor: c.bg,
    },
    optionOn: { backgroundColor: c.blush },
    radio: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 2,
      borderColor: c.muted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    radioOn: { borderColor: c.accent },
    radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: c.accent },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
    uploadRow: { marginTop: 4 },
    rowText: { flex: 1, gap: 2 },
    rowTitle: { ...typeStyles.bodyBold, color: c.ink, fontSize: 15, lineHeight: 20 },
    rowHint: { ...typeStyles.body, color: c.muted, fontSize: 13, lineHeight: 18 },
    share: { marginTop: 8 },
  });
};
