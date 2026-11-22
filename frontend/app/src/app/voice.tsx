/**
 * Voice status (expo-audio, ux.md §3.7): AAC in M4A (what the backend publishes anyway), up to
 * 60 s, with a live level meter. WhatsApp's grammar: hold 🎙 to record, slide to the start side to
 * cancel, let go to keep it. Tap 🎙 is the hands-free, accessible way (tap again to stop).
 * LONG_PRESS fires before the recorder starts and GESTURE_END after it stopped; nothing in between
 * (suppressHaptics: the microphone would hear the motor).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import {
  AudioModule,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { BackHandler, I18nManager, Linking, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { suppressHaptics } from '../../modules/omw-native';
import { formatClock } from '../core/entry';
import { useOutbox } from '../outbox/outbox';
import { useShare } from '../outbox/use-share';
import { type as typeStyles } from '../theme';
import { PillButton, RoundButton } from '../ui/button';
import { feedback } from '../ui/haptics';
import { Icon } from '../ui/icons';
import { Press } from '../ui/press';
import { AS_USUAL, type PublishChoice, PublishSheet, usePublishLine } from '../ui/publish-sheet';
import { useToast } from '../ui/toast';

const STAGE = '#1b1322';
const MAX_MS = 60_000;
const BARS = 40;
const CANCEL_PX = 110;

/** dBFS (about -60 … 0) -> 0 … 1 for the meter. */
export function meterLevel(db: number | undefined): number {
  if (db === undefined || !Number.isFinite(db)) return 0.05;
  return Math.max(0.05, Math.min(1, (db + 60) / 60));
}

type Phase = 'idle' | 'recording' | 'done';

export default function Voice() {
  const { t } = useLingui();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const outbox = useOutbox();
  const toast = useToast();
  const { share, sharing } = useShare();
  const params = useLocalSearchParams<{ id?: string }>();
  const existing = params.id ? outbox.get(params.id) : undefined;
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    numberOfChannels: 1,
    bitRate: 96_000,
    isMeteringEnabled: true,
  });
  const recState = useAudioRecorderState(recorder, 100);
  const [phase, setPhase] = useState<Phase>(existing ? 'done' : 'idle');
  const [levels, setLevels] = useState<number[]>([]);
  const [result, setResult] = useState<{ uri: string; durationMs: number } | null>(
    existing?.source
      ? { uri: outbox.fileUri(existing.entryId, existing.source.name), durationMs: existing.source.durationMs ?? 0 }
      : null,
  );
  const [denied, setDenied] = useState(false);
  const [cancelArmed, setCancelArmed] = useState(false);
  const [choice, setChoice] = useState<PublishChoice>(AS_USUAL);
  const [sheetOpen, setSheetOpen] = useState(false);
  const publishLine = usePublishLine(choice);
  const holdMode = useRef(false);
  /** The finger is on 🎙 after a hold (refs: the release must never see a stale render). */
  const holding = useRef(false);
  const armed = useRef(false);
  const touchStartX = useRef<number | null>(null);
  const endSuppression = useRef<(() => void) | null>(null);
  const startedAt = useRef(0);
  const finishing = useRef(false);
  const left = useRef(false);

  const player = useAudioPlayer(result?.uri ?? null);
  const playing = useAudioPlayerStatus(player);

  // The live meter (information, so it keeps moving with reduced motion too).
  // biome-ignore lint/correctness/useExhaustiveDependencies: durationMillis ticks pace the meter sampling while recording
  useEffect(() => {
    if (phase !== 'recording') return;
    setLevels((l) => [...l, meterLevel(recState.metering)].slice(-BARS));
  }, [phase, recState.metering, recState.durationMillis]);

  const start = async (hold: boolean) => {
    if (phase === 'recording') return;
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) {
      setDenied(true);
      return;
    }
    holdMode.current = hold;
    feedback.holdToRecord(); // before the recorder starts
    endSuppression.current = suppressHaptics();
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: MAX_MS / 1000 });
    // Let go while the recorder was starting: keep recording hands-free (tap to stop).
    if (hold && !holding.current) holdMode.current = false;
    startedAt.current = Date.now();
    finishing.current = false;
    setLevels([]);
    setResult(null);
    setPhase('recording');
  };

  const finish = async (cancel: boolean) => {
    if (finishing.current) return;
    finishing.current = true;
    const durationMs = Math.min(MAX_MS, Date.now() - startedAt.current);
    try {
      await recorder.stop();
    } catch {
      // already stopped (60 s)
    }
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    endSuppression.current?.();
    endSuppression.current = null;
    feedback.recordEnd(); // after it stopped
    armed.current = false;
    holding.current = false;
    setCancelArmed(false);
    const uri = recorder.uri;
    if (cancel || !uri || durationMs < 700) {
      if (uri) {
        try {
          new File(uri).delete();
        } catch {
          // a cache file: the system cleans it up anyway
        }
      }
      setPhase('idle');
      return;
    }
    setResult({ uri, durationMs });
    setPhase('done');
  };

  // The 60 s limit stops the recorder by itself.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stop once when the recorder ends by itself; finish is a fresh closure every render
  useEffect(() => {
    if (phase === 'recording' && !recState.isRecording && Date.now() - startedAt.current > 1000) void finish(false);
  }, [recState.isRecording, phase]);

  useEffect(
    () => () => {
      endSuppression.current?.();
      void AudioModule;
    },
    [],
  );

  const keepDraft = async (): Promise<string | null> => {
    if (existing) return existing.entryId;
    if (!result) return null;
    return outbox.createDraft({ kind: 'voice', uri: result.uri, durationMs: result.durationMs });
  };

  const back = async () => {
    if (left.current) return;
    left.current = true;
    if (phase === 'recording') await finish(false);
    player.pause();
    const id = await keepDraft().catch(() => null);
    if (id && !existing) toast.show({ message: t`Saved as a draft`, icon: 'Pencil', durationMs: 3000 });
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
    player.pause();
    left.current = true;
    const id = await keepDraft();
    if (!id || !(await share([id], choice))) left.current = false;
  };

  const elapsed = phase === 'recording' ? recState.durationMillis : (result?.durationMs ?? 0);
  const remaining = MAX_MS - elapsed;
  const shownLevels = levels.length > 0 ? levels : Array.from({ length: 24 }, (_, i) => 0.12 + ((i * 7) % 5) * 0.05);

  return (
    <View
      style={[styles.screen, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 }]}
      testID="voice-screen"
    >
      <View style={styles.top}>
        <RoundButton
          tone="glass"
          icon="Close"
          label={t`Close, keep as a draft`}
          onPress={() => void back()}
          testID="voice-close"
        />
      </View>

      <View style={styles.center}>
        <View
          style={styles.wave}
          accessible
          accessibilityLabel={phase === 'recording' ? t`Recording` : t`Your voice note`}
        >
          {shownLevels.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length level bars, never reordered or filtered
            <View key={i} style={[styles.bar, { height: 8 + l * 88, opacity: phase === 'idle' ? 0.35 : 1 }]} />
          ))}
        </View>
        <Text
          style={styles.time}
          accessibilityLiveRegion={phase === 'recording' ? 'polite' : 'none'}
          testID="voice-time"
        >
          {formatClock(elapsed)}
          {phase === 'recording' && remaining <= 15_000 ? t` · ${Math.ceil(remaining / 1000)} s left` : ''}
        </Text>
        {phase === 'done' && result ? (
          <View style={styles.playRow}>
            <RoundButton
              tone="glass"
              icon={playing.playing ? 'Pause' : 'Play'}
              label={playing.playing ? t`Pause` : t`Play`}
              onPress={() => {
                if (playing.playing) player.pause();
                else {
                  if (playing.didJustFinish || playing.currentTime >= playing.duration - 0.1) void player.seekTo(0);
                  player.play();
                }
              }}
              size={56}
              testID="voice-play"
            />
            {!existing ? (
              <PillButton
                variant="ghost"
                label={t`Record again`}
                icon="Refresh"
                onPress={() => {
                  player.pause();
                  try {
                    new File(result.uri).delete();
                  } catch {
                    // cache
                  }
                  setResult(null);
                  setLevels([]);
                  setPhase('idle');
                }}
                testID="voice-again"
              />
            ) : null}
          </View>
        ) : null}
        {denied ? (
          <View style={styles.denied}>
            <Text style={styles.hint}>
              <Trans>To record, On My Way needs the microphone.</Trans>
            </Text>
            <PillButton small label={t`Open settings`} onPress={() => void Linking.openSettings()} />
          </View>
        ) : null}
      </View>

      {phase !== 'done' ? (
        <View style={styles.recordArea}>
          <Text style={[styles.hint, cancelArmed && styles.hintArmed]}>
            {phase === 'recording' && holdMode.current
              ? cancelArmed
                ? t`Let go to cancel`
                : I18nManager.isRTL
                  ? t`Slide right to cancel ›`
                  : t`‹ Slide left to cancel`
              : phase === 'recording'
                ? t`Tap to stop`
                : t`Hold to record, or tap to start`}
          </Text>
          <View
            onTouchStart={(e) => {
              touchStartX.current = e.nativeEvent.pageX;
            }}
            onTouchMove={(e) => {
              if (phase !== 'recording' || !holdMode.current || touchStartX.current === null) return;
              const dx = (e.nativeEvent.pageX - touchStartX.current) * (I18nManager.isRTL ? -1 : 1);
              const next = dx < -CANCEL_PX;
              if (next !== armed.current) {
                armed.current = next;
                setCancelArmed(next);
              }
            }}
          >
            <Press
              style={[styles.mic, phase === 'recording' && styles.micOn]}
              delayLongPress={250}
              // Sliding to cancel must not count as letting go.
              pressRetentionOffset={{ top: 400, bottom: 200, left: 1000, right: 1000 }}
              onPress={() => {
                if (phase === 'recording') void finish(false);
                else void start(false);
              }}
              onLongPress={() => {
                if (phase !== 'idle') return;
                holding.current = true;
                void start(true);
              }}
              onPressOut={() => {
                if (!holding.current) return;
                holding.current = false;
                if (phase === 'recording' && holdMode.current) void finish(armed.current);
              }}
              accessibilityRole="button"
              accessibilityLabel={phase === 'recording' ? t`Stop recording` : t`Start recording`}
              testID="voice-mic"
            >
              <Icon name={phase === 'recording' ? 'Stop' : 'Mic'} size={36} color="#ffffff" />
            </Press>
          </View>
        </View>
      ) : (
        <View style={styles.sendRow}>
          <Press
            style={styles.publishLine}
            onPress={() => setSheetOpen(true)}
            accessibilityRole="button"
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
            accessibilityLabel={t`Share`}
            testID="send-button"
          >
            <Icon name="Send" size={26} color="#ffffff" />
          </Press>
        </View>
      )}

      <PublishSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        count={1}
        choice={choice}
        onChange={setChoice}
        onShare={() => void onShare()}
        daySuggestions={[]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: STAGE, paddingHorizontal: 16 },
  top: { flexDirection: 'row' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 20 },
  wave: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 110, direction: 'ltr' },
  bar: { width: 4, borderRadius: 2, backgroundColor: '#f4a3bc' },
  time: { ...typeStyles.title, color: '#f7ecf2', fontSize: 40, fontVariant: ['tabular-nums'] },
  playRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  denied: { alignItems: 'center', gap: 10 },
  hint: { ...typeStyles.bodyBold, color: '#c9b6cc', fontSize: 15, textAlign: 'center' },
  hintArmed: { color: '#f4a3bc' },
  recordArea: { alignItems: 'center', gap: 16, paddingBottom: 12 },
  mic: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#be4a74',
    backgroundImage: 'linear-gradient(135deg, #be4a74, #5d3fa0)',
    boxShadow: '0 10px 30px -10px rgba(190, 74, 116, 0.8)',
  },
  micOn: { transform: [{ scale: 1.08 }] },
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
  },
});
