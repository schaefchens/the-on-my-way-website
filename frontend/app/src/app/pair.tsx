/**
 * Pairing (app-plan §5.1, contracts APP_PAIRING): the 8-character code typed (shown as
 * "ABCD-EFGH", look-alikes forgiven), or the omw://pair#<code> link opened from the admin on this
 * phone or from a chat. A link only fills the code: she confirms with one tap, and the API base
 * always comes from the build, never from the link. The token goes straight into the TokenVault.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { appPairingCodeFromLink, formatAppTypedPairingCode, normalizeAppPairingCode } from '@omw/contracts/app';
import Constants from 'expo-constants';
import { getRandomBytes } from 'expo-crypto';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TokenVault } from '../../modules/omw-native';
import { AppApiError, pairPhone } from '../api/client';
import { INSTALL_ID_PATTERN, makeInstallId } from '../core/install-id';
import { useOutbox } from '../outbox/outbox';
import { useAppSettings } from '../state/app-settings';
import { type Theme, type as typeStyles, useTheme } from '../theme';
import { Card, PillButton, RoundButton } from '../ui/button';
import { CheckStroke } from '../ui/check-stroke';
import { feedback } from '../ui/haptics';
import { Icon } from '../ui/icons';

type Status = 'idle' | 'busy' | 'done' | { error: string };

/** "k7q2 m9px" -> "K7Q2-M9PX" while typing (display only; the API gets the normalized code). */
export function formatTypedInput(raw: string): string {
  const clean = raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .slice(0, 8);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

export default function Pair() {
  const theme = useTheme();
  const { t } = useLingui();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const outbox = useOutbox();
  const { settings, update } = useAppSettings();
  const url = Linking.useLinkingURL();
  const [typed, setTyped] = useState('');
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const s = styles(theme);

  useEffect(() => {
    const code = url ? appPairingCodeFromLink(url) : null;
    if (code) setLinkCode(code);
  }, [url]);

  const code = linkCode ?? normalizeAppPairingCode(typed);

  const connect = async () => {
    if (!code || status === 'busy') return;
    setStatus('busy');
    const c = Platform.constants as { Model?: string; Brand?: string };
    const deviceName = [c.Brand, c.Model].filter(Boolean).join(' ').slice(0, 100) || 'Android phone';
    // The same install connected again continues its moments on the way (kept before the request).
    const installId =
      settings.installId && INSTALL_ID_PATTERN.test(settings.installId)
        ? settings.installId
        : makeInstallId((n) => getRandomBytes(n));
    if (installId !== settings.installId) update({ installId });
    try {
      const res = await pairPhone({
        code,
        deviceName,
        installId,
        appVersion: String(Constants.expoConfig?.extra?.versionName ?? Constants.expoConfig?.version ?? 'dev').slice(
          0,
          40,
        ),
      });
      await TokenVault.set(res.token);
      update({ pairing: { deviceName, pairedAt: new Date().toISOString(), tokenName: res.info.name } });
      outbox.setPaired(true);
      feedback.confirm();
      setStatus('done');
    } catch (e) {
      feedback.reject();
      // Development builds only: the reason (never the token: errors don't carry it).
      if (__DEV__) console.warn(`Pairing failed: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
      const codeOf = e instanceof AppApiError ? e.code : 'server';
      setStatus({
        error:
          codeOf === 'pairing_expired'
            ? t`This code has expired. Show a new one in the admin.`
            : codeOf === 'pairing_invalid'
              ? t`This code doesn’t work. Check it, or show a new one in the admin.`
              : codeOf === 'rate_limited' || codeOf === 'busy'
                ? t`Too many tries. Wait a minute, then try again.`
                : codeOf === 'network'
                  ? t`No connection to your website right now. Try again later.`
                  : t`That didn’t work. Try again with a new code from the admin.`,
      });
    }
  };

  const close = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  if (status === 'done') {
    return (
      <View style={[s.screen, s.done, { paddingTop: insets.top + 24 }]} testID="pair-done">
        <View style={s.checkCircle}>
          <CheckStroke size={56} color="#ffffff" />
        </View>
        <Text style={s.title} accessibilityRole="header">
          <Trans>Connected ✓</Trans>
        </Text>
        <Text style={s.body}>
          <Trans>Your moments now travel home to your archive. Nothing is published yet.</Trans>
        </Text>
        <PillButton label={t`Start`} onPress={() => router.replace('/')} testID="pair-start" style={s.wide} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={s.screen} behavior="padding">
      <ScrollView
        contentContainerStyle={[s.content, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
        testID="pair-screen"
      >
        <RoundButton icon="ChevronLeft" label={t`Back`} onPress={close} testID="pair-back" />
        <Text style={s.title} accessibilityRole="header">
          <Trans>Connect to your website</Trans>
        </Text>
        <Text style={s.body}>
          <Trans>In the admin: Settings › “Connect a phone”. Then type the code, or open its link on this phone.</Trans>
        </Text>

        {linkCode ? (
          <Card tone="lilac" testID="pair-link-card">
            <View style={s.row}>
              <Icon name="Link" size={20} color={theme.colors.violet} />
              <Text style={s.cardTitle}>
                <Trans>A connection link was opened</Trans>
              </Text>
            </View>
            <Text style={s.hint}>
              <Trans>Connect this phone with it? Only do this with a link from your own admin.</Trans>
            </Text>
            <View style={s.row}>
              <PillButton small label={t`Use another code`} variant="ghost" onPress={() => setLinkCode(null)} />
            </View>
          </Card>
        ) : (
          <View style={s.inputBox}>
            <TextInput
              value={formatTypedInput(typed)}
              onChangeText={(v) => {
                setTyped(v);
                if (typeof status === 'object') setStatus('idle');
              }}
              placeholder="K7Q2-M9PX"
              placeholderTextColor={theme.colors.line}
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="off"
              maxLength={9}
              style={s.input}
              accessibilityLabel={t`Connection code`}
              accessibilityHint={t`8 letters and numbers from the admin`}
              testID="pair-code"
              onSubmitEditing={() => void connect()}
            />
            {/* Only when the look-alikes were forgiven (O -> 0, I/L -> 1): show what really goes out. */}
            {code && code.length === 8 && formatAppTypedPairingCode(code) !== formatTypedInput(typed) ? (
              <Text style={s.hint} testID="pair-code-normalized">
                {formatAppTypedPairingCode(code)}
              </Text>
            ) : null}
          </View>
        )}

        {typeof status === 'object' ? (
          <View style={s.error} accessibilityLiveRegion="assertive" testID="pair-error">
            <Icon name="Alert" size={18} color={theme.colors.danger} />
            <Text style={s.errorText}>{status.error}</Text>
          </View>
        ) : null}

        <PillButton
          label={status === 'busy' ? t`Connecting…` : t`Connect`}
          icon="Link"
          onPress={() => void connect()}
          disabled={!code || status === 'busy'}
          testID="pair-connect"
          style={s.wide}
        />
        <Text style={s.small}>
          <Trans>
            The phone gets a key that can only add your own moments. You can disconnect it in the admin at any time.
          </Trans>
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = (theme: Theme) => {
  const c = theme.colors;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bg },
    content: { paddingHorizontal: theme.spacing.gutter, gap: 16 },
    done: { alignItems: 'center', paddingHorizontal: 32, gap: 16, justifyContent: 'center' },
    checkCircle: {
      width: 96,
      height: 96,
      borderRadius: 48,
      backgroundColor: c.success,
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: theme.shadows.lift,
    },
    title: { ...typeStyles.title, color: c.ink, fontSize: 30, lineHeight: 36, marginTop: 8 },
    body: { ...typeStyles.body, color: c.ink, fontSize: 16, lineHeight: 23 },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    cardTitle: { ...typeStyles.label, color: c.ink, fontSize: 15, flexShrink: 1 },
    hint: { ...typeStyles.body, color: c.muted, fontSize: 14, lineHeight: 20 },
    inputBox: { gap: 6 },
    input: {
      ...typeStyles.label,
      color: c.ink,
      fontSize: 30,
      letterSpacing: 4,
      textAlign: 'center',
      minHeight: 64,
      borderRadius: 20,
      backgroundColor: c.surface,
      boxShadow: theme.shadows.soft,
    },
    error: {
      flexDirection: 'row',
      gap: 8,
      alignItems: 'flex-start',
      padding: 12,
      borderRadius: 16,
      backgroundColor: c.blush,
    },
    errorText: { ...typeStyles.bodyBold, color: c.danger, fontSize: 14, lineHeight: 20, flex: 1 },
    wide: { alignSelf: 'stretch' },
    small: { ...typeStyles.body, color: c.muted, fontSize: 13, lineHeight: 18 },
  });
};
