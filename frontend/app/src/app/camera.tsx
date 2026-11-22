/**
 * Camera (expo-camera, ux.md §3.3): always on the dark stage.
 * - Photo mode: tap = photo; hold = a video while holding (LONG_PRESS before the recorder starts,
 *   GESTURE_END after it stops, nothing in between: the microphone would hear the motor).
 * - Video mode: tap to start, tap to stop (the hands-free, accessible way).
 * - Recording stops by itself at 60 s; the ring fills linearly (it's a clock).
 * - Pinch = zoom (chips 1× / 2× as the visible way), double tap = flip (⟲), pull down = close (✕),
 *   swipe sideways on the lower third = mode (or tap the labels). Text and Voice are modes too.
 * - No white flash: the viewfinder dims to 85 % for 90 ms; the photo is in the outbox (a durable
 *   draft) before the editor opens.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import {
  type CameraType,
  CameraView,
  type FlashMode,
  useCameraPermissions,
  useMicrophonePermissions,
} from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import {
  GestureDetector,
  useExclusiveGestures,
  usePanGesture,
  usePinchGesture,
  useSimultaneousGestures,
  useTapGesture,
} from 'react-native-gesture-handler';
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';
import { suppressHaptics } from '../../modules/omw-native';
import { formatClock } from '../core/entry';
import { MAX_CLIP_MS } from '../core/trim';
import { useOutbox } from '../outbox/outbox';
import { useGalleryPick } from '../outbox/use-gallery';
import { type as typeStyles } from '../theme';
import { PillButton, RoundButton } from '../ui/button';
import { feedback } from '../ui/haptics';
import { Icon } from '../ui/icons';
import { SHUTTER_DIM, SPRINGS } from '../ui/motion';
import { Press } from '../ui/press';

const STAGE = '#120c17';
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const MODES = ['text', 'photo', 'video', 'voice'] as const;
type RailMode = (typeof MODES)[number];
/** Linear zoom of CameraX for ≈ 2× on phones with an 8–10× digital range (an approximation). */
const ZOOM_2X = 0.55;
const SHUTTER = 80;
const RING_R = (SHUTTER + 12) / 2 - 3;
const RING_LEN = 2 * Math.PI * RING_R;

export default function CameraScreen() {
  const { t } = useLingui();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ start?: string }>();
  const outbox = useOutbox();
  const gallery = useGalleryPick();
  const reduced = useReducedMotion();
  const [permission, requestPermission] = useCameraPermissions();
  const [mic, requestMic] = useMicrophonePermissions();
  const camera = useRef<CameraView>(null);
  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<Exclude<FlashMode, 'screen'>>('auto');
  const [zoom, setZoom] = useState(0);
  const [rail, setRail] = useState<RailMode>(params.start === 'video' ? 'video' : 'photo');
  const [camMode, setCamMode] = useState<'picture' | 'video'>(params.start === 'video' ? 'video' : 'picture');
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState<{ startedAt: number; hold: boolean } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const readyWaiters = useRef<(() => void)[]>([]);
  const endSuppression = useRef<(() => void) | null>(null);
  const autoStarted = useRef(false);
  /** The finger is still on the shutter after a hold (hold-to-record; a ref, not state: no stale closures). */
  const holding = useRef(false);

  const dim = useSharedValue(0);
  const ring = useSharedValue(0);
  const pull = useSharedValue(0);
  const zoomBase = useSharedValue(0);

  const close = useCallback(() => {
    if (recording) camera.current?.stopRecording();
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, [recording, router]);

  // ---- camera readiness (a mode switch rebinds the camera)

  const onReady = () => {
    setReady(true);
    const waiters = readyWaiters.current;
    readyWaiters.current = [];
    for (const w of waiters) w();
  };
  const waitReady = () =>
    new Promise<void>((resolve) => {
      readyWaiters.current.push(resolve);
      setTimeout(resolve, 1500);
    });

  // ---- photo

  const takePhoto = async () => {
    if (!camera.current || busy || recording) return;
    feedback.shutter();
    setBusy(true);
    dim.value = withSequence(
      withTiming(1 - SHUTTER_DIM.opacity + 0.0001, { duration: SHUTTER_DIM.in }),
      withTiming(0, { duration: SHUTTER_DIM.out }),
    );
    try {
      const pic = await camera.current.takePictureAsync({ quality: 1, exif: false, shutterSound: false });
      const id = await outbox.createDraft({
        kind: 'photo',
        origin: 'camera',
        uri: pic.uri,
        how: 'move',
        mimetype: 'image/jpeg',
        width: pic.width,
        height: pic.height,
      });
      router.replace({ pathname: '/compose', params: { ids: id } });
    } catch {
      feedback.reject();
      setBusy(false);
    }
  };

  // ---- video

  const startVideo = async (hold: boolean) => {
    if (!camera.current || recording || busy) return;
    if (!mic?.granted) {
      const r = await requestMic();
      if (!r.granted) return;
    }
    feedback.holdToRecord(); // before the recorder starts
    if (camMode !== 'video') {
      setReady(false);
      setCamMode('video');
      await waitReady();
    }
    if (hold && !holding.current) {
      // Let go before the recorder could start: nothing to keep.
      if (rail === 'photo') setCamMode('picture');
      return;
    }
    const startedAt = Date.now();
    endSuppression.current = suppressHaptics();
    setRecording({ startedAt, hold });
    ring.value = 0;
    ring.value = withTiming(1, { duration: MAX_CLIP_MS, easing: Easing.linear });
    let uri: string | null = null;
    // Released while the recorder was starting: stop as soon as it runs.
    const releasedEarly = setTimeout(() => {
      if (hold && !holding.current) camera.current?.stopRecording();
    }, 400);
    try {
      const result = await camera.current?.recordAsync({ maxDuration: MAX_CLIP_MS / 1000 });
      uri = result?.uri ?? null;
    } catch {
      uri = null;
    } finally {
      clearTimeout(releasedEarly);
      holding.current = false;
    }
    const durationMs = Math.min(MAX_CLIP_MS, Date.now() - startedAt);
    endSuppression.current?.();
    endSuppression.current = null;
    feedback.recordEnd(); // after it stopped
    setRecording(null);
    ring.value = 0;
    if (!uri || durationMs < 600) {
      // A mis-tap: nothing worth keeping.
      if (rail === 'photo') setCamMode('picture');
      return;
    }
    setBusy(true);
    try {
      const id = await outbox.createDraft({
        kind: 'video',
        origin: 'camera',
        uri,
        how: 'move',
        mimetype: 'video/mp4',
        durationMs,
      });
      router.replace({ pathname: '/compose', params: { ids: id } });
    } catch {
      feedback.reject();
      setBusy(false);
    }
  };

  const stopVideo = () => {
    camera.current?.stopRecording();
  };

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setElapsed(Date.now() - recording.startedAt), 250);
    return () => {
      clearInterval(timer);
      setElapsed(0);
    };
  }, [recording]);

  // Hold ◉ on Today: start a video right away (hands-free: tap to stop).
  // biome-ignore lint/correctness/useExhaustiveDependencies: auto-start once when the camera is ready (guarded by autoStarted); startVideo is a fresh closure every render
  useEffect(() => {
    if (params.start === 'video' && ready && !autoStarted.current && permission?.granted) {
      autoStarted.current = true;
      void startVideo(false);
    }
  }, [ready, permission?.granted]);

  useEffect(
    () => () => {
      endSuppression.current?.();
    },
    [],
  );

  // ---- modes

  const chooseMode = (next: RailMode) => {
    if (recording || next === rail) return;
    feedback.step();
    if (next === 'text') {
      router.replace('/text');
      return;
    }
    if (next === 'voice') {
      router.replace('/voice');
      return;
    }
    setRail(next);
    setReady(false);
    setCamMode(next === 'video' ? 'video' : 'picture');
  };

  const stepMode = (dir: 1 | -1) => {
    const i = MODES.indexOf(rail);
    const next = MODES[Math.max(0, Math.min(MODES.length - 1, i + dir))];
    if (next) chooseMode(next);
  };

  // ---- gestures (each has a visible button too)

  const pinch = usePinchGesture({
    runOnJS: true,
    onBegin: () => {
      zoomBase.value = zoom;
    },
    onUpdate: (e) => {
      const next = Math.max(0, Math.min(1, zoomBase.value + (e.scale - 1) * 0.4));
      if (Math.abs(next - zoom) > 0.005) setZoom(next);
    },
  });
  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    runOnJS: true,
    onActivate: () => {
      if (!recording) flip();
    },
  });
  const pullDown = usePanGesture({
    maxPointers: 1,
    activeOffsetY: 24,
    failOffsetX: [-30, 30],
    onUpdate: (e) => {
      'worklet';
      pull.value = Math.max(0, e.translationY);
    },
    onDeactivate: (e) => {
      'worklet';
      if (e.translationY > 140 || e.velocityY > 1000) {
        scheduleOnRN(close);
      } else {
        pull.value = withSpring(0, SPRINGS.snappy);
      }
    },
  });
  const viewfinderGestures = useSimultaneousGestures(pinch, useExclusiveGestures(doubleTap, pullDown));
  const railSwipe = usePanGesture({
    activeOffsetX: [-30, 30],
    failOffsetY: [-20, 20],
    runOnJS: true,
    onDeactivate: (e) => {
      if (Math.abs(e.translationX) > 50) stepMode(e.translationX < 0 ? 1 : -1);
    },
  });

  const flip = () => {
    feedback.step();
    setFacing((f) => (f === 'back' ? 'front' : 'back'));
    setZoom(0);
  };
  const cycleFlash = () => {
    feedback.step();
    setFlash((f) => (f === 'auto' ? 'on' : f === 'on' ? 'off' : 'auto'));
  };

  const stageStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: pull.value * 0.6 }],
    borderRadius: pull.value > 0 ? 24 : 0,
  }));
  const dimStyle = useAnimatedStyle(() => ({ opacity: dim.value }));
  const ringProps = useAnimatedProps(() => ({ strokeDashoffset: RING_LEN * (1 - ring.value) }));
  const contentIn = useSharedValue(0);
  useEffect(() => {
    contentIn.value = withTiming(1, { duration: reduced ? 120 : 220 });
  }, [contentIn, reduced]);
  const chromeStyle = useAnimatedStyle(() => ({ opacity: contentIn.value }));

  const left = MAX_CLIP_MS - elapsed;
  const flashLabel = flash === 'auto' ? t`Flash: auto` : flash === 'on' ? t`Flash: on` : t`Flash: off`;
  const modeLabels: Record<RailMode, string> = { text: t`Text`, photo: t`Photo`, video: t`Video`, voice: t`Voice` };
  const granted = permission?.granted ?? false;

  return (
    <View style={styles.screen} testID="camera-screen">
      <Animated.View style={[StyleSheet.absoluteFill, styles.stage, stageStyle]}>
        {granted ? (
          <GestureDetector gesture={viewfinderGestures}>
            <View style={StyleSheet.absoluteFill} collapsable={false}>
              <CameraView
                ref={camera}
                style={StyleSheet.absoluteFill}
                facing={facing}
                flash={facing === 'front' && flash === 'on' ? 'screen' : flash}
                zoom={zoom}
                mode={camMode}
                animateShutter={false}
                videoQuality="1080p"
                onCameraReady={onReady}
                onMountError={() => setReady(false)}
                testID="camera-view"
              />
              <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.dim, dimStyle]} />
            </View>
          </GestureDetector>
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.permission]} testID="camera-permission">
            <Icon name="Camera" size={40} color="#f4a3bc" />
            <Text style={styles.permissionText}>
              {permission && !permission.canAskAgain ? (
                <Trans>The camera is off for On My Way.</Trans>
              ) : (
                <Trans>To take photos, On My Way needs the camera.</Trans>
              )}
            </Text>
            {permission && !permission.canAskAgain ? (
              <PillButton label={t`Open settings`} onPress={() => void Linking.openSettings()} />
            ) : (
              <PillButton label={t`Allow the camera`} onPress={() => void requestPermission()} testID="camera-allow" />
            )}
            <Text style={styles.permissionHint}>
              <Trans>Text, voice and the gallery work without it.</Trans>
            </Text>
          </View>
        )}
      </Animated.View>

      <Animated.View style={[styles.top, { paddingTop: insets.top + 8 }, chromeStyle]} pointerEvents="box-none">
        <RoundButton tone="glass" icon="Close" label={t`Close the camera`} onPress={close} testID="camera-close" />
        {recording ? (
          <View style={styles.timer} accessibilityLiveRegion="polite" testID="record-timer">
            <View style={styles.recDot} />
            <Text style={styles.timerText} maxFontSizeMultiplier={1.3}>
              {formatClock(elapsed)}
              {left <= 15_000 ? t` · ${Math.ceil(left / 1000)} s left` : ''}
            </Text>
          </View>
        ) : (
          <View style={styles.topRight}>
            <RoundButton tone="glass" label={flashLabel} onPress={cycleFlash} testID="camera-flash">
              <Icon name={flash === 'off' ? 'FlashOff' : 'Flash'} size={22} color="#ffffff" />
              {flash === 'auto' ? <Text style={styles.flashA}>A</Text> : null}
            </RoundButton>
            <RoundButton tone="glass" icon="Flip" label={t`Switch camera`} onPress={flip} testID="camera-flip" />
          </View>
        )}
      </Animated.View>

      <GestureDetector gesture={railSwipe}>
        <Animated.View style={[styles.bottom, { paddingBottom: insets.bottom + 16 }, chromeStyle]} collapsable={false}>
          {granted && facing === 'back' && !recording ? (
            <View style={styles.zoomRow} accessibilityRole="radiogroup">
              {[
                { label: '1×', value: 0 },
                { label: '2×', value: ZOOM_2X },
              ].map((z) => {
                const on = Math.abs(zoom - z.value) < 0.05;
                return (
                  <Press
                    key={z.label}
                    onPress={() => {
                      feedback.step();
                      setZoom(z.value);
                    }}
                    style={[styles.zoomChip, on && styles.zoomChipOn]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: on }}
                    accessibilityLabel={t`Zoom ${z.label}`}
                  >
                    <Text style={[styles.zoomText, on && styles.zoomTextOn]} maxFontSizeMultiplier={1.3}>
                      {z.label}
                    </Text>
                  </Press>
                );
              })}
            </View>
          ) : null}

          <View style={styles.shutterRow}>
            <View style={styles.sideSlot}>
              {!recording ? (
                <RoundButton
                  tone="glass"
                  icon="Image"
                  label={t`Gallery`}
                  onPress={() => {
                    void gallery.pick().then((ids) => {
                      if (ids.length > 0) router.replace({ pathname: '/compose', params: { ids: ids.join(',') } });
                    });
                  }}
                  size={52}
                  testID="camera-gallery"
                />
              ) : null}
            </View>
            <View style={styles.shutterWrap}>
              <Svg width={SHUTTER + 12} height={SHUTTER + 12} style={StyleSheet.absoluteFill} pointerEvents="none">
                <Defs>
                  <LinearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
                    <Stop offset="0" stopColor="#be4a74" />
                    <Stop offset="1" stopColor="#8e6bd6" />
                  </LinearGradient>
                </Defs>
                <Circle
                  cx={(SHUTTER + 12) / 2}
                  cy={(SHUTTER + 12) / 2}
                  r={RING_R}
                  stroke="rgba(255,255,255,0.85)"
                  strokeWidth={4}
                  fill="none"
                />
                {recording ? (
                  <AnimatedCircle
                    cx={(SHUTTER + 12) / 2}
                    cy={(SHUTTER + 12) / 2}
                    r={RING_R}
                    stroke="url(#ring)"
                    strokeWidth={5}
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={`${RING_LEN} ${RING_LEN}`}
                    animatedProps={ringProps}
                    transform={`rotate(-90 ${(SHUTTER + 12) / 2} ${(SHUTTER + 12) / 2})`}
                  />
                ) : null}
              </Svg>
              <Press
                style={[styles.shutter, rail === 'video' && styles.shutterVideo, recording && styles.shutterRecording]}
                disabled={!granted || busy}
                delayLongPress={350}
                onPress={() => {
                  if (rail === 'video') {
                    if (recording) stopVideo();
                    else void startVideo(false);
                  } else if (!recording) {
                    void takePhoto();
                  }
                }}
                onLongPress={() => {
                  if (rail !== 'photo') return;
                  holding.current = true;
                  void startVideo(true);
                }}
                onPressOut={() => {
                  if (!holding.current) return;
                  holding.current = false;
                  stopVideo();
                }}
                accessibilityRole="button"
                accessibilityLabel={recording ? t`Stop recording` : rail === 'video' ? t`Start video` : t`Take photo`}
                accessibilityHint={rail === 'photo' && !recording ? t`Double-tap and hold for a video` : undefined}
                testID="shutter"
              >
                {recording ? <View style={styles.stopSquare} /> : null}
              </Press>
            </View>
            <View style={styles.sideSlot} />
          </View>

          <View style={styles.rail} accessibilityRole="radiogroup">
            {MODES.map((m) => {
              const on = rail === m;
              return (
                <Press
                  key={m}
                  onPress={() => chooseMode(m)}
                  disabled={!!recording}
                  style={[styles.railItem, on && styles.railItemOn]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on, disabled: !!recording }}
                  testID={`mode-${m}`}
                >
                  <Text style={[styles.railText, on && styles.railTextOn]} maxFontSizeMultiplier={1.3}>
                    {modeLabels[m]}
                  </Text>
                </Press>
              );
            })}
          </View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: STAGE },
  stage: { backgroundColor: STAGE, overflow: 'hidden' },
  dim: { backgroundColor: '#000000' },
  permission: { alignItems: 'center', justifyContent: 'center', gap: 16, paddingHorizontal: 32 },
  permissionText: { ...typeStyles.title, color: '#f7ecf2', fontSize: 22, lineHeight: 28, textAlign: 'center' },
  permissionHint: { ...typeStyles.body, color: '#c9b6cc', fontSize: 14, textAlign: 'center' },
  top: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topRight: { flexDirection: 'row', gap: 12 },
  flashA: {
    position: 'absolute',
    right: 9,
    bottom: 7,
    color: '#ffffff',
    fontSize: 10,
    fontFamily: 'Nunito',
    fontWeight: '800',
  },
  timer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 9999,
    backgroundColor: 'rgba(18, 12, 23, 0.6)',
  },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#f4a3bc' },
  timerText: { color: '#ffffff', fontFamily: 'Nunito', fontWeight: '700', fontSize: 16, fontVariant: ['tabular-nums'] },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingTop: 24, alignItems: 'center', gap: 14 },
  zoomRow: { flexDirection: 'row', gap: 8, padding: 4, borderRadius: 9999, backgroundColor: 'rgba(18, 12, 23, 0.46)' },
  zoomChip: {
    minWidth: 44,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  zoomChipOn: { backgroundColor: 'rgba(255,255,255,0.92)' },
  zoomText: { color: '#ffffff', fontFamily: 'Nunito', fontWeight: '800', fontSize: 14 },
  zoomTextOn: { color: STAGE },
  shutterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    paddingHorizontal: 28,
  },
  sideSlot: { width: 56, alignItems: 'center' },
  shutterWrap: { width: SHUTTER + 12, height: SHUTTER + 12, alignItems: 'center', justifyContent: 'center' },
  shutter: {
    width: SHUTTER - 12,
    height: SHUTTER - 12,
    borderRadius: (SHUTTER - 12) / 2,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterVideo: { backgroundColor: '#be4a74' },
  shutterRecording: { backgroundColor: 'rgba(190, 74, 116, 0.35)' },
  stopSquare: { width: 26, height: 26, borderRadius: 6, backgroundColor: '#ffffff' },
  rail: { flexDirection: 'row', gap: 4, padding: 4, borderRadius: 9999, backgroundColor: 'rgba(18, 12, 23, 0.46)' },
  railItem: { paddingHorizontal: 14, minHeight: 40, borderRadius: 20, justifyContent: 'center' },
  railItemOn: { backgroundColor: 'rgba(255,255,255,0.16)' },
  railText: { color: '#c9b6cc', fontFamily: 'Nunito', fontWeight: '700', fontSize: 14, letterSpacing: 0.4 },
  railTextOn: { color: '#ffffff', fontWeight: '800' },
});
