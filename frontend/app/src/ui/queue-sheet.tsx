/**
 * The queue sheet ("On its way", ux.md §3.11): every shared moment that is not home yet, with the
 * one status vocabulary, one clear action where she can help (Upload, Allow on this SIM, Try
 * again, Connect), and today's safe ones with their check. "Upload now" on mobile data asks once.
 * A moment that needs her can also be removed (asked once; it is withdrawn from the API first).
 */
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef } from 'react';
import { AccessibilityInfo, Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatBytes, localDateIn } from '../core/entry';
import { type EntryStatusView, isPending, type OutboxManifest, originalLine, queueOrder } from '../core/outbox-machine';
import { allowSimPatch, uploadNowQuestion } from '../core/upload-rules';
import { deviceTimeZone, useOutbox } from '../outbox/outbox';
import { type Theme, type as typeStyles, useTheme } from '../theme';
import { PillButton } from './button';
import { CheckStroke } from './check-stroke';
import { EntryThumb } from './entry-thumb';
import { feedback } from './haptics';
import { Icon } from './icons';
import { Sheet } from './sheet';
import { intlLocale, isDone, STATUS_ICONS, statusColor, useStatusText } from './status';

export function useUploadNow() {
  const outbox = useOutbox();
  const { t, i18n } = useLingui();
  return async (entries: readonly OutboxManifest[], entryId?: string) => {
    const settings = outbox.uploadSettings;
    if (!settings) return;
    const waiting = entries
      .filter((m) => (entryId ? m.entryId === entryId : true))
      .map((m) => ({
        kind: m.kind,
        bytes: m.files.filter((f) => f.role !== 'original').reduce((s, f) => s + f.bytes, 0),
      }));
    const q = uploadNowQuestion(waiting, settings, outbox.network);
    if (!q.ask) {
      await outbox.uploadNow(entryId ? { entryId } : {});
      return;
    }
    const size = formatBytes(q.bytes, intlLocale(i18n.locale));
    Alert.alert(t`You’re on mobile data`, t`Upload ${size} anyway?`, [
      { text: t`Wait for Wi-Fi`, style: 'cancel', onPress: () => void outbox.uploadNow(entryId ? { entryId } : {}) },
      {
        text: t`Upload anyway`,
        onPress: () => void outbox.uploadNow({ ...(entryId ? { entryId } : {}), allowMetered: true }),
      },
    ]);
  };
}

export function QueueSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const theme = useTheme();
  const { t } = useLingui();
  const router = useRouter();
  const outbox = useOutbox();
  const uploadNow = useUploadNow();
  const { label, detail, original } = useStatusText();
  const s = styles(theme);

  useEffect(() => {
    if (open) void outbox.refresh({ server: true });
  }, [open]);

  const today = localDateIn(new Date(), deviceTimeZone());
  const rows = useMemo(
    () =>
      outbox.entries
        .filter((m) => isPending(m) || m.phase === 'uploaded' || originalLine(m) !== null)
        .sort(queueOrder)
        .map((m) => ({ m, view: outbox.statusOf(m) }))
        .filter((r): r is { m: OutboxManifest; view: EntryStatusView } => r.view !== null),
    [outbox],
  );
  const safeToday = outbox.entries.filter(
    (m) =>
      m.phase === 'archived' &&
      originalLine(m) === null &&
      m.sharedAt &&
      localDateIn(m.sharedAt, m.tz ?? deviceTimeZone()) === today,
  );
  const waitingForTap = rows.filter((r) => ['ready', 'waiting_wifi', 'waiting_network'].includes(r.view.status));
  const uploaded = rows.filter((r) => r.view.status === 'uploaded').length;

  // TalkBack: one polite, grouped line when the counts change (never per percent).
  const lastAnnounced = useRef('');
  useEffect(() => {
    if (!open || rows.length === 0) return;
    const line = t`${uploaded} of ${rows.length} uploaded`;
    if (line !== lastAnnounced.current) {
      lastAnnounced.current = line;
      AccessibilityInfo.announceForAccessibility(line);
    }
  }, [open, uploaded, rows.length, t]);

  const carrier = outbox.network.simOperatorName;

  return (
    <Sheet open={open} onClose={onClose} title={t`On its way`} testID="queue-sheet">
      <ScrollView style={s.scroll} contentContainerStyle={s.content}>
        {!outbox.paired ? (
          <View style={s.banner}>
            <Icon name="Link" size={20} color={theme.colors.violet} />
            <Text style={s.bannerText}>
              <Trans>Not connected to your website yet. Your moments wait here, safely.</Trans>
            </Text>
            <PillButton
              small
              label={t`Connect`}
              onPress={() => {
                onClose();
                router.push('/pair');
              }}
              testID="queue-connect"
            />
          </View>
        ) : null}

        {waitingForTap.length > 0 && outbox.paired ? (
          <PillButton
            label={t`Upload now`}
            icon="Upload"
            onPress={() => void uploadNow(waitingForTap.map((r) => r.m))}
            testID="upload-now-all"
            style={s.uploadAll}
          />
        ) : null}

        {rows.length === 0 ? (
          <View style={s.empty} testID="queue-empty">
            <CheckStroke size={28} color={theme.colors.success} />
            <Text style={s.emptyText}>
              <Trans>Everything is safe. Nothing is waiting.</Trans>
            </Text>
          </View>
        ) : (
          rows.map(({ m, view }) => (
            <QueueRow
              key={m.entryId}
              m={m}
              view={view}
              theme={theme}
              label={label(view)}
              detail={detail(view, carrier)}
              original={original(m)}
              onUpload={() =>
                void uploadNow(
                  rows.map((r) => r.m),
                  m.entryId,
                )
              }
              onAllowSim={() => {
                const settings = outbox.uploadSettings;
                const patch = settings ? allowSimPatch(settings, outbox.network) : null;
                if (patch) {
                  feedback.toggle(true);
                  void outbox.setUploadSettings(patch);
                }
              }}
              onRetry={() => {
                void outbox.retry(m.entryId).catch(() => feedback.reject());
              }}
              onRemove={() => {
                Alert.alert(t`Remove this moment?`, t`It isn’t home yet. It will be deleted from your phone.`, [
                  { text: t`Keep it`, style: 'cancel' },
                  {
                    text: t`Remove`,
                    style: 'destructive',
                    onPress: () => {
                      feedback.reject();
                      void outbox.discard(m.entryId).catch(() => {});
                    },
                  },
                ]);
              }}
              onConnect={() => {
                onClose();
                router.push('/pair');
              }}
              carrier={carrier}
            />
          ))
        )}

        {safeToday.length > 0 ? (
          <View style={s.safe}>
            <Text style={s.sectionTitle}>
              {plural(safeToday.length, {
                one: 'Safe at home today: # moment',
                other: 'Safe at home today: # moments',
              })}
            </Text>
            <View style={s.safeStrip}>
              {safeToday.slice(0, 8).map((m, i) => (
                <View key={m.entryId} style={s.safeItem}>
                  <EntryThumb m={m} size={44} />
                  <View style={s.safeCheck}>
                    <CheckStroke size={14} color="#ffffff" delayMs={i * 60} />
                  </View>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

function QueueRow(props: {
  m: OutboxManifest;
  view: EntryStatusView;
  theme: Theme;
  label: string;
  detail: string | null;
  /** The archive original's own line (Q2 c). */
  original: string | null;
  carrier: string | null;
  onUpload: () => void;
  onAllowSim: () => void;
  onRetry: () => void;
  onRemove: () => void;
  onConnect: () => void;
}) {
  const { m, view, theme } = props;
  const { t } = useLingui();
  const s = styles(theme);
  const color = statusColor(view.status, theme);
  const reconnect = view.reason === 'not_paired' || view.reason === 'unauthorized';
  return (
    <View
      style={s.row}
      testID={`queue-row-${m.entryId}`}
      accessible
      accessibilityLabel={[props.label, props.detail, props.original].filter(Boolean).join('. ')}
    >
      <EntryThumb m={m} size={52} radius={8} />
      <View style={s.rowText}>
        <View style={s.rowTitle}>
          {isDone(view.status) ? (
            <CheckStroke size={16} color={color} />
          ) : (
            <Icon name={STATUS_ICONS[view.status]} size={16} color={color} />
          )}
          <Text
            style={[s.rowLabel, { color: view.status === 'needs_you' ? theme.colors.danger : theme.colors.ink }]}
            testID="queue-row-status"
          >
            {props.label}
          </Text>
        </View>
        {props.detail ? <Text style={s.rowDetail}>{props.detail}</Text> : null}
        {props.original ? (
          <Text style={s.rowDetail} testID="queue-row-original">
            {props.original}
          </Text>
        ) : null}
        {view.status === 'uploading' ? (
          <View style={s.bar}>
            <View style={[s.barFill, { width: `${view.percent ?? 0}%` }]} />
          </View>
        ) : null}
        {view.status === 'ready' ? (
          <PillButton
            small
            variant="soft"
            label={t`Upload`}
            onPress={props.onUpload}
            style={s.rowAction}
            testID="row-upload"
          />
        ) : null}
        {view.status === 'waiting_roaming' ? (
          <PillButton
            small
            variant="soft"
            label={props.carrier ? t`Allow on ${props.carrier}` : t`Allow on this SIM`}
            onPress={props.onAllowSim}
            style={s.rowAction}
            testID="row-allow-sim"
          />
        ) : null}
        {view.status === 'needs_you' && !reconnect ? (
          <View style={s.rowActions}>
            <PillButton
              small
              variant="soft"
              icon="Refresh"
              label={t`Try again`}
              onPress={props.onRetry}
              testID="row-retry"
            />
            <PillButton
              small
              variant="ghost"
              icon="Trash"
              label={t`Remove`}
              onPress={props.onRemove}
              testID="row-remove"
            />
          </View>
        ) : null}
        {reconnect && view.status === 'needs_you' ? (
          <PillButton small variant="soft" label={t`Connect`} onPress={props.onConnect} style={s.rowAction} />
        ) : null}
      </View>
    </View>
  );
}

const styles = (theme: Theme) => {
  const c = theme.colors;
  return StyleSheet.create({
    scroll: { marginTop: 8 },
    content: { paddingBottom: 12, gap: 4 },
    banner: {
      backgroundColor: c.lilac,
      borderRadius: 20,
      padding: 14,
      gap: 10,
      marginBottom: 8,
      alignItems: 'flex-start',
    },
    bannerText: { ...typeStyles.body, color: c.ink, fontSize: 15, lineHeight: 21 },
    uploadAll: { alignSelf: 'stretch', marginBottom: 8 },
    empty: { alignItems: 'center', gap: 10, paddingVertical: 28 },
    emptyText: { ...typeStyles.hand, color: c.muted, fontSize: 16, textAlign: 'center' },
    row: {
      flexDirection: 'row',
      gap: 14,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.line,
      alignItems: 'flex-start',
    },
    rowText: { flex: 1, gap: 4 },
    rowTitle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    rowLabel: { ...typeStyles.bodyBold, fontSize: 16 },
    rowDetail: { ...typeStyles.body, color: c.muted, fontSize: 14, lineHeight: 19 },
    rowAction: { alignSelf: 'flex-start', marginTop: 6 },
    rowActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
    bar: { height: 6, borderRadius: 3, backgroundColor: c.lilac, overflow: 'hidden', marginTop: 4 },
    barFill: { height: 6, borderRadius: 3, backgroundColor: c.violet },
    safe: { marginTop: 18, gap: 10 },
    sectionTitle: { ...typeStyles.label, color: c.muted, fontSize: 13, letterSpacing: 0.4 },
    safeStrip: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    safeItem: { width: 44, height: 44 },
    safeCheck: {
      position: 'absolute',
      right: -4,
      bottom: -4,
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: c.success,
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
};
