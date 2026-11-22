/**
 * Video trim (ux.md §3.5 "Trim"): start and end handles on a timeline, never more than 60 s. The
 * end handle stops at the limit with GESTURE_THRESHOLD_ACTIVATE ("60 s max"), and _DEACTIVATE when
 * it moves back. No haptics while scrubbing. The timeline is not mirrored in RTL (media time runs
 * like a tape). Handles are adjustable for TalkBack (±1 s per step) and get extra touch area
 * inwards only.
 */
import { useLingui } from '@lingui/react/macro';
import { useRef, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import { GestureDetector, type PanGestureActiveEvent, usePanGesture } from 'react-native-gesture-handler';
import { formatClock } from '../core/entry';
import { clipLengthMs, MAX_CLIP_MS, moveHandle, type TrimWindow } from '../core/trim';
import { feedback } from './haptics';

const HANDLE = 22;

export function TrimBar({
  durationMs,
  window,
  onChange,
  onScrub,
}: {
  durationMs: number;
  window: TrimWindow;
  onChange: (w: TrimWindow) => void;
  /** Seek the preview while a handle moves. */
  onScrub?: (ms: number) => void;
}) {
  const { t } = useLingui();
  const [width, setWidth] = useState(0);
  const atLimit = useRef(false);
  const startAt = useRef(0);
  const usable = Math.max(1, width - HANDLE * 2);
  const toX = (ms: number) => HANDLE + (ms / Math.max(1, durationMs)) * usable;

  const move = (handle: 'start' | 'end', ms: number) => {
    const next = moveHandle(window, handle, ms, durationMs);
    if (next.atLimit && !atLimit.current) feedback.threshold();
    if (!next.atLimit && atLimit.current) feedback.thresholdBack();
    atLimit.current = next.atLimit;
    onChange({ startMs: next.startMs, endMs: next.endMs });
    onScrub?.(handle === 'start' ? next.startMs : next.endMs);
  };

  const panConfig = (handle: 'start' | 'end') =>
    ({
      runOnJS: true,
      minDistance: 0,
      hitSlop: handle === 'start' ? { right: 16, top: 12, bottom: 12 } : { left: 16, top: 12, bottom: 12 },
      onBegin: () => {
        startAt.current = handle === 'start' ? window.startMs : window.endMs;
      },
      onUpdate: (e: PanGestureActiveEvent) => {
        move(handle, startAt.current + (e.translationX / usable) * durationMs);
      },
      onDeactivate: () => {
        atLimit.current = false;
      },
    }) as const;
  const startPan = usePanGesture(panConfig('start'));
  const endPan = usePanGesture(panConfig('end'));

  const a11y = (handle: 'start' | 'end') => ({
    accessible: true,
    accessibilityRole: 'adjustable' as const,
    accessibilityLabel: handle === 'start' ? t`Start of the clip` : t`End of the clip`,
    accessibilityValue: { text: formatClock(handle === 'start' ? window.startMs : window.endMs) },
    accessibilityActions: [{ name: 'increment' as const }, { name: 'decrement' as const }],
    onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => {
      const base = handle === 'start' ? window.startMs : window.endMs;
      move(handle, base + (e.nativeEvent.actionName === 'increment' ? 1000 : -1000));
    },
  });

  const long = durationMs > MAX_CLIP_MS;
  const left = toX(window.startMs);
  const right = toX(window.endMs);

  return (
    <View style={styles.wrap}>
      <View style={styles.labels}>
        <Text style={styles.label} maxFontSizeMultiplier={1.3}>
          {formatClock(window.startMs)} – {formatClock(window.endMs)} · {Math.round(clipLengthMs(window) / 1000)} s
        </Text>
        <Text style={[styles.label, styles.hint]} maxFontSizeMultiplier={1.3}>
          {long ? t`Choose the best 60 seconds` : t`60 s max`}
        </Text>
      </View>
      <View
        style={styles.track}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        testID="trim-bar"
      >
        <View style={[styles.rail]} />
        {width > 0 ? (
          <>
            <View style={[styles.selected, { left, width: Math.max(0, right - left) }]} />
            <GestureDetector gesture={startPan}>
              <View style={[styles.handle, { left: left - HANDLE }]} {...a11y('start')} testID="trim-start">
                <View style={styles.grip} />
              </View>
            </GestureDetector>
            <GestureDetector gesture={endPan}>
              <View style={[styles.handle, { left: right }]} {...a11y('end')} testID="trim-end">
                <View style={styles.grip} />
              </View>
            </GestureDetector>
          </>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, direction: 'ltr' },
  labels: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { color: '#f7ecf2', fontFamily: 'Nunito', fontWeight: '700', fontSize: 13, fontVariant: ['tabular-nums'] },
  hint: { color: '#c9b6cc', fontWeight: '400' },
  track: { height: 48, justifyContent: 'center' },
  rail: {
    position: 'absolute',
    left: HANDLE,
    right: HANDLE,
    height: 36,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  selected: {
    position: 'absolute',
    height: 36,
    borderTopWidth: 3,
    borderBottomWidth: 3,
    borderColor: '#f4a3bc',
    backgroundColor: 'rgba(244, 163, 188, 0.18)',
  },
  handle: {
    position: 'absolute',
    width: HANDLE,
    height: 44,
    borderRadius: 8,
    backgroundColor: '#f4a3bc',
    alignItems: 'center',
    justifyContent: 'center',
  },
  grip: { width: 3, height: 16, borderRadius: 2, backgroundColor: '#3b2341' },
});
