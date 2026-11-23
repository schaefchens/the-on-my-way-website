/**
 * Today (home, ux.md §3.2): greeting, the archive-only note, today's moments as polaroids with
 * their state, the drafts line, calm cards (connect, background uploads, roaming), and the capture
 * row in the thumb zone: Gallery · ◉ Capture · Text.
 *
 * Gestures on ◉ (each with a visible alternative): tap = camera (circular reveal), hold = camera
 * straight into video, swipe up = camera. The sync pill opens the queue sheet.
 * Signature transitions here: the camera reveal (1) and the send flight into the strip (2).
 */
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useFocusEffect, useRouter } from 'expo-router';
import { type ComponentRef, useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { localDateIn } from '../core/entry';
import { type OutboxManifest, pillSummary } from '../core/outbox-machine';
import { allowSimPatch } from '../core/upload-rules';
import { deviceTimeZone, useOutbox } from '../outbox/outbox';
import { useGalleryPick } from '../outbox/use-gallery';
import { useAppSettings } from '../state/app-settings';
import { useLock } from '../state/lock';
import { type Theme, type as typeStyles, useTheme } from '../theme';
import { Card, PillButton, RoundButton } from '../ui/button';
import { CheckStroke } from '../ui/check-stroke';
import { EntryThumb } from '../ui/entry-thumb';
import { dayPart } from '../ui/greeting';
import { feedback } from '../ui/haptics';
import { Icon } from '../ui/icons';
import { REDUCED_FADE, SPRINGS } from '../ui/motion';
import { OemHintCard } from '../ui/oem-card';
import { Press } from '../ui/press';
import { QueueSheet } from '../ui/queue-sheet';
import { Sheet } from '../ui/sheet';
import { intlLocale, isDone, STATUS_ICONS, statusColor, useStatusText } from '../ui/status';
import { useToast } from '../ui/toast';

const STAGE = '#120c17';
const POLAROID = 108;

export default function Today() {
  const theme = useTheme();
  const { t, i18n } = useLingui();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const outbox = useOutbox();
  const toast = useToast();
  const lock = useLock();
  const { settings, update } = useAppSettings();
  const reduced = useReducedMotion();
  const { width: screenW, height: screenH } = useWindowDimensions();
  const [queueOpen, setQueueOpen] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [roamingDismissed, setRoamingDismissed] = useState(false);
  const [hiddenDrafts, setHiddenDrafts] = useState<string[]>([]);
  const gallery = useGalleryPick();
  const busy = gallery.busy;
  const statusText = useStatusText();
  const kindLabel = (kind: OutboxManifest['kind']) =>
    kind === 'photo' ? t`Photo` : kind === 'video' ? t`Video` : kind === 'voice' ? t`Voice note` : t`Text`;
  const s = styles(theme);

  // ---- data

  const tz = deviceTimeZone();
  const now = new Date();
  const today = localDateIn(now, tz);
  const todays = useMemo(
    () =>
      outbox.entries.filter(
        (m) =>
          m.phase !== 'draft' &&
          m.phase !== 'withdrawn' &&
          m.sharedAt !== undefined &&
          localDateIn(m.sharedAt, m.tz ?? tz) === today,
      ),
    [outbox.entries, today, tz],
  );
  const drafts = outbox.entries.filter((m) => m.phase === 'draft' && !hiddenDrafts.includes(m.entryId));
  const views = outbox.entries.map((m) => outbox.statusOf(m));
  const pill = pillSummary(views);
  const roamingWaiting = !roamingDismissed && views.some((v) => v?.status === 'waiting_roaming');

  const part = dayPart(now.getHours());
  const greeting =
    part === 'night'
      ? t`Good night`
      : part === 'morning'
        ? t`Good morning`
        : part === 'day'
          ? t`Hello`
          : t`Good evening`;
  const date = new Intl.DateTimeFormat(intlLocale(i18n.locale), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(now);
  const pillText =
    pill.kind === 'all_safe'
      ? t`All safe`
      : pill.kind === 'needs_you'
        ? plural(pill.count, { one: '# needs you', other: '# need you' })
        : pill.kind === 'ready'
          ? plural(pill.count, { one: '# ready to upload', other: '# ready to upload' })
          : pill.kind === 'waiting_wifi'
            ? plural(pill.count, { one: '# waits for Wi-Fi', other: '# wait for Wi-Fi' })
            : plural(pill.count, { one: '# on its way', other: '# on their way' });
  const pillIcon =
    pill.kind === 'needs_you'
      ? 'Alert'
      : pill.kind === 'waiting_wifi'
        ? 'Wifi'
        : pill.kind === 'ready'
          ? 'Upload'
          : 'Plane';
  const pillColor =
    pill.kind === 'needs_you'
      ? theme.colors.danger
      : pill.kind === 'all_safe'
        ? theme.colors.success
        : theme.colors.violet;

  // ---- signature transition 1: the camera reveal from ◉

  const captureRef = useRef<ComponentRef<typeof View>>(null);
  const reveal = useSharedValue(0);
  const [revealAt, setRevealAt] = useState<{ x: number; y: number } | null>(null);
  const radius = Math.hypot(screenW, screenH);

  const openCamera = useCallback(
    (params?: { start?: 'video' }) => {
      if (!settings.coachSeen) update({ coachSeen: true });
      // The camera opens exactly once, whether or not the reveal reports "finished": some devices
      // (e-ink tablets with animations off) never finish it, and a tap must never be lost.
      let went = false;
      const go = () => {
        if (went) return;
        went = true;
        clearTimeout(fallback);
        router.push({ pathname: '/camera', params: params ?? {} });
      };
      const fallback = setTimeout(go, reduced ? 250 : 900);
      const node = captureRef.current;
      if (!node) {
        go();
        return;
      }
      node.measureInWindow((x, y, w, h) => {
        setRevealAt({ x: x + w / 2, y: y + h / 2 });
        reveal.value = 0;
        const done = () => {
          'worklet';
          scheduleOnRN(go);
        };
        reveal.value = reduced
          ? withTiming(1, REDUCED_FADE, done)
          : withSpring(1, { ...SPRINGS.soft, overshootClamping: true }, done);
      });
    },
    [reduced, reveal, router, settings.coachSeen, update],
  );

  useFocusEffect(
    useCallback(() => {
      // Coming back from the camera: the stage shrinks away under the visible screen.
      reveal.value = withTiming(0, { duration: reduced ? 0 : 160 });
    }, [reduced, reveal]),
  );

  const revealStyle = useAnimatedStyle(() =>
    reduced
      ? { opacity: reveal.value, transform: [{ scale: 1 }] }
      : {
          opacity: reveal.value > 0.001 ? 1 : 0,
          transform: [{ scale: interpolate(reveal.value, [0, 1], [44 / radius, 1]) }],
        },
  );

  const swipeUp = usePanGesture({
    activeOffsetY: -24,
    failOffsetX: [-24, 24],
    runOnJS: true,
    onActivate: () => openCamera(),
  });

  // ---- signature transition 2: the send flight into the strip

  const firstSlot = useRef<ComponentRef<typeof View>>(null);
  const flight = useSharedValue(1);
  const [flying, setFlying] = useState<{
    entry: OutboxManifest;
    from: { x: number; y: number };
    to: { x: number; y: number };
  } | null>(null);
  const playedAt = useRef(0);

  useFocusEffect(
    useCallback(() => {
      const last = outbox.lastShared;
      if (!last || last.at <= playedAt.current) return;
      playedAt.current = last.at;
      const entry = outbox.get(last.ids[last.ids.length - 1] ?? '');
      if (!entry) return;
      const frame = requestAnimationFrame(() => {
        firstSlot.current?.measureInWindow((x, y, w, h) => {
          if (!w) return;
          setFlying({
            entry,
            from: { x: screenW / 2, y: screenH - insets.bottom - 160 },
            to: { x: x + w / 2, y: y + h / 2 },
          });
          flight.value = 0;
          // Cleared whether or not the flight reports "finished" (and after 1.5 s at the latest).
          const landed = setTimeout(() => setFlying(null), 1500);
          const land = () => {
            'worklet';
            scheduleOnRN(setFlying, null);
            scheduleOnRN(clearTimeout, landed);
          };
          flight.value = reduced
            ? withTiming(1, REDUCED_FADE, land)
            : withSpring(1, { ...SPRINGS.float, overshootClamping: true }, land);
        });
      });
      return () => cancelAnimationFrame(frame);
    }, [outbox, screenW, screenH, insets.bottom, flight, reduced]),
  );

  const flightStyle = useAnimatedStyle(() => {
    if (!flying) return { opacity: 0 };
    const p = flight.value;
    if (reduced)
      return {
        opacity: 1 - p,
        transform: [{ translateX: flying.to.x - POLAROID / 2 }, { translateY: flying.to.y - POLAROID / 2 }],
      };
    const x = flying.from.x + (flying.to.x - flying.from.x) * p;
    const y = flying.from.y + (flying.to.y - flying.from.y) * p - Math.sin(Math.PI * p) * 90;
    return {
      opacity: p > 0.97 ? interpolate(p, [0.97, 1], [1, 0]) : 1,
      transform: [
        { translateX: x - POLAROID / 2 },
        { translateY: y - POLAROID / 2 },
        { rotate: `${interpolate(p, [0, 1], [4, -1.2])}deg` },
        { scale: interpolate(p, [0, 1], [1.35, 1]) },
      ],
    };
  });

  // ---- gallery

  const openGallery = async () => {
    try {
      const ids = await gallery.pick();
      if (ids.length > 0) router.push({ pathname: '/compose', params: { ids: ids.join(',') } });
    } catch {
      feedback.reject();
      toast.show({ message: t`That didn’t work. Your phone may be full.`, icon: 'Alert' });
    }
  };

  const openSettings = async () => {
    if (await lock.requireUnlock(t`Unlock to open Settings`)) router.push('/settings');
  };

  const openQueue = async () => {
    if (await lock.requireUnlock(t`Unlock to see your uploads`)) setQueueOpen(true);
  };

  const openDraft = (m: OutboxManifest) => {
    setDraftsOpen(false);
    if (m.kind === 'text') router.push({ pathname: '/text', params: { id: m.entryId } });
    else if (m.kind === 'voice') router.push({ pathname: '/voice', params: { id: m.entryId } });
    else router.push({ pathname: '/compose', params: { ids: m.entryId } });
  };

  const discardDraft = (m: OutboxManifest) => {
    setHiddenDrafts((h) => [...h, m.entryId]);
    let undone = false;
    toast.show({
      message: t`Draft discarded`,
      action: {
        label: t`Undo`,
        onPress: () => {
          undone = true;
          feedback.undo();
          setHiddenDrafts((h) => h.filter((id) => id !== m.entryId));
        },
      },
    });
    setTimeout(() => {
      if (!undone) void outbox.discard(m.entryId).catch(() => {});
    }, 9000);
  };

  const roamingYes = (smallOnly: boolean) => {
    const settingsNow = outbox.uploadSettings;
    const patch = settingsNow ? allowSimPatch(settingsNow, outbox.network) : null;
    if (!patch) return;
    feedback.toggle(true);
    void outbox.setUploadSettings(smallOnly ? { ...patch, wifiOnly: true, photosOnMobileData: true } : patch);
  };

  const archiveOnly = settings.hints?.archiveOnly ?? true;
  const carrier = outbox.network.simOperatorName ?? t`this SIM`;

  return (
    <View style={[s.screen, { paddingTop: insets.top + 8 }]} testID="today-screen">
      <View style={s.topBar}>
        <RoundButton icon="Settings" label={t`Settings`} onPress={() => void openSettings()} testID="settings-button" />
        <Press
          style={s.pill}
          onPress={() => void openQueue()}
          accessibilityRole="button"
          accessibilityLabel={pillText}
          accessibilityHint={t`Shows what is on its way`}
          testID="sync-pill"
        >
          {pill.kind === 'all_safe' ? (
            <CheckStroke size={16} color={pillColor} animate={false} />
          ) : (
            <Icon name={pillIcon} size={16} color={pillColor} />
          )}
          <Text style={[s.pillText, { color: pillColor }]}>{pillText}</Text>
        </Press>
      </View>

      <ScrollView contentContainerStyle={[s.content, { paddingBottom: 24 }]} showsVerticalScrollIndicator={false}>
        <Text style={s.greeting} accessibilityRole="header" testID="greeting">
          {greeting}
        </Text>
        <Text style={s.date}>{date}</Text>

        {archiveOnly ? (
          <Card tone="lilac" style={s.card} testID="archive-note">
            <Text style={s.noteTitle}>
              <Trans>Archive mode</Trans>
            </Text>
            <Text style={s.noteText}>
              <Trans>Your moments go safely to the archive at home. Nothing is published yet.</Trans>
            </Text>
          </Card>
        ) : null}

        {!outbox.paired && outbox.ready ? (
          <Card style={s.card} testID="pair-card">
            <View style={s.cardHead}>
              <Icon name="Link" size={20} color={theme.colors.accent} />
              <Text style={s.cardTitle}>
                <Trans>Connect to your website</Trans>
              </Text>
            </View>
            <Text style={s.noteText}>
              <Trans>Until then your moments wait safely on this phone.</Trans>
            </Text>
            <PillButton
              small
              label={t`Connect`}
              onPress={() => router.push('/pair')}
              style={s.cardAction}
              testID="pair-open"
            />
          </Card>
        ) : null}

        {roamingWaiting ? (
          <Card tone="blush" style={s.card} testID="roaming-card">
            <View style={s.cardHead}>
              <Icon name="Signal" size={20} color={theme.colors.accent} />
              <Text style={s.cardTitle}>
                <Trans>You’re using {carrier} abroad. Upload on it?</Trans>
              </Text>
            </View>
            <View style={s.cardActions}>
              <PillButton small label={t`Yes`} onPress={() => roamingYes(false)} testID="roaming-yes" />
              <PillButton
                small
                variant="soft"
                label={t`Only photos, text and voice`}
                onPress={() => roamingYes(true)}
              />
              <PillButton small variant="ghost" label={t`No`} onPress={() => setRoamingDismissed(true)} />
            </View>
          </Card>
        ) : null}

        {!settings.oemHintDone && outbox.ready ? (
          <View style={s.card}>
            <OemHintCard onDone={() => update({ oemHintDone: true })} />
          </View>
        ) : null}

        <Text style={s.section} accessibilityRole="header">
          <Trans>Today</Trans>
        </Text>
        {todays.length === 0 ? (
          <View style={s.emptyPolaroid} testID="today-empty">
            <View style={s.emptyPhoto} />
            <Text style={s.emptyText}>
              <Trans>Nothing yet today. The first moment goes here.</Trans>
            </Text>
            {/* The coach mark lives here while the day is empty, so it never covers the card. */}
            {!settings.coachSeen ? (
              <Text style={[s.emptyText, s.emptyCoach]}>
                <Trans>Tap for a photo, hold for a video</Trans>
              </Text>
            ) : null}
          </View>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.strip}
            testID="today-strip"
          >
            {todays.map((m, i) => {
              const view = outbox.statusOf(m);
              const hidden = flying !== null && outbox.lastShared?.ids.includes(m.entryId);
              return (
                <View
                  key={m.entryId}
                  ref={i === 0 ? firstSlot : undefined}
                  collapsable={false}
                  style={[
                    s.polaroid,
                    { transform: [{ rotate: `${i % 2 === 0 ? -1.2 : 1}deg` }], opacity: hidden ? 0 : 1 },
                  ]}
                  accessible
                  accessibilityLabel={view ? `${kindLabel(m.kind)}: ${statusText.label(view)}` : kindLabel(m.kind)}
                  testID={`today-item-${i}`}
                >
                  <EntryThumb m={m} size={POLAROID - 16} radius={3} />
                  {view ? (
                    <View
                      style={[
                        s.badge,
                        { backgroundColor: isDone(view.status) ? theme.colors.success : theme.colors.surface },
                      ]}
                    >
                      {isDone(view.status) ? (
                        <CheckStroke size={14} color="#ffffff" />
                      ) : (
                        <Icon name={STATUS_ICONS[view.status]} size={14} color={statusColor(view.status, theme)} />
                      )}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </ScrollView>
        )}

        {drafts.length > 0 ? (
          <Press style={s.drafts} onPress={() => setDraftsOpen(true)} accessibilityRole="button" testID="drafts-line">
            <Icon name="Pencil" size={18} color={theme.colors.accent} />
            <Text style={s.draftsText}>{plural(drafts.length, { one: '# draft', other: '# drafts' })}</Text>
            <Icon name="ChevronRight" size={18} color={theme.colors.muted} />
          </Press>
        ) : null}
      </ScrollView>

      <View style={[s.captureRow, { paddingBottom: insets.bottom + 12 }]}>
        <CaptureSide
          label={t`Gallery`}
          icon="Image"
          testID="gallery-button"
          theme={theme}
          onPress={() => void openGallery()}
        />
        <View style={s.captureCenter}>
          {!settings.coachSeen && todays.length > 0 ? (
            <View style={s.coach} pointerEvents="none">
              <Text style={s.coachText}>
                <Trans>Tap for a photo, hold for a video</Trans>
              </Text>
            </View>
          ) : null}
          <GestureDetector gesture={swipeUp}>
            <View ref={captureRef} collapsable={false}>
              <Press
                style={s.capture}
                feedback="VIRTUAL_KEY"
                onPress={() => openCamera()}
                onLongPress={() => {
                  feedback.holdToRecord();
                  openCamera({ start: 'video' });
                }}
                delayLongPress={450}
                accessibilityRole="button"
                accessibilityLabel={t`Capture`}
                accessibilityHint={t`Opens the camera. Hold to start a video.`}
                accessibilityActions={[{ name: 'longpress', label: t`Start a video` }]}
                onAccessibilityAction={(e) => {
                  if (e.nativeEvent.actionName === 'longpress') openCamera({ start: 'video' });
                }}
                testID="capture-button"
              >
                <View style={s.captureInner}>
                  <Icon name="Camera" size={30} color="#ffffff" />
                </View>
              </Press>
            </View>
          </GestureDetector>
          <Text style={s.captureLabel}>
            <Trans>Capture</Trans>
          </Text>
        </View>
        <CaptureSide
          label={t`Text`}
          icon="Text"
          testID="text-button"
          theme={theme}
          onPress={() => router.push('/text')}
        />
      </View>

      {busy ? (
        <View style={[StyleSheet.absoluteFill, s.busy]} accessibilityLiveRegion="polite">
          <ActivityIndicator color={theme.colors.accent} size="large" />
          <Text style={s.busyText}>
            <Trans>Copying into your outbox…</Trans>
          </Text>
        </View>
      ) : null}

      {flying ? (
        <Animated.View pointerEvents="none" style={[s.flight, flightStyle]}>
          <EntryThumb m={flying.entry} size={POLAROID - 16} radius={3} />
        </Animated.View>
      ) : null}

      {revealAt ? (
        <Animated.View
          pointerEvents="none"
          style={[
            s.reveal,
            reduced
              ? StyleSheet.absoluteFill
              : {
                  left: revealAt.x - radius,
                  top: revealAt.y - radius,
                  width: radius * 2,
                  height: radius * 2,
                  borderRadius: radius,
                },
            revealStyle,
          ]}
        />
      ) : null}

      <QueueSheet open={queueOpen} onClose={() => setQueueOpen(false)} />
      <Sheet open={draftsOpen} onClose={() => setDraftsOpen(false)} title={t`Drafts`} testID="drafts-sheet">
        <ScrollView contentContainerStyle={s.draftList}>
          {drafts.map((m) => (
            <View key={m.entryId} style={s.draftRow}>
              <Press
                style={s.draftOpen}
                onPress={() => openDraft(m)}
                accessibilityRole="button"
                testID={`draft-${m.entryId}`}
              >
                <EntryThumb m={m} size={52} radius={8} />
                <View style={s.draftText}>
                  <Text style={s.draftLabel}>{kindLabel(m.kind)}</Text>
                  <Text style={s.draftTime}>
                    {new Intl.DateTimeFormat(intlLocale(i18n.locale), {
                      weekday: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    }).format(new Date(m.createdAt))}
                  </Text>
                </View>
              </Press>
              <RoundButton icon="Trash" label={t`Discard draft`} onPress={() => discardDraft(m)} size={44} />
            </View>
          ))}
        </ScrollView>
      </Sheet>
    </View>
  );
}

function CaptureSide({
  label,
  icon,
  testID,
  theme,
  onPress,
}: {
  label: string;
  icon: 'Image' | 'Text';
  testID: string;
  theme: Theme;
  onPress: () => void;
}) {
  const s = styles(theme);
  return (
    <View style={s.side}>
      <RoundButton icon={icon} label={label} onPress={onPress} testID={testID} size={60} feedback="VIRTUAL_KEY" />
      <Text style={s.captureLabel}>{label}</Text>
    </View>
  );
}

const styles = (theme: Theme) => {
  const c = theme.colors;
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bg },
    topBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: 52,
      paddingHorizontal: theme.spacing.gutter,
    },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      minHeight: 44,
      paddingHorizontal: 16,
      borderRadius: theme.radii.pill,
      backgroundColor: c.surface,
      boxShadow: theme.shadows.soft,
    },
    pillText: { ...typeStyles.bodyBold, fontSize: 14 },
    content: { paddingTop: 16, paddingHorizontal: theme.spacing.gutter },
    greeting: { ...typeStyles.title, color: c.ink, fontSize: 34, lineHeight: 40 },
    date: { ...typeStyles.hand, color: c.accent, fontSize: 18, marginTop: 4 },
    card: { marginTop: 16 },
    cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    cardTitle: { ...typeStyles.label, color: c.ink, fontSize: 15, flexShrink: 1 },
    cardAction: { alignSelf: 'flex-start', marginTop: 6 },
    cardActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
    noteTitle: { ...typeStyles.label, color: c.violet, fontSize: 15 },
    noteText: { ...typeStyles.body, color: c.ink, fontSize: 15, lineHeight: 21 },
    section: { ...typeStyles.label, color: c.muted, fontSize: 13, letterSpacing: 0.6, marginTop: 28, marginBottom: 12 },
    emptyPolaroid: {
      alignSelf: 'flex-start',
      width: 168,
      padding: 10,
      paddingBottom: 14,
      borderRadius: 6,
      backgroundColor: c.surface,
      transform: [{ rotate: '-1.2deg' }],
      boxShadow: theme.shadows.lift,
    },
    emptyPhoto: {
      height: 148,
      borderRadius: 3,
      borderWidth: 2,
      borderStyle: 'dashed',
      borderColor: c.line,
      backgroundColor: c.blush,
    },
    emptyText: { ...typeStyles.hand, color: c.muted, fontSize: 14, lineHeight: 19, marginTop: 10 },
    emptyCoach: { color: c.accent, marginTop: 6 },
    strip: { gap: 14, paddingVertical: 8, paddingEnd: 24 },
    polaroid: {
      width: POLAROID,
      padding: 8,
      paddingBottom: 18,
      borderRadius: 5,
      backgroundColor: c.surface,
      boxShadow: theme.shadows.lift,
    },
    badge: {
      position: 'absolute',
      right: -6,
      top: -6,
      width: 26,
      height: 26,
      borderRadius: 13,
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: theme.shadows.soft,
    },
    drafts: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 18,
      minHeight: 48,
      alignSelf: 'flex-start',
      paddingHorizontal: 14,
      borderRadius: theme.radii.pill,
      backgroundColor: c.blush,
    },
    draftsText: { ...typeStyles.bodyBold, color: c.ink, fontSize: 15 },
    captureRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      justifyContent: 'space-between',
      paddingTop: 8,
      paddingHorizontal: theme.spacing.gutter,
    },
    side: { width: 88, alignItems: 'center' },
    captureCenter: { alignItems: 'center' },
    capture: {
      width: 88,
      height: 88,
      borderRadius: 44,
      padding: 4,
      backgroundColor: c.bg,
      boxShadow: theme.shadows.float,
    },
    captureInner: {
      flex: 1,
      borderRadius: 40,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.palette['rose-600'],
      backgroundImage: `linear-gradient(135deg, ${theme.palette['rose-600']}, ${theme.palette['violet-700']})`,
    },
    captureLabel: { ...typeStyles.bodyBold, color: c.muted, fontSize: 13, marginTop: 8 },
    coach: {
      position: 'absolute',
      bottom: 122,
      width: 220,
      alignSelf: 'center',
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 14,
      backgroundColor: c.ink,
    },
    coachText: { ...typeStyles.bodyBold, color: c.bg, fontSize: 13, textAlign: 'center' },
    busy: {
      backgroundColor: theme.name === 'dusk' ? 'rgba(27,19,34,0.86)' : 'rgba(255,248,246,0.9)',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
    },
    busyText: { ...typeStyles.hand, color: c.ink, fontSize: 16 },
    flight: {
      position: 'absolute',
      left: 0,
      top: 0,
      width: POLAROID,
      padding: 8,
      paddingBottom: 18,
      borderRadius: 5,
      backgroundColor: c.surface,
      boxShadow: theme.shadows.float,
    },
    reveal: { position: 'absolute', backgroundColor: STAGE },
    draftList: { gap: 10, paddingTop: 8, paddingBottom: 12 },
    draftRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    draftOpen: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56 },
    draftText: { flex: 1 },
    draftLabel: { ...typeStyles.bodyBold, color: c.ink, fontSize: 15 },
    draftTime: { ...typeStyles.body, color: c.muted, fontSize: 13 },
  });
};
