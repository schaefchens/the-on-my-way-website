/**
 * Compose (the v0.5 editor for photos and videos, ux.md §3.5 without the v0.6 overlays): the
 * picture or clip on the dark stage, video trim + mute (exported on the phone by MediaExport),
 * a thumbnail strip for a batch (posting order), "Put it on that day?" for older gallery photos,
 * the caption (separate text, WhatsApp's caption), the publish line → publish sheet, and ➤.
 * Back keeps everything as a draft ("Saved as a draft").
 */
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { APP_LIMITS } from '@omw/contracts/app';
import { useEvent } from 'expo';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Image, KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { localDateIn, suggestionsByDay } from '../core/entry';
import type { OutboxManifest } from '../core/outbox-machine';
import { initialTrim, type TrimWindow } from '../core/trim';
import { deviceTimeZone, useOutbox } from '../outbox/outbox';
import { useShare } from '../outbox/use-share';
import { type as typeStyles } from '../theme';
import { RoundButton } from '../ui/button';
import { EntryThumb } from '../ui/entry-thumb';
import { feedback } from '../ui/haptics';
import { Icon } from '../ui/icons';
import { Press } from '../ui/press';
import { AS_USUAL, type PublishChoice, PublishSheet, usePublishLine } from '../ui/publish-sheet';
import { intlLocale } from '../ui/status';
import { useToast } from '../ui/toast';
import { TrimBar } from '../ui/trim-bar';

const STAGE = '#120c17';

interface ItemEdit {
  caption: string;
  trim: TrimWindow | null;
  mute: boolean;
}

export default function Compose() {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const outbox = useOutbox();
  const toast = useToast();
  const { share, sharing } = useShare();
  const params = useLocalSearchParams<{ ids?: string }>();
  const ids = useMemo(() => (params.ids ?? '').split(',').filter(Boolean), [params.ids]);
  const items = ids
    .map((id) => outbox.get(id))
    .filter((m): m is OutboxManifest => m !== undefined && m.phase === 'draft');
  const [index, setIndex] = useState(0);
  const current = items[Math.min(index, Math.max(0, items.length - 1))];
  const [edits, setEdits] = useState<Record<string, ItemEdit>>({});
  const [choice, setChoice] = useState<PublishChoice>(AS_USUAL);
  const [sheetOpen, setSheetOpen] = useState(false);
  const saved = useRef(false);

  // Initial edit state from the drafts (a reopened draft continues where she left off).
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed edit state only when the set of entries changes (keyed by their ids), never on every items update
  useEffect(() => {
    setEdits((prev) => {
      const next = { ...prev };
      for (const m of items) {
        if (next[m.entryId]) continue;
        const duration = m.source?.durationMs ?? 0;
        next[m.entryId] = {
          caption: m.caption ?? '',
          trim:
            m.kind === 'video' && duration > 0
              ? m.edit?.trimEndMs !== undefined
                ? { startMs: m.edit.trimStartMs ?? 0, endMs: m.edit.trimEndMs }
                : initialTrim(duration)
              : null,
          mute: m.edit?.mute ?? false,
        };
      }
      return next;
    });
  }, [items.map((m) => m.entryId).join(',')]);

  const edit = current ? edits[current.entryId] : undefined;
  const setEdit = (patch: Partial<ItemEdit>) => {
    if (!current) return;
    setEdits((prev) => ({ ...prev, [current.entryId]: { ...(prev[current.entryId] as ItemEdit), ...patch } }));
  };

  /** Writes captions and video edits into the drafts (they stay drafts). */
  const persist = async () => {
    for (const m of items) {
      const e = edits[m.entryId];
      if (!e) continue;
      await outbox
        .edit(m.entryId, {
          caption: e.caption,
          ...(m.kind === 'video'
            ? { edit: { ...(e.trim ? { trimStartMs: e.trim.startMs, trimEndMs: e.trim.endMs } : {}), mute: e.mute } }
            : {}),
        })
        .catch(() => {});
    }
  };

  const back = async () => {
    if (saved.current) return;
    saved.current = true;
    await persist();
    toast.show({ message: t`Saved as a draft`, icon: 'Pencil', durationMs: 3000 });
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (sheetOpen) return false;
      void back();
      return true;
    });
    return () => sub.remove();
  });

  const onShare = async () => {
    setSheetOpen(false);
    await persist();
    saved.current = true;
    const ok = await share(
      items.map((m) => m.entryId),
      choice,
    );
    if (!ok) saved.current = false;
  };

  const tz = deviceTimeZone();
  const today = localDateIn(new Date(), tz);
  const dayFormat = new Intl.DateTimeFormat(intlLocale(i18n.locale), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const suggestions = suggestionsByDay(
    items.map((m) => ({ entryId: m.entryId, takenOn: m.source?.takenOn ?? null })),
    today,
  ).map((s) => ({ day: s.day, count: s.entryIds.length, label: dayFormat.format(new Date(`${s.day}T12:00:00Z`)) }));
  const currentSuggestion = suggestions.find((s) => s.day === current?.source?.takenOn);
  const acceptedDay =
    currentSuggestion && choice.acceptedDays.includes(currentSuggestion.day) ? currentSuggestion.label : null;
  const publishLine = usePublishLine(choice, acceptedDay);

  if (!current || !edit) {
    return (
      <View style={[styles.screen, styles.center]} testID="compose-empty">
        <Text style={styles.emptyText}>
          <Trans>Nothing to share here.</Trans>
        </Text>
        <RoundButton tone="glass" icon="ChevronLeft" label={t`Back`} onPress={() => router.replace('/')} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding" testID="compose-screen">
      <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <RoundButton
          tone="glass"
          icon="ChevronLeft"
          label={t`Back, keep as a draft`}
          onPress={() => void back()}
          testID="compose-back"
        />
        {items.length > 1 ? (
          <Text style={styles.counter} maxFontSizeMultiplier={1.3}>
            {index + 1} / {items.length}
          </Text>
        ) : null}
        {current.kind === 'video' ? (
          <RoundButton
            tone="glass"
            icon={edit.mute ? 'VolumeOff' : 'Volume'}
            label={edit.mute ? t`Sound off` : t`Sound on`}
            onPress={() => {
              feedback.toggle(!edit.mute);
              setEdit({ mute: !edit.mute });
            }}
            testID="compose-mute"
          />
        ) : (
          <View style={{ width: 48 }} />
        )}
      </View>

      <Animated.View
        key={current.entryId}
        entering={FadeIn.duration(240).reduceMotion(ReduceMotion.System)}
        style={styles.media}
      >
        {current.kind === 'photo' ? (
          <Image
            source={{ uri: outbox.fileUri(current.entryId, current.source?.name ?? '') }}
            style={styles.fill}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
            accessibilityLabel={t`Your photo`}
            testID="compose-photo"
          />
        ) : (
          <VideoPreview
            uri={outbox.fileUri(current.entryId, current.source?.name ?? '')}
            muted={edit.mute}
            trim={edit.trim}
            onDuration={(ms) => {
              if (!edit.trim || (current.source?.durationMs ?? 0) <= 0) setEdit({ trim: edit.trim ?? initialTrim(ms) });
            }}
          />
        )}
      </Animated.View>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
        {current.kind === 'video' && edit.trim ? (
          <TrimBar
            durationMs={
              current.source?.durationMs && current.source.durationMs > 0 ? current.source.durationMs : edit.trim.endMs
            }
            window={edit.trim}
            onChange={(w) => setEdit({ trim: w })}
          />
        ) : null}

        {items.length > 1 ? (
          <ScrollView horizontal contentContainerStyle={styles.strip} showsHorizontalScrollIndicator={false}>
            {items.map((m, i) => (
              <Press
                key={m.entryId}
                onPress={() => {
                  feedback.step();
                  setIndex(i);
                }}
                style={[styles.stripItem, i === index && styles.stripItemOn]}
                accessibilityRole="button"
                accessibilityState={{ selected: i === index }}
                accessibilityLabel={t`Moment ${i + 1} of ${items.length}`}
                testID={`compose-item-${i}`}
              >
                <EntryThumb m={m} size={48} radius={6} />
              </Press>
            ))}
          </ScrollView>
        ) : null}

        {currentSuggestion ? (
          <Press
            style={[styles.dayChip, choice.acceptedDays.includes(currentSuggestion.day) && styles.dayChipOn]}
            onPress={() => {
              feedback.step();
              const on = choice.acceptedDays.includes(currentSuggestion.day);
              setChoice({
                ...choice,
                acceptedDays: on
                  ? choice.acceptedDays.filter((d) => d !== currentSuggestion.day)
                  : [...choice.acceptedDays, currentSuggestion.day],
              });
            }}
            accessibilityRole="switch"
            accessibilityState={{ checked: choice.acceptedDays.includes(currentSuggestion.day) }}
            testID="day-chip"
          >
            <Icon name="Calendar" size={18} color="#f4a3bc" />
            <Text style={styles.dayText}>
              {choice.acceptedDays.includes(currentSuggestion.day)
                ? t`On ${currentSuggestion.label} ✓`
                : currentSuggestion.count === 1
                  ? t`This photo is from ${currentSuggestion.label}. Put it on that day?`
                  : t`${currentSuggestion.count} photos are from ${currentSuggestion.label}. Put them on that day?`}
            </Text>
          </Press>
        ) : null}

        <View style={styles.captionBox}>
          <TextInput
            value={edit.caption}
            onChangeText={(caption) => setEdit({ caption })}
            placeholder={t`Add a caption…`}
            placeholderTextColor="#a08ba6"
            style={styles.caption}
            multiline
            maxLength={APP_LIMITS.captionChars}
            textAlignVertical="center"
            accessibilityLabel={t`Caption`}
            testID="caption-input"
          />
        </View>

        <View style={styles.sendRow}>
          <Press
            style={styles.publishLine}
            onPress={() => setSheetOpen(true)}
            accessibilityRole="button"
            accessibilityHint={t`Choose when it appears`}
            testID="publish-line"
          >
            <Text style={styles.publishText} numberOfLines={2}>
              {publishLine}
            </Text>
            <Icon name="ChevronRight" size={18} color="#c9b6cc" />
          </Press>
          <Press
            style={[styles.send, sharing && { opacity: 0.6 }]}
            disabled={sharing}
            onPress={() => void onShare()}
            accessibilityRole="button"
            accessibilityLabel={plural(items.length, { one: 'Share this moment', other: 'Share # moments' })}
            testID="send-button"
          >
            <Icon name="Send" size={26} color="#ffffff" />
          </Press>
        </View>
      </View>

      <PublishSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        count={items.length}
        choice={choice}
        onChange={setChoice}
        onShare={() => void onShare()}
        daySuggestions={suggestions}
      />
    </KeyboardAvoidingView>
  );
}

/** The clip, looping inside the trim window, contained on the stage. */
function VideoPreview({
  uri,
  muted,
  trim,
  onDuration,
}: {
  uri: string;
  muted: boolean;
  trim: TrimWindow | null;
  onDuration: (ms: number) => void;
}) {
  const { t } = useLingui();
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    p.muted = true;
    p.timeUpdateEventInterval = 0.25;
    p.play();
  });
  const source = useEvent(player, 'sourceLoad');
  const time = useEvent(player, 'timeUpdate');

  // biome-ignore lint/correctness/useExhaustiveDependencies: report the duration once per new source; onDuration is a fresh closure every render
  useEffect(() => {
    if (source?.duration) onDuration(Math.round(source.duration * 1000));
  }, [source?.duration]);

  useEffect(() => {
    player.muted = muted;
  }, [player, muted]);

  // Loop inside the chosen window.
  useEffect(() => {
    if (!trim || !time) return;
    const now = time.currentTime * 1000;
    if (now < trim.startMs - 300 || now >= trim.endMs) {
      player.currentTime = trim.startMs / 1000;
      player.play();
    }
  }, [player, time, trim]);

  return (
    <VideoView
      player={player}
      style={styles.fill}
      contentFit="contain"
      nativeControls={false}
      accessibilityLabel={t`Your video`}
      testID="compose-video"
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: STAGE },
  center: { alignItems: 'center', justifyContent: 'center', gap: 16 },
  emptyText: { ...typeStyles.hand, color: '#f7ecf2', fontSize: 18 },
  top: {
    position: 'absolute',
    zIndex: 2,
    left: 0,
    right: 0,
    top: 0,
    paddingHorizontal: 16,
    paddingBottom: 20,
    // Keeps the glass buttons readable over a bright picture.
    backgroundImage: 'linear-gradient(rgba(18, 12, 23, 0.5), rgba(18, 12, 23, 0))',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  counter: { color: '#ffffff', fontFamily: 'Nunito', fontWeight: '800', fontSize: 15 },
  media: { flex: 1 },
  fill: { flex: 1, width: '100%' },
  bottom: { paddingHorizontal: 16, paddingTop: 12, gap: 10, backgroundColor: 'rgba(18, 12, 23, 0.92)' },
  strip: { gap: 8 },
  stripItem: { padding: 2, borderRadius: 8, borderWidth: 2, borderColor: 'transparent' },
  stripItemOn: { borderColor: '#f4a3bc' },
  dayChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    minHeight: 44,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 22,
    backgroundColor: 'rgba(244, 163, 188, 0.14)',
  },
  dayChipOn: { backgroundColor: 'rgba(244, 163, 188, 0.3)' },
  dayText: { color: '#f7ecf2', fontFamily: 'Nunito', fontWeight: '700', fontSize: 14, flexShrink: 1 },
  captionBox: { borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.1)', paddingHorizontal: 16 },
  caption: {
    color: '#ffffff',
    fontFamily: 'Nunito',
    fontSize: 16,
    minHeight: 48,
    maxHeight: 120,
    paddingVertical: 10,
    writingDirection: 'auto',
  },
  sendRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  publishLine: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 48 },
  publishText: { color: '#e7d7ea', fontFamily: 'Nunito', fontWeight: '700', fontSize: 14, flexShrink: 1 },
  send: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#be4a74',
    boxShadow: '0 8px 24px -8px rgba(190, 74, 116, 0.7)',
  },
});
